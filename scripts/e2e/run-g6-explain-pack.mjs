/**
 * G6 浏览器 E2E：E2E-A（讲解与拒答）+ E2E-D（pack v2 载入三态）。
 * 范式沿用 run-m5.mjs / run-xianyu.mjs：真实 Chromium + MV3 extension + 真实 gateway 子进程 +
 * 静态站点夹具 + 可编程 mock LLM（不接触真实密钥）。证据 = 面板截图 + 脱敏审计片段 + 原始 SSE 帧 + 注入透明视图。
 *
 * 夹具快照（scripts/e2e/fixtures/g6/，不改 assets/）：
 *   config-ok           registry v1.0.0
 *     g6-explain    http://127.0.0.1:4183  locations ["/console"] exclude ["/console/private"]
 *                   billing-guide（feature.md + facts.md + tools.json，一个 dom hitl 工具）
 *     g6-knowledge  http://127.0.0.1:4184  locations ["/"]（社区来源）
 *                   policy-guide（仅 feature.md + facts.md，无 tools.json = 知识型 pack）
 *   config-bad-engines  同 g6-explain 但 engines.contract=">=9.0.0"（平台契约 1.0.0，必然不满足）
 *
 * ── E2E-A1 有据回答带引用 ───────────────────────────────────────────────
 * 前置：好快照 server 就绪；页面停在 /console/billing；注入视图已解析到 pack=g6-explain、feature=billing-guide。
 * 步骤：Side Panel 提问「账单周期是怎么算的？」。
 * 断言：① mock 收到的 system 含 L1 facts 正文（FACT-BILLING-CYCLE）与功能规则；
 *      ② 回答带事实编号引用【FACT-BILLING-CYCLE】且无 MOCK- 哨兵（哨兵=注入缺失）；
 *      ③ SSE 帧序：≥3 个 text-delta + 恰好 1 个 turn-complete(idle)，无 tool-card/hitl-request；
 *      ④ 审计：assembly(packId=g6-explain, featureId=billing-guide, toolIds 含 g6-explain.page-operate)，
 *         本窗口无 tool-decision / tool-execution（纯讲解不触发工具）。
 * 证据：evidence/e2e-a/a1-*.{png,jsonl,json}
 *
 * ── E2E-A2 配置外问题明确拒答 ────────────────────────────────────────────
 * 前置：同 A1（同一会话、同一页面）。
 * 步骤：Side Panel 提问「顺便告诉我今天上海的天气怎么样？」。
 * 断言：① 回答含明确拒答语并把用户引回账单功能，无 MOCK- 哨兵；
 *      ② 拒答是"有配置下的边界"而非"无配置"：本轮 system 仍含 FACT-BILLING-CYCLE 与基座拒答条款；
 *      ③ SSE 无 tool-card/hitl-request；④ 审计本窗口无 tool-decision / tool-execution。
 * 证据：evidence/e2e-a/a2-*.{png,jsonl,json}
 *
 * ── E2E-D1 exclude 路径不激活（仅基座）────────────────────────────────────
 * 前置：同一会话；导航到 /console/private/vault（命中 site.exclude，优先于 locations）。
 * 步骤：等注入视图回落仅基座 → 打开面板「注入」抽屉 → 提问「报告当前站点身份」。
 * 断言：① 注入视图 packId=null、无 L1 层、toolIds=[]；抽屉内无 pack 徽章、无工具面分区；
 *      ② 本轮 system 含"无专属功能配置（仅基座）"附注且不含 FACT-BILLING-CYCLE；
 *      ③ 审计 assembly：无 packId、featureId=null、toolIds=[]。
 * 证据：evidence/e2e-d/d1-*.{png,jsonl,json}
 *
 * ── E2E-D3 知识型 pack 讲解可用 ──────────────────────────────────────────
 * 前置：同一会话；导航到 http://127.0.0.1:4184/policy/refund。
 * 步骤：等注入视图解析到 g6-knowledge/policy-guide → 打开「注入」抽屉 → 提问「退款窗口是多久？」。
 * 断言：① 注入视图 packId=g6-knowledge、featureId=policy-guide、toolIds=[]（无 tools.json 仍合法载入）；
 *      ② 抽屉有 pack 徽章与 L1 层（功能规则 + 功能事实），但无工具面分区；
 *      ③ 讲解可用：回答带【FACT-REFUND-WINDOW】引用，无 MOCK- 哨兵；SSE 有 text-delta + turn-complete；
 *      ④ 审计 assembly：packId=g6-knowledge、toolIds=[]。
 * 证据：evidence/e2e-d/d3-*.{png,jsonl,json}
 *
 * ── E2E-D2 engines 不满足拒载有可见错误 ──────────────────────────────────
 * 前置：其余用例已跑完（本例会打掉 server 进程，放最后）。
 * 步骤：停好快照 server → 以 config-bad-engines 在同端口启动 server → 面板再发一条消息。
 * 断言：① server 退出码 1，stderr 含"快照拒载"+ pack 标识 + "engines.contract" + 平台契约版本（可见错误、可定位）；
 *      ② 拒载是整快照 fail-closed：进程不监听，面板明示"无法连接 zen-agent 服务"，不静默降级成"仅基座可用"。
 * 证据：evidence/e2e-d/d2-*.{png,txt,json}
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const SERVER_MAIN = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'e2e', 'fixtures', 'g6');
const SNAPSHOT_OK = join(FIXTURE_DIR, 'config-ok');
const SNAPSHOT_BAD_ENGINES = join(FIXTURE_DIR, 'config-bad-engines');
const WORK_DIR = join(REPO_ROOT, '.za', 'e2e-g6');
const AUDIT_SINK = join(WORK_DIR, 'events.jsonl');
const SESSION_DIR = join(WORK_DIR, 'sessions');
const PROFILE_DIR = join(WORK_DIR, 'profile');

const EVIDENCE_ROOT = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence'),
);

const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `g6-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_E2E_G6_SERVER_PORT ?? 8801);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_G6_MOCK_PORT ?? 8803);
// 站点端口硬绑：夹具 pack.json 的 site.origin 与此处必须同值，不经 env 覆盖。
const EXPLAIN_PORT = 4183;
const KNOWLEDGE_PORT = 4184;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const EXPLAIN_ORIGIN = `http://127.0.0.1:${EXPLAIN_PORT}`;
const KNOWLEDGE_ORIGIN = `http://127.0.0.1:${KNOWLEDGE_PORT}`;
const BILLING_URL = `${EXPLAIN_ORIGIN}/console/billing`;
const EXCLUDED_URL = `${EXPLAIN_ORIGIN}/console/private/vault`;
const POLICY_URL = `${KNOWLEDGE_ORIGIN}/policy/refund`;

const FACT_BILLING = 'FACT-BILLING-CYCLE';
const FACT_REFUND = 'FACT-REFUND-WINDOW';
const BASE_ONLY_NOTICE = '无专属功能配置（仅基座）';
const ANSWER_BILLING = `根据本功能事实【${FACT_BILLING}】：账单周期为自然月，出账日为次月 1 日 10:00。`;
const ANSWER_REFUSE = '这超出了我的职责范围：本站点只配置了账单功能，天气问题不在讲解范围内。需要账单相关的帮助我可以继续。';
const ANSWER_BASE_ONLY = `当前站点${BASE_ONLY_NOTICE}，我无法说明该站点的身份或归属，也没有本站点的专属知识。`;
const ANSWER_REFUND = `根据本功能事实【${FACT_REFUND}】：退款窗口为签收后 7 天内，逾期只能走人工工单。`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: 'g6-e2e-user',
      tenant: 'g6-e2e',
      roles: ['user'],
      hostUserId: 'g6-host-user',
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 1800,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

const TOKEN = signTestJwt();

/** 证据落盘前统一脱敏：夹具 token/secret 值一律不入任何产物（SEC-01）。 */
function redact(text) {
  return String(text)
    .split(TOKEN).join('[redacted-token]')
    .split(JWT_SECRET).join('[redacted-secret]')
    .split(SIGNING_SECRET).join('[redacted-secret]');
}

