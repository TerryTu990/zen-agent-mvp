/**
 * M5 端到端验证（ADR-013 批次④ 跨站任务组）：真实 Chromium 加载扩展 → 显式会话组 →
 * 跨站导航自动入组 → 任务级授权复用 + 对外发送独立确认 + 越界围栏拒绝，覆盖方案 §六与 §5 的浏览器可观察面。
 *
 * 两站两 pack（独立 registry 夹具 fixtures/m5/config，不污染 host-demo 三套 E2E）：
 *   pack A = host-a  http://127.0.0.1:4173  order-list 页 + order-list.page-operate（dom hitl，含 navigate 能力）
 *   pack B = site-b  http://127.0.0.1:4174  site-b.html 表单 + site-b.page-operate（dom hitl）+ site-b.confirm-submit（dom hitl every-call）
 *
 * 场景链（mock LLM 剧本按哨兵/工具可见性确定性驱动）：
 *   S1 越界：'越界演练' → 快照 → navigate 去无 pack 的 4199 → toolgate fence-violation 拒绝、无新 tab、agent 收 fence 回喂如实告知。
 *   S2 跨站：'跨站演练'（回合①，站点甲）→ 快照 → page-operate 读一格（任务级授权卡，批准）→ 同任务 navigate 去站点乙
 *            （grant 复用、无第二卡）→ 新 tab 自动入 zen 组、面板出现 → 回合①收尾。
 *            回合②（站点乙）→ 快照 → site-b.page-operate 填表（任务级授权卡，批准）→ site-b.confirm-submit
 *            （every-call：即便已有任务级授权仍单独弹卡，批准）→ 提交生效（#sb-result 可见变化）→ 收尾。
 *
 * 断言另含：审计 jsonl 的 assembly/tool-decision/tool-execution 事件带 packId 且出现两个不同 packId（host-a / site-b）；
 * 持久化会话历史含站点边界标记（切到站点乙 origin）。za.autoActivate 只配站点甲，站点乙靠 navigate 入组。
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const HOST_A_DIR = join(REPO_ROOT, 'examples', 'host-demo');
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'e2e', 'fixtures', 'm5');
const HOST_B_DIR = join(FIXTURE_DIR, 'hosts');
const SNAPSHOT_ROOT = join(FIXTURE_DIR, 'config');
const WORK_DIR = join(REPO_ROOT, '.za', 'e2e-m5');
const AUDIT_SINK = join(WORK_DIR, 'events.jsonl');
const SESSION_DIR = join(WORK_DIR, 'sessions');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8797);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_MOCK_PORT ?? 8798);
// 站点端口固定：mock 剧本与 pack.json origin 均硬绑 4173/4174，不经 env 覆盖。
const HOST_A_PORT = 4173;
const HOST_B_PORT = 4174;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_A_ORIGIN = `http://127.0.0.1:${HOST_A_PORT}`;
const HOST_B_ORIGIN = `http://127.0.0.1:${HOST_B_PORT}`;
const ORDER_LIST_URL = `${HOST_A_ORIGIN}/order-list.html`;
const BOUNDARY_MARKER = '【站点边界】';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: 'e2e-user',
      tenant: 'e2e-tenant',
      roles: ['user'],
      hostUserId: 'host-e2e-user',
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/** 纯静态文件服务（两站各一实例，dom 代操作无宿主 API 面）。 */
function startStaticHost(rootDir, port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = decodeURIComponent(url.pathname);
    const filePath = normalize(join(rootDir, path));
    if (!filePath.startsWith(rootDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveHost) => {
    server.listen(port, '127.0.0.1', () => resolveHost({ close: () => new Promise((r) => server.close(() => r())) }));
  });
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

async function buildTargets() {
  await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
  await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);
}

