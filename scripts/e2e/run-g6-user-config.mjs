/**
 * G6 E2E-B / E2E-C 浏览器级驱动：真实 Chromium + MV3 extension + 真实 gateway/toolgate/assembly，
 * 以 host-demo 站点包（examples/host-demo/config）与脚本化 mock LLM 驱动 L2 用户配置全链路。
 *
 * E2E-B（L2 全链路，浏览器级）
 *   B1 teach：模型调 config_draft → 面板出 .za-config-card 草稿卡 → 点 .za-config-approve → 服务端落盘 overlay（origin=teach）。
 *   B2 下轮注入：新回合的 system 注入含该规则条目（[id] 正文（来源：对话确认）），注入自省 L2 层出现 user-rules 段且 origin=L2。
 *   B3 配置中心：options 页个人定制页把 order-list.refresh-orders（pack 基线 auto）收紧为 hitl → PUT 落盘 → teach 条目原样保留。
 *   B4 收紧生效：同一工具再次被调用时弹 HITL 确认卡（收紧前同一工具在 M3 既有 E2E 中为直执无卡），确认后经签名指令真实执行一次。
 *
 * E2E-C（治理故障语义，U7 拆分降级）
 *   C1 构造损坏 overlay（新 subject，进程内 lastGood 缓存必空）→ 切 za.installId 到该身份 → 新会话。
 *   C2 rules 不可读 → 会话正常纯 L1：讲解回合正常完成，system 注入含 L1 功能规则、无任何 L2 条目。
 *   C3/C4 restrictions 不可读 → 受影响工具拒执行：该工具不在模型工具面；模型幻觉调用被拒、宿主 API 零调用、无 HITL 卡、无代执行。
 *   C5 审计 assembly 事件带 userConfigDegraded=fail-open-closed。
 *
 * 纪律：只读产品源码与 assets/，不修改；LLM 一律 mock（不加载任何 .env）；证据落 evidenceDir 且不含令牌值。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ANON_TENANT, activate } from './anon-identity.mjs';
import { activateTab, prepareExtensionDir, removeExtensionDir } from './extension-fixture.mjs';
import { hostPortReplacements, materializeSnapshot } from './snapshot-fixture.mjs';
import { assertPortsFree } from './port-guard.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const HOST_DEMO_DIR = join(REPO_ROOT, 'examples', 'host-demo');
const WORK_DIR = join(REPO_ROOT, '.za', 'e2e-g6-user-config');
// host-demo pack 的 site.origin 以 4173 书写：快照按实际 HOST_PORT 物化后再交 server 载入。
const SNAPSHOT_ROOT = join(WORK_DIR, 'config');
const PROFILE_DIR = join(WORK_DIR, 'profile');
const AUDIT_SINK = join(WORK_DIR, 'events.jsonl');
const SESSION_DIR = join(WORK_DIR, 'sessions');
const USER_CONFIG_DIR = join(WORK_DIR, 'user-config');

// 本地 harness 的测试签名密钥：每次运行进程内随机生成，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `g6-user-config-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-anon';
const TENANT = ANON_TENANT;
/** E2E-C 用的第二个匿名身份（换身份 = 换 installId）；现生成，不落仓。 */
const INSTALL_DEGRADED = randomUUID();
/** 主身份的安装 id 由插件自己生成（零预置），运行中从 chrome.storage 读回。 */
let installMain = '';
/** 两个身份的 hostUserId 由服务端激活响应给出（派生权威在服务端）。 */
let userMain = '';
let userDegraded = '';
/** 两个身份各自的匿名令牌：脚本侧直查会话注入自省端点时鉴权用。 */
let tokenMain = '';
let tokenDegraded = '';

const HOST_PORT = Number(process.env.ZA_E2E_G6_HOST_PORT ?? 4173);
/**
 * gateway 必须起在插件开发构建的默认服务地址上（apps/extension/src/background.ts DEFAULT_SERVER_BASE_URL）：
 * service worker 一启动就会做首次匿名激活，此时脚本还来不及下发 za.serverBaseUrl；起在同一地址，
 * 这次预取即直接命中，省掉一轮必然失败的激活（失败退避按服务端地址分账，不会连累别的地址）。
 */
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_G6_MOCK_PORT ?? 8798);
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const ORDER_LIST_URL = `${HOST_BASE}/order-list.html`;

const PACK_ID = 'host-demo';
const TIGHTEN_TOOL = 'order-list.refresh-orders';
/** 基线为 hitl 的工具：用于验证「比基线更宽的档位不可选」——在基线 auto 的工具上该断言恒真。 */
const WIDEN_GUARD_TOOL = 'order-list.cancel-order';
const RULE_TEXT = '刷新订单前先用一句话说明将要做什么。';
const DRAFT_ACK = '好的，我已生成个人配置草稿，请在卡片上确认后保存。';
const REFRESH_DONE = '已刷新，当前 2 笔订单';
const EXPLAIN_REPLY = '订单列表页可查看订单、进入详情、取消未发货订单。';
const L1_MARKER = 'ZA-FEAT-01 讲解以功能事实为准';
const L2_ENTRY_MARKER = '（来源：对话确认）';

