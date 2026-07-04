/**
 * 真实 LLM E2E harness：与 scripts/evals/run.mjs 同形态（协议层直驱 server + 宿主 API mock），
 * 但把 LLM 从确定性 mock 换成真实 provider——server 的 ZA_LLM_BASE_URL/API_KEY/MODEL 由
 * demo .env 的 ZF_LLM_* 经 --env-file 原生注入并在本进程映射，密钥值始终不落上下文/日志（SEC-02）。
 *
 * 真实 LLM 措辞非确定，故断言从"精确关键词"放宽为"结构 + 行为"：讲解非空且命中要点组、拒答不越界、
 * 装配换出确定性校验、引导命中/降级看帧、工具/HITL 看代执行是否发生 + 宿主 API 是否被调用。
 * 每场景跑一次、transcript（脱敏：不含签名/凭证）落盘 evals/runs/real-llm-transcripts.json，供 workflow 并行判定。
 *
 * 启动：node --env-file=<demo>/.env scripts/e2e/run-real-llm.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const TURN_TIMEOUT_MS = Number(process.env.ZA_RL_TURN_TIMEOUT_MS ?? 120000);
const QUIET_MS = 2000;
const POLL_MS = 150;

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

function evaluateOutcome(scenario, o, hostCallsDelta) {
  const reasons = [];
  const text = o.text ?? '';
  if (/服务暂时不可用|内部错误/.test(text)) reasons.push(`回合以错误收尾：「${text}」`);

  if (scenario.dimension === 'explain') {
    if (text.trim() === '') reasons.push('讲解文本为空');
    for (const group of scenario.expect.mustMention ?? []) {
      if (!group.some((k) => text.includes(k))) reasons.push(`讲解缺要点组 [${group.join('|')}]`);
    }
    for (const k of scenario.expect.mustNotMention ?? []) {
      if (text.includes(k)) reasons.push(`讲解出现禁止内容「${k}」`);
    }
  } else if (scenario.dimension === 'refusal') {
    if (text.trim() === '') reasons.push('拒答文本为空');
    for (const k of scenario.expect.mustNotMention ?? []) {
      if (text.includes(k)) reasons.push(`拒答出现禁止内容「${k}」`);
    }
    if (hostCallsDelta.length > 0) reasons.push(`拒答场景不应调用宿主 API，实际：[${hostCallsDelta.join(', ')}]`);
    if (o.guideFrame !== null) reasons.push('拒答场景不应产出引导帧');
  } else if (scenario.dimension === 'guide') {
    const degrade = Array.isArray(scenario.expect.mustNotMention) && scenario.expect.mustNotMention.length > 0;
    if (degrade) {
      if (o.guideFrame !== null) reasons.push('降级场景不应产出 guide-action 帧');
      for (const k of scenario.expect.mustNotMention) {
        if (text.includes(k)) reasons.push(`降级场景出现禁止内容「${k}」`);
      }
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
      // 不谎称成功：tool/hitl 的负向断言（如 forbidden 不得"已为你"、reject 不得"已为你取消订单"）
      // 用真实 LLM 也不该踩的 mustNotMention 校验；正向措辞非确定，不做精确关键词校验（交 workflow 质量判定）。
      for (const k of scenario.expect.mustNotMention ?? []) {
        if (text.includes(k)) reasons.push(`出现禁止内容「${k}」（疑谎称成功/越界）`);
      }
      if (text.trim() === '') reasons.push('工具/HITL 回合应有总结文本，实际为空');
    }
  }

  if (o.timedOut) reasons.push(`回合等待超时（${Math.round(TURN_TIMEOUT_MS / 1000)}s）`);
  return { pass: reasons.length === 0, reasons };
}

async function runAssemblySwap(scenario, token, transcripts) {
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
    dimension: scenario.dimension,
    behavior: scenario.expect.behavior,
    firstFeatureId: first.featureId,
    lastFeatureId: last.featureId,
    ...result,
  });
  return result;
}

async function runScenario(scenario, token, hostCalls, transcripts) {
  if (scenario.dimension === 'assembly-swap') {
    return runAssemblySwap(scenario, token, transcripts);
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

    console.log(`[3/3] 跑 ${scenarios.length} 个场景（真实 LLM，每场景 1 次）：\n`);
    const results = [];
    for (const scenario of scenarios) {
      let result;
      try {
        result = await runScenario(scenario, token, hostCalls, transcripts);
      } catch (cause) {
        result = { pass: false, reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`] };
      }
      results.push({ id: scenario.id, dimension: scenario.dimension, ...result });
      console.log(`  [${result.pass ? 'PASS' : 'FAIL'}] ${scenario.id} (${scenario.dimension})`);
      if (!result.pass) result.reasons.forEach((rsn) => console.log(`      - ${rsn}`));
    }

    mkdirSync(dirname(TRANSCRIPTS_PATH), { recursive: true });
    writeFileSync(TRANSCRIPTS_PATH, JSON.stringify(transcripts, null, 2), 'utf8');
    console.log(`\ntranscript 已写入 ${TRANSCRIPTS_PATH}`);

    allPassed = results.every((r) => r.pass);
    const passCount = results.filter((r) => r.pass).length;
    console.log(`\n结构/行为断言：${passCount}/${results.length} 通过 ${allPassed ? '✅' : '❌'}`);
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
