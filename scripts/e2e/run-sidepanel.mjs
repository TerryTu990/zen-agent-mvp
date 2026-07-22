import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_DIR = process.env.ZA_EXTENSION_E2E_DIR
  ? resolve(process.env.ZA_EXTENSION_E2E_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const PROFILE_DIR = join(REPO_ROOT, '.za', 'e2e-profile-sidepanel');
const SCREENSHOT_PATH = join(REPO_ROOT, '.za', 'e2e-sidepanel.png');

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${command} exit ${code}`))));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitServiceWorker(context) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 10000 });
}

async function main() {
  let context;
  let authServer;
  try {
    if (process.env.ZA_EXTENSION_E2E_DIR === undefined) {
      console.log('[1/3] 构建 extension…');
      await run('pnpm', ['--filter', '@zen-agent/extension', 'build']);
    } else {
      console.log(`[1/3] 使用最终 zip 解包目录：${EXTENSION_DIR}`);
    }
    console.log('[2/3] 真实 Chromium 加载 MV3 extension…');
    let sw;
    for (const headless of [true, false]) {
      await run('rm', ['-rf', PROFILE_DIR]);
      const candidate = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      sw = await waitServiceWorker(candidate).catch(() => null);
      if (sw !== null) {
        context = candidate;
        console.log(`  扩展已加载（headless=${headless}）`);
        break;
      }
      await candidate.close();
    }
    if (context === undefined || sw === undefined || sw === null) {
      throw new Error('Chromium 无法加载扩展（headless 与 headed 均失败）');
    }
    const extensionId = new URL(sw.url()).host;
    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    assert(manifest.side_panel?.default_path === 'sidepanel.html', 'manifest 未声明 Side Panel 页面');
    assert(manifest.permissions?.includes('sidePanel'), 'manifest 未声明 sidePanel 权限');

    authServer = createServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end('{"error":"unauthorized-fixture"}');
    });
    await new Promise((resolveListen) => authServer.listen(0, '127.0.0.1', resolveListen));
    const authAddress = authServer.address();
    assert(authAddress !== null && typeof authAddress === 'object', '无法启动鉴权失败夹具');
    await sw.evaluate(async (baseUrl) => {
      await chrome.storage.local.set({ 'za.token': 'e2e-invalid-token', 'za.serverBaseUrl': baseUrl });
    }, `http://127.0.0.1:${authAddress.port}`);

    console.log('[3/3] 打开打包后的 Side Panel 并验证需求入口…');
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 780 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('section[aria-label="Zen Commerce Agent 控制台"]').waitFor();
    assert((await panel.locator('.za-topbar').count()) === 0, 'Side Panel 不应重复渲染 Chrome 原生标题');
    await panel.getByText('没有可恢复的 Zen 任务', { exact: true }).waitFor();
    assert(await panel.getByRole('button', { name: '发送消息' }).isDisabled(), '无任务组时发送入口必须禁用');
    const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    assert(typeof windowId === 'number', '无法识别 Side Panel 所在窗口');
    const panelKey = `za.panelGroup.w${windowId}`;
    await panel.evaluate(({ key }) => chrome.storage.session.set({ [key]: 321 }), { key: panelKey });
    await panel.locator('[data-za-context][data-group-id="321"]').waitFor();
    assert(!(await panel.getByRole('button', { name: '上传知识文档' }).isDisabled()), '迟到任务组未自动绑定');
    await panel.evaluate(({ key }) => chrome.storage.session.set({ [key]: 322 }), { key: panelKey });
    await panel.locator('[data-za-context][data-group-id="322"]').waitFor();
    await panel.getByLabel('执行偏好').selectOption('dom-only');
    assert((await panel.getByLabel('执行偏好').inputValue()) === 'dom-only', '执行偏好入口不可操作');
    await panel.getByLabel('给 Zen 发送消息').fill('中文输入中');
    await panel.getByLabel('给 Zen 发送消息').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '中文输入中', '输入法候选确认不应发送消息');
    const attachmentInput = panel.locator('[data-za-file-input]');
    await attachmentInput.setInputFiles({ name: 'policy.md', mimeType: 'text/markdown', buffer: Buffer.from('# Policy\nRead only') });
    await panel.getByRole('button', { name: '移除附件 policy.md' }).waitFor();
    assert(!(await panel.getByRole('button', { name: '发送消息' }).isDisabled()), '仅附件消息应允许发送');
    await panel.getByLabel('给 Zen 发送消息').fill('检查当前页面，不要执行操作');
    assert(!(await panel.getByRole('button', { name: '发送消息' }).isDisabled()), '文本输入后发送入口未启用');
    await panel.evaluate(() => {
      const observed = { waiting: false, thinking: false };
      Object.assign(globalThis, { __zaObservedComposerState: observed });
      new MutationObserver(() => {
        if (document.querySelector('[data-za-action]')?.getAttribute('aria-label') === '正在处理') observed.waiting = true;
        if (document.querySelector('.za-thinking')?.textContent?.includes('思考中')) observed.thinking = true;
      }).observe(document.body, { attributes: true, childList: true, subtree: true });
    });
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText('访问令牌无效或已过期，请在扩展设置中更新后重试；草稿仍保留', { exact: true }).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '检查当前页面，不要执行操作', '服务端拒绝后文本草稿未保留');
    await panel.getByRole('button', { name: '移除附件 policy.md' }).waitFor();
    const observed = await panel.evaluate(() => globalThis.__zaObservedComposerState);
    assert(observed.waiting, '发送后合并按钮未进入处理中状态');
    assert(observed.thinking, '发送后未即时显示思考中状态');
    await panel.setViewportSize({ width: 280, height: 720 });
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '280px 窄屏出现横向溢出');
    await panel.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('Phase 1A Side Panel E2E 全部场景通过 ✅');
  } catch (error) {
    console.error(`Phase 1A Side Panel E2E 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    if (authServer !== undefined) {
      await new Promise((resolveClose) => authServer.close(() => resolveClose())).catch(() => {});
    }
  }
}

void main();
