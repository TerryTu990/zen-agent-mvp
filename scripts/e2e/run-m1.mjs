/**
 * M1 端到端验证：真实 Chromium 加载扩展 → content/background → server SSE → mock LLM 全链路。
 *
 * 评测集对应关系（evals/scenarios.json → 本脚本场景）：
 *   a 讲解  ← m1-explain-02（order-list "已完成的订单能取消吗？"，断言含"不可取消"、无 MOCK-）
 *   b 换出  ← m1-swap-01 + m1-explain-04（跳 order-detail 问"这个页面显示的是什么？"：
 *            气泡含 订单号/状态/金额；并经独立会话断言 GET /injection 的 featureId
 *            order-list→order-detail、blocks 换出）
 *   e 通用问答  ← 基座通用化后（2026-09-03，470d3a9）站点无关问题不再拒答而是直接应答：
 *            order-list 页问 "今天北京天气怎么样？"，断言命中 mock 的通用问答哨兵
 *            MOCK-GENERAL-QA-HIT（该哨兵由 mock 在 system 含基座字面「通用助手」时产出，
 *            故它同时证明基座已随装配到达模型；缺失时 mock 回 MOCK-BASE-MISSING，断言即红）。
 * 其余 evals 场景属离线评测 runner 范围，非本 E2E 冒烟集。
 *
 * 环境编排（谁先谁后）：构建 extension → 起 mock LLM(8788) → 起 server(8787) →
 *   静态托管 host-demo(4173) → chromium launchPersistentContext 加载扩展（优先 headless 新架构，
 *   不支持扩展则回退 headed）；身份零预置——插件自己匿名激活，脚本只经 service worker target
 *   注入 chrome.storage.local 的 serverBaseUrl，再以 activateTab 复现图标手势（见 extension-fixture）。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { activate } from './anon-identity.mjs';
import { activateTab, assertNoZenInjection, prepareExtensionDir, removeExtensionDir } from './extension-fixture.mjs';
import { hostPortReplacements, materializeSnapshot } from './snapshot-fixture.mjs';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const HOST_DEMO_DIR = join(REPO_ROOT, 'examples', 'host-demo');

const JWT_SECRET = 'za-test-secret';
const JWT_ISS = 'zen-agent-anon';
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_MOCK_PORT ?? 8788);
const HOST_PORT = Number(process.env.ZA_E2E_HOST_PORT ?? 4173);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
// host-demo pack 的 site.origin 以 4173 书写：快照按实际 HOST_PORT 物化后再交 server 载入。
const SNAPSHOT_ROOT = join(REPO_ROOT, '.za', 'e2e-snapshot-m1');
const ORDER_LIST_URL = `${HOST_BASE}/order-list.html`;
const ORDER_DETAIL_URL = `${HOST_BASE}/order-detail.html?orderId=ORD-1001`;
/** 第三方站点（端口不同即不同 origin）：用户从未在其上发起动作，也从未授权它。 */
const STRANGER_PORT = HOST_PORT + 1;
const STRANGER_URL = `http://127.0.0.1:${STRANGER_PORT}/index.html`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function startStaticHost() {
  const server = createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', HOST_BASE).pathname;
    const filePath = normalize(join(HOST_DEMO_DIR, decodeURIComponent(urlPath)));
    if (!filePath.startsWith(HOST_DEMO_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveHost) => {
    server.listen(HOST_PORT, '127.0.0.1', () =>
      resolveHost({ close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}

/** 第三方站点的最小静态服务：只回一张与 zen 无关的页面，供不变量 IN 的反例断言使用。 */
function startStrangerHost() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end('<!doctype html><meta charset="utf-8"><title>第三方站点</title><main id="stranger">与 zen 无关的页面</main>');
  });
  return new Promise((resolveHost) => {
    server.listen(STRANGER_PORT, '127.0.0.1', () =>
      resolveHost({
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
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

async function buildExtension() {
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
      ZA_SIGNING_SECRET: 'za-test-signing-secret',
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: SNAPSHOT_ROOT,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`,
      ZA_LLM_MODEL: 'mock-model',
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

/** 独立会话直接断言服务端 featureId/注入换出（scenario b 的服务端契约面，与扩展 UI 面互补）。 */
async function assertInjectionSwap() {
  const { token } = await activate(SERVER_BASE, randomUUID());
  const authJson = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sid = created.sessionId;
  const report = (url) =>
    fetch(`${SERVER_BASE}/v1/sessions/${sid}/frames`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ type: 'context-report', sessionId: sid, url }),
    });
  const injection = () => fetch(`${SERVER_BASE}/v1/sessions/${sid}/injection`, { headers: auth }).then((r) => r.json());

  await report(ORDER_LIST_URL);
  const before = await injection();
  await report(ORDER_DETAIL_URL);
  const after = await injection();

  if (before.featureId !== 'order-list') throw new Error(`换出前 featureId 期望 order-list，实际 ${before.featureId}`);
  if (after.featureId !== 'order-detail') throw new Error(`换出后 featureId 期望 order-detail，实际 ${after.featureId}`);
  if (JSON.stringify(before.blocks) === JSON.stringify(after.blocks)) {
    throw new Error('换出后 injection blocks 未变化，功能块未换出');
  }
  console.log('  [pass] 服务端注入换出：order-list → order-detail，blocks 已换出');
}

async function waitServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent('serviceworker', { timeout: timeoutMs }).catch(() => null);
}

async function restartServiceWorker(context, worker, panelPage) {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  await waitFor(
    () => [...versions.values()].some((item) => item.scriptURL === worker.url() && item.runningStatus === 'running'),
    { label: '读取运行中的 service worker 版本', timeoutMs: 5000 },
  );
  const active = [...versions.values()].find(
    (item) => item.scriptURL === worker.url() && item.runningStatus === 'running',
  );
  if (!active) throw new Error('未找到运行中的 extension service worker 版本');
  await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId });
  await waitFor(
    () => versions.get(active.versionId)?.runningStatus === 'stopped',
    { label: 'service worker 停止', timeoutMs: 5000 },
  );
  await panelPage.reload();
  await waitFor(
    () => versions.get(active.versionId)?.runningStatus === 'running',
    { label: 'service worker 重启', timeoutMs: 10000 },
  );
}

/** 取当前页第 index 个 assistant 气泡文本，轮询至 predicate 命中；超时抛出并附实际文本。 */
async function waitAssistantBubble(page, index, predicate, { timeoutMs = 15000 } = {}) {
  const locator = page.locator('.za-msg[data-role="assistant"]').nth(index);
  const deadline = Date.now() + timeoutMs;
  let text = '';
  for (;;) {
    try {
      if ((await locator.count()) > 0) {
        text = (await locator.innerText()).trim();
        if (predicate(text)) return text;
      }
    } catch {
      /* 导航瞬间 DOM 重建，忽略后重试 */
    }
    if (Date.now() > deadline) {
      throw new Error(`assistant 气泡[${index}]未达预期，实际文本：「${text}」`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function sendMessage(page, text) {
  await page.locator('#za-input').fill(text);
  await page.locator('[data-za-action][data-mode="send"]').click();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenarios(context, worker, extensionId, hostPage, panelPage) {
  // a 讲解（order-list）
  await sendMessage(panelPage, '已完成的订单能取消吗？');
  const a = await waitAssistantBubble(panelPage, 0, (t) => t.includes('不可取消'));
  assert(!a.includes('MOCK-'), `场景 a 命中 MOCK 兜底：「${a}」`);
  console.log(`  [pass] a 讲解：「${a}」`);

  await panelPage.close();
  panelPage = await context.newPage();
  await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panelPage.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });
  const restored = await waitAssistantBubble(panelPage, 0, (t) => t.includes('不可取消'));
  assert(restored === a, 'Side Panel 重开后首轮对话未原样恢复');
  console.log('  [pass] Side Panel 重开：对话恢复且未重复');

  await restartServiceWorker(context, worker, panelPage);
  await panelPage.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });
  await waitAssistantBubble(panelPage, 0, (t) => t.includes('不可取消'));
  assert((await panelPage.locator('.za-msg[data-role="assistant"]').count()) === 1, 'SW 重启后对话重复');
  console.log('  [pass] service worker 重启：同一会话恢复且对话未重复');

  // e 通用问答（order-list，同页复用会话）：基座通用化后站点无关问题直接应答
  await sendMessage(panelPage, '今天北京天气怎么样？');
  const e = await waitAssistantBubble(panelPage, 1, (t) => t.includes('MOCK-GENERAL-QA-HIT'));
  assert(!e.includes('MOCK-BASE-MISSING'), `场景 e 基座未随装配到达模型（MOCK-BASE-MISSING）：「${e}」`);
  console.log(`  [pass] e 通用问答：「${e}」`);

  // b 换出（宿主页跳转，Side Panel 会话保持）
  await hostPage.goto(ORDER_DETAIL_URL, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 400)); // 让 context-report 先于 user-message 落到服务端
  await sendMessage(panelPage, '这个页面显示的是什么？');
  const b = await waitAssistantBubble(panelPage, 2, (t) => t.includes('订单号') && t.includes('状态') && t.includes('金额'));
  assert(!b.includes('MOCK-'), `场景 b 命中 MOCK 兜底：「${b}」`);
  console.log(`  [pass] b 换出（UI 面）：「${b}」`);
}

async function main() {
  const cleanups = [];
  let failure = null;

  try {
    console.log('[1/5] 构建 extension…');
    await buildExtension();

    console.log('[2/5] 起 mock LLM…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());

    console.log('[3/5] 起 server…');
    rmSync(SNAPSHOT_ROOT, { recursive: true, force: true });
    materializeSnapshot(join(REPO_ROOT, 'examples', 'host-demo', 'config'), SNAPSHOT_ROOT, hostPortReplacements([[4173, HOST_PORT]]));
    const serverProc = startServer();
    cleanups.push(
      () =>
        new Promise((r) => {
          serverProc.once('exit', () => r());
          serverProc.kill('SIGTERM');
        }),
    );
    await waitServerReady();

    console.log('[4/5] 静态托管 host-demo…');
    const host = await startStaticHost();
    cleanups.push(() => host.close());
    // 与 host-demo 同时起：cleanups 逆序执行，晚起的先关；第三方站点若关在浏览器之前，
    // 会卡在浏览器尚未释放的 keep-alive 连接上。
    const stranger = await startStrangerHost();
    cleanups.push(() => stranger.close());

    console.log('[5/5] 启动 chromium 加载扩展…');
    const userDataDir = join(REPO_ROOT, '.za', 'e2e-profile');
    const loadedExtensionDir = prepareExtensionDir(EXTENSION_DIR);
    cleanups.push(() => removeExtensionDir(loadedExtensionDir));
    const launchArgs = [
      `--disable-extensions-except=${loadedExtensionDir}`,
      `--load-extension=${loadedExtensionDir}`,
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

    // 身份零预置：插件首次用到时自己完成匿名激活。经 service worker 只注入服务端地址。
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': base });
    }, SERVER_BASE);
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    // 按需注入：脚本不再随页面常驻，由图标手势的自动化等价把它放进这一页。
    const orderTabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id ?? null);
    await activateTab(sw, orderTabId);
    await new Promise((r) => setTimeout(r, 400));
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });
    assert((await page.locator('#za-root').count()) === 0, '宿主页面仍注入旧对话抽屉');

    console.log('场景断言：');
    await runScenarios(context, sw, extensionId, page, panel);
    await assertInjectionSwap();

    // 不变量 IN 的反例：用户没对这一页发起任何动作，也没授权它的 origin——页面上不该有任何注入痕迹。
    console.log('  · 未打开面板的第三方页面上 document 无 zen 注入痕迹');
    const strangerPage = await context.newPage();
    await strangerPage.goto(STRANGER_URL, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));
    const strangerTabId = await sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => (tab.url ?? '') === url)?.id ?? null;
    }, STRANGER_URL);
    assert(typeof strangerTabId === 'number', '未找到第三方页标签');
    await assertNoZenInjection(sw, strangerPage, strangerTabId);
    await strangerPage.close();

    console.log('\nM1 E2E 全部场景通过 ✅');
  } catch (error) {
    failure = error;
    console.error(`\nM1 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
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
