/**
 * M3 端到端验证：真实 Chromium 加载扩展 → content/background → server SSE → toolgate → 页面代执行 → 宿主 API，
 * 覆盖"API 调用协助 + HITL"能力全链路（分级判定 / 挂起卡片 / 一次性签名指令 / 页面 fetch / 结果回喂）。
 *
 * 场景（evals/scenarios.json tool/hitl/forbidden 维度 → 本脚本）：
 *   d4 auto      ← 刷新订单列表：refresh-orders(riskTier=auto) 直执，无 HITL 卡片，宿主页 GET /api/orders，
 *                  回喂后气泡"已刷新，当前 2 笔订单"。
 *   d3 forbidden ← 清空所有订单：purge-orders(riskTier=forbidden) 服务端 fail-closed deny，无 HITL、无 exec-instruction、
 *                  宿主 DELETE /api/orders 计数 0，气泡"抱歉，该操作不被允许执行"。
 *   d2 拒绝       ← 取消 ORD-1002：cancel-order(riskTier=hitl) 挂起弹卡 → 点拒绝 → 不下发指令、宿主 /cancel 计数不增、
 *                  气泡"已取消该操作"。
 *   d1 HITL happy ← 取消 ORD-1001：挂起弹卡 → 点确认 → 一次性签名指令下发 → 页面以用户会话 fetch /cancel →
 *                  结果过 resultSchema 回喂 → 气泡"已为你取消订单 ORD-1001"，tool-card 已完成。
 *
 * 另三反例（nonce 重放 / ttl 超时 / invalid-result）在 toolgate 单测 + apps/server 集成测试覆盖（更确定、无需浏览器），
 * 见 evals/runs/2026-07-04-m3.md 分层说明；本脚本覆盖三反例中"拒绝 + forbidden"两个可浏览器观察者。
 *
 * 与 run-m1/m2 共用环境编排，唯一差异：host 服务由纯静态升级为"静态 + 宿主 API mock（带调用计数）"，
 * 且 server 注入 ZA_SIGNING_SECRET（U7 一次性签名前提）。
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const HOST_DEMO_DIR = join(REPO_ROOT, 'examples', 'host-demo');

const JWT_SECRET = 'za-test-secret';
const SIGNING_SECRET = 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_MOCK_PORT ?? 8788);
const HOST_PORT = Number(process.env.ZA_E2E_HOST_PORT ?? 4173);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const ORDER_LIST_URL = `${HOST_BASE}/order-list.html`;

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

function sendApiJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 宿主服务：静态文件 + 宿主 API mock。counts 暴露各端点调用次数供断言（代执行真实发生在页面环境、打到本服务）。
 * cancel 返回 resultSchema 契合的 {ok, orderId}；refresh 返回 {ok, count}；delete（forbidden，永不应被调用）返回 {ok}。
 */
