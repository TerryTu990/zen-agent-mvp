import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_DIR = process.env.ZA_EXTENSION_E2E_DIR
  ? resolve(process.env.ZA_EXTENSION_E2E_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const PROFILE_DIR = join(REPO_ROOT, '.za', 'e2e-profile-sidepanel');

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

    console.log('[3/3] 打开打包后的 Side Panel 并验证需求入口…');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('section[aria-label="Zen Commerce Agent 控制台"]').waitFor();
    assert((await panel.locator('.za-brand h1').textContent()) === 'Zen Commerce', '生产品牌未切换为 Zen Commerce');
    const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    assert(typeof windowId === 'number', '无法识别 Side Panel 所在窗口');
    const panelKey = `za.panelGroup.w${windowId}`;
    await panel.evaluate(({ key }) => chrome.storage.session.set({ [key]: 321 }), { key: panelKey });
    await panel.locator('[data-za-context][data-group-id="321"]').waitFor();
    assert(!(await panel.getByRole('button', { name: '发送' }).isDisabled()), '迟到任务组未自动绑定');
    await panel.evaluate(({ key }) => chrome.storage.session.set({ [key]: 322 }), { key: panelKey });
    await panel.locator('[data-za-context][data-group-id="322"]').waitFor();
    await panel.getByLabel('执行偏好').selectOption('dom-only');
    assert((await panel.getByLabel('执行偏好').inputValue()) === 'dom-only', '执行偏好入口不可操作');
    assert(!(await panel.getByRole('button', { name: '发送' }).isDisabled()), '切换任务组后发送入口未恢复');
    assert(await panel.getByRole('button', { name: '停止当前操作' }).isDisabled(), '无运行任务时停止按钮必须禁用');
    console.log('Phase 1A Side Panel E2E 全部场景通过 ✅');
  } catch (error) {
    console.error(`Phase 1A Side Panel E2E 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
  }
}

void main();
