/**
 * M4 评测 runner：协议层直驱 evals/scenarios.json 五维度场景（讲解/拒答/装配换出/引导/工具/HITL），
 * 不经浏览器/插件——runner 自己扮演客户端：fetch 发上行帧、读 SSE 下行帧，
 * 收到 exec-instruction 即代插件之职 fetch 宿主 API 回 exec-result，收到 hitl-request 按场景裁决表回 hitl-decision。
 * 每场景跑 RUNS 次、全 3/3 通过才算过（ZA-C-EVAL-02）；额外跑 HITL happy 场景后校验审计事件链完整性
 * 与脱敏（Goal-f）。环境编排复用 scripts/e2e/run-m3.mjs 的形态（mock LLM + node dist/main.js + 宿主 API mock）。
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERVER_DIST = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const SCENARIOS_PATH = join(REPO_ROOT, 'evals', 'scenarios.json');
// 装配快照根（server 载入）+ pack 级评测发现根（ADR-013 §4：扫 packs 各 eval/scenarios.json 逐 pack 跑）。
// 两根分阶段各起一台 server（同端口先后独占）：host-demo 根跑存量 13 场景 + 其 pack 发现；
// acceptance 根跑 codeflow-console/mail-126 两验收 pack（origin 为 codeflow.asia/mail.126.com，与 host-demo 不同源，故须独立载入）。
const SNAPSHOT_ROOT = join(REPO_ROOT, 'examples', 'host-demo', 'config');
const ACCEPTANCE_ROOT = join(REPO_ROOT, 'examples', 'acceptance');
const COMMERCE_ROOT = join(REPO_ROOT, 'assets');
const AUDIT_SCHEMA_PATH = join(REPO_ROOT, 'packages', 'contracts', 'schemas', 'audit-event.schema.json');
const AUDIT_SINK_PATH = join(REPO_ROOT, '.za', 'eval-events.jsonl');
const REPORT_PATH = join(REPO_ROOT, 'evals', 'runs', '2026-07-22-commerce-phase1.md');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_EVAL_SERVER_PORT ?? 8791);
const MOCK_LLM_PORT = Number(process.env.ZA_EVAL_MOCK_PORT ?? 8792);
// host 端口须对齐 host-demo pack 的 site.origin（http://127.0.0.1:4173），否则 origin 围栏不命中、featureId 落空。
const HOST_PORT = Number(process.env.ZA_EVAL_HOST_PORT ?? 4173);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;

const RUNS = Number(process.env.ZA_EVAL_RUNS ?? 3);
const TURN_TIMEOUT_MS = Number(process.env.ZA_EVAL_TURN_TIMEOUT_MS ?? 15000);
const QUIET_MS = Number(process.env.ZA_EVAL_QUIET_MS ?? 500);
const POLL_MS = Number(process.env.ZA_EVAL_POLL_MS ?? 120);

/**
 * hitl 维度场景没有机器可读的"裁决策略"字段（scenarios.json 契约只有 mustMention/mustNotMention/behavior，
 * 后者是人工走查判据）；runner 扮演客户端时必须显式决定点确认还是拒绝，按现有两个 hitl 场景语义固定映射
 * （m3-hitl-01 取消 ORD-1001 期望"已为你取消" → approve；m3-hitl-02 取消 ORD-1002 期望"已取消该操作" → reject）。
 */