function writeEvidence(caseDir, name, content) {
  const dir = join(EVIDENCE_ROOT, caseDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, redact(typeof content === 'string' ? content : JSON.stringify(content, null, 2)), 'utf8');
  return path;
}

function evidencePath(caseDir, name) {
  const dir = join(EVIDENCE_ROOT, caseDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';
  for (;;) {
    const result = await predicate();
    if (result === true) return;
    if (typeof result === 'string') lastDetail = result;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}${lastDetail === '' ? '' : `（最后观察：${lastDetail}）`}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---- 站点夹具（任意路径同构返回一页，路径写进标题便于截图取证）----

function startStaticHost(port, siteName) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${siteName} ${path}</title></head>` +
        `<body><h1 id="site">${siteName}</h1><p id="path">${path}</p></body></html>`,
    );
  });
  return new Promise((resolveHost) => {
    server.listen(port, '127.0.0.1', () =>
      resolveHost({ close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

// ---- 可编程 mock LLM（OpenAI chat completions 兼容，仅 stream:true）----
// 判定只看「system 拼接是否含该轮应被注入的内容」：注入缺失即产出 MOCK- 哨兵，
// 使"回答对不对"退化为"装配对不对"的机械可检信号，不靠模型自由发挥。

function decideReply(sys, user) {
  if (user.includes('账单周期')) {
    return sys.includes(FACT_BILLING) && sys.includes('ZA-FEAT-01') ? ANSWER_BILLING : 'MOCK-MISSING-FACTS';
  }
  if (user.includes('天气')) {
    return sys.includes('拒答') && sys.includes(FACT_BILLING) ? ANSWER_REFUSE : 'MOCK-BASE-MISSING';
  }
  if (user.includes('站点身份')) {
    return sys.includes(BASE_ONLY_NOTICE) && !sys.includes(FACT_BILLING)
      ? ANSWER_BASE_ONLY
      : 'MOCK-BASEONLY-MISS';
  }
  if (user.includes('退款窗口')) {
    return sys.includes(FACT_REFUND) ? ANSWER_REFUND : 'MOCK-MISSING-KNOWLEDGE';
  }
  return 'MOCK-DEFAULT';
}

function splitInThree(text) {
  const chars = Array.from(text);
  const step = Math.ceil(chars.length / 3);
  const parts = [];
  for (let i = 0; i < chars.length; i += step) parts.push(chars.slice(i, i + step).join(''));
  while (parts.length < 3) parts.push('');
  return parts;
}

function startMockLlm(port) {
  /** 原始请求只留在测试进程内存中供边界断言；永不打印、永不落盘。 */
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const sys = body.messages
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content ?? ''))
        .join('\n');
      const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user');
      const user = String(lastUser?.content ?? '');
      requests.push({ sys, user, toolNames: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name) });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = { id: 'chatcmpl-g6', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      for (const part of splitInThree(decideReply(sys, user))) {
        send({ index: 0, delta: { content: part }, finish_reason: null });
      }
      send({ index: 0, delta: {}, finish_reason: 'stop' });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolveMock) => {
    server.listen(port, '127.0.0.1', () =>
      resolveMock({ requests, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

// ---- 真实 gateway 子进程 ----

function spawnServer(snapshotRoot) {
  const child = spawn('node', [SERVER_MAIN], {
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
      ZA_AUDIT_SINK: AUDIT_SINK,
      ZA_SESSION_DIR: SESSION_DIR,
      ZA_USER_CONFIG_DIR: join(WORK_DIR, 'user-config'),
      ZA_APPLICATIONS_DIR: join(WORK_DIR, 'applications'),
    },
  });
  const stderr = [];
  const stdout = [];
  child.stdout.on('data', (d) => {
    stdout.push(String(d));
    process.stdout.write(`[server] ${d}`);
  });
  child.stderr.on('data', (d) => {
    stderr.push(String(d));
    process.stderr.write(`[server] ${d}`);
  });
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, stderr, stdout, exited };
}

async function waitServerReady() {
  await waitFor(
    async () => {
      try {
        return (await fetch(`${SERVER_BASE}/healthz`)).status === 200;
      } catch {
        return false;
      }
    },
    { label: 'server 就绪', timeoutMs: 25000 },
  );
}

function stopServer(server) {
  if (server === null) return Promise.resolve();
  server.child.kill('SIGTERM');
  return server.exited;
}

// ---- 审计与 SSE ----

function readAuditEvents() {
  if (!existsSync(AUDIT_SINK)) return [];
  return readFileSync(AUDIT_SINK, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** 订阅同一会话的下行 SSE（只读旁路，与插件订阅并存，不改变服务端行为）。 */
async function subscribeSse(sessionId) {
  const controller = new AbortController();
  const frames = [];
  const response = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`订阅 SSE 失败：HTTP ${response.status}`);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '') continue;
            frames.push(JSON.parse(payload));
          }
        }
      }
    } catch {
      // 连接被 abort 或服务端关闭：订阅结束即止，主流程不受影响（旁路只读）。
    }
  })();
  return { frames, close: () => controller.abort() };
}

async function fetchInjection(sessionId) {
  const response = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return response.ok ? response.json() : null;
}

// ---- Side Panel 交互 ----

async function panelText(panel) {
  const messages = panel.locator('[data-za-messages]');
  return (await messages.count()) === 0 ? '' : (await messages.innerText());
}

async function sendMessage(panel, text) {
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').click();
}

async function openInjectionDrawer(panel) {
  const drawer = panel.locator('[data-za-injection]');
  if (await drawer.isVisible()) return drawer;
  await panel.locator('[data-za-injection-toggle]').click();
  await drawer.waitFor({ state: 'visible', timeout: 10000 });
  await waitFor(async () => (await drawer.locator('.za-injection-title').count()) > 0, {
    label: '注入抽屉渲染',
    timeoutMs: 10000,
  });
  return drawer;
}

async function closeInjectionDrawer(panel) {
  const drawer = panel.locator('[data-za-injection]');
  if (await drawer.isVisible()) await panel.locator('[data-za-injection-toggle]').click();
}

/** 一轮讲解回合：发问 → 等回答落面板 → 收拢本轮的 SSE 帧 / 审计事件 / LLM 请求。 */
async function askAndCollect(context, question, expectedAnswer, label) {
  const { panel, sse, mock } = context;
  const sseMark = sse.frames.length;
  const auditMark = readAuditEvents().length;
  const llmMark = mock.requests.length;
  await sendMessage(panel, question);
  await waitFor(
    async () => {
      const text = await panelText(panel);
      return text.includes(expectedAnswer) ? true : text.slice(-120);
    },
    { label: `${label}：等待回答落面板`, timeoutMs: 30000 },
  );
  await waitFor(async () => sse.frames.slice(sseMark).some((frame) => frame.type === 'turn-complete'), {
    label: `${label}：等待 turn-complete 帧`,
    timeoutMs: 15000,
  });
  // 审计为旁路异步落盘：给 sink 一个短窗口把本轮事件写完，再取窗口切片。
  await new Promise((r) => setTimeout(r, 300));
  return {
    frames: sse.frames.slice(sseMark),
    events: readAuditEvents().slice(auditMark),
    llmRequests: mock.requests.slice(llmMark),
    panelText: await panelText(panel),
  };
}

function assertPlainTurnFrames(frames, label) {
  const deltas = frames.filter((frame) => frame.type === 'text-delta');
  const completes = frames.filter((frame) => frame.type === 'turn-complete');
  assert(deltas.length >= 3, `${label}：应有 ≥3 个 text-delta 帧（流式分片），实际 ${deltas.length}`);
  assert(completes.length === 1, `${label}：应有恰好 1 个 turn-complete 帧，实际 ${completes.length}`);
  assert(completes[0].idle === true, `${label}：turn-complete 应回到 idle`);
  const toolFrames = frames.filter((frame) => frame.type === 'tool-card' || frame.type === 'hitl-request');
  assert(toolFrames.length === 0, `${label}：纯讲解回合不应出现工具卡/确认卡，实际 ${toolFrames.map((f) => f.type).join(',')}`);
  return deltas.map((frame) => frame.delta).join('');
}

function assertNoToolEvents(events, label) {
  const toolEvents = events.filter((event) => event.type === 'tool-decision' || event.type === 'tool-execution');
  assert(
    toolEvents.length === 0,
    `${label}：纯讲解回合不应产生工具审计事件，实际 ${toolEvents.map((e) => e.type).join(',')}`,
  );
}

function lastAssembly(events, label) {
  const assemblies = events.filter((event) => event.type === 'assembly');
  assert(assemblies.length >= 1, `${label}：本轮应有 assembly 审计事件`);
  return assemblies.at(-1);
}

function archiveTurn(caseDir, prefix, result, meta) {
  writeEvidence(caseDir, `${prefix}-sse-frames.json`, result.frames);
  writeEvidence(caseDir, `${prefix}-audit.jsonl`, result.events.map((event) => JSON.stringify(event)).join('\n'));
  writeEvidence(caseDir, `${prefix}-case.json`, meta);
}

// ---- 用例 ----

async function caseA1(ctx) {
  const label = 'E2E-A1 有据回答带引用';
  const result = await askAndCollect(ctx, '账单周期是怎么算的？', ANSWER_BILLING, label);

  const request = result.llmRequests.at(-1);
  assert(request !== undefined, `${label}：mock LLM 未收到本轮请求`);
  assert(request.sys.includes(FACT_BILLING), `${label}：L1 功能事实未进入 system 注入`);
  assert(request.sys.includes('ZA-FEAT-01'), `${label}：L1 功能规则未进入 system 注入`);
  assert(!result.panelText.includes('MOCK-'), `${label}：面板出现注入缺失哨兵：${result.panelText.slice(-160)}`);
  assert(result.panelText.includes(`【${FACT_BILLING}】`), `${label}：回答未带事实编号引用`);

  const streamed = assertPlainTurnFrames(result.frames, label);
  assert(streamed === ANSWER_BILLING, `${label}：SSE text-delta 拼接与预期回答不一致：${streamed}`);

  const assembly = lastAssembly(result.events, label);
  assert(assembly.packId === 'g6-explain', `${label}：assembly.packId 应为 g6-explain，实际 ${assembly.packId}`);
  assert(assembly.data.featureId === 'billing-guide', `${label}：assembly.featureId 应为 billing-guide，实际 ${assembly.data.featureId}`);
  assert(
    assembly.data.toolIds.includes('g6-explain.page-operate'),
    `${label}：assembly.toolIds 应含 pack 工具，实际 ${JSON.stringify(assembly.data.toolIds)}`,
  );
  assertNoToolEvents(result.events, label);

  await ctx.panel.screenshot({ path: evidencePath('e2e-a', 'a1-cited-answer.png'), fullPage: true });
  archiveTurn('e2e-a', 'a1', result, {
    case: 'E2E-A1',
    title: '讲解：有据回答带引用',
    前置: `好快照 server 就绪；活跃页 ${BILLING_URL}；注入解析为 pack=g6-explain / feature=billing-guide`,
    步骤: ['Side Panel 提问「账单周期是怎么算的？」'],
    断言: [
      'system 注入含 L1 facts（FACT-BILLING-CYCLE）与功能规则 ZA-FEAT-01',
      '回答带【FACT-BILLING-CYCLE】引用且无 MOCK- 注入缺失哨兵',
      'SSE：≥3 text-delta + 1 turn-complete(idle)，无 tool-card/hitl-request',
      'audit assembly：packId=g6-explain / featureId=billing-guide / toolIds 含 g6-explain.page-operate；本轮无 tool-decision、tool-execution',
    ],
    证据: ['a1-cited-answer.png', 'a1-sse-frames.json', 'a1-audit.jsonl'],
    结果: 'pass',
    回答: result.panelText.split('\n').filter((line) => line.includes(FACT_BILLING)).at(-1) ?? '',
  });
  console.log(`  [pass] ${label}`);
}

async function caseA2(ctx) {
  const label = 'E2E-A2 配置外问题明确拒答';
  const result = await askAndCollect(ctx, '顺便告诉我今天上海的天气怎么样？', ANSWER_REFUSE, label);

  const request = result.llmRequests.at(-1);
  assert(request !== undefined, `${label}：mock LLM 未收到本轮请求`);
  assert(request.sys.includes('拒答'), `${label}：基座拒答条款未进入 system 注入`);
  assert(request.sys.includes(FACT_BILLING), `${label}：拒答须发生在"配置齐备"前提下，本轮 L1 事实缺失`);
  assert(!result.panelText.includes('MOCK-'), `${label}：面板出现注入缺失哨兵：${result.panelText.slice(-160)}`);
  assert(result.panelText.includes('超出了我的职责范围'), `${label}：回答未明确拒答`);

  assertPlainTurnFrames(result.frames, label);
  assertNoToolEvents(result.events, label);
  const assembly = lastAssembly(result.events, label);
  assert(assembly.packId === 'g6-explain', `${label}：拒答轮仍应在 g6-explain 装配下，实际 ${assembly.packId}`);

  await ctx.panel.screenshot({ path: evidencePath('e2e-a', 'a2-refusal.png'), fullPage: true });
  archiveTurn('e2e-a', 'a2', result, {
    case: 'E2E-A2',
    title: '讲解：配置外问题明确拒答',
    前置: '同 A1（同一会话、同一页面、配置齐备）',
    步骤: ['Side Panel 提问「顺便告诉我今天上海的天气怎么样？」'],
    断言: [
      '回答含明确拒答语并引回账单功能，无 MOCK- 哨兵',
      '本轮 system 仍含基座拒答条款与 L1 事实：拒答是边界判定而非配置缺失',
      'SSE 无 tool-card/hitl-request；本轮无 tool-decision、tool-execution',
    ],
    证据: ['a2-refusal.png', 'a2-sse-frames.json', 'a2-audit.jsonl'],
    结果: 'pass',
    回答: ANSWER_REFUSE,
  });
  console.log(`  [pass] ${label}`);
}

async function caseD1(ctx) {
  const label = 'E2E-D1 exclude 路径不激活（仅基座）';
  await ctx.page.goto(EXCLUDED_URL, { waitUntil: 'load' });
  let injection = null;
  await waitFor(
    async () => {
      injection = await fetchInjection(ctx.sessionId);
      return injection?.packId === null ? true : `packId=${injection?.packId}`;
    },
    { label: `${label}：等待注入回落仅基座`, timeoutMs: 20000 },
  );
  assert(injection.featureId === null, `${label}：exclude 命中后不应有 featureId，实际 ${injection.featureId}`);
  assert(injection.toolIds.length === 0, `${label}：仅基座工具面应为空，实际 ${JSON.stringify(injection.toolIds)}`);
  assert(
    !injection.blocks.some((block) => block.origin === 'L1'),
    `${label}：仅基座不应有 L1 注入段，实际 ${JSON.stringify(injection.blocks)}`,
  );

  const drawer = await openInjectionDrawer(ctx.panel);
  await waitFor(async () => (await drawer.locator('.za-injection-pack').count()) === 0, {
    label: `${label}：注入抽屉不应展示 pack 徽章`,
    timeoutMs: 10000,
  });
  assert((await drawer.locator('[data-za-layer="L1"]').count()) === 0, `${label}：注入抽屉不应有 L1 分区`);
  assert((await drawer.locator('.za-injection-tools').count()) === 0, `${label}：仅基座不应渲染工具面分区`);
  await ctx.panel.screenshot({ path: evidencePath('e2e-d', 'd1-injection-base-only.png'), fullPage: true });
  await closeInjectionDrawer(ctx.panel);

  const result = await askAndCollect(ctx, '报告当前站点身份', ANSWER_BASE_ONLY, label);
  const request = result.llmRequests.at(-1);
  assert(request.sys.includes(BASE_ONLY_NOTICE), `${label}：system 未带仅基座附注`);
  assert(!request.sys.includes(FACT_BILLING), `${label}：exclude 路径仍注入了 pack 事实（围栏失效）`);
  assert(!result.panelText.includes('MOCK-'), `${label}：面板出现注入缺失哨兵：${result.panelText.slice(-160)}`);
  assertPlainTurnFrames(result.frames, label);

  const assembly = lastAssembly(result.events, label);
  assert(assembly.packId === undefined, `${label}：仅基座轮不应记 packId，实际 ${assembly.packId}`);
  assert(assembly.data.featureId === null, `${label}：仅基座轮 featureId 应为 null，实际 ${assembly.data.featureId}`);
  assert(assembly.data.toolIds.length === 0, `${label}：仅基座轮 toolIds 应为空，实际 ${JSON.stringify(assembly.data.toolIds)}`);

  await ctx.panel.screenshot({ path: evidencePath('e2e-d', 'd1-base-only-answer.png'), fullPage: true });
  writeEvidence('e2e-d', 'd1-injection.json', injection);
  archiveTurn('e2e-d', 'd1', result, {
    case: 'E2E-D1',
    title: 'pack v2 载入：exclude 路径不激活（仅基座）',
    前置: `同一会话；活跃页 ${EXCLUDED_URL}（命中 site.exclude，优先于 locations ["/console"]）`,
    步骤: ['等注入回落仅基座', '打开 Side Panel「注入」抽屉取证', '提问「报告当前站点身份」'],
    断言: [
      '注入透明视图：packId=null、featureId=null、toolIds=[]、无 L1 注入段',
      '抽屉可见面：无 pack 徽章、无 L1 分区、无工具面分区',
      'system 含「无专属功能配置（仅基座）」附注且不含 pack 事实 FACT-BILLING-CYCLE',
      'audit assembly：无 packId、featureId=null、toolIds=[]',
    ],
    证据: ['d1-injection-base-only.png', 'd1-base-only-answer.png', 'd1-injection.json', 'd1-sse-frames.json', 'd1-audit.jsonl'],
    结果: 'pass',
  });
  console.log(`  [pass] ${label}`);
}

async function caseD3(ctx) {
  const label = 'E2E-D3 知识型 pack 讲解可用';
  await ctx.page.goto(POLICY_URL, { waitUntil: 'load' });
  let injection = null;
  await waitFor(
    async () => {
      injection = await fetchInjection(ctx.sessionId);
      return injection?.packId === 'g6-knowledge' ? true : `packId=${injection?.packId}`;
    },
    { label: `${label}：等待知识型 pack 激活`, timeoutMs: 20000 },
  );
  assert(injection.featureId === 'policy-guide', `${label}：featureId 应为 policy-guide，实际 ${injection.featureId}`);
  assert(injection.toolIds.length === 0, `${label}：知识型 pack 工具面应为空，实际 ${JSON.stringify(injection.toolIds)}`);
  const l1Kinds = injection.blocks.filter((block) => block.origin === 'L1').map((block) => block.kind);
  assert(
    l1Kinds.includes('feature-rules') && l1Kinds.includes('facts'),
    `${label}：知识型 pack 应注入功能规则与事实，实际 L1=${JSON.stringify(l1Kinds)}`,
  );

  const drawer = await openInjectionDrawer(ctx.panel);
  await waitFor(
    async () => {
      const badge = await drawer.locator('.za-injection-pack').first().textContent().catch(() => null);
      return badge !== null && badge.includes('G6 退款政策知识站') ? true : `徽章=${badge}`;
    },
    { label: `${label}：注入抽屉展示知识型 pack 徽章`, timeoutMs: 10000 },
  );
  assert((await drawer.locator('[data-za-layer="L1"]').count()) === 1, `${label}：注入抽屉应有 L1 分区`);
  assert((await drawer.locator('.za-injection-tools').count()) === 0, `${label}：无 tools.json 的 pack 不应渲染工具面分区`);
  await ctx.panel.screenshot({ path: evidencePath('e2e-d', 'd3-injection-knowledge-only.png'), fullPage: true });
  await closeInjectionDrawer(ctx.panel);

  const result = await askAndCollect(ctx, '退款窗口是多久？', ANSWER_REFUND, label);
  const request = result.llmRequests.at(-1);
  assert(request.sys.includes(FACT_REFUND), `${label}：知识型 pack 的 L1 事实未进入 system 注入`);
  assert(!result.panelText.includes('MOCK-'), `${label}：面板出现注入缺失哨兵：${result.panelText.slice(-160)}`);
  assert(result.panelText.includes(`【${FACT_REFUND}】`), `${label}：知识型 pack 回答未带事实编号引用`);
  assertPlainTurnFrames(result.frames, label);
  assertNoToolEvents(result.events, label);

  const assembly = lastAssembly(result.events, label);
  assert(assembly.packId === 'g6-knowledge', `${label}：assembly.packId 应为 g6-knowledge，实际 ${assembly.packId}`);
  assert(assembly.data.toolIds.length === 0, `${label}：知识型 pack assembly.toolIds 应为空，实际 ${JSON.stringify(assembly.data.toolIds)}`);

  await ctx.panel.screenshot({ path: evidencePath('e2e-d', 'd3-knowledge-answer.png'), fullPage: true });
  writeEvidence('e2e-d', 'd3-injection.json', injection);
  archiveTurn('e2e-d', 'd3', result, {
    case: 'E2E-D3',
    title: 'pack v2 载入：知识型 pack（无 tools.json）讲解可用',
    前置: `同一会话；活跃页 ${POLICY_URL}；pack g6-knowledge 无 tools.json`,
    步骤: ['等注入解析到 g6-knowledge/policy-guide', '打开「注入」抽屉取证', '提问「退款窗口是多久？」'],
    断言: [
      '注入透明视图：packId=g6-knowledge、featureId=policy-guide、toolIds=[]，L1 含 feature-rules + facts',
      '抽屉可见面：有 pack 徽章与 L1 分区，无工具面分区',
      '讲解可用：回答带【FACT-REFUND-WINDOW】引用，无 MOCK- 哨兵',
      'SSE：≥3 text-delta + 1 turn-complete；audit assembly packId=g6-knowledge、toolIds=[]',
    ],
    证据: ['d3-injection-knowledge-only.png', 'd3-knowledge-answer.png', 'd3-injection.json', 'd3-sse-frames.json', 'd3-audit.jsonl'],
    结果: 'pass',
  });
  console.log(`  [pass] ${label}`);
}

async function caseD2(ctx, stopCurrentServer) {
  const label = 'E2E-D2 engines 不满足拒载有可见错误';
  await stopCurrentServer();
  const bad = spawnServer(SNAPSHOT_BAD_ENGINES);
  const exitCode = await Promise.race([
    bad.exited,
    new Promise((r) => setTimeout(() => r('timeout'), 20000)),
  ]);
  const stderrText = bad.stderr.join('');
  if (exitCode === 'timeout') {
    bad.child.kill('SIGKILL');
    throw new Error(`${label}：engines 不兼容的坏快照未拒载，server 仍在运行`);
  }
  assert(exitCode === 1, `${label}：拒载应以退出码 1 结束，实际 ${exitCode}`);
  assert(stderrText.includes('快照拒载'), `${label}：stderr 未见拒载错误：${stderrText}`);
  assert(stderrText.includes('g6-explain'), `${label}：拒载错误未定位到具体 pack：${stderrText}`);
  assert(stderrText.includes('engines.contract'), `${label}：拒载错误未指明 engines.contract：${stderrText}`);
  assert(/1\.0\.0/.test(stderrText), `${label}：拒载错误未给出平台契约版本：${stderrText}`);

  // 拒载是整快照 fail-closed：进程不监听 → 客户端明示服务不可用，不静默降级成"仅基座可用"。
  // 断点可能落在下行事件流或上行投递，两条路径的用户可见文案不同，故按闭集匹配。
  const unavailableNotice = /无法连接 zen-agent 服务|事件流重连失败|会话创建失败/;
  const answersBefore = (await panelText(ctx.panel)).split(ANSWER_BILLING).length - 1;
  await sendMessage(ctx.panel, '账单周期是怎么算的？');
  let finalText = '';
  await waitFor(
    async () => {
      finalText = await panelText(ctx.panel);
      return unavailableNotice.test(finalText) ? true : finalText.slice(-120);
    },
    { label: `${label}：等待面板明示服务不可用`, timeoutMs: 25000 },
  );
  const answersAfter = finalText.split(ANSWER_BILLING).length - 1;
  assert(answersAfter === answersBefore, `${label}：坏快照下不应产出新的讲解回答`);

  await ctx.panel.screenshot({ path: evidencePath('e2e-d', 'd2-server-unavailable.png'), fullPage: true });
  writeEvidence('e2e-d', 'd2-server-stderr.txt', stderrText);
  writeEvidence('e2e-d', 'd2-case.json', {
    case: 'E2E-D2',
    title: 'pack v2 载入：engines 不满足拒载有可见错误',
    前置: 'A1/A2/D1/D3 已跑完（本例打掉 server 进程，故置最后）；坏快照 config-bad-engines 的 engines.contract=">=9.0.0"，平台契约版本 1.0.0',
    步骤: ['停好快照 server', '同端口以 config-bad-engines 启动 server', 'Side Panel 再发一条讲解消息'],
    断言: [
      `server 退出码 1；stderr 含「快照拒载」+ pack g6-explain + engines.contract + 平台契约版本（实测：${stderrText.trim().split('\n').at(-1) ?? ''}）`,
      `拒载为整快照 fail-closed：端口无监听，面板明示服务不可用（实测文案：${(finalText.match(unavailableNotice) ?? [''])[0]}），不产出新回答、不静默降级为仅基座可用`,
    ],
    证据: ['d2-server-stderr.txt', 'd2-server-unavailable.png'],
    结果: 'pass',
  });
  console.log(`  [pass] ${label}`);
}

// ---- 主流程 ----

async function main() {
  const cleanups = [];
  let failure = null;
  let server = null;
  try {
    if (process.env.ZA_E2E_SKIP_BUILD === '1') {
      if (!existsSync(SERVER_MAIN)) throw new Error(`ZA_E2E_SKIP_BUILD=1 但 server 未构建：缺 ${SERVER_MAIN}`);
      console.log('[0/5] 跳过构建（ZA_E2E_SKIP_BUILD=1），使用既有产物…');
    } else {
      console.log('[0/5] 构建 server + extension…');
      await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
      await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);
    }
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(SESSION_DIR, { recursive: true });
    mkdirSync(EVIDENCE_ROOT, { recursive: true });

    console.log('[1/5] 起可编程 mock LLM…');
    const mock = await startMockLlm(MOCK_LLM_PORT);
    cleanups.push(() => mock.close());

    console.log('[2/5] 起两站静态夹具（讲解站 4183 / 知识站 4184）…');
    const explainHost = await startStaticHost(EXPLAIN_PORT, 'G6 账单讲解站');
    cleanups.push(() => explainHost.close());
    const knowledgeHost = await startStaticHost(KNOWLEDGE_PORT, 'G6 退款政策知识站');
    cleanups.push(() => knowledgeHost.close());

    console.log('[3/5] 起 server（好快照 config-ok）…');
    server = spawnServer(SNAPSHOT_OK);
    cleanups.push(() => stopServer(server));
    await waitServerReady();

    console.log('[4/5] 启动 Chromium 加载 MV3 extension…');
    let context = null;
    let sw = null;
    for (const headless of [true, false]) {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
      const candidate = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      const page = candidate.pages()[0] ?? (await candidate.newPage());
      await page.goto(BILLING_URL, { waitUntil: 'load' }).catch(() => {});
      sw = candidate.serviceWorkers()[0] ?? (await candidate.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null));
      if (sw !== null) {
        context = candidate;
        console.log(`  扩展已加载（headless=${headless}）`);
        break;
      }
      await candidate.close();
    }
    if (context === null || sw === null) throw new Error('Chromium 无法加载扩展（headless 与 headed 均失败）');
    cleanups.push(() => context.close());

    await sw.evaluate(
      async ([token, base, origins]) => {
        await chrome.storage.local.set({
          'za.token': token,
          'za.serverBaseUrl': base,
          'za.autoActivate': origins,
        });
      },
      [TOKEN, SERVER_BASE, [EXPLAIN_ORIGIN, KNOWLEDGE_ORIGIN]],
    );
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 15000 });

    let sessionId = null;
    await waitFor(
      async () => {
        const starts = readAuditEvents().filter((event) => event.type === 'session-start');
        if (starts.length === 0) return false;
        sessionId = starts.at(-1).sessionId;
        return true;
      },
      { label: '等待插件建立会话（审计 session-start）', timeoutMs: 25000 },
    );
    const sse = await subscribeSse(sessionId);
    cleanups.push(() => sse.close());
    await waitFor(
      async () => {
        const injection = await fetchInjection(sessionId);
        return injection?.featureId === 'billing-guide' ? true : `featureId=${injection?.featureId}`;
      },
      { label: '等待活跃页解析为 billing-guide', timeoutMs: 20000 },
    );

    const ctx = { context, page, panel, sse, mock, sessionId };
    console.log('[5/5] 用例断言：');
    await caseA1(ctx);
    await caseA2(ctx);
    await caseD1(ctx);
    await caseD3(ctx);
    await caseD2(ctx, async () => {
      const current = server;
      server = null;
      await stopServer(current);
    });

    console.log(`\nG6 E2E-A / E2E-D 全部用例通过 ✅（证据：${EVIDENCE_ROOT}）`);
  } catch (error) {
    failure = error;
    console.error(`\nG6 E2E-A / E2E-D 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve().then(cleanup).catch(() => {});
    }
  }
  process.exit(failure === null ? 0 : 1);
}

void main();
