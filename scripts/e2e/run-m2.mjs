/**
 * M2 端到端验证：真实 Chromium 加载扩展 → content/background → server SSE → mock LLM，
 * 覆盖"引导"能力全链路（guide-action 下发 + 宿主页高亮 / 失配降级）。
 *
 * 场景对应关系（evals/scenarios.json guide 维度 → 本脚本场景）：
 *   c 命中  ← m2-guide-01（order-list 问"导出订单在哪里？"：server 注入 built-in guide_highlight →
 *            LLM 产 tool_call → GuideActionFrame 下发 → 宿主页 #btn-export 获 za 高亮 class，
 *            面板 status 含定位文案）
 *   c 失配  ← m2-guide-02（order-list 问"在哪里打印发票？"：facts 无对应锚点，LLM 如实以文本降级、
 *            不产 guide-action —— 无元素获得高亮 class、面板不含成功文案，honest degradation）
 *
 * 与 run-m1 共用环境编排：构建 extension + server → 起 mock LLM(8788) → 起 server(8787,node dist/main.js) →
 *   静态托管 host-demo(4173) → chromium launchPersistentContext 加载扩展（优先 headless、回退 headed）；
 *   node crypto 现签 HS256 测试 JWT，经 service worker 注入 chrome.storage.local。
 *
 * 失配路径说明：order-list 的 facts 恒登记 #btn-export，故"打印发票"这类无登记锚点的定位问句由 LLM
 *   直接以文本降级（mock 产出 MOCK-NO-ANCHOR），不发 GuideActionFrame——page-action 的 DOM 未命中
 *   ("未能…定位") 状态在本场景不可达。E2E 据实断言 honest degradation 的可观察面：无高亮 class +
 *   无"已为你定位"成功文案 + 出现如实文本降级气泡，而非假装高亮。
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

/** page-action.ts 加在宿主页命中元素上的 za 前缀高亮 class（extension 无 @zen-agent 依赖、经手抄镜像）。 */
const HIGHLIGHT_CLASS = 'za-guide-highlight';

const JWT_SECRET = 'za-test-secret';
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

/** 构建 extension + server（M2 gateway 引导接入需最新 dist），供后续 node dist/main.js 与扩展加载。 */
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

async function waitServiceWorker(context, timeoutMs) {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent('serviceworker', { timeout: timeoutMs }).catch(() => null);
}

async function sendMessage(page, text) {
  await page.locator('#za-input').fill(text);
  await page.locator('[data-za-action][data-mode="send"]').click();
}

/** 宿主页（light DOM）当前是否有元素带 za 高亮 class；#btn-export 命中与否是 DOM 事实、非治理判定。 */
function anyHighlighted(page) {
  return page.evaluate((cls) => document.querySelector(`.${cls}`) !== null, HIGHLIGHT_CLASS);
}

function btnExportHighlighted(page) {
  return page.evaluate((cls) => {
    const el = document.querySelector('#btn-export');
    return el !== null && el.classList.contains(cls);
  }, HIGHLIGHT_CLASS);
}

async function panelText(page) {
  const locator = page.locator('[data-za-messages]');
  if ((await locator.count()) === 0) return '';
  return (await locator.innerText()).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runScenarios(hostPage, panelPage) {
  // c 失配（order-list）：facts 无"打印发票"锚点 → LLM 如实文本降级，不假装高亮。
  // 先跑失配再跑命中，避免命中留下的高亮 class 污染"无元素高亮"断言。
  await sendMessage(panelPage, '在哪里打印发票？');
  await waitFor(async () => (await panelText(panelPage)).includes('MOCK-NO-ANCHOR'), {
    label: 'c 失配：等待如实文本降级回复',
    timeoutMs: 15000,
  });
  const missText = await panelText(panelPage);
  assert(!(await anyHighlighted(hostPage)), `场景 c 失配：不应有元素获得高亮 class，面板文本：「${missText}」`);
  assert(!missText.includes('已为你定位'), `场景 c 失配：出现了成功定位文案（假装高亮）：「${missText}」`);
  console.log('  [pass] c 失配：无元素高亮、无成功文案，如实文本降级（MOCK-NO-ANCHOR）');

  // c 命中（order-list，同会话）：注入 guide_highlight → tool_call → GuideActionFrame → #btn-export 高亮。
  await sendMessage(panelPage, '导出订单在哪里？');
  await waitFor(() => btnExportHighlighted(hostPage), {
    label: 'c 命中：等待 #btn-export 获得高亮 class',
    timeoutMs: 15000,
  });
  await waitFor(async () => (await panelText(panelPage)).includes('已为你定位'), {
    label: 'c 命中：等待面板定位文案',
    timeoutMs: 5000,
  });
  const hitText = await panelText(panelPage);
  assert(hitText.includes('导出按钮'), `场景 c 命中：面板 status 缺定位说明，实际：「${hitText}」`);
  console.log(`  [pass] c 命中：#btn-export 已高亮，面板 status 含定位文案`);
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

    console.log('[4/5] 静态托管 host-demo…');
    const host = await startStaticHost();
    cleanups.push(() => host.close());

    console.log('[5/5] 启动 chromium 加载扩展…');
    const userDataDir = join(REPO_ROOT, '.za', 'e2e-profile-m2');
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
    assert((await page.locator('#za-root').count()) === 0, '宿主页面仍注入旧对话抽屉');

    console.log('场景断言：');
    await runScenarios(page, panel);

    console.log('\nM2 E2E 全部场景通过 ✅');
  } catch (error) {
    failure = error;
    console.error(`\nM2 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
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
