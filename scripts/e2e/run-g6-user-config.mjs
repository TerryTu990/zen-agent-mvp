/**
 * G6 E2E-B / E2E-C 浏览器级驱动：真实 Chromium + MV3 extension + 真实 gateway/toolgate/assembly，
 * 以 host-demo 站点包（examples/host-demo/config）与脚本化 mock LLM 驱动 L2 用户配置全链路。
 *
 * E2E-B（L2 全链路，浏览器级）
 *   B1 teach：模型调 config_draft → 面板出 .za-config-card 草稿卡 → 点 .za-config-approve → 服务端落盘 overlay（origin=teach）。
 *   B2 下轮注入：新回合的 system 注入含该规则条目（[id] 正文（来源：对话确认）），注入透明视图 L2 分区出现 user-rules 段且 origin=L2。
 *   B3 配置中心：options 页个人定制页把 order-list.refresh-orders（pack 基线 auto）收紧为 hitl → PUT 落盘 → teach 条目原样保留。
 *   B4 收紧生效：同一工具再次被调用时弹 HITL 确认卡（收紧前同一工具在 M3 既有 E2E 中为直执无卡），确认后经签名指令真实执行一次。
 *
 * E2E-C（治理故障语义，U7 拆分降级）
 *   C1 构造损坏 overlay（新 subject，进程内 lastGood 缓存必空）→ 切 za.token 到该身份 → 新会话。
 *   C2 rules 不可读 → 会话正常纯 L1：讲解回合正常完成，system 注入含 L1 功能规则、无任何 L2 条目。
 *   C3/C4 restrictions 不可读 → 受影响工具拒执行：该工具不在模型工具面；模型幻觉调用被拒、宿主 API 零调用、无 HITL 卡、无代执行。
 *   C5 审计 assembly 事件带 userConfigDegraded=fail-open-closed。
 *
 * 纪律：只读产品源码与 assets/，不修改；LLM 一律 mock（不加载任何 .env）；证据落 evidenceDir 且不含令牌值。
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const HOST_DEMO_DIR = join(REPO_ROOT, 'examples', 'host-demo');
const SNAPSHOT_ROOT = join(HOST_DEMO_DIR, 'config');
const WORK_DIR = join(REPO_ROOT, '.za', 'e2e-g6-user-config');
const PROFILE_DIR = join(WORK_DIR, 'profile');
const AUDIT_SINK = join(WORK_DIR, 'events.jsonl');
const SESSION_DIR = join(WORK_DIR, 'sessions');
const USER_CONFIG_DIR = join(WORK_DIR, 'user-config');

// 本地 harness 的测试签名密钥：每次运行进程内随机生成，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `g6-user-config-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-demo';
const TENANT = 'g6-tenant';
const USER_MAIN = 'g6-host-user';
const USER_DEGRADED = 'g6-degraded-user';

const HOST_PORT = Number(process.env.ZA_E2E_G6_HOST_PORT ?? 4173);
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

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt(hostUserId) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: `${hostUserId}-sub`,
    tenant: TENANT,
    roles: ['user'],
    hostUserId,
    iss: JWT_ISS,
    exp: Math.floor(Date.now() / 1000) + 1800,
  }));
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/**
 * fs UserConfigStore 的 subject 段编码镜像（apps/server/src/user-config-store.ts encodeSegment）。
 * 仅用于 E2E-C 在服务端从未读过该 subject 时预置损坏文件；编码若漂移，C 段的 degraded 断言会直接失败，
 * 不会产生假通过。
 */
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

async function sendMessage(panel, text) {
  await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]').click();
}

