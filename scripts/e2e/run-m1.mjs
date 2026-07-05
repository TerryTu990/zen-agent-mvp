/**
 * M1 端到端验证：真实 Chromium 加载扩展 → content/background → server SSE → mock LLM 全链路。
 *
 * 评测集对应关系（evals/scenarios.json → 本脚本场景）：
 *   a 讲解  ← m1-explain-02（order-list "已完成的订单能取消吗？"，断言含"不可取消"、无 MOCK-）
 *   b 换出  ← m1-swap-01 + m1-explain-04（跳 order-detail 问"这个页面显示的是什么？"：
 *            气泡含 订单号/状态/金额；并经独立会话断言 GET /injection 的 featureId
 *            order-list→order-detail、blocks 换出）
 *   e 拒答  ← m1-refusal-01（order-list "今天北京天气怎么样？"，断言含"职责范围/无关"、
 *            无 晴/雨/气温、无 MOCK-BASE-MISSING）
 * 其余 evals 场景（explain-01/03、refusal-02）属离线评测 runner（M4）范围，非本 E2E 冒烟集。
 *
 * 环境编排（谁先谁后）：构建 extension → 起 mock LLM(8788) → 起 server(8787) →
 *   静态托管 host-demo(4173) → chromium launchPersistentContext 加载扩展（优先 headless 新架构，
 *   不支持扩展则回退 headed）；jose 之外用 node crypto 现签 HS256 测试 JWT，经 service worker
 *   target 注入 chrome.storage.local（token + serverBaseUrl）。
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
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const MOCK_LLM_PORT = Number(process.env.ZA_E2E_MOCK_PORT ?? 8788);
const HOST_PORT = Number(process.env.ZA_E2E_HOST_PORT ?? 4173);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const ORDER_LIST_URL = `${HOST_BASE}/order-list.html`;
const ORDER_DETAIL_URL = `${HOST_BASE}/order-detail.html?orderId=ORD-1001`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HS256 现签测试 JWT：claims 过 C2 identity-claims 契约，exp 为 now+10min。 */
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

/** 独立会话直接断言服务端 featureId/注入换出（scenario b 的服务端契约面，与扩展 UI 面互补）。 */
async function assertInjectionSwap(token) {
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
  await page.locator('#za-send').click();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenarios(page) {
  // a 讲解（order-list）
  await sendMessage(page, '已完成的订单能取消吗？');
  const a = await waitAssistantBubble(page, 0, (t) => t.includes('不可取消'));
  assert(!a.includes('MOCK-'), `场景 a 命中 MOCK 兜底：「${a}」`);
  console.log(`  [pass] a 讲解：「${a}」`);

  // e 拒答（order-list，同页复用会话）
  await sendMessage(page, '今天北京天气怎么样？');
  const e = await waitAssistantBubble(page, 1, (t) => t.includes('职责范围') || t.includes('无关'));
  assert(!/[晴雨]|气温/.test(e), `场景 e 泄露天气内容：「${e}」`);
  assert(!e.includes('MOCK-BASE-MISSING'), `场景 e 基座规则缺失（MOCK-BASE-MISSING）：「${e}」`);
  console.log(`  [pass] e 拒答：「${e}」`);

  // b 换出（跳转 order-detail，新会话）
  await page.goto(ORDER_DETAIL_URL, { waitUntil: 'load' });
  await page.locator('#za-input').waitFor({ state: 'visible', timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400)); // 让 context-report 先于 user-message 落到服务端
  await sendMessage(page, '这个页面显示的是什么？');
  const b = await waitAssistantBubble(page, 0, (t) => t.includes('订单号') && t.includes('状态') && t.includes('金额'));
  assert(!b.includes('MOCK-'), `场景 b 命中 MOCK 兜底：「${b}」`);
  console.log(`  [pass] b 换出（UI 面）：「${b}」`);
}

async function main() {
  const token = signTestJwt();
  const cleanups = [];
  let failure = null;

  try {
    console.log('[1/5] 构建 extension…');
    await buildExtension();

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

    console.log('[4/5] 静态托管 host-demo…');
    const host = await startStaticHost();
    cleanups.push(() => host.close());

    console.log('[5/5] 启动 chromium 加载扩展…');
    const userDataDir = join(REPO_ROOT, '.za', 'e2e-profile');
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

    // 经 service worker 注入令牌与服务端地址；za.autoActivate 命中 host origin 使 reload 后自动激活
    // （显式发起模型下 content 不自动连会话，autoActivate 供自动化驱动等价"打开即注入"）。
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
    await page.locator('#za-input').waitFor({ state: 'visible', timeout: 10000 });
    await new Promise((r) => setTimeout(r, 400));

    console.log('场景断言：');
    await runScenarios(page);
    await assertInjectionSwap(token);

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
