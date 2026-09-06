/**
 * 真实 LLM E2E harness：与 scripts/evals/run.mjs 同形态（协议层直驱 server + 宿主 API mock），
 * 但把 LLM 从确定性 mock 换成真实 provider——server 的 ZA_LLM_BASE_URL/API_KEY/MODEL 由
 * demo .env 的 ZF_LLM_* 经 --env-file 原生注入并在本进程映射，密钥值始终不落上下文/日志（SEC-02）。
 *
 * 真实 LLM 措辞非确定，故断言从"精确关键词"放宽为"结构 + 行为"：讲解非空且命中要点组、
 * 装配换出确定性校验、引导命中/降级看帧、工具/HITL 看代执行是否发生 + 宿主 API 是否被调用。
 * scenarios.json 的 judges 与 mustNotMention 属结构性判据，两 harness 同一解释、逐场景照跑；
 * 判据依赖 mock LLM 哨兵（MOCK-*）而真模型必然跑不过的场景在 scenarios.json 标 mockOnly，本 harness 跳过并如实列出。
 * 每场景跑 RUNS 次、全过才算过（ZA-C-EVAL-02）；transcript（脱敏：不含签名/凭证）逐跑落盘
 * evals/runs/real-llm-transcripts.json，供 workflow 并行判定。
 *
 * 启动：node --env-file=<demo>/.env scripts/e2e/run-real-llm.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortsFree } from './port-guard.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERVER_DIST = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const SCENARIOS_PATH = join(REPO_ROOT, 'evals', 'scenarios.json');
const AUDIT_SINK_PATH = join(REPO_ROOT, '.za', 'real-llm-events.jsonl');
const TRANSCRIPTS_PATH = join(REPO_ROOT, 'evals', 'runs', 'real-llm-transcripts.json');

// 本地 harness 的测试签名密钥：仅用于签测试 JWT / HMAC 代执行指令，非真实凭证；允许 env 覆盖，默认取测试值。
const JWT_SECRET = process.env.ZA_TEST_JWT_SECRET ?? 'za-test-secret';
const SIGNING_SECRET = process.env.ZA_TEST_SIGNING_SECRET ?? 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_RL_SERVER_PORT ?? 8795);
const HOST_PORT = Number(process.env.ZA_RL_HOST_PORT ?? 4180);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;

// 真模型回答非确定：单跑通过不足以判稳，按 ZA-C-EVAL-02 每场景跑 3 次全过才算过。
// 允许 ZA_RL_RUNS 覆盖——调试单场景时压回 1 次，省真实调用配额。
const RUNS = Number(process.env.ZA_RL_RUNS ?? 3);
const TURN_TIMEOUT_MS = Number(process.env.ZA_RL_TURN_TIMEOUT_MS ?? 120000);
const QUIET_MS = Number(process.env.ZA_RL_QUIET_MS ?? 2000);
const POLL_MS = Number(process.env.ZA_RL_POLL_MS ?? 150);

/** 已知场景的行为期望：真实 LLM 是否应发起代执行、宿主 API 是否应被调用、HITL 如何裁决。 */
const BEHAVIOR_BY_ID = {
  'm3-tool-01': { decision: 'approve', expectExec: true, expectHostCall: 'GET /api/orders' },
  'm3-tool-02': { decision: 'approve', expectExec: false, expectHostCall: null },
  'm3-hitl-01': { decision: 'approve', expectExec: true, expectHostCall: 'POST /api/orders/ORD-1001/cancel' },
  'm3-hitl-02': { decision: 'reject', expectExec: false, expectHostCall: null },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: 'rl-user',
      tenant: 'rl-tenant',
      roles: ['user'],
      hostUserId: 'host-rl-user',
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 1800,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function sendApiJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 宿主 API mock：实现 tools.json adapter 命中的三个端点，并记录每次调用（METHOD path）供行为断言。 */
function startHostServer(hostCalls) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', HOST_BASE);
    const path = decodeURIComponent(url.pathname);
    hostCalls.push(`${req.method} ${path}`);
    const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      sendApiJson(res, 200, { ok: true, orderId: cancelMatch[1] });
      return;
    }
    if (req.method === 'GET' && path === '/api/orders') {
      sendApiJson(res, 200, { ok: true, count: 2 });
      return;
    }
    if (req.method === 'DELETE' && path === '/api/orders') {
      sendApiJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolveHost) => {
    server.listen(HOST_PORT, '127.0.0.1', () =>
      resolveHost({ close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

/** 起真实 LLM 的 server：ZA_LLM_* 由本进程从 --env-file 注入的 ZF_LLM_* 映射，值不打印。 */
function startServer() {
  if (!existsSync(SERVER_DIST)) {
    throw new Error(`server 未构建：缺 ${SERVER_DIST}（先 pnpm --filter @zen-agent/server build）`);
  }
  const baseUrl = process.env.ZF_LLM_BASE_URL;
  const apiKey = process.env.ZF_LLM_API_KEY;
  const model = process.env.ZF_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      '缺 ZF_LLM_BASE_URL/ZF_LLM_API_KEY/ZF_LLM_MODEL：请以 node --env-file=<demo>/.env 启动本 harness',
    );
  }
  const child = spawn('node', [SERVER_DIST], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: join(REPO_ROOT, 'examples', 'host-demo', 'config'),
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: baseUrl,
      ZA_LLM_API_KEY: apiKey,
      ZA_LLM_MODEL: model,
      ZA_AUDIT_SINK: AUDIT_SINK_PATH,
    },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

async function waitServerReady() {
  await waitFor(
    async () => {
      try {
        return (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'OPTIONS' })).status === 204;
      } catch {
        return false;
      }
    },
    { label: 'server 就绪', timeoutMs: 20000 },
  );
}

function createFrameBus() {
  const frames = [];
  let lastActivity = Date.now();
  return {
    push(frame) {
      frames.push(frame);
      lastActivity = Date.now();
    },
    all: () => frames,
    idleMs: () => Date.now() - lastActivity,
  };
}

async function openSse(sessionId, token, bus) {
  const controller = new AbortController();
  const res = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              bus.push(JSON.parse(line.slice(6)));
            } catch {
              /* 非 JSON data 行，忽略 */
            }
          }
        }
      }
    } catch {
      /* 收尾 abort 属预期 */
    }
  })();
  return { close: () => controller.abort() };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' };
}