function startHostServer() {
  const counts = { cancel: 0, refresh: 0, purge: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', HOST_BASE);
    const path = decodeURIComponent(url.pathname);

    const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      counts.cancel += 1;
      sendApiJson(res, 200, { ok: true, orderId: cancelMatch[1] });
      return;
    }
    if (req.method === 'GET' && path === '/api/orders') {
      counts.refresh += 1;
      sendApiJson(res, 200, { ok: true, count: 2 });
      return;
    }
    if (req.method === 'DELETE' && path === '/api/orders') {
      counts.purge += 1;
      sendApiJson(res, 200, { ok: true });
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
      ZA_SNAPSHOT_ROOT: join(REPO_ROOT, 'examples', 'host-demo', 'config'),
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

async function runScenarios(hostPage, panelPage, counts) {
  // d4 auto（刷新）：riskTier=auto 直执，无 HITL 卡片，页面 GET /api/orders，回喂后总结。
  await sendMessage(panelPage, '刷新订单列表');
  await waitFor(async () => (await panelText(panelPage)).includes('已刷新，当前 2 笔订单'), {
    label: 'd4 auto：等待刷新总结', timeoutMs: 15000,
  });
  assert((await hitlCardCount(panelPage)) === 0, 'd4 auto：不应出现 HITL 卡片');
  assert(counts.refresh === 1, `d4 auto：GET /api/orders 应恰被调用 1 次，实际 ${counts.refresh}`);
  console.log('  [pass] d4 auto：refresh 直执、无 HITL、页面 fetch 命中、总结正确');

  // d3 forbidden（清空）：服务端 deny，无 HITL、无 exec-instruction，DELETE 计数 0。
  await sendMessage(panelPage, '清空所有订单');
  await waitFor(async () => (await panelText(panelPage)).includes('抱歉，该操作不被允许执行'), {
    label: 'd3 forbidden：等待拒绝文案', timeoutMs: 15000,
  });
  assert((await hitlCardCount(panelPage)) === 0, 'd3 forbidden：不应出现 HITL 卡片');
  assert(counts.purge === 0, `d3 forbidden：DELETE /api/orders 不应被调用，实际 ${counts.purge}`);
  console.log('  [pass] d3 forbidden：fail-closed deny、无 HITL/无 exec、DELETE 计数 0');

  // d2 拒绝（取消 ORD-1002）：hitl 挂起弹卡 → 拒绝 → 不下发指令、/cancel 计数不增。
  await sendMessage(panelPage, '帮我取消订单 ORD-1002');
  await waitFor(async () => (await hitlCardCount(panelPage)) > 0, {
    label: 'd2 拒绝：等待 HITL 卡片', timeoutMs: 15000,
  });
  await panelPage.locator('[data-za-hitl-reject]').click();
  await waitFor(async () => (await panelText(panelPage)).includes('已取消该操作'), {
    label: 'd2 拒绝：等待取消回喂总结', timeoutMs: 15000,
  });
  assert(counts.cancel === 0, `d2 拒绝：/cancel 不应被调用，实际 ${counts.cancel}`);
  assert((await hitlCardCount(panelPage)) === 0, 'd2 拒绝：裁决后卡片应移除');
  console.log('  [pass] d2 拒绝：挂起弹卡 → 拒绝 → 无代执行、/cancel 计数 0');

  // d1 HITL happy（取消 ORD-1001）：挂起弹卡 → 确认 → 一次性签名指令 → 页面 fetch /cancel → 回喂总结。
  await sendMessage(panelPage, '帮我取消订单 ORD-1001');
  await waitFor(async () => (await hitlCardCount(panelPage)) > 0, {
    label: 'd1 happy：等待 HITL 卡片', timeoutMs: 15000,
  });
  await panelPage.locator('[data-za-hitl-approve]').click();
  await waitFor(async () => (await panelText(panelPage)).includes('已为你取消订单 ORD-1001'), {
    label: 'd1 happy：等待取消成功总结', timeoutMs: 15000,
  });
  assert(counts.cancel === 1, `d1 happy：POST /api/orders/ORD-1001/cancel 应恰 1 次，实际 ${counts.cancel}`);
  const finalText = await panelText(panelPage);
  assert(finalText.includes('已完成：'), 'd1 happy：应出现 tool-card 已完成状态');
  console.log('  [pass] d1 HITL happy：确认 → 签名指令 → 页面 fetch /cancel → 结果回喂 → 成功总结');

  await panelPage.getByLabel('执行偏好').selectOption('dom-only');
  await panelPage.reload();
  await panelPage.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });
  await waitFor(async () => (await panelPage.getByLabel('执行偏好').inputValue()) === 'dom-only', {
    label: '执行偏好持久化', timeoutMs: 5000,
  });
  await sendMessage(panelPage, '再次刷新订单列表');
  await waitFor(async () => (await panelText(panelPage)).includes('当前执行偏好下没有可用的刷新工具'), {
    label: 'DOM-only 拦截客户端 API', timeoutMs: 15000,
  });
  assert(counts.refresh === 1, `DOM-only 下客户端 API 不应再次调用，实际 ${counts.refresh}`);
  assert((await hostPage.locator('#za-root').count()) === 0, '宿主页面仍注入旧对话抽屉');
  console.log('  [pass] 执行偏好：持久化、服务端工具面收窄、不可用通道暂停且未静默降级');
}

async function main() {
  const token = signTestJwt();
  const cleanups = [];
  let failure = null;

  try {
    console.log('[1/5] 构建 extension + server…');
    await buildTargets();

    console.log('[2/5] 起 mock LLM…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());

    console.log('[3/5] 起 server…');
    const serverProc = startServer();
    cleanups.push(
      () =>
        new Promise((r) => {
          serverProc.once('exit', () => r());
          serverProc.kill('SIGTERM');
        }),
    );
    await waitServerReady();

    console.log('[4/5] 起 host 服务（静态 + 宿主 API mock）…');
    const host = await startHostServer();
    cleanups.push(() => host.close());

    console.log('[5/5] 启动 chromium 加载扩展…');
    const userDataDir = join(REPO_ROOT, '.za', 'e2e-profile-m3');
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

    // za.autoActivate 命中 host origin 使 reload 后自动激活（显式发起模型下 content 不自动连会话）。
    await sw.evaluate(
      async ([t, base, origin]) => {
        await chrome.storage.local.set({
          'za.token': t,
          'za.serverBaseUrl': base,
          'za.autoActivate': [origin],
        });
      },
      [token, SERVER_BASE, HOST_BASE],
    );
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 400));
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ state: 'visible', timeout: 10000 });

    console.log('场景断言：');
    await runScenarios(page, panel, host.counts);

    console.log('\nM3 E2E 全部场景通过 ✅');
  } catch (error) {
    failure = error;
    console.error(`\nM3 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
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