const HITL_DECISION_BY_SCENARIO = {
  'm3-hitl-01': 'approve',
  'm3-hitl-02': 'reject',
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
      sub: 'eval-user',
      tenant: 'eval-tenant',
      roles: ['user'],
      hostUserId: 'host-eval-user',
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function sendApiJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 宿主 API mock：仅实现 tools.json adapter 命中的三个端点，代执行(exec-instruction)由 runner 直接 fetch 本服务。 */
function startHostServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', HOST_BASE);
    const path = decodeURIComponent(url.pathname);
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

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

function startServer(snapshotRoot = SNAPSHOT_ROOT) {
  if (!existsSync(SERVER_DIST)) {
    throw new Error(`server 未构建：缺 ${SERVER_DIST}（先 pnpm --filter @zen-agent/server build）`);
  }
  const child = spawn('node', [SERVER_DIST], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: snapshotRoot,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`,
      ZA_LLM_MODEL: 'mock-model',
      ZA_AUDIT_SINK: AUDIT_SINK_PATH,
      ZA_GENERIC_ALLOWLIST: HOST_BASE,
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

/** 累积下行帧 + 最近一次到达时刻；用于判定一回合"已安静"（无新帧一段时间）而非依赖显式收尾帧。 */
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

/** 用 fetch 流式读 SSE（EventSource 不支持自定义 header，故用 fetch stream 解析 data: 行）。 */
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
              /* 非 JSON data 行（不应出现），忽略 */
            }
          }
        }
      }
    } catch {
      /* 场景结束时 controller.abort() 使 read() 拒绝，属预期收尾 */
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

/** 代插件之职：绝对化 exec-instruction 的相对 url、真实 fetch 宿主 API、把结果原样回喂为 exec-result。 */
async function executeInstruction(sessionId, token, frame, scenario) {
  const { request } = frame;
  // dom 代执行批次（ADR-013 send-email 等）：代插件之职回一个符合 resultSchema 的确定性结果
  // （reads 空对象 + completedSteps=步数），供回喂轮总结；不触真实浏览器。
  if (request?.kind === 'dom') {
    if (typeof scenario.execResultError === 'string') {
      await postFrame(sessionId, token, {
        type: 'exec-result',
        sessionId,
        nonce: frame.nonce,
        ok: false,
        error: scenario.execResultError,
      });
      return;
    }
    await postFrame(sessionId, token, {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: true,
      body: { reads: {}, completedSteps: Array.isArray(request.steps) ? request.steps.length : 1 },
    });
    return;
  }
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
    execResult = {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: false,
      error: '代执行请求发送失败（网络不可达）',
    };
  }
  await postFrame(sessionId, token, execResult);
}

/**
 * 单回合通用驱动：轮询下行帧，side-effect 地处理 hitl-request（按裁决表回决策）与 exec-instruction
 * （fetch 宿主 API 回 exec-result），并在文本/引导帧安静 QUIET_MS 后判定回合结束。
 * explain/refusal/tool/hitl/guide 五维度共用本函数——引导与工具/HITL 只是"途中多几帧"，终态判据一致。
 */
async function driveTurn(sessionId, token, scenario, bus) {
  const handledHitl = new Set();
  const handledExec = new Set();
  const handledSnapshot = new Set();
  let guideFrame = null;
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  for (;;) {
    for (const frame of bus.all()) {
      if (frame.type === 'hitl-request' && !handledHitl.has(frame.hitlId)) {
        handledHitl.add(frame.hitlId);
        const decision = HITL_DECISION_BY_SCENARIO[scenario.id] ?? 'approve';
        await postFrame(sessionId, token, {
          type: 'hitl-decision',
          sessionId,
          hitlId: frame.hitlId,
          decision,
        });
      }
      if (frame.type === 'snapshot-request' && !handledSnapshot.has(frame.requestId)) {
        // 代插件之职回一份确定性快照；pack 场景可声明需求相关元素，未声明则沿用发送按钮夹具。
        const snapshotIndex = handledSnapshot.size;
        handledSnapshot.add(frame.requestId);
        const snapshotFixture = scenario.snapshotSequence?.[snapshotIndex] ?? scenario;
        await postFrame(sessionId, token, {
          type: 'snapshot-report',
          sessionId,
          requestId: frame.requestId,
          url: scenario.url ?? `${HOST_BASE}/${scenario.page}`,
          elements: snapshotFixture.snapshotElements ?? [{ ref: 'za-send', role: 'button', label: '发送' }],
          notices: snapshotFixture.snapshotNotices ?? [],
          ...(snapshotFixture.snapshotEvidence !== undefined
            ? { evidence: snapshotFixture.snapshotEvidence }
            : {}),
        });
      }
      if (frame.type === 'exec-instruction' && !handledExec.has(frame.nonce)) {
        handledExec.add(frame.nonce);
        await executeInstruction(sessionId, token, frame, scenario);
      }
      if (frame.type === 'guide-action' && guideFrame === null) {
        guideFrame = frame;
      }
    }

    const text = bus
      .all()
      .filter((f) => f.type === 'text-delta')
      .map((f) => f.delta)
      .join('');
    const toolCardSettled = bus
      .all()
      .some((f) => f.type === 'tool-card' && f.status !== 'running');
    const settled = bus.idleMs() > QUIET_MS && (text !== '' || guideFrame !== null || toolCardSettled);
    if (settled) return { text, guideFrame, frames: bus.all() };
    if (Date.now() > deadline) return { text, guideFrame, frames: bus.all(), timedOut: true };
    await sleep(POLL_MS);
  }
}

/**
 * guide 维度场景是否为"失配/降级"用例：scenarios.json 未开放机器可读的 hit/miss 字段，
 * 但两个已知 guide 场景恰以 mustNotMention 是否存在为界——命中场景(m2-guide-01)只有 behavior，
 * 失配场景(m2-guide-02)带 mustNotMention 断言不出现"已为你定位"。据此推断，不硬编码场景 id。
 */
function isGuideDegradeCase(expect) {
  return Array.isArray(expect.mustNotMention) && expect.mustNotMention.length > 0;
}

function evaluateOutcome(scenario, outcome) {
  const expect = scenario.expect;
  const text = outcome.text ?? '';
  const reasons = [];

  for (const group of expect.mustMention ?? []) {
    if (!group.some((keyword) => text.includes(keyword))) {
      reasons.push(`缺少必含关键词组 [${group.join('|')}]；实际文本：「${text}」`);
    }
  }
  for (const keyword of expect.mustNotMention ?? []) {
    if (text.includes(keyword)) {
      reasons.push(`出现禁止关键词「${keyword}」；实际文本：「${text}」`);
    }
  }
  if (scenario.dimension === 'guide') {
    if (isGuideDegradeCase(expect)) {
      if (outcome.guideFrame !== null) {
        reasons.push('失配场景不应产出 guide-action 帧，但观察到一个');
      }
    } else if (outcome.guideFrame === null || outcome.guideFrame.selector === '') {
      reasons.push('命中场景应产出 guide-action 帧且 selector 非空，但未观察到');
    }
  }
  if (outcome.timedOut && reasons.length === 0 && text === '' && outcome.guideFrame === null) {
    reasons.push('等待下行帧超时（15s）且无任何可判定内容');
  }
  const frames = outcome.frames ?? [];
  const expectedCounts = expect.frameCounts ?? {};
  const targetCalls = frames.filter(
    (frame) =>
      frame.type === 'tool-card' &&
      frame.status === 'running' &&
      (expect.targetToolId === undefined || frame.toolId === expect.targetToolId),
  );
  const targetCallIds = new Set(targetCalls.map((frame) => frame.toolCallId));
  const targetInstructions = frames.filter(
    (frame) => frame.type === 'exec-instruction' && targetCallIds.has(frame.toolCallId),
  );
  const actualCounts = {
    targetToolCalls: targetCalls.length,
    execInstructions: new Set(targetInstructions.map((frame) => frame.nonce)).size,
    snapshotRequests: new Set(
      frames.filter((frame) => frame.type === 'snapshot-request').map((frame) => frame.requestId),
    ).size,
    hitlRequests: frames.filter(
      (frame) => frame.type === 'hitl-request' && targetCallIds.has(frame.toolCallId),
    ).length,
  };
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (actualCounts[name] !== expected) {
      reasons.push(`帧计数 ${name} 期望 ${expected}，实际 ${actualCounts[name] ?? '未知'}`);
    }
  }
  if (Array.isArray(expect.frameSequence)) {
    const actualSequence = frames.flatMap((frame) => {
      if (frame.type === 'snapshot-request') return ['snapshot'];
      if (frame.type === 'tool-card' && frame.status === 'running' && targetCallIds.has(frame.toolCallId)) {
        return ['target-tool'];
      }
      if (frame.type === 'exec-instruction' && targetCallIds.has(frame.toolCallId)) {
        return ['target-exec'];
      }
      return [];
    });
    if (JSON.stringify(actualSequence) !== JSON.stringify(expect.frameSequence)) {
      reasons.push(
        `关键帧顺序期望 [${expect.frameSequence.join(' → ')}]，实际 [${actualSequence.join(' → ')}]`,
      );
    }
  }
  if (typeof expect.evidenceRuleId === 'string') {
    const missing = frames.filter(
      (frame) =>
        frame.type === 'snapshot-request' &&
        !(frame.evidenceRules ?? []).some((rule) => rule.id === expect.evidenceRuleId),
    );
    if (missing.length > 0) reasons.push(`有 ${missing.length} 个快照请求缺证据配方 ${expect.evidenceRuleId}`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function runAssemblySwap(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const injections = [];
  for (const pagePath of scenario.flow) {
    await postFrame(sessionId, token, {
      type: 'context-report',
      sessionId,
      url: `${HOST_BASE}/${pagePath}`,
    });
    await sleep(100);
    const injection = await (
      await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, { headers: auth })
    ).json();
    injections.push(injection);
  }
  const last = injections[injections.length - 1];
  const first = injections[0];
  const reasons = [];
  if (last.featureId !== scenario.featureId) {
    reasons.push(`装配换出后 featureId 期望 ${scenario.featureId}，实际 ${last.featureId}`);
  }
  if (JSON.stringify(first.blocks) === JSON.stringify(last.blocks)) {
    reasons.push('装配换出前后 injection blocks 未变化，功能块未随 featureId 换出');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * pack 级评测发现（ADR-013 §4）：扫 <root>/packs 下各 pack 的 eval/scenarios.json，逐 pack 收其场景。
 * ZA-EVAL 素材同仓——pack 分发到哪评测跟到哪；本阶段 host-demo pack 暂无 eval 目录，发现为空即跳过。
 */
function discoverPackScenarios(root) {
  const packsDir = join(root, 'packs');
  if (!existsSync(packsDir)) return [];
  const discovered = [];
  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scenariosPath = join(packsDir, entry.name, 'eval', 'scenarios.json');
    if (!existsSync(scenariosPath)) continue;
    const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'));
    discovered.push({ packId: entry.name, scenarios });
  }
  return discovered;
}

/**
 * pack 级「装配」维度（ADR-013 §4 验收）：只经 /injection 自省端口断言装配结果，不驱动 LLM。
 * scenario.url 为完整 URL（含 pack origin），context-report 后拉取注入描述断言 featureId 与工具面投影
 * （toolIncludes 须命中、toolExcludesPrefixes 前缀不得出现——后者证跨 pack 隔离与 fail-safe 回落）。
 */
async function runAssemblyInjection(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  await postFrame(sessionId, token, { type: 'context-report', sessionId, url: scenario.url });
  await sleep(100);
  const injection = await (
    await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, { headers: auth })
  ).json();
  const expect = scenario.expect ?? {};
  const toolIds = Array.isArray(injection.toolIds) ? injection.toolIds : [];
  const reasons = [];
  if ('featureId' in expect && injection.featureId !== expect.featureId) {
    reasons.push(`装配 featureId 期望 ${JSON.stringify(expect.featureId)}，实际 ${JSON.stringify(injection.featureId)}`);
  }
  for (const toolId of expect.toolIncludes ?? []) {
    if (!toolIds.includes(toolId)) {
      reasons.push(`工具面缺必含工具 ${toolId}；实际工具面 [${toolIds.join(', ')}]`);
    }
  }
  for (const prefix of expect.toolExcludesPrefixes ?? []) {
    const leaked = toolIds.filter((id) => id.startsWith(prefix));
    if (leaked.length > 0) {
      reasons.push(`工具面出现禁止前缀 ${prefix} 的工具 [${leaked.join(', ')}]`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * hitl「授权不复用」场景（ADR-013 every-call）：同一会话内对同一发送动作连发两次请求，
 * 断言两次都触发了对目标工具的 hitl-request（每次单独确认、不复用授权）。
 * per-task 工具第二次会因任务级授权复用而不再触发 hitl，故本断言可判别 every-call。
 */
async function runHitlNoReuse(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const bus = createFrameBus();
  const sse = await openSse(sessionId, token, bus);
  try {
    await postFrame(sessionId, token, { type: 'context-report', sessionId, url: scenario.url });
    await sleep(80);
    const rounds = scenario.expect?.hitlCount ?? 2;
    for (let i = 0; i < rounds; i += 1) {
      await postFrame(sessionId, token, { type: 'user-message', sessionId, text: scenario.question });
      await driveTurn(sessionId, token, scenario, bus);
    }
    const targetTool = scenario.expect?.hitlToolId;
    const hitlIds = new Set(
      bus
        .all()
        .filter((f) => f.type === 'hitl-request' && (!targetTool || f.toolId === targetTool))
        .map((f) => f.hitlId),
    );
    const reasons = [];
    if (hitlIds.size !== rounds) {
      reasons.push(
        `期望 ${targetTool ?? '目标工具'} 触发 ${rounds} 次独立 hitl-request（授权不复用），实际 ${hitlIds.size} 次`,
      );
    }
    return { pass: reasons.length === 0, reasons };
  } finally {
    sse.close();
  }
}

async function runScenarioOnce(scenario, token) {
  if (scenario.dimension === 'assembly-swap') {
    return runAssemblySwap(scenario, token);
  }
  if (scenario.dimension === 'assembly') {
    return runAssemblyInjection(scenario, token);
  }
  if (scenario.dimension === 'hitl' && scenario.expect?.hitlCount !== undefined) {
    return runHitlNoReuse(scenario, token);
  }
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const bus = createFrameBus();
  const sse = await openSse(sessionId, token, bus);
  try {
    // pack 级场景用完整 url（含 pack origin）；存量场景用相对 page（挂 host-demo 本地 origin）。
    await postFrame(sessionId, token, {
      type: 'context-report',
      sessionId,
      url: scenario.url ?? `${HOST_BASE}/${scenario.page}`,
    });
    await sleep(80); // 让 context-report 落地先于 user-message（与既有 e2e 脚本一致的时序假设）
    await postFrame(sessionId, token, { type: 'user-message', sessionId, text: scenario.question });
    const outcome = await driveTurn(sessionId, token, scenario, bus);
    return evaluateOutcome(scenario, outcome);
  } finally {
    sse.close();
  }
}

function loadAuditValidator() {
  // audit-event.schema.json 的 ts 字段用 format:date-time；ajv-formats 由 packages/audit
  // 的 devDependency 提供解析上下文（apps/server 不依赖 ajv-formats，故不能借它的 require）。
  const require = createRequire(join(REPO_ROOT, 'packages', 'audit', 'package.json'));
  const { Ajv2020 } = require('ajv/dist/2020.js');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv2020({ strict: true });
  (addFormats.default ?? addFormats)(ajv);
  const schema = JSON.parse(readFileSync(AUDIT_SCHEMA_PATH, 'utf8'));
  return ajv.compile(schema);
}

/** 与 packages/audit 落盘前脱敏同族的已知 secret 样式，用于独立复核事件确实未泄漏（defense-in-depth 复检，非脱敏实现本身）。 */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const REQUIRED_AUDIT_TYPES = [
  'session-start',
  'assembly',
  'tool-decision',
  'hitl-verdict',
  'tool-execution',
];

function checkAuditIntegrity() {
  const validate = loadAuditValidator();
  if (!existsSync(AUDIT_SINK_PATH)) {
    return { ok: false, reasons: [`审计 sink 不存在：${AUDIT_SINK_PATH}`], seenTypes: [], lineCount: 0 };
  }
  const raw = readFileSync(AUDIT_SINK_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  const reasons = [];
  const seenTypes = new Set();
  lines.forEach((line, i) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      reasons.push(`第 ${i + 1} 行不是合法 JSON`);
      return;
    }
    if (!validate(event)) {
      reasons.push(`第 ${i + 1} 行不过 audit-event schema：${JSON.stringify(validate.errors)}`);
      return;
    }
    seenTypes.add(event.type);
  });
  for (const requiredType of REQUIRED_AUDIT_TYPES) {
    if (!seenTypes.has(requiredType)) reasons.push(`审计事件链缺 type=${requiredType}`);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) reasons.push(`审计文件命中疑似 secret 样式：${pattern}`);
  }
  return { ok: reasons.length === 0, reasons, seenTypes: [...seenTypes], lineCount: lines.length };
}

function renderReport({ results, auditReport, dimensionSummary }) {
  const sourceHash = createHash('sha256');
  const addTree = (path) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) addTree(child);
      else if (entry.isFile()) sourceHash.update(child.slice(REPO_ROOT.length)).update(readFileSync(child));
    }
  };
  sourceHash.update(readFileSync(SCENARIOS_PATH));
  addTree(ACCEPTANCE_ROOT);
  addTree(COMMERCE_ROOT);
  const project = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const lines = [];
  lines.push('# Zen Commerce Agent Phase 1 评测报告 — 2026-07-22');
  lines.push('');
  lines.push(`证据环境：评测输入 SHA-256 \`${sourceHash.digest('hex')}\`；Node \`${project.engines.node}\`；\`${project.packageManager}\`；LLM=确定性 mock（非真实模型）。`);
  lines.push(`runner：\`scripts/evals/run.mjs\`；每场景重复 ${RUNS} 次，需 ${RUNS}/${RUNS} 全过才算该场景通过（ZA-C-EVAL-02）。`);
  lines.push('');
  lines.push('## 场景通过率');
  lines.push('');
  lines.push('| id | dimension | 通过/跑次 | 结论 |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    const status = r.passCount === RUNS ? 'PASS' : 'FAIL';
    lines.push(`| ${r.id} | ${r.dimension} | ${r.passCount}/${RUNS} | ${status} |`);
  }
  lines.push('');
  const failed = results.filter((r) => r.passCount !== RUNS);
  if (failed.length > 0) {
    lines.push('### 失败明细');
    lines.push('');
    for (const r of failed) {
      lines.push(`- **${r.id}**`);
      r.runOutcomes.forEach((outcome, i) => {
        if (!outcome.pass) {
          lines.push(`  - run${i + 1}: ${outcome.reasons.join('; ')}`);
        }
      });
    }
    lines.push('');
  }
  lines.push('## 五维度覆盖');
  lines.push('');
  lines.push('| dimension | 场景数 | 全绿场景数 |');
  lines.push('|---|---|---|');
  for (const [dim, summary] of Object.entries(dimensionSummary)) {
    lines.push(`| ${dim} | ${summary.total} | ${summary.allGreen} |`);
  }
  lines.push('');
  lines.push('## 审计完整性（Goal-f）');
  lines.push('');
  lines.push(`- 事件行数：${auditReport.lineCount}`);
  lines.push(`- 观测到的事件类型：${auditReport.seenTypes.join(', ') || '（无）'}`);
  lines.push(`- 结论：${auditReport.ok ? 'PASS（事件链完整、全过 schema、无 secret 样式）' : 'FAIL'}`);
  if (!auditReport.ok) {
    lines.push('');
    for (const reason of auditReport.reasons) lines.push(`  - ${reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 幂等停止 server 子进程：已退出即直接 resolve，避免二次 kill 时 exit 事件不再触发而永挂。 */
function makeStop(child) {
  let stopped = false;
  return () =>
    new Promise((r) => {
      if (stopped || child.exitCode !== null) return r();
      stopped = true;
      child.once('exit', () => r());
      child.kill('SIGTERM');
    });
}

/** 逐 pack 跑其 eval/scenarios.json（发现为空即打印跳过），结果并入 results。 */
async function runPackSets(root, token, results, excludedPackIds = new Set()) {
  const packSets = discoverPackScenarios(root);
  if (packSets.length === 0) {
    console.log(`  未发现 pack 级评测素材（${join(root, 'packs')}/*/eval/scenarios.json），跳过。`);
    return;
  }
  for (const { packId, scenarios: packScenarios } of packSets) {
    if (excludedPackIds.has(packId)) continue;
    console.log(`  pack「${packId}」：${packScenarios.length} 个场景 × ${RUNS} 次`);
    for (const scenario of packScenarios) {
      const runOutcomes = [];
      for (let i = 0; i < RUNS; i += 1) {
        try {
          runOutcomes.push(await runScenarioOnce(scenario, token));
        } catch (cause) {
          runOutcomes.push({ pass: false, reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`] });
        }
      }
      const passCount = runOutcomes.filter((r) => r.pass).length;
      results.push({ id: `${packId}/${scenario.id}`, dimension: scenario.dimension, passCount, runOutcomes });
      const status = passCount === RUNS ? 'PASS' : 'FAIL';
      console.log(`    [${status}] ${packId}/${scenario.id} (${scenario.dimension})：${passCount}/${RUNS}`);
      if (passCount !== RUNS) {
        runOutcomes.forEach((o, i) => {
          if (!o.pass) console.log(`        run${i + 1}: ${o.reasons.join('; ')}`);
        });
      }
    }
  }
}

async function main() {
  const cleanups = [];
  let failure = null;
  let allPassed = false;

  try {
    mkdirSync(dirname(AUDIT_SINK_PATH), { recursive: true });
    rmSync(AUDIT_SINK_PATH, { force: true });

    console.log('[1/4] 构建 server…');
    await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);

    console.log('[2/4] 起 mock LLM…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());

    console.log('[3/4] 起 server（host-demo 根）…');
    const stopServer1 = makeStop(startServer(SNAPSHOT_ROOT));
    cleanups.push(stopServer1);
    await waitServerReady();

    console.log('[4/4] 起宿主 API mock…');
    const host = await startHostServer();
    cleanups.push(() => host.close());

    const token = signTestJwt();
    const scenarios = JSON.parse(readFileSync(SCENARIOS_PATH, 'utf8'));

    console.log(`\n跑 ${scenarios.length} 个场景 × ${RUNS} 次：`);
    const results = [];
    for (const scenario of scenarios) {
      const runOutcomes = [];
      for (let i = 0; i < RUNS; i += 1) {
        try {
          runOutcomes.push(await runScenarioOnce(scenario, token));
        } catch (cause) {
          runOutcomes.push({ pass: false, reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`] });
        }
      }
      const passCount = runOutcomes.filter((r) => r.pass).length;
      results.push({ id: scenario.id, dimension: scenario.dimension, passCount, runOutcomes });
      const status = passCount === RUNS ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${scenario.id} (${scenario.dimension})：${passCount}/${RUNS}`);
      if (passCount !== RUNS) {
        runOutcomes.forEach((o, i) => {
          if (!o.pass) console.log(`      run${i + 1}: ${o.reasons.join('; ')}`);
        });
      }
    }

    console.log('\n按根发现 pack 级评测（host-demo 根 · packs/*/eval/scenarios.json）…');
    await runPackSets(SNAPSHOT_ROOT, token, results);

    // acceptance 根的 pack（codeflow.asia/mail.126.com）与 host-demo 不同源，须换台 server 独立载入；
    // 同端口先停 host-demo server 再起 acceptance server（宿主 API mock 沿用，验收 pack 场景为装配/拒答，不触宿主 API）。
    console.log('\n停 host-demo server，换起 acceptance 根 server…');
    await stopServer1();
    const stopServer2 = makeStop(startServer(ACCEPTANCE_ROOT));
    cleanups.push(stopServer2);
    await waitServerReady();

    console.log('\n按根发现 pack 级评测（acceptance 根 · packs/*/eval/scenarios.json）…');
    await runPackSets(ACCEPTANCE_ROOT, token, results, new Set(['xianyu-seller']));
    await stopServer2();

    console.log('\n换起 Zen Commerce Agent 生产快照 server…');
    const stopServer3 = makeStop(startServer(COMMERCE_ROOT));
    cleanups.push(stopServer3);
    await waitServerReady();

    console.log('\n按根发现生产 pack 级评测（assets/packs/*/eval/scenarios.json）…');
    await runPackSets(COMMERCE_ROOT, token, results);
    await stopServer3();

    console.log('\n审计完整性校验…');
    const auditReport = checkAuditIntegrity();
    console.log(
      `  ${auditReport.ok ? 'PASS' : 'FAIL'}：${auditReport.lineCount} 条事件，类型 [${auditReport.seenTypes.join(', ')}]`,
    );
    if (!auditReport.ok) {
      for (const reason of auditReport.reasons) console.log(`    - ${reason}`);
    }

    const dimensionSummary = {};
    for (const r of results) {
      dimensionSummary[r.dimension] ??= { total: 0, allGreen: 0 };
      dimensionSummary[r.dimension].total += 1;
      if (r.passCount === RUNS) dimensionSummary[r.dimension].allGreen += 1;
    }

    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, renderReport({ results, auditReport, dimensionSummary }), 'utf8');
    console.log(`\n报告已写入 ${REPORT_PATH}`);

    allPassed = results.every((r) => r.passCount === RUNS) && auditReport.ok;
    console.log(allPassed ? '\nM4 评测全部通过 ✅' : '\nM4 评测存在未过项 ❌');
  } catch (error) {
    failure = error;
    console.error(`\n评测 runner 异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {});
    }
  }
  process.exit(failure || !allPassed ? 1 : 0);
}

main();