async function postFrame(sessionId, token, frame) {
  return fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/frames`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(frame),
  });
}

async function executeInstruction(sessionId, token, frame) {
  const { request } = frame;
  const absoluteUrl = request.url.startsWith('http') ? request.url : `${HOST_BASE}${request.url}`;
  let execResult;
  try {
    const res = await fetch(absoluteUrl, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    execResult = {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: res.ok,
      status: res.status,
      ...(body !== undefined ? { body } : {}),
    };
  } catch {
    execResult = { type: 'exec-result', sessionId, nonce: frame.nonce, ok: false, error: '代执行请求发送失败' };
  }
  await postFrame(sessionId, token, execResult);
}

/**
 * 单回合驱动。settle 判据相较 mock 版做了关键调整：不再以 tool-card 落定为收尾快捷方式——真实 LLM 在
 * 工具执行后还需一轮 LLM 才产出总结文本，若见 tool-card succeeded 即返回会截断总结。故只认"安静 + 有终态
 * 文本或引导帧"为收尾（工具/HITL 回合恒以总结文本收尾，引导回合以 guide-action 收尾）。
 */
async function driveTurn(sessionId, token, decision, bus) {
  const handledHitl = new Set();
  const handledExec = new Set();
  let guideFrame = null;
  let execIssued = false;
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  for (;;) {
    for (const frame of bus.all()) {
      if (frame.type === 'hitl-request' && !handledHitl.has(frame.hitlId)) {
        handledHitl.add(frame.hitlId);
        await postFrame(sessionId, token, { type: 'hitl-decision', sessionId, hitlId: frame.hitlId, decision });
      }
      if (frame.type === 'exec-instruction' && !handledExec.has(frame.nonce)) {
        handledExec.add(frame.nonce);
        execIssued = true;
        await executeInstruction(sessionId, token, frame);
      }
      if (frame.type === 'guide-action' && guideFrame === null) {
        guideFrame = { action: frame.action, selector: frame.selector, message: frame.message ?? '' };
      }
    }

    const frames = bus.all();
    let lastTextIdx = -1;
    let lastToolIdx = -1;
    let toolCardStatus = null;
    frames.forEach((f, i) => {
      if (f.type === 'text-delta') lastTextIdx = i;
      if (f.type === 'hitl-request' || f.type === 'exec-instruction' || f.type === 'tool-card') lastToolIdx = i;
      if (f.type === 'tool-card') toolCardStatus = f.status;
    });
    const text = frames.filter((f) => f.type === 'text-delta').map((f) => f.delta).join('');
    // 有工具交互时，须等到"最后一个工具帧之后"的总结文本才算收尾——否则第一轮的中途文本会让回合在
    // 工具执行后、第二轮总结到达前被提前判定结束，截断拒绝/成功总结（真实 LLM 第二轮有秒级延迟）。
    const hasTerminalText = text !== '' && (lastToolIdx === -1 || lastTextIdx > lastToolIdx);
    const settled = bus.idleMs() > QUIET_MS && (hasTerminalText || guideFrame !== null);
    if (settled) return { text, guideFrame, execIssued, toolCardStatus };
    if (Date.now() > deadline) return { text, guideFrame, execIssued, toolCardStatus, timedOut: true };
    await sleep(POLL_MS);
  }
}

/**
 * 词界判定：命中处两侧须非「字母/数字/下划线」。语义与 scripts/evals/run.mjs 的 containsToken 逐字一致——
 * 两 harness 读同一份 scenarios.json，judges 不得有两套解释，否则同一判据在 mock 与真模型下含义分叉。
 */
function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

function containsToken(text, keyword) {
  if (keyword === '') return false;
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(keyword, from);
    if (at < 0) return false;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + keyword.length])) return true;
    from = at;
  }
}

/** 判据类型闭集：闭集外的 kind 一律判失败（防拼错静默恒真）。 */
const JUDGE_KINDS = {
  substring: (text, judge) => (judge.anyOf ?? []).some((keyword) => text.includes(keyword)),
  token: (text, judge) => (judge.anyOf ?? []).some((keyword) => containsToken(text, keyword)),
  regex: (text, judge) => new RegExp(judge.pattern, judge.flags ?? '').test(text),
};

function describeJudge(judge) {
  return judge.kind === 'regex' ? `/${judge.pattern}/` : `[${(judge.anyOf ?? []).join('|')}]`;
}

/** 逐条 judge 连乘：任一不成立即该跑失败（"不得出现"仍走 mustNotMention）。 */
function evaluateJudges(judges, text) {
  const reasons = [];
  for (const judge of judges) {
    const match = JUDGE_KINDS[judge.kind];
    if (match === undefined) {
      reasons.push(`判据 kind「${judge.kind}」不在闭集 [${Object.keys(JUDGE_KINDS).join('|')}] 内`);
      continue;
    }
    if (!match(text, judge)) reasons.push(`${judge.kind} 判据未命中 ${describeJudge(judge)}`);
  }
  return reasons;
}

function evaluateOutcome(scenario, o, hostCallsDelta) {
  const reasons = [];
  const text = o.text ?? '';
  if (/服务暂时不可用|内部错误/.test(text)) reasons.push(`回合以错误收尾：「${text}」`);

  // judges 与 mustNotMention 是结构性/负向判据（词界、正则、不得谎称成功），措辞非确定也应成立，
  // 故不分维度一律照跑——遗漏它们等于把场景的核心断言在真模型路径上静默丢弃。
  reasons.push(...evaluateJudges(scenario.expect.judges ?? [], text));
  for (const k of scenario.expect.mustNotMention ?? []) {
    if (text.includes(k)) reasons.push(`出现禁止内容「${k}」`);
  }

  if (scenario.dimension === 'explain') {
    if (text.trim() === '') reasons.push('讲解文本为空');
    for (const group of scenario.expect.mustMention ?? []) {
      if (!group.some((k) => text.includes(k))) reasons.push(`讲解缺要点组 [${group.join('|')}]`);
    }
  } else if (scenario.dimension === 'guide') {
    const degrade = Array.isArray(scenario.expect.mustNotMention) && scenario.expect.mustNotMention.length > 0;
    if (degrade) {
      if (o.guideFrame !== null) reasons.push('降级场景不应产出 guide-action 帧');
    } else if (o.guideFrame === null || o.guideFrame.selector === '') {
      reasons.push('命中场景应产出 selector 非空的 guide-action 帧');
    }
  } else if (scenario.dimension === 'tool' || scenario.dimension === 'hitl') {
    const b = BEHAVIOR_BY_ID[scenario.id];
    if (!b) {
      reasons.push(`缺该工具场景的行为期望表项：${scenario.id}`);
    } else {
      if (b.expectExec !== o.execIssued) {
        reasons.push(`代执行期望=${b.expectExec}，实际=${o.execIssued}`);
      }
      if (b.expectHostCall) {
        if (!hostCallsDelta.includes(b.expectHostCall)) {
          reasons.push(`应调用宿主 API「${b.expectHostCall}」，实际：[${hostCallsDelta.join(', ') || '无'}]`);
        }
      } else if (hostCallsDelta.length > 0) {
        reasons.push(`不应调用宿主 API，实际：[${hostCallsDelta.join(', ')}]`);
      }
      // 正向措辞非确定，不做精确关键词校验（交 workflow 质量判定）；只要求回合确实有总结文本收尾。
      if (text.trim() === '') reasons.push('工具/HITL 回合应有总结文本，实际为空');
    }
  } else {
    // 未建真模型判据的维度不得静默放行：宁可红，也不让「跑了但什么都没断言」冒充通过。
    reasons.push(`维度「${scenario.dimension}」在本 harness 无行为判据：请补判据或给该场景标 mockOnly`);
  }

  if (o.timedOut) reasons.push(`回合等待超时（${Math.round(TURN_TIMEOUT_MS / 1000)}s）`);
  return { pass: reasons.length === 0, reasons };
}

async function runAssemblySwap(scenario, token, transcripts, run) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const injections = [];
  for (const pagePath of scenario.flow) {
    await postFrame(sessionId, token, { type: 'context-report', sessionId, url: `${HOST_BASE}/${pagePath}` });
    await sleep(120);
    const injection = await (
      await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, { headers: auth })
    ).json();
    injections.push(injection);
  }
  const last = injections[injections.length - 1];
  const first = injections[0];
  const reasons = [];
  if (last.featureId !== scenario.featureId) {
    reasons.push(`换出后 featureId 期望 ${scenario.featureId}，实际 ${last.featureId}`);
  }
  if (JSON.stringify(first.blocks) === JSON.stringify(last.blocks)) {
    reasons.push('换出前后 injection blocks 未变化');
  }
  const result = { pass: reasons.length === 0, reasons };
  transcripts.push({
    id: scenario.id,
    run,
    dimension: scenario.dimension,
    behavior: scenario.expect.behavior,
    firstFeatureId: first.featureId,
    lastFeatureId: last.featureId,
    ...result,
  });
  return result;
}

async function runScenario(scenario, token, hostCalls, transcripts, run) {
  if (scenario.dimension === 'assembly-swap') {
    return runAssemblySwap(scenario, token, transcripts, run);
  }
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const bus = createFrameBus();
  const sse = await openSse(sessionId, token, bus);
  const callsBefore = hostCalls.length;
  try {
    await postFrame(sessionId, token, { type: 'context-report', sessionId, url: `${HOST_BASE}/${scenario.page}` });
    await sleep(80);
    await postFrame(sessionId, token, { type: 'user-message', sessionId, text: scenario.question });
    const decision = BEHAVIOR_BY_ID[scenario.id]?.decision ?? 'approve';
    const outcome = await driveTurn(sessionId, token, decision, bus);
    const hostCallsDelta = hostCalls.slice(callsBefore);
    const result = evaluateOutcome(scenario, outcome, hostCallsDelta);
    transcripts.push({
      id: scenario.id,
      run,
      dimension: scenario.dimension,
      page: scenario.page,
      question: scenario.question,
      behavior: scenario.expect.behavior,
      text: outcome.text,
      guideFrame: outcome.guideFrame,
      execIssued: outcome.execIssued,
      toolCardStatus: outcome.toolCardStatus,
      hostCalls: hostCallsDelta,
      timedOut: outcome.timedOut ?? false,
      ...result,
    });
    return result;
  } finally {
    sse.close();
  }
}

async function main() {
  const cleanups = [];
  let failure = null;
  let allPassed = false;
  const hostCalls = [];
  const transcripts = [];

  try {
    mkdirSync(dirname(AUDIT_SINK_PATH), { recursive: true });
    rmSync(AUDIT_SINK_PATH, { force: true });

    console.log('[1/3] 构建 server…');
    await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);

    await assertPortsFree([
      { port: SERVER_PORT, label: 'gateway' },
      { port: HOST_PORT, label: 'host' },
    ]);
    console.log('[2/3] 起真实 LLM server + 宿主 API mock…');
    const serverProc = startServer();
    cleanups.push(
      () =>
        new Promise((r) => {
          serverProc.once('exit', () => r());
          serverProc.kill('SIGTERM');
        }),
    );
    await waitServerReady();
    const host = await startHostServer(hostCalls);
    cleanups.push(() => host.close());

    const token = signTestJwt();
    let scenarios = JSON.parse(readFileSync(SCENARIOS_PATH, 'utf8'));
    const only = process.env.ZA_RL_ONLY;
    if (only) {
      const ids = new Set(only.split(',').map((s) => s.trim()));
      scenarios = scenarios.filter((s) => ids.has(s.id));
    }

    // mock 专用场景（判据依赖 mock LLM 哨兵）不跑：真模型必然红，跑了只会把结果变成噪声。
    // 跳过必须显式列出——否则"少跑了几条"会伪装成"全过"。
    const skipped = scenarios.filter((s) => s.mockOnly === true);
    scenarios = scenarios.filter((s) => s.mockOnly !== true);
    if (skipped.length > 0) {
      console.log(
        `已跳过 ${skipped.length} 条 mock 专用场景（mockOnly，判据依赖 MOCK-* 哨兵）：${skipped.map((s) => s.id).join(', ')}\n`,
      );
    }

    console.log(`[3/3] 跑 ${scenarios.length} 个场景 × ${RUNS} 次（真实 LLM）：\n`);
    const results = [];
    for (const scenario of scenarios) {
      const runOutcomes = [];
      for (let i = 0; i < RUNS; i += 1) {
        try {
          runOutcomes.push(await runScenario(scenario, token, hostCalls, transcripts, i + 1));
        } catch (cause) {
          runOutcomes.push({
            pass: false,
            reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`],
          });
        }
      }
      const passCount = runOutcomes.filter((r) => r.pass).length;
      results.push({ id: scenario.id, dimension: scenario.dimension, passCount });
      console.log(
        `  [${passCount === RUNS ? 'PASS' : 'FAIL'}] ${scenario.id} (${scenario.dimension})：${passCount}/${RUNS}`,
      );
      runOutcomes.forEach((o, i) => {
        if (!o.pass) o.reasons.forEach((rsn) => console.log(`      run${i + 1}: ${rsn}`));
      });
    }

    mkdirSync(dirname(TRANSCRIPTS_PATH), { recursive: true });
    writeFileSync(TRANSCRIPTS_PATH, JSON.stringify(transcripts, null, 2), 'utf8');
    console.log(`\ntranscript 已写入 ${TRANSCRIPTS_PATH}`);

    allPassed = results.every((r) => r.passCount === RUNS);
    const passedScenarios = results.filter((r) => r.passCount === RUNS).length;
    console.log(
      `\n结构/行为断言：${passedScenarios}/${results.length} 场景 ${RUNS} 跑全过 ${allPassed ? '✅' : '❌'}` +
        `${skipped.length > 0 ? `（另跳过 ${skipped.length} 条 mock 专用场景）` : ''}`,
    );
  } catch (error) {
    failure = error;
    console.error(`\nharness 异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve().then(cleanup).catch(() => {});
    }
  }
  process.exit(failure || !allPassed ? 1 : 0);
}

main();