function startServer() {
  const mainJs = join(EXTENSION_DIR, '..', 'server', 'dist', 'main.js');
  if (!existsSync(mainJs)) {
    throw new Error(`server 未构建：缺 ${mainJs}（先 pnpm --filter @zen-agent/server build）`);
  }
  const child = spawn('node', [mainJs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: SNAPSHOT_ROOT,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`,
      ZA_LLM_MODEL: 'mock-model',
      ZA_AUDIT_SINK: AUDIT_SINK,
      ZA_SESSION_DIR: SESSION_DIR,
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
    await new Promise((r) => setTimeout(r, intervalMs));
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

async function waitServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent('serviceworker', { timeout: timeoutMs }).catch(() => null);
}

async function sendMessage(page, text) {
  await page.locator('#za-input').fill(text);
  await page.locator('#za-send').click();
}

async function panelText(page) {
  const locator = page.locator('[data-za-messages]');
  if ((await locator.count()) === 0) return '';
  return (await locator.innerText()).trim();
}

function hitlCardCount(page) {
  return page.locator('[data-za-hitl]').count();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 等待并批准一张 HITL 卡（点击即从 DOM 移除，故批准后卡数回落）。 */
async function approveOneCard(page, label) {
  await waitFor(async () => (await hitlCardCount(page)) > 0, { label, timeoutMs: 20000 });
  await page.locator('[data-za-hitl-approve]').first().click();
}

/** 在浏览器上下文中查找 url 命中子串的页面（跨站导航新开页）。 */
async function findPage(context, urlPart, label) {
  let found = null;
  await waitFor(
    async () => {
      for (const p of context.pages()) {
        if (p.url().includes(urlPart)) {
          found = p;
          return true;
        }
      }
      return false;
    },
    { label, timeoutMs: 20000 },
  );
  return found;
}

/** 审计 jsonl → 事件数组（record-only 旁路，逐行 JSON）。 */
function readAuditEvents() {
  if (!existsSync(AUDIT_SINK)) return [];
  return readFileSync(AUDIT_SINK, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** 持久化会话历史合并文本（跨 pack 边界标记落此）。 */
function readSessionHistory() {
  if (!existsSync(SESSION_DIR)) return '';
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readFileSync(join(SESSION_DIR, f), 'utf8'))
    .join('\n');
}

async function runScenarios(context, packAPage, panelPage) {
  const pageCountBeforeFence = context.pages().length;

  // S1 越界：navigate 目标 origin 不属任何 pack → toolgate fence-violation 拒绝、无新 tab、agent 如实回报。
  await sendMessage(panelPage, '越界演练：尝试跳转到站外地址');
  await waitFor(async () => (await panelText(panelPage)).includes('已阻止跳转'), {
    label: 'S1 越界：等待围栏拒绝回报', timeoutMs: 20000,
  });
  assert((await hitlCardCount(panelPage)) === 0, 'S1 越界：deny 不应弹 HITL 卡');
  assert(context.pages().length === pageCountBeforeFence, 'S1 越界：被拒的 navigate 不应开新 tab');
  console.log('  [pass] S1 越界：fence-violation 拒绝、无新 tab、无 HITL、如实回报');

  // S2 回合①（站点甲）：读一格数据（任务级授权卡）→ 批准 → 同任务 navigate 去站点乙（grant 复用、无第二卡）。
  await sendMessage(panelPage, '跨站演练：读取一格订单数据后前往站点乙提交备注');
  await approveOneCard(panelPage, 'S2 回合①：等待站点甲任务级授权卡');
  const siteBPage = await findPage(context, 'site-b.html', 'S2：等待站点乙页面自动开启');
  await new Promise((r) => setTimeout(r, 300));
  await waitFor(async () => (await panelText(panelPage)).includes('已打开站点乙页面'), {
    label: 'S2 回合①：等待站点甲收尾', timeoutMs: 20000,
  });
  assert((await hitlCardCount(panelPage)) === 0, 'S2 回合①：navigate 为同任务批次，不应弹第二张授权卡');
  console.log('  [pass] S2 回合①：任务级授权一次 → 批准 → navigate 自动执行、新 tab 入组、面板出现');

  // S2 回合②（站点乙）：填表（任务级授权卡）→ 批准 → confirm-submit（every-call 单独弹卡，即便已有任务级授权）→ 批准 → 提交生效。
  await sendMessage(panelPage, '在站点乙填写备注并提交表单');
  await approveOneCard(panelPage, 'S2 回合②：等待站点乙填表授权卡');
  // 填表批次执行后 confirm-submit 独立弹卡：第二次卡出现即证明 every-call 不复用已有任务级授权。
  await approveOneCard(panelPage, 'S2 回合②：等待 confirm-submit 独立确认卡');
  await waitFor(async () => (await panelText(panelPage)).includes('跨站演练完成'), {
    label: 'S2 回合②：等待提交收尾', timeoutMs: 20000,
  });
  const submitted = (await siteBPage.locator('#sb-result').innerText()).trim();
  assert(submitted.includes('已提交：跨站演练备注'), `S2 回合②：站点乙提交应生效，实际 #sb-result="${submitted}"`);
  console.log('  [pass] S2 回合②：填表授权 + confirm-submit 独立确认 → 提交生效（页面可见变化）');

  const outsidePage = await context.newPage();
  await outsidePage.goto(`${HOST_B_ORIGIN}/site-b.html?outside=1`, { waitUntil: 'load' });
  await waitFor(
    async () => (await panelPage.locator('[data-za-context]').getAttribute('data-state')) === 'outside',
    { label: '组外页面提示', timeoutMs: 5000 },
  );
  assert((await outsidePage.locator('#za-root').count()) === 0, '任务组外页面不应注入或获得 Zen UI');
  await outsidePage.close();
  await siteBPage.bringToFront();
  await waitFor(
    async () => (await panelPage.locator('[data-za-context]').getAttribute('data-state')) === 'ready',
    { label: '任务页重新成为权威执行页', timeoutMs: 5000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  console.log('  [pass] 任务组外页面：Side Panel 明示不可执行，页面无注入 UI');

  await sendMessage(panelPage, '停止演练：执行两步页面操作');
  await approveOneCard(panelPage, '停止演练：等待任务授权');
  await panelPage.locator('[data-za-stop]:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });
  await panelPage.locator('[data-za-stop]').click();
  await waitFor(async () => (await panelText(panelPage)).includes('已按用户要求停止'), {
    label: '停止演练：等待停止总结', timeoutMs: 20000,
  });
  await sendMessage(panelPage, '停止演练：停止后重试');
  await waitFor(async () => (await hitlCardCount(panelPage)) > 0, {
    label: '停止演练：等待重新授权', timeoutMs: 20000,
  });
  await panelPage.locator('[data-za-hitl-reject]').click();
  console.log('  [pass] 停止语义：中止余下 DOM 步骤、回传 user-stopped、吊销任务授权，重试重新询问');

  // 审计断言：assembly/tool-decision/tool-execution 均带 packId，且出现两个不同 packId。
  const events = readAuditEvents();
  for (const type of ['assembly', 'tool-decision', 'tool-execution']) {
    assert(
      events.some((e) => e.type === type && typeof e.packId === 'string'),
      `审计：应存在带 packId 的 ${type} 事件`,
    );
  }
  const packIds = new Set(
    events
      .filter((e) => ['assembly', 'tool-decision', 'tool-execution'].includes(e.type) && typeof e.packId === 'string')
      .map((e) => e.packId),
  );
  assert(packIds.has('host-a') && packIds.has('site-b'), `审计：应出现两个不同 packId，实际 ${[...packIds].join(',')}`);
  assert(
    events.some((e) => e.type === 'tool-decision' && e.data?.verdict === 'deny' && e.data?.reason === 'fence-violation'),
    '审计：应存在越界 navigate 的 fence-violation 拒绝决策',
  );
  console.log(`  [pass] 审计：assembly/tool-decision/tool-execution 带 packId，两个 packId=${[...packIds].join(',')}，含 fence-violation 拒绝`);

  // 边界标记断言：跨 pack 切站（甲→乙）向历史注入指向站点乙 origin 的边界标记。
  const history = readSessionHistory();
  assert(history.includes(BOUNDARY_MARKER), '会话历史：应含站点边界标记');
  assert(history.includes(HOST_B_ORIGIN), `会话历史：边界标记应指向站点乙 origin ${HOST_B_ORIGIN}`);
  console.log('  [pass] 会话历史：切到站点乙注入了站点边界标记');
}

async function main() {
  const token = signTestJwt();
  const cleanups = [];
  let failure = null;

  try {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(SESSION_DIR, { recursive: true });

    console.log('[1/5] 构建 extension + server…');
    await buildTargets();

    console.log('[2/5] 起 mock LLM…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());

    console.log('[3/5] 起 server（M5 registry 夹具）…');
    const serverProc = startServer();
    cleanups.push(
      () =>
        new Promise((r) => {
          serverProc.once('exit', () => r());
          serverProc.kill('SIGTERM');
        }),
    );
    await waitServerReady();

    console.log('[4/5] 起两站静态服务（甲 4173 / 乙 4174）…');
    const hostA = await startStaticHost(HOST_A_DIR, HOST_A_PORT);
    cleanups.push(() => hostA.close());
    const hostB = await startStaticHost(HOST_B_DIR, HOST_B_PORT);
    cleanups.push(() => hostB.close());

    console.log('[5/5] 启动 chromium 加载扩展…');
    const userDataDir = join(REPO_ROOT, '.za', 'e2e-profile-m5');
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ];
    let context = null;
    let sw = null;
    for (const headless of [true, false]) {
      await run('rm', ['-rf', userDataDir]).catch(() => {});
      const candidate = await chromium.launchPersistentContext(userDataDir, { headless, args: launchArgs });
      const page = candidate.pages()[0] ?? (await candidate.newPage());
      await page.goto(ORDER_LIST_URL, { waitUntil: 'load' }).catch(() => {});
      sw = await waitServiceWorker(candidate, 8000);
      if (sw) {
        context = candidate;
        console.log(`  扩展已加载（headless=${headless}）`);
        break;
      }
      console.log(`  headless=${headless} 未检测到扩展 service worker，${headless ? '回退 headed…' : '放弃'}`);
      await candidate.close();
    }
    if (!context || !sw) throw new Error('Chromium 无法加载扩展（headless 与 headed 均失败）');
    cleanups.push(() => context.close());

    // za.autoActivate 只配站点甲：站点甲页 reload 后自动激活建组；站点乙由 navigate 入组（不靠 autoActivate）。
    await sw.evaluate(
      async ([t, base, origin]) => {
        await chrome.storage.local.set({
          'za.token': t,
          'za.serverBaseUrl': base,
          'za.autoActivate': [origin],
        });
      },
      [token, SERVER_BASE, HOST_A_ORIGIN],
    );
    const packAPage = context.pages()[0];
    await packAPage.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 400));
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });

    console.log('场景断言：');
    await runScenarios(context, packAPage, panel);

    console.log('\nM5 E2E 全部场景通过 ✅');
  } catch (error) {
    failure = error;
    console.error(`\nM5 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {});
    }
  }
  process.exit(failure ? 1 : 0);
}

main();
