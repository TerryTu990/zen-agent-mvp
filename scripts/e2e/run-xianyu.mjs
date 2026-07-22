/**
 * Zen Commerce 闲鱼全链浏览器 E2E：真实 Chromium + MV3 extension + gateway/toolgate，
 * 页面使用 seller.goofish.com HTTPS origin 的受控 route fixture，不接触真实账号或订单。
 */
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const JWT_SECRET = 'xianyu-e2e-jwt-fixture';
const SIGNING_SECRET = 'xianyu-e2e-signing-fixture';
const JWT_ISS = 'zen-agent-demo';
const MOCK_LLM_PORT = process.env.ZA_E2E_XIANYU_MOCK_PORT === undefined
  ? 0
  : Number(process.env.ZA_E2E_XIANYU_MOCK_PORT);
const SELLER_ORIGIN = 'https://seller.goofish.com';
const ORDER_ID = 'order-e2e';
const ITEM_ID = 'item-e2e';
const DIALOG_ORDER_ID = 'order-dialog';
const DIALOG_ITEM_ID = 'item-dialog';
const CARD_CANARY = 'fixture-card-secret-not-real';
const HREF_CANARY = 'href-query-canary';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: 'xianyu-e2e-user', tenant: 'xianyu-e2e', roles: ['ops'], hostUserId: 'seller-e2e',
    iss: JWT_ISS, exp: Math.floor(Date.now() / 1000) + 600,
  }));
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exit ${code}`)));
  });
}

function shippingHtml(orderId, itemId, opensDialog = false) {
  const click = opensDialog
    ? `window.fixtureShipClicks += 1; document.querySelector('#dialog').hidden = false;`
    : `window.fixtureShipClicks += 1; document.querySelector('#ship-status').textContent = '已发货';`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>订单详情</title></head><body>
    <span class="ant-descriptions-item-label">订单编号</span>
    <span class="ant-descriptions-item-content">${orderId}</span>
    <a href="https://www.goofish.com/item?id=${itemId}">受控商品</a>
    <a href="https://example.test/download?token=${HREF_CANARY}">带查询参数的无关链接</a>
    <div class="ant-steps-item"><div id="ship-status" class="ant-steps-item-title">待发货</div></div>
    <button id="ship" type="button">发货</button>
    <div id="dialog" role="dialog" hidden>确认发货</div>
    <script>window.fixtureShipClicks = 0; document.querySelector('#ship').addEventListener('click', () => { ${click} });</script>
  </body></html>`;
}

function chatHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>买家联系</title></head><body>
    <div id="messages"><div class="message-content"><span class="read-status-text">已读</span></div></div>
    <textarea id="message" placeholder="请输入消息，按Enter键发送或点击发送按钮发送"></textarea>
    <button id="send" type="button" disabled>发 送</button>
    <script>
      window.fixtureSendClicks = 0;
      const input = document.querySelector('#message');
      const send = document.querySelector('#send');
      input.addEventListener('input', () => { send.disabled = input.value.length === 0; });
      send.addEventListener('click', () => {
        window.fixtureSendClicks += 1;
        const item = document.createElement('div'); item.className = 'message-content';
        const body = document.createElement('span'); body.className = 'fixture-message-body'; body.textContent = input.value;
        const status = document.createElement('span'); status.className = 'read-status-text'; status.textContent = '未读';
        item.append(body, status); document.querySelector('#messages').append(item);
        input.value = ''; send.disabled = true;
      });
    </script>
  </body></html>`;
}

function fixtureHtml(urlText) {
  const url = new URL(urlText);
  const fixture = url.searchParams.get('fixture');
  // URL fragment 不参与 HTTP 请求；夹具类型必须取自 hash 前的受控查询参数。
  if (fixture === 'chat') return chatHtml();
  if (fixture === 'dialog') return shippingHtml(DIALOG_ORDER_ID, DIALOG_ITEM_ID, true);
  return shippingHtml(ORDER_ID, ITEM_ID, false);
}

function createInventory() {
  const records = new Map();
  const events = [];
  const productFor = (orderId) => orderId === DIALOG_ORDER_ID ? 'product-dialog' : 'product-e2e';
  return {
    events,
    stage(orderId) { return records.get(orderId)?.stage; },
    port: {
      async reserve({ productKey, orderId }) {
        events.push(`reserve:${orderId}`);
        const prior = records.get(orderId);
        if (prior !== undefined) {
          if (prior.productKey !== productKey || prior.stage === 'manual') return { ok: false, error: 'inventory-paused' };
          return {
            ok: true, cardId: prior.cardId, cardSecret: CARD_CANARY, status: 'reserved',
            stage: prior.stage, reused: true,
          };
        }
        if (productKey !== productFor(orderId)) return { ok: false, error: 'inventory-empty' };
        records.set(orderId, { cardId: `card-${orderId}`, productKey, stage: 'reserved' });
        return {
          ok: true, cardId: `card-${orderId}`, cardSecret: CARD_CANARY,
          status: 'reserved', stage: 'reserved', reused: false,
        };
      },
      async beginShipment({ orderId }) {
        events.push(`begin-shipment:${orderId}`);
        const record = records.get(orderId);
        if (record?.stage !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
        record.stage = 'shipping-attempted'; return { ok: true };
      },
      async confirmShipment({ orderId, confirmed }) {
        events.push(`confirm-shipment:${orderId}`);
        const record = records.get(orderId);
        if (record?.stage === 'shipped-confirmed' && confirmed) return { ok: true };
        if (record?.stage !== 'shipping-attempted') return { ok: false, error: 'inventory-invalid-record' };
        record.stage = confirmed ? 'shipped-confirmed' : 'manual'; return { ok: true };
      },
      async beginDelivery({ orderId }) {
        events.push(`begin-delivery:${orderId}`);
        const record = records.get(orderId);
        if (record?.stage !== 'shipped-confirmed') return { ok: false, error: 'inventory-invalid-record' };
        record.stage = 'delivery-attempted'; return { ok: true };
      },
      async settle({ orderId, status }) {
        events.push(`settle-${status}:${orderId}`);
        const record = records.get(orderId);
        if (record === undefined) return { ok: false, error: 'inventory-invalid-record' };
        if (status === 'sent' && record.stage !== 'delivery-attempted') return { ok: false, error: 'inventory-invalid-record' };
        record.stage = status === 'sent' ? 'sent' : 'manual'; return { ok: true };
      },
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`等待超时：${label}`);
}

async function waitServiceWorker(context) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
}

async function panelText(panel) {
  const messages = panel.locator('[data-za-messages]');
  return (await messages.count()) === 0 ? '' : (await messages.innerText());
}

async function sendMessage(panel, text) {
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]').click();
}

async function restartServiceWorker(context, page, scriptUrl, wake) {
  const cdp = await context.newCDPSession(page);
  let versions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => { versions = event.versions; });
  try {
    await cdp.send('ServiceWorker.enable');
    await waitFor(
      () => versions.some((version) => version.scriptURL === scriptUrl && version.runningStatus === 'running'),
      '定位运行中的 MV3 Service Worker',
      5_000,
    );
    const version = versions.find((item) => item.scriptURL === scriptUrl && item.runningStatus === 'running');
    if (version === undefined) throw new Error('未找到可停止的 MV3 Service Worker');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await waitFor(
      () => versions.some((item) => item.scriptURL === scriptUrl && item.runningStatus === 'stopped'),
      'MV3 Service Worker 进入 stopped',
      5_000,
    );
    await wake();
    await waitFor(
      () => versions.some((item) => item.scriptURL === scriptUrl && item.runningStatus === 'running'),
      'MV3 Service Worker 从 stopped 恢复 running',
      10_000,
    );
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function readTree(root) {
  if (!existsSync(root)) return '';
  let output = '';
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output += entry.isDirectory() ? readTree(path) : readFileSync(path, 'utf8');
  }
  return output;
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-commerce-xianyu-e2e-'));
  const sessionDir = join(tempRoot, 'sessions');
  const auditPath = join(tempRoot, 'audit.jsonl');
  const inventory = createInventory();
  const cleanups = [];
  try {
    console.log('[1/5] 构建完整 workspace（含 server 依赖与 extension）…');
    await run('pnpm', ['-r', 'build']);

    console.log('[2/5] 启动 mock LLM 与真实 gateway/toolgate…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());
    process.env.ZA_LLM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.ZA_LLM_MODEL = 'mock-model';
    const { startServer } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/index.js')).href);
    const validUntil = Date.now() + 120_000;
    const policies = [ITEM_ID, DIALOG_ITEM_ID].flatMap((productId) => [
      { id: `shipping-${productId}`, toolId: 'xianyu-shipping.execute-intent' },
      { id: `delivery-${productId}`, toolId: 'xianyu-fulfillment.execute-intent' },
    ].map((entry) => ({
      ...entry, accountId: 'seller-e2e', siteOrigin: SELLER_ORIGIN, productIds: [productId],
      validUntil, maxCodesPerOrder: 1, dailyOrderLimit: 5, dayBoundaryOffsetMinutes: 480,
    })));
    const server = await startServer({
      port: 0, jwtSecret: JWT_SECRET, signingSecret: SIGNING_SECRET, issAllowlist: [JWT_ISS],
      snapshotRoot: join(REPO_ROOT, 'assets'), systemPromptPath: join(REPO_ROOT, 'assets/system-prompt.md'),
      auditSinkPath: auditPath, sessionDir, heartbeatMs: 60_000,
      allowedProviders: ['openai-compatible'],
      cardInventoryPort: inventory.port, cardInventoryGuideUrl: 'https://example.test/guide',
      fulfillmentProductKeys: { [ITEM_ID]: 'product-e2e', [DIALOG_ITEM_ID]: 'product-dialog' },
      fulfillmentPolicies: policies,
    });
    cleanups.push(() => server.close());
    const serverBase = `http://127.0.0.1:${server.port}`;

    console.log('[3/5] 真实 Chromium 加载 MV3 extension 与闲鱼 HTTPS 夹具…');
    let context;
    let sw;
    for (const headless of [true, false]) {
      const profile = join(tempRoot, `profile-${headless}`);
      const candidate = await chromium.launchPersistentContext(profile, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      let selected = false;
      try {
        await candidate.route(`${SELLER_ORIGIN}/**`, (route) => route.fulfill({
          status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml(route.request().url()),
        }));
        const page = candidate.pages()[0] ?? await candidate.newPage();
        await page.goto(`${SELLER_ORIGIN}/?fixture=shipping#/seller-trade/order-manage/order-detail?orderId=${ORDER_ID}`);
        const worker = await waitServiceWorker(candidate);
        if (worker !== null) {
          context = candidate;
          sw = worker;
          selected = true;
          break;
        }
      } finally {
        if (!selected) await candidate.close().catch(() => {});
      }
    }
    if (context === undefined || sw === undefined) throw new Error('Chromium 未加载扩展 service worker');
    cleanups.push(() => context.close());
    const token = signTestJwt();
    await sw.evaluate(async ([authToken, base]) => {
      await chrome.storage.local.set({
        'za.token': authToken, 'za.serverBaseUrl': base,
        'za.autoActivate': ['https://seller.goofish.com'],
      });
    }, [token, serverBase]);
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    const extensionId = new URL(sw.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 10_000 });
    await panel.getByLabel('执行偏好').selectOption('dom-only');

    console.log('[4/5] happy path：发货确认 → 卡密消息回执 → sent…');
    await sendMessage(panel, '执行当前订单自动发货。');
    await waitFor(async () => (await panelText(panel)).includes('已明确变为已发货'), '发货成功总结');
    assert(await page.evaluate(() => window.fixtureShipClicks) === 1, '发货按钮必须恰好点击一次');
    assert(inventory.stage(ORDER_ID) === 'shipped-confirmed', '库存必须推进到 shipped-confirmed');

    // 不可逆边界恢复：发货已经确认、卡密尚未发送时由 Chromium 停止 SW；
    // Side Panel 只恢复连接与观察，不恢复点击。
    const previousWorker = sw;
    await restartServiceWorker(context, page, previousWorker.url(), async () => {
      // 主动重载控制页，触发端口重连并唤醒 worker，不依赖 20 秒 ping 定时器。
      await panel.reload({ waitUntil: 'load' });
    });
    sw = context.serviceWorkers()[0] ?? previousWorker;
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 10_000 });
    assert(await page.evaluate(() => window.fixtureShipClicks) === 1, 'SW 恢复不得重放已确认的发货点击');

    const chatUrl = `${SELLER_ORIGIN}/?fixture=chat#/im?itemId=${ITEM_ID}&orderId=${ORDER_ID}&peerUserId=buyer-e2e`;
    await page.goto(chatUrl, { waitUntil: 'load' });
    await page.locator('#message').waitFor();
    await page.waitForTimeout(300);
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 10_000 });
    await sendMessage(panel, '执行闲鱼自动履约扫描。每轮最多处理一笔。');
    try {
      await waitFor(async () => (await panelText(panel)).includes('页面新回执已确认履约消息送达'), '消息回执成功总结');
    } catch (error) {
      throw new Error(`${error.message}；inventory=${inventory.stage(ORDER_ID) ?? 'none'}；events=${inventory.events.join(',')}`);
    }
    assert(await page.evaluate(() => window.fixtureSendClicks) === 1, '消息发送按钮必须恰好点击一次');
    assert(inventory.stage(ORDER_ID) === 'sent', '库存终态必须为 sent');
    assert((await page.locator('.fixture-message-body').last().textContent())?.includes(CARD_CANARY), '固定卡密正文未进入页面');

    console.log('[5/5] 异常 path：额外确认弹窗且状态不变 → manual、零重试…');
    const dialogUrl = `${SELLER_ORIGIN}/?fixture=dialog#/seller-trade/order-manage/order-detail?orderId=${DIALOG_ORDER_ID}`;
    await page.goto(dialogUrl, { waitUntil: 'load' });
    await page.locator('#ship').waitFor();
    await page.waitForTimeout(300);
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 10_000 });
    await sendMessage(panel, '执行当前订单自动发货。');
    await waitFor(async () => (await panelText(panel)).includes('未能明确确认'), '不明确状态转人工总结');
    const dialogShipClicks = await page.evaluate(() => window.fixtureShipClicks);
    assert(dialogShipClicks === 1, `不明确状态必须点击一次且不得重试（实际 ${dialogShipClicks} 次）`);
    assert(inventory.stage(DIALOG_ORDER_ID) === 'manual', '不明确状态必须转 manual');

    const panelOutput = await panelText(panel);
    const llmRequests = mock.requests.join('\n');
    const persisted = readTree(sessionDir);
    const audit = readFileSync(auditPath, 'utf8');
    for (const [name, text] of [
      ['llm-requests', llmRequests], ['panel', panelOutput], ['sessions', persisted], ['audit', audit],
    ]) {
      assert(!text.includes(CARD_CANARY), `${name} 泄漏卡密 canary`);
      assert(!text.includes(HREF_CANARY), `${name} 泄漏 href query canary`);
    }
    assert(inventory.events.filter((event) => event === `begin-shipment:${DIALOG_ORDER_ID}`).length === 1,
      '不明确订单的 shipping attempt 必须恰好一次');
    console.log('闲鱼 Chromium E2E 全部场景通过 ✅');
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`闲鱼 Chromium E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