async function openInjectionView(panel) {
  const view = panel.locator('[data-za-injection]');
  if (!(await view.isHidden())) await panel.locator('[data-za-injection-toggle]').click();
  await panel.locator('[data-za-injection-toggle]').click();
  await panel.locator('.za-injection-head').waitFor({ state: 'visible', timeout: 20_000 });
  return view;
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

/** 审计片段归档：只留治理相关事件类型，并核验令牌值不在其中（SEC-01/04）。 */
function archiveAudit(caseDir, name, since, tokens) {
  const events = auditLines().slice(since);
  const picked = events.filter((event) => AUDIT_TYPES.has(event.type));
  const text = picked.map((event) => JSON.stringify(event)).join('\n');
  for (const token of tokens) {
    assert(!text.includes(token), `${name} 审计片段泄漏访问令牌值`);
  }
  assert(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), `${name} 审计片段含 JWT 原文`);
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
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
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
      port: 0,
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

    console.log('[4/6] 真实 Chromium 加载 MV3 extension…');
    let context;
    let sw;
    for (const headless of [true, false]) {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
      const candidate = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
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

    const tokenMain = signTestJwt(USER_MAIN);
    const tokenDegraded = signTestJwt(USER_DEGRADED);
    await sw.evaluate(async ([token, base, origin]) => {
      await chrome.storage.local.set({
        'za.token': token,
        'za.serverBaseUrl': base,
        'za.autoActivate': [origin],
      });
    }, [tokenMain, serverBase, HOST_BASE]);
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 400));
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 460, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });

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
    assert(readOverlay(USER_MAIN) === null, '草稿未确认前不得落盘（U8）');
    await panel.screenshot({ path: join(evidenceB, 'b1-config-draft-card.png'), fullPage: true });
    note('B1 teach：config_draft → 草稿卡出现且逐条预览 change；确认前零落盘');

    await card.locator('.za-config-approve').click();
    await waitFor(() => readOverlay(USER_MAIN) !== null, { label: 'B1 overlay 落盘' });
    const overlayAfterTeach = readOverlay(USER_MAIN);
    const teachRule = overlayAfterTeach?.packs?.[PACK_ID]?.rules?.[0];
    assert(teachRule?.text === RULE_TEXT, `落盘规则正文不符：${JSON.stringify(teachRule)}`);
    assert(teachRule?.origin === 'teach', `落盘条目 origin 应为 teach，实际 ${teachRule?.origin}`);
    assert(overlayAfterTeach.subject?.tenant === TENANT && overlayAfterTeach.subject?.hostUserId === USER_MAIN,
      'overlay subject 未由服务端按 claims 推导');
    await waitFor(async () => (await card.getAttribute('data-decided')) === 'accept', { label: 'B1 卡片终态' });
    note('B1 确认：.za-config-approve → 服务端合并落盘（origin=teach、subject 由 claims 推导）');

    // B2 下轮注入含该规则 + 透明视图 origin=L2
    const requestsBeforeB2 = mock.requests.length;
    await sendMessage(panel, '订单列表页能做什么？');
    await waitFor(async () => (await panelText(panel)).includes(EXPLAIN_REPLY), { label: 'B2 讲解回合完成' });
    const b2System = systemTextOf(mock.requests[requestsBeforeB2]);
    assert(b2System.includes(RULE_TEXT), 'B2：下轮 system 注入未含已确认的个人规则');
    assert(b2System.includes(L2_ENTRY_MARKER), 'B2：个人规则注入缺来源标注（来源：对话确认）');
    assert(b2System.includes(teachRule.id), 'B2：个人规则注入缺条目 id（R4 逐条可追溯）');
    note('B2 注入：下轮 system 含该规则条目（带 id 与来源标注）');

    const view = await openInjectionView(panel);
    await view.locator('[data-za-layer="L2"]').waitFor({ state: 'visible', timeout: 20_000 });
    const l2Block = view.locator('[data-za-layer="L2"] [data-za-block-kind="user-rules"]');
    assert((await l2Block.count()) === 1, 'B2：透明视图 L2 分区未出现 user-rules 段');
    const l2BlockText = await l2Block.innerText();
    assert(l2BlockText.includes('L2'), `B2：user-rules 段未标注 origin=L2（实际：${l2BlockText}）`);
    assert(l2BlockText.includes(teachRule.id), 'B2：user-rules 段未标注条目 id');
    assert((await view.locator('.za-injection-revision').innerText()).includes('个人定制版本'),
      'B2：透明视图未呈现本轮定格的个人定制版本');
    await panel.screenshot({ path: join(evidenceB, 'b2-injection-view-l2.png'), fullPage: true });
    note('B2 透明视图：L2 分区呈现 user-rules（origin=L2）+ 定格 revision');
    await panel.locator('[data-za-injection-toggle]').click();

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
    const overlayAfterTighten = readOverlay(USER_MAIN);
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
    note('B4 收紧生效：原 auto 工具改判 hitl → 弹确认卡 → 确认后经签名指令真实执行一次');

    const viewAfter = await openInjectionView(panel);
    const toolRow = viewAfter.locator(`[data-za-tool-id="${TIGHTEN_TOOL}"]`);
    await toolRow.waitFor({ state: 'visible', timeout: 20_000 });
    const toolRowText = await toolRow.innerText();
    assert(toolRowText.includes('自动执行（auto）') && toolRowText.includes('需确认（hitl）'),
      `B4：透明视图未呈现 baseTier→effectiveTier 收紧（实际：${toolRowText}）`);
    assert(toolRowText.includes(`收紧来源：${PACK_ID}`), `B4：透明视图未标注收紧来源（实际：${toolRowText}）`);
    await panel.screenshot({ path: join(evidenceB, 'b4-injection-view-tightened.png'), fullPage: true });
    await panel.locator('[data-za-injection-toggle]').click();
    note('B4 透明视图：工具面呈现 auto→hitl 收紧箭头与收紧来源');

    const auditB = archiveAudit(evidenceB, 'audit-e2e-b.jsonl', auditBaseB, [tokenMain, tokenDegraded]);
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

    // ------------------------------------------------------------ E2E-C
    console.log('[6/6] E2E-C：治理故障语义（overlay 不可读的拆分降级）');
    const auditBaseC = auditLines().length;
    const refreshBeforeC = host.counts.refresh;

    // C1 预置损坏 overlay（该 subject 服务端从未成功读过 → 进程内 lastGood 必空 → read 抛错）
    const degradedPath = overlayPathFor(USER_DEGRADED);
    mkdirSync(join(degradedPath, '..'), { recursive: true });
    writeFileSync(degradedPath, '{ "schemaVersion": 1, "packs": { "host-demo": { "restrictions": ', 'utf8');
    await sw.evaluate(async (token) => {
      await chrome.storage.local.set({ 'za.token': token });
    }, tokenDegraded);
    // 换身份即换会话（background 侦听 za.token 变更后作废旧会话）：宿主页重载使新会话重新拿到页面上下文，
    // 否则新会话 currentUrl 为空、装配回落「仅基座」，L1/L2 两分支都无从观察。
    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));
    await panel.reload({ waitUntil: 'load' });
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 20_000 });

    // C2 rules 不可读 → 会话正常纯 L1
    const requestsBeforeC2 = mock.requests.length;
    await sendMessage(panel, '订单列表页能做什么？');
    await waitFor(async () => (await panelText(panel)).includes(EXPLAIN_REPLY), { label: 'C2 讲解回合正常完成' });
    const c2Request = mock.requests[requestsBeforeC2];
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

    // C5 审计与透明视图
    const auditC = archiveAudit(evidenceC, 'audit-e2e-c.jsonl', auditBaseC, [tokenMain, tokenDegraded]);
    const degradedAssembly = auditC.filter(
      (event) => event.type === 'assembly' && event.data.userConfigDegraded === 'fail-open-closed',
    );
    assert(degradedAssembly.length > 0, 'C5：审计 assembly 事件缺 userConfigDegraded=fail-open-closed');
    assert(degradedAssembly.every((event) => event.data.userConfigRevision === undefined),
      'C5：降级轮不应带 userConfigRevision（无可信定格值）');
    assert(!auditC.some((event) => event.type === 'tool-execution'), 'C5：降级轮不得出现代执行事件');
    note('C5 审计：assembly 带 userConfigDegraded=fail-open-closed、无 revision、无 tool-execution');

    const degradedView = await openInjectionView(panel);
    const degradedViewText = await degradedView.innerText();
    const toolRowsVisible = await degradedView.locator('.za-injection-tool').count();
    await panel.screenshot({ path: join(evidenceC, 'c5-injection-view-degraded.png'), fullPage: true });
    writeEvidence(
      evidenceC,
      'injection-view-degraded.txt',
      `工具行数：${toolRowsVisible}\n含「因存储故障降级收紧」：${degradedViewText.includes('因存储故障降级收紧')}\n---\n${degradedViewText}\n`,
    );
    // 降级轮的透明视图是「compose 真实输出 → 视图」这条接缝的唯一浏览器级守卫：
    // 单测夹具由手写 description 驱动，复现不了服务端降级时的真实形状。
    assert(toolRowsVisible > 0, 'C5：降级轮透明视图无任何工具行——用户看不到 agent 为何不动手');
    assert(degradedViewText.includes('因存储故障降级收紧'),
      'C5：降级轮工具行缺「因存储故障降级收紧」来源标注');
    assert(degradedViewText.includes('个人定制读取失败'), 'C5：降级轮缺顶部降级说明横幅');
    note(`C5 透明视图：降级轮逐条列出工具（${toolRowsVisible} 行）+ 收紧来源标注 + 顶部降级横幅`);

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