const DEFAULT_EVIDENCE_ROOT = join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence');
const AUDIT_TYPES = new Set(['assembly', 'tool-decision', 'hitl-verdict', 'tool-execution', 'user-config-write']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function evidenceRoot() {
  const flag = process.argv.indexOf('--evidence-dir');
  const raw = flag >= 0 ? process.argv[flag + 1] : process.env.ZA_E2E_EVIDENCE_DIR;
  return resolve(raw === undefined || raw === '' ? DEFAULT_EVIDENCE_ROOT : raw);
}

/**
 * fs UserConfigStore 的 subject 段编码镜像（apps/server/src/user-config-store.ts encodeSegment）。
 * 仅用于 E2E-C 在服务端从未读过该 subject 时预置损坏文件；编码若漂移，C 段的 degraded 断言会直接失败，
 * 不会产生假通过。
 */
/** 直写 L2 overlay（PUT /v1/user-config）：配置中心 UI 覆盖不到的字段（站点授权集）由此前置。 */
async function putOverlay(serverBase, token, overlay) {
  const res = await fetch(`${serverBase}/v1/user-config`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(overlay),
  });
  if (!res.ok) throw new Error(`用户配置写入失败：${res.status} ${await res.text()}`);
}

function overlayPathFor(hostUserId) {
  const seg = (value) =>
    `${encodeURIComponent(value).replace(/\*/g, '%2A').replace(/^\.+$/, (dots) => dots.replace(/\./g, '%2E'))}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  return join(USER_CONFIG_DIR, seg(TENANT), `${seg(hostUserId)}.json`);
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 停掉 extension service worker（等价 MV3 空闲回收）：进程内的匿名令牌缓存随之丢失，
 * 下次唤醒才会按新的 za.installId 重新激活——只清 chrome.storage 换不掉已在内存里的旧身份令牌。
 */
async function stopServiceWorker(context, workerUrl) {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  const isRunning = (version) => version.scriptURL === workerUrl && version.runningStatus === 'running';
  await waitFor(() => [...versions.values()].some(isRunning), {
    label: '读取运行中的 service worker 版本', timeoutMs: 10_000,
  });
  const active = [...versions.values()].find(isRunning);
  await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId });
  await waitFor(() => versions.get(active.versionId)?.runningStatus === 'stopped', {
    label: 'service worker 停止', timeoutMs: 10_000,
  });
  await cdp.detach();
}

// ---------------------------------------------------------------- 宿主站点

/** 静态 host-demo + 宿主 API mock：counts 暴露真实代执行落点的调用次数。 */
function startHostServer() {
  const counts = { cancel: 0, refresh: 0, purge: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', HOST_BASE);
    const path = decodeURIComponent(url.pathname);
    const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      counts.cancel += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, orderId: cancelMatch[1] }));
      return;
    }
    if (req.method === 'GET' && path === '/api/orders') {
      counts.refresh += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, count: 2 }));
      return;
    }
    if (req.method === 'DELETE' && path === '/api/orders') {
      counts.purge += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const filePath = normalize(join(HOST_DEMO_DIR, path));
    if (!filePath.startsWith(HOST_DEMO_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveHost) => {
    server.listen(HOST_PORT, '127.0.0.1', () =>
      resolveHost({ counts, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

// ---------------------------------------------------------------- 脚本化 mock LLM

/** 请求 tools 中指定 toolId 的 wire 名（llm-port 出网把点换成 '__'）；不在工具面时返回 null。 */
function wireNameOf(body, toolId) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string' && name.replaceAll('__', '.') === toolId) return name;
  }
  return null;
}

function splitInThree(text) {
  const chars = Array.from(text);
  const step = Math.max(1, Math.ceil(chars.length / 3));
  const parts = [];
  for (let i = 0; i < chars.length; i += step) parts.push(chars.slice(i, i + step).join(''));
  while (parts.length < 3) parts.push('');
  return parts;
}

/**
 * 确定性剧本：回喂轮（末条 role:tool）产总结文本；否则按最后一条 user 关键词产 tool_call。
 * '刷新' 分支恒发 tool_call 且不判工具可见性——E2E-C 借此制造「模型幻觉调用被服务端拒」的可观察面。
 */
function decide(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') {
    const observation = String(last.content ?? '');
    if (observation.includes('pending-decision')) return { text: DRAFT_ACK };
    if (observation.includes('"ok":true')) return { text: REFRESH_DONE };
    return { text: `工具未成功：${observation}` };
  }
  const user = String([...messages].reverse().find((m) => m?.role === 'user')?.content ?? '');
  if (user.includes('记住') && wireNameOf(body, 'config_draft') !== null) {
    return {
      toolCall: {
        id: 'call_config_draft',
        name: wireNameOf(body, 'config_draft'),
        arguments: JSON.stringify({ packId: PACK_ID, rules: [{ text: RULE_TEXT }] }),
      },
    };
  }
  if (user.includes('刷新')) {
    return {
      toolCall: {
        id: 'call_refresh',
        name: wireNameOf(body, TIGHTEN_TOOL) ?? TIGHTEN_TOOL,
        arguments: JSON.stringify({}),
      },
    };
  }
  return { text: EXPLAIN_REPLY };
}

/** OpenAI 兼容 chat completions（仅 stream:true）；requests 只留在测试进程内，不打印不落盘。 */
function startScriptedMockLlm(port) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"invalid json"}}');
        return;
      }
      requests.push(body);
      const decision = decide(body);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-g6-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: typeof body.model === 'string' ? body.model : 'mock-model',
      };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      if (decision.toolCall !== undefined) {
        splitInThree(decision.toolCall.arguments).forEach((args, i) => {
          const call = i === 0
            ? {
                index: 0,
                id: decision.toolCall.id,
                type: 'function',
                function: { name: decision.toolCall.name, arguments: args },
              }
            : { index: 0, function: { arguments: args } };
          send({ index: 0, delta: { tool_calls: [call] }, finish_reason: null });
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        for (const part of splitInThree(decision.text)) {
          send({ index: 0, delta: { content: part }, finish_reason: null });
        }
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      }
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

/** 某次请求的 system 拼接文本（注入构成的模型侧可观察面）。 */
function systemTextOf(request) {
  return (request?.messages ?? [])
    .filter((m) => m?.role === 'system')
    .map((m) => String(m.content ?? ''))
    .join('\n');
}

// ---------------------------------------------------------------- 面板与配置中心操作

async function panelText(panel) {
  const locator = panel.locator('[data-za-messages]');
  return (await locator.count()) === 0 ? '' : (await locator.innerText()).trim();
}

/**
 * 等一轮问答收敛并取回本轮的那次 LLM 请求。判据先看 mock 请求增长再看面板文本：
 * 面板重载会复原历史气泡，同一句回复可能是上一轮留下的——只看文本会在本轮请求尚未到达时就放行，
 * 随后按序号取到 undefined。
 */
async function awaitTurn(panel, mock, since, reply, label) {
  await waitFor(
    async () => mock.requests.length > since && (await panelText(panel)).includes(reply),
    { label },
  );
  return mock.requests[since];
}

async function sendMessage(panel, text) {
  await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]').click();
}

/** 会话注入自省（GET /v1/sessions/:id/injection）：与 compose 同源，是 L2 生效与治理收紧的服务端可观察面。 */
async function fetchInjection(serverBase, sessionId, token) {
  const response = await fetch(`${serverBase}/v1/sessions/${sessionId}/injection`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(response.ok, `注入自省端点 HTTP ${response.status}`);
  return response.json();
}

/** 插件自建会话、脚本不持有其 id：取审计中自 since 以来最近一条 session-start 的 sessionId；尚无新会话即 null。 */
function newSessionIdSince(since) {
  return auditLines().slice(since).findLast((event) => event.type === 'session-start')?.sessionId ?? null;
}

/** 插件自建会话、脚本不持有其 id：取审计中自 since 以来最近一条 assembly 事件的 sessionId。 */
function currentSessionIdSince(since) {
  const assembly = auditLines().slice(since).findLast((event) => event.type === 'assembly');
  assert(assembly !== undefined, '审计缺 assembly 事件，无从定位当前会话');
  return assembly.sessionId;
}

function readOverlay(hostUserId) {
  const path = overlayPathFor(hostUserId);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function auditLines() {
  if (!existsSync(AUDIT_SINK)) return [];
  return readFileSync(AUDIT_SINK, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function writeEvidence(caseDir, name, content) {
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, name), content, 'utf8');
}

/** 审计片段归档：只留治理相关事件类型，并核验安装 id 与令牌原文不在其中（SEC-01/04）。 */
function archiveAudit(caseDir, name, since, installIds) {
  const events = auditLines().slice(since);
  const picked = events.filter((event) => AUDIT_TYPES.has(event.type));
  const text = picked.map((event) => JSON.stringify(event)).join('\n');
  for (const installId of installIds) {
    assert(!text.includes(installId), `${name} 审计片段泄漏安装 id`);
  }
  assert(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), `${name} 审计片段含 JWT 原文`);
  assert(!text.includes(JWT_SECRET) && !text.includes(SIGNING_SECRET), `${name} 审计片段泄漏本地 harness 密钥`);
  writeEvidence(caseDir, name, `${text}\n`);
  return picked;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const evidenceDir = evidenceRoot();
  const evidenceB = join(evidenceDir, 'e2e-b');
  const evidenceC = join(evidenceDir, 'e2e-c');
  const notes = [];
  const cleanups = [];
  let failure = null;

  const note = (line) => {
    notes.push(line);
    console.log(`  [pass] ${line}`);
  };

  try {
    await assertPortsFree([
      { port: SERVER_PORT, label: 'gateway' },
      { port: MOCK_LLM_PORT, label: 'mock LLM' },
      { port: HOST_PORT, label: 'host' },
    ]);
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    materializeSnapshot(join(HOST_DEMO_DIR, 'config'), SNAPSHOT_ROOT, hostPortReplacements([[4173, HOST_PORT]]));
    mkdirSync(evidenceB, { recursive: true });
    mkdirSync(evidenceC, { recursive: true });

    console.log('[1/6] 构建 server 与 extension…');
    await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
    await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);

    console.log('[2/6] 启动脚本化 mock LLM 与宿主站点…');
    const mock = await startScriptedMockLlm(MOCK_LLM_PORT);
    cleanups.push(() => mock.close());
    const host = await startHostServer();
    cleanups.push(() => host.close());

    console.log('[3/6] 进程内启动真实 gateway（含 L2 写入通道）…');
    process.env.ZA_LLM_BASE_URL = `http://127.0.0.1:${MOCK_LLM_PORT}/v1`;
    process.env.ZA_LLM_MODEL = 'mock-model';
    const { startServer } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/index.js')).href);
    const server = await startServer({
      port: SERVER_PORT,
      jwtSecret: JWT_SECRET,
      signingSecret: SIGNING_SECRET,
      issAllowlist: [JWT_ISS],
      snapshotRoot: SNAPSHOT_ROOT,
      systemPromptPath: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      auditSinkPath: AUDIT_SINK,
      sessionDir: SESSION_DIR,
      userConfigDir: USER_CONFIG_DIR,
      allowedProviders: ['openai-compatible'],
      heartbeatMs: 60_000,
    });
    cleanups.push(() => server.close());
    const serverBase = `http://127.0.0.1:${server.port}`;
    // 身份派生以服务端为准：激活只签发、不落盘，故预激活 degraded 身份不会让它进 lastGood 缓存，
    // C1「该 subject 服务端从未成功读过」的前提仍成立。
    ({ hostUserId: userDegraded, token: tokenDegraded } = await activate(serverBase, INSTALL_DEGRADED));

    console.log('[4/6] 真实 Chromium 加载 MV3 extension…');
    let context;
    let sw;
    const loadedExtensionDir = prepareExtensionDir(EXTENSION_DIR);
    cleanups.push(() => removeExtensionDir(loadedExtensionDir));
    for (const headless of [true, false]) {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
      const candidate = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: [`--disable-extensions-except=${loadedExtensionDir}`, `--load-extension=${loadedExtensionDir}`],
      });
      const page = candidate.pages()[0] ?? (await candidate.newPage());
      await page.goto(ORDER_LIST_URL, { waitUntil: 'load' }).catch(() => {});
      const worker = candidate.serviceWorkers()[0]
        ?? (await candidate.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null));
      if (worker !== null && worker !== undefined) {
        context = candidate;
        sw = worker;
        console.log(`  扩展已加载（headless=${headless}）`);
        break;
      }
      await candidate.close();
    }
    if (context === undefined || sw === undefined) throw new Error('Chromium 无法加载扩展');
    cleanups.push(() => context.close());

    // 身份零预置：插件自己生成安装 id 并匿名激活；脚本读回它换算主身份的 subject（overlay 归属键）。
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': base });
    }, serverBase);
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    const orderTabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id ?? null);
    await activateTab(sw, orderTabId);
    await new Promise((r) => setTimeout(r, 400));
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });

    installMain = await sw.evaluate(async () => (await chrome.storage.local.get('za.installId'))['za.installId']);
    assert(typeof installMain === 'string' && installMain !== '', '插件未生成安装 id（匿名自动登录未发生）');
    ({ hostUserId: userMain, token: tokenMain } = await activate(serverBase, installMain));

    // ------------------------------------------------------------ E2E-B
    console.log('[5/6] E2E-B：L2 全链路（teach 草稿 → 确认 → 注入 → 配置中心收紧 → HITL）');
    const auditBaseB = auditLines().length;

    // B1 teach 草稿卡
    await sendMessage(panel, `记住：${RULE_TEXT}`);
    const card = panel.locator('.za-config-card');
    await card.waitFor({ state: 'visible', timeout: 20_000 });
    const cardText = await card.innerText();
    assert(cardText.includes(RULE_TEXT), `草稿卡未逐条预览将写入的规则正文：${cardText}`);
    assert(cardText.includes('对话不会直接修改你的配置'), '草稿卡缺信任 microcopy');
    assert(readOverlay(userMain) === null, '草稿未确认前不得落盘（U8）');
    await panel.screenshot({ path: join(evidenceB, 'b1-config-draft-card.png'), fullPage: true });
    note('B1 teach：config_draft → 草稿卡出现且逐条预览 change；确认前零落盘');

    await card.locator('.za-config-approve').click();
    await waitFor(() => readOverlay(userMain) !== null, { label: 'B1 overlay 落盘' });
    const overlayAfterTeach = readOverlay(userMain);
    const teachRule = overlayAfterTeach?.packs?.[PACK_ID]?.rules?.[0];
    assert(teachRule?.text === RULE_TEXT, `落盘规则正文不符：${JSON.stringify(teachRule)}`);
    assert(teachRule?.origin === 'teach', `落盘条目 origin 应为 teach，实际 ${teachRule?.origin}`);
    assert(overlayAfterTeach.subject?.tenant === TENANT && overlayAfterTeach.subject?.hostUserId === userMain,
      'overlay subject 未由服务端按 claims 推导');
    await waitFor(async () => (await card.getAttribute('data-decided')) === 'accept', { label: 'B1 卡片终态' });
    note('B1 确认：.za-config-approve → 服务端合并落盘（origin=teach、subject 由 claims 推导）');

    // B2 下轮注入含该规则 + 注入自省 origin=L2
    const requestsBeforeB2 = mock.requests.length;
    await sendMessage(panel, '订单列表页能做什么？');
    const b2System = systemTextOf(
      await awaitTurn(panel, mock, requestsBeforeB2, EXPLAIN_REPLY, 'B2 讲解回合完成'),
    );
    assert(b2System.includes(RULE_TEXT), 'B2：下轮 system 注入未含已确认的个人规则');
    assert(b2System.includes(L2_ENTRY_MARKER), 'B2：个人规则注入缺来源标注（来源：对话确认）');
    assert(b2System.includes(teachRule.id), 'B2：个人规则注入缺条目 id（R4 逐条可追溯）');
    note('B2 注入：下轮 system 含该规则条目（带 id 与来源标注）');

    const b2Injection = await fetchInjection(serverBase, currentSessionIdSince(auditBaseB), tokenMain);
    const l2Blocks = b2Injection.blocks.filter((block) => block.origin === 'L2' && block.kind === 'user-rules');
    assert(l2Blocks.length === 1, `B2：注入自省 L2 层未出现 user-rules 段（实际：${JSON.stringify(b2Injection.blocks)}）`);
    assert(l2Blocks[0].id === teachRule.id, `B2：user-rules 段未标注条目 id（实际：${JSON.stringify(l2Blocks[0])}）`);
    assert(typeof b2Injection.userConfigRevision === 'string' && b2Injection.userConfigRevision !== '',
      'B2：注入自省未呈现本轮定格的个人定制版本');
    writeEvidence(evidenceB, 'b2-injection.json', `${JSON.stringify(b2Injection, null, 2)}\n`);
    note('B2 注入自省：L2 层呈现 user-rules（origin=L2、带条目 id）+ 定格 revision');

    // B3 配置中心收紧 auto → hitl
    const options = await context.newPage();
    await options.setViewportSize({ width: 1100, height: 900 });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('[data-za-tab="overlay"]').click();
    const tierSelect = options.locator(`[data-za-panel="overlay"] select[data-za-tool-id="${TIGHTEN_TOOL}"]`);
    await tierSelect.waitFor({ state: 'visible', timeout: 20_000 });
    const baseCell = options.locator(`[data-za-panel="overlay"] tr[data-za-tool-id="${TIGHTEN_TOOL}"] .za-cc-tool-base`);
    assert((await baseCell.innerText()).includes('auto'), 'B3：目标工具的站点包基线不是 auto，收紧用例前提不成立');
    assert(await tierSelect.locator('option[value="auto"]').isEnabled(), 'B3：基线 auto 档位应可选');
    // R1 只收紧：比基线更宽的档位必须不可选。用基线 hitl 的工具验证——
    // 在基线 auto 的工具上「auto 可选」恒真，证不出任何收紧约束。
    const hitlBaselineSelect = options.locator(
      `[data-za-panel="overlay"] select[data-za-tool-id="${WIDEN_GUARD_TOOL}"]`,
    );
    await hitlBaselineSelect.waitFor({ state: 'visible', timeout: 20_000 });
    assert(await hitlBaselineSelect.locator('option[value="auto"]').isDisabled(),
      `B3：基线 hitl 的 ${WIDEN_GUARD_TOOL} 竟可放宽为 auto——R1 只收紧被破坏`);
    assert(await hitlBaselineSelect.locator('option[value="forbidden"]').isEnabled(),
      'B3：比基线更严的 forbidden 档位应可选');
    const teachRuleRow = options.locator(`[data-za-panel="overlay"] [data-za-rule-id="${teachRule.id}"]`);
    assert((await teachRuleRow.count()) === 1, 'B3：配置中心未呈现 teach 沉淀的规则条目');
    assert((await teachRuleRow.innerText()).includes('对话沉淀'), 'B3：teach 条目缺来源标注');
    await tierSelect.selectOption('hitl');
    await options.getByRole('button', { name: '保存', exact: true }).click();
    await waitFor(async () => (await options.locator('.za-cc-status').innerText()).trim() === '已保存',
      { label: 'B3 配置中心保存成功' });
    await options.screenshot({ path: join(evidenceB, 'b3-config-center-tighten.png'), fullPage: true });
    const overlayAfterTighten = readOverlay(userMain);
    assert(overlayAfterTighten?.packs?.[PACK_ID]?.restrictions?.riskTierRaise?.[TIGHTEN_TOOL] === 'hitl',
      `B3：收紧未落盘：${JSON.stringify(overlayAfterTighten?.packs?.[PACK_ID]?.restrictions)}`);
    const preservedRule = overlayAfterTighten?.packs?.[PACK_ID]?.rules?.find((r) => r.id === teachRule.id);
    assert(preservedRule?.origin === 'teach', 'B3：面板整份提交后 teach 条目未原样保留');
    note('B3 配置中心：auto→hitl 收紧落盘、teach 条目原样保留、比基线更宽的档位不可选（基线 hitl 的工具上 auto 为 disabled）');

    // B4 收紧生效 → HITL 卡
    assert(host.counts.refresh === 0, 'B4 前提：宿主刷新接口应尚未被调用');
    await sendMessage(panel, '刷新订单列表');
    const hitl = panel.locator('[data-za-hitl]');
    await hitl.waitFor({ state: 'visible', timeout: 20_000 });
    assert(host.counts.refresh === 0, 'B4：HITL 挂起期间不得已执行');
    await panel.screenshot({ path: join(evidenceB, 'b4-hitl-card-after-tighten.png'), fullPage: true });
    await panel.locator('[data-za-hitl-approve]').click();
    await waitFor(async () => (await panelText(panel)).includes(REFRESH_DONE), { label: 'B4 确认后执行完成' });
    assert(host.counts.refresh === 1, `B4：宿主刷新接口应恰调用一次，实际 ${host.counts.refresh}`);
    const doneCards = panel.locator('[data-za-toolcard][data-status="succeeded"]');
    await waitFor(async () => (await doneCards.count()) > 0, { label: 'B4 执行卡呈现' });
    const doneCardText = await doneCards.last().innerText();
    assert(doneCardText.trim() !== '', 'B4：执行卡是空壳，用户看不到这一步做了什么');
    note('B4 收紧生效：原 auto 工具改判 hitl → 弹确认卡 → 确认后经签名指令真实执行一次，面板留下 succeeded 执行卡');

    const b4Injection = await fetchInjection(serverBase, currentSessionIdSince(auditBaseB), tokenMain);
    const tightened = (b4Injection.tools ?? []).find((tool) => tool.toolId === TIGHTEN_TOOL);
    assert(tightened !== undefined, `B4：注入自省工具面缺 ${TIGHTEN_TOOL}（实际：${JSON.stringify(b4Injection.tools)}）`);
    assert(tightened.baseTier === 'auto' && tightened.effectiveTier === 'hitl',
      `B4：注入自省未呈现 baseTier→effectiveTier 收紧（实际：${JSON.stringify(tightened)}）`);
    assert(tightened.tightenedBy === PACK_ID, `B4：注入自省未标注收紧来源（实际：${JSON.stringify(tightened)}）`);
    writeEvidence(evidenceB, 'b4-injection.json', `${JSON.stringify(b4Injection, null, 2)}\n`);
    note('B4 注入自省：工具面呈现 auto→hitl 收紧与收紧来源');

    const auditB = archiveAudit(evidenceB, 'audit-e2e-b.jsonl', auditBaseB, [installMain, INSTALL_DEGRADED]);
    const writeEvents = auditB.filter((event) => event.type === 'user-config-write');
    assert(writeEvents.some((event) => event.data.origin === 'teach'), 'B：审计缺 origin=teach 的写入事件');
    assert(writeEvents.some((event) => event.data.origin === 'panel'), 'B：审计缺 origin=panel 的写入事件');
    const decisionEvents = auditB.filter(
      (event) => event.type === 'tool-decision' && event.data.toolId === TIGHTEN_TOOL,
    );
    assert(decisionEvents.length === 1 && decisionEvents[0].data.verdict === 'hitl',
      `B：审计中该工具的裁决应为 hitl，实际 ${JSON.stringify(decisionEvents.map((e) => e.data.verdict))}`);
    assert(decisionEvents[0].data.riskTier === 'auto' && decisionEvents[0].data.effectiveTier === 'hitl',
      `B：审计未自证 auto→hitl 收紧：${JSON.stringify(decisionEvents[0].data)}`);
    assert(auditB.some((event) => event.type === 'assembly' && typeof event.data.userConfigRevision === 'string'),
      'B：审计 assembly 事件缺 userConfigRevision 定格');
    note('B 审计：teach/panel 两路写入事件 + 该工具 tool-decision=hitl + assembly 带 userConfigRevision');
    await options.close();

    // B5 站点授权集 → 本机常驻注册面（adr-027 轨二）。
    // 注册失败在产品里是静默的（background 对 registerContentScripts 的 rejection 只 catch 不报），
    // 描述符形状一旦不被真实 chrome.scripting 接受，单测的假 chrome 照样全绿——故该往返只能在浏览器里判。
    const grantedRegistrations = async () =>
      sw.evaluate(async (pattern) => {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        return scripts
          .filter((item) => (item.matches ?? []).includes(pattern))
          .map((item) => ({ id: item.id, js: item.js }));
      }, `${HOST_BASE}/*`);
    // 镜像刷新只由身份/服务端地址变更与 SW 启动触发：改完 L2 得推一次，否则等的是下次冷启。
    const pokeUserConfigMirrors = async () => {
      await sw.evaluate(async (base) => {
        await chrome.storage.local.remove('za.serverBaseUrl');
        await chrome.storage.local.set({ 'za.serverBaseUrl': base });
      }, serverBase);
    };
    assert((await grantedRegistrations()).length === 0, 'B5 前提：该 origin 尚未授权时不应有常驻注册项');
    await putOverlay(serverBase, tokenMain, {
      ...overlayAfterTighten,
      packs: { ...overlayAfterTighten.packs, '*': { grantedOrigins: [HOST_BASE] } },
    });
    await pokeUserConfigMirrors();
    await waitFor(async () => (await grantedRegistrations()).length > 0,
      { label: 'B5 已授权 origin 进入常驻注册面' });
    const [registration] = await grantedRegistrations();
    assert(Array.isArray(registration.js) && registration.js.includes('dist/content.js'),
      `B5：常驻注册载荷必须是插件自带产物，实际 ${JSON.stringify(registration.js)}`);
    await putOverlay(serverBase, tokenMain, overlayAfterTighten);
    await pokeUserConfigMirrors();
    await waitFor(async () => (await grantedRegistrations()).length === 0,
      { label: 'B5 撤销授权后常驻注册项被清掉' });
    note('B5 站点授权集：L2 声明该 origin → 真实 chrome.scripting 注册常驻注入项（载荷为插件自带 dist/content.js）；L2 移除即对称注销');

    // ------------------------------------------------------------ E2E-C
    console.log('[6/6] E2E-C：治理故障语义（overlay 不可读的拆分降级）');
    const auditBaseC = auditLines().length;
    const refreshBeforeC = host.counts.refresh;

    // C1 预置损坏 overlay（该 subject 服务端从未成功读过 → 进程内 lastGood 必空 → read 抛错）
    const degradedPath = overlayPathFor(userDegraded);
    mkdirSync(join(degradedPath, '..'), { recursive: true });
    writeFileSync(degradedPath, '{ "schemaVersion": 1, "packs": { "host-demo": { "restrictions": ', 'utf8');
    // 换身份 = 换 installId：除落盘的缓存令牌外，还要重启 extension 丢掉 service worker 进程内的
    // 令牌缓存——否则插件仍拿旧身份的令牌开会话，C 段就换不到「服务端从未读过」的新 subject。
    await sw.evaluate(async (installId) => {
      await chrome.storage.local.remove('za.anonToken');
      await chrome.storage.local.set({ 'za.installId': installId });
    }, INSTALL_DEGRADED);
    await stopServiceWorker(context, sw.url());
    // 换身份即换会话（background 侦听 za.installId 变更后作废旧会话）：宿主页重载使新会话重新拿到页面上下文，
    // 否则新会话 currentUrl 为空、装配回落「仅基座」，L1/L2 两分支都无从观察。
    await page.reload({ waitUntil: 'load' });
    // 「新会话已拿到页面上下文」是可观察的：注入自省（面板「本页生效」块的同一取数口径）在 context-report
    // 落地前报仅基座、落地后报出本页 pack。等这个信号而不是等一段时长——后者与页面重载耗时赛跑。
    await waitFor(
      async () => {
        const sessionId = newSessionIdSince(auditBaseC);
        if (sessionId === null) return false;
        return (await fetchInjection(serverBase, sessionId, tokenDegraded)).packId === PACK_ID;
      },
      { label: 'C 段新会话拿到页面上下文（注入自省报出本页 pack）' },
    );
    await panel.reload({ waitUntil: 'load' });
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });

    // C2 rules 不可读 → 会话正常纯 L1
    const requestsBeforeC2 = mock.requests.length;
    await sendMessage(panel, '订单列表页能做什么？');
    const c2Request = await awaitTurn(panel, mock, requestsBeforeC2, EXPLAIN_REPLY, 'C2 讲解回合正常完成');
    const c2System = systemTextOf(c2Request);
    assert(c2System.includes(L1_MARKER), 'C2：L1 功能规则未注入（rules 读失败应 fail-open 纯 L1）');
    assert(!c2System.includes(L2_ENTRY_MARKER), 'C2：降级轮不应出现任何 L2 条目');
    assert(!c2System.includes(RULE_TEXT), 'C2：降级轮混入了其它 subject 的个人规则');
    note('C2 rules 不可读：会话正常完成，system 注入纯 L1（无任何 L2 条目）');

    // C3 restrictions 不可读 → 工具面不再向模型开放
    assert(wireNameOf(c2Request, TIGHTEN_TOOL) === null,
      'C3：降级轮不应向模型开放受影响工具（治理面 fail-closed）');
    note('C3 restrictions 不可读：受影响工具不在模型工具面（治理面 fail-closed，不放宽）');

    // C4 幻觉调用被拒 → 零执行
    await sendMessage(panel, '刷新订单列表');
    await waitFor(async () => (await panelText(panel)).includes('该操作暂未支持'), { label: 'C4 拒执行回执' });
    await new Promise((r) => setTimeout(r, 500));
    assert(host.counts.refresh === refreshBeforeC, `C4：降级轮不得真实执行（refresh ${refreshBeforeC} → ${host.counts.refresh}）`);
    assert((await panel.locator('[data-za-hitl]').count()) === 0, 'C4：降级轮不得弹 HITL 确认卡');
    await panel.screenshot({ path: join(evidenceC, 'c4-tool-refused.png'), fullPage: true });
    note('C4 受影响工具拒执行：模型幻觉调用被拒、宿主接口零调用、无 HITL 卡');

    // C5 审计与注入自省
    const auditC = archiveAudit(evidenceC, 'audit-e2e-c.jsonl', auditBaseC, [installMain, INSTALL_DEGRADED]);
    const degradedAssembly = auditC.filter(
      (event) => event.type === 'assembly' && event.data.userConfigDegraded === 'fail-open-closed',
    );
    assert(degradedAssembly.length > 0, 'C5：审计 assembly 事件缺 userConfigDegraded=fail-open-closed');
    assert(degradedAssembly.every((event) => event.data.userConfigRevision === undefined),
      'C5：降级轮不应带 userConfigRevision（无可信定格值）');
    assert(!auditC.some((event) => event.type === 'tool-execution'), 'C5：降级轮不得出现代执行事件');
    note('C5 审计：assembly 带 userConfigDegraded=fail-open-closed、无 revision、无 tool-execution');

    const degradedInjection = await fetchInjection(serverBase, currentSessionIdSince(auditBaseC), tokenDegraded);
    const degradedTools = degradedInjection.tools ?? [];
    writeEvidence(evidenceC, 'c5-injection-degraded.json', `${JSON.stringify(degradedInjection, null, 2)}\n`);
    // 降级轮的注入自省是「compose 真实输出 → 自省」这条接缝的唯一端到端守卫：
    // 单测夹具由手写 description 驱动，复现不了服务端降级时的真实形状。
    assert(degradedTools.length > 0, 'C5：降级轮注入自省无任何工具条目——用户看不到 agent 为何不动手');
    assert(degradedTools.every((tool) => tool.tightenedBy === 'storage-failure' && tool.effectiveTier === 'forbidden'),
      `C5：降级轮工具条目未全部标注 storage-failure 收紧至 forbidden（实际：${JSON.stringify(degradedTools)}）`);
    assert(degradedInjection.userConfigRevision === undefined, 'C5：降级轮不应带 userConfigRevision（无可信定格值）');
    note(`C5 注入自省：降级轮逐条列出工具（${degradedTools.length} 项）+ storage-failure 收紧来源、无 revision`);

    writeEvidence(evidenceB, 'assertions.log', `${notes.filter((n) => n.startsWith('B')).join('\n')}\n`);
    writeEvidence(evidenceC, 'assertions.log', `${notes.filter((n) => n.startsWith('C')).join('\n')}\n`);
    console.log('\nG6 E2E-B / E2E-C 全部断言通过 ✅');
    console.log(`证据目录：${evidenceB}  ${evidenceC}`);
  } catch (error) {
    failure = error;
    console.error(`\nG6 E2E-B/C 失败：${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve().then(cleanup).catch(() => {});
    }
  }
  process.exit(failure ? 1 : 0);
}

void main();
