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

/** 与插件开发构建的默认服务地址同端口（apps/extension/src/background.ts DEFAULT_SERVER_BASE_URL）。 */
const FIXTURE_PORT = 8787;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitServiceWorker(context) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 10000 });
}

async function main() {
  let context;
  let authServer;
  let nextFrameStatus = 401;
  let holdNextTurn = false;
  let delayNextFrameResponse = false;
  let releaseDelayedFrameResponse = null;
  let delayedFrameStatus = null;
  let sessionSequence = 0;
  const eventStreams = new Map();
  /** 夹具签发过的匿名令牌（形状占位，非真实凭证）：401 前后各一枚，用于核对重试是否换了身份。 */
  const issuedTokens = [];
  const frameRequests = [];
  const stopRequests = [];
  const fixtureActiveTurnIds = new Set();
  let safetyAlertsEmitted = 0;
  try {
    if (process.env.ZA_EXTENSION_E2E_DIR === undefined) {
      console.log('[1/3] 构建 extension…');
      await run('pnpm', ['--filter', '@zen-agent/extension', 'build']);
    } else {
      console.log(`[1/3] 使用最终 zip 解包目录：${EXTENSION_DIR}`);
    }
    // 夹具须先于 Chromium 起、且占用插件开发构建的默认服务地址：面板与 service worker 都按该地址取身份，
    // 夹具不在那里就一律拿不到令牌，401 后的重新激活路径无从观察。
    authServer = createServer(async (req, res) => {
      const headers = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      // 匿名激活（adr-022）：插件零配置自己来换令牌；每次换发新值，401 后的重激活才可辨识。
      if (req.method === 'POST' && req.url === '/v1/activation') {
        const issued = `fixture-${issuedTokens.length + 1}.e2e.stub`;
        issuedTokens.push(issued);
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          token: issued,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          hostUserId: 'anon-sidepanel-e2e-fixture',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/sessions') {
        sessionSequence += 1;
        res.writeHead(201, headers);
        res.end(JSON.stringify({ sessionId: `sidepanel-e2e-${sessionSequence}` }));
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)\/(events|frames)$/.exec(req.url ?? '');
      const stopMatch = /^\/v1\/sessions\/([^/]+)\/stop$/.exec(req.url ?? '');
      if (stopMatch && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        stopRequests.push({ sessionId: stopMatch[1], messageId: request.messageId });
        res.writeHead(202, headers);
        res.end('{"accepted":true}');
        if (fixtureActiveTurnIds.has(request.messageId)) {
          fixtureActiveTurnIds.delete(request.messageId);
          safetyAlertsEmitted += 1;
          eventStreams.get(stopMatch[1])?.write(`data: ${JSON.stringify({
            type: 'hitl-request', sessionId: stopMatch[1], hitlId: 'late-hitl', toolCallId: 'late-tool',
            toolId: 'late-tool', params: {}, reason: '停止后迟到的授权卡',
          })}\n\n`);
          eventStreams.get(stopMatch[1])?.write(`data: ${JSON.stringify({
            type: 'text-delta', sessionId: stopMatch[1], delta: '停止后安全告警测试', priority: 'safety',
          })}\n\n`);
          eventStreams.get(stopMatch[1])?.write(`data: ${JSON.stringify({
            type: 'turn-complete', sessionId: stopMatch[1], messageId: request.messageId, idle: true,
          })}\n\n`);
          releaseDelayedFrameResponse?.();
          releaseDelayedFrameResponse = null;
        }
        return;
      }
      if (match?.[2] === 'events' && req.method === 'GET') {
        const sessionId = match[1];
        res.writeHead(200, {
          ...headers,
          'content-type': 'text/event-stream',
          'x-zen-agent-exec-algorithm': 'Ed25519',
          'x-zen-agent-exec-public-key': 'sidepanel-e2e-public-key',
        });
        res.write(': ping\n\n');
        eventStreams.set(sessionId, res);
        req.on('close', () => eventStreams.delete(sessionId));
        return;
      }
      if (match?.[2] === 'frames' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const frame = JSON.parse(body);
        // 状态注入与位置断言只锚定 user-message；group-pages 等背景簿记帧无回合语义，
        // 比照真实服务端以 204 无内容受理，不消耗注入、不进断言序列。
        if (frame.type !== 'user-message') {
          res.writeHead(204, headers);
          res.end();
          return;
        }
        frameRequests.push({ sessionId: match[1], authorization: req.headers.authorization, messageId: frame.messageId });
        const status = nextFrameStatus;
        nextFrameStatus = 202;
        if (status === 202 && typeof frame.messageId === 'string') fixtureActiveTurnIds.add(frame.messageId);
        if (delayNextFrameResponse) {
          delayNextFrameResponse = false;
          delayedFrameStatus = status;
          await new Promise((resolveDelay) => {
            releaseDelayedFrameResponse = resolveDelay;
          });
        }
        res.writeHead(status, headers);
        res.end(status === 202
          ? '{"accepted":true,"messageState":"pending","idle":false}'
          : status === 409
            ? '{"error":"fixture-interrupted","messageState":"interrupted","idle":true}'
            : JSON.stringify({ error: `fixture-${status}` }));
        if (status === 202 && holdNextTurn) {
          holdNextTurn = false;
          for (let index = 1; index <= 36; index += 1) {
            eventStreams.get(match[1])?.write(`data: ${JSON.stringify({
              type: 'text-delta', sessionId: match[1], delta: `持续回复第 ${index} 行。\n`,
            })}\n\n`);
          }
        } else if (status === 202) {
          eventStreams.get(match[1])?.write(`data: ${JSON.stringify({
            type: 'turn-complete', sessionId: match[1], messageId: frame.messageId, idle: true,
          })}\n\n`);
          fixtureActiveTurnIds.delete(frame.messageId);
        }
        return;
      }
      res.writeHead(404, headers);
      res.end('{"error":"fixture-not-found"}');
    });
    await new Promise((resolveListen) => authServer.listen(FIXTURE_PORT, '127.0.0.1', resolveListen));
    const authAddress = authServer.address();
    assert(authAddress !== null && typeof authAddress === 'object', '无法启动鉴权失败夹具');

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

    // 身份零预置：插件自己完成匿名激活；这里只显式指向夹具（与默认同址，默认值变更时不至于哑连生产）。
    await sw.evaluate(async (baseUrl) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': baseUrl });
    }, `http://127.0.0.1:${authAddress.port}`);

    console.log('[3/3] 打开打包后的 Side Panel 并验证需求入口…');
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 780 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('section[aria-label="Zen Agent 控制台"]').waitFor();
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
    // 文案可能随身份形态改写，故按语义匹配：既要指认身份/令牌失效，又要承诺草稿保留。
    await panel.getByText(/(令牌|身份).*草稿仍保留/).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '检查当前页面，不要执行操作', '服务端拒绝后文本草稿未保留');
    await panel.getByRole('button', { name: '移除附件 policy.md' }).waitFor();
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText('检查当前页面，不要执行操作', { exact: false }).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '', '重新激活后重试未使用新会话');
    assert(issuedTokens.length >= 1, '夹具未收到任何匿名激活请求：插件没有自己取身份');
    assert(frameRequests[1]?.authorization === `Bearer ${issuedTokens.at(-1)}`, '401 后重试未使用重新激活的令牌');
    assert(frameRequests[0]?.authorization !== frameRequests[1]?.authorization, '401 后重试仍复用了被拒的令牌');
    assert(frameRequests[0]?.sessionId !== frameRequests[1]?.sessionId, '重新激活后仍复用了旧 sessionId');
    assert(frameRequests[0]?.messageId === frameRequests[1]?.messageId, '401 重试改变了 messageId，无法保证幂等');
    await panel.getByRole('button', { name: '发送消息' }).waitFor();

    nextFrameStatus = 404;
    await panel.getByLabel('给 Zen 发送消息').fill('验证失效会话恢复');
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText('会话已失效，已准备重新连接，请直接重试；草稿仍保留', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText('验证失效会话恢复', { exact: false }).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '', '404 后直接重试未创建新会话');
    assert(frameRequests[2]?.sessionId !== frameRequests[3]?.sessionId, '404 后仍复用了失效 sessionId');
    assert(frameRequests[2]?.messageId === frameRequests[3]?.messageId, '404 重试改变了 messageId，无法保证幂等');

    nextFrameStatus = 409;
    await panel.getByLabel('给 Zen 发送消息').fill('验证服务重启中断');
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText(/上一回合因服务重启中断.*草稿仍保留/).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '验证服务重启中断', '中断后文本草稿未保留');
    assert(!(await panel.getByRole('button', { name: '发送消息' }).isDisabled()), '中断后编辑器未解锁');
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.getByText('验证服务重启中断', { exact: false }).waitFor();
    assert((await panel.getByLabel('给 Zen 发送消息').inputValue()) === '', '中断后重新提交未成功');
    assert(frameRequests[4]?.messageId !== frameRequests[5]?.messageId, '中断后重新提交没有生成新的 messageId');

    delayNextFrameResponse = true;
    const framesBeforeInflightStop = frameRequests.length;
    await panel.getByLabel('给 Zen 发送消息').fill('验证投递响应返回前立即停止');
    await panel.getByRole('button', { name: '发送消息' }).click();
    for (let attempt = 0; attempt < 50 && frameRequests.length === framesBeforeInflightStop; attempt += 1) {
      await panel.waitForTimeout(10);
    }
    assert(frameRequests.length > framesBeforeInflightStop, '未进入 /frames 已接受但响应未返回的测试窗口');
    await panel.locator('[data-za-action][data-mode="stop"]:not([disabled])').click();
    await panel.getByText('当前任务已停止', { exact: true }).waitFor();
    await panel.waitForTimeout(400);
    assert(safetyAlertsEmitted > 0, `测试夹具未命中服务端已接受但响应未返回的活动回合（status=${delayedFrameStatus}）`);
    const inflightHitlCards = await panel.locator('[data-za-hitl]').allTextContents();
    assert(inflightHitlCards.length === 0, `投递在途时停止仍渲染了迟到 HITL 卡片：${inflightHitlCards.join('|')}`);
    assert((await panel.getByText('停止后安全告警测试', { exact: false }).count()) > 0, '停止期间安全告警被错误过滤');

    await panel.evaluate(() => {
      const original = File.prototype.text;
      Object.assign(globalThis, { __zaOriginalFileText: original });
      File.prototype.text = function delayedText() {
        return new Promise((resolveText) => {
          setTimeout(() => void original.call(this).then(resolveText), 300);
        });
      };
    });
    const framesBeforeGroupSwitch = frameRequests.length;
    await attachmentInput.setInputFiles({
      name: 'group-switch.md', mimeType: 'text/markdown', buffer: Buffer.from('# group switch'),
    });
    await panel.getByLabel('给 Zen 发送消息').fill('验证附件读取期间切换任务组');
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.evaluate(({ key }) => chrome.storage.session.set({ [key]: 323 }), { key: panelKey });
    await panel.locator('[data-za-context][data-group-id="323"]').waitFor();
    await panel.waitForTimeout(400);
    assert(frameRequests.length === framesBeforeGroupSwitch, '附件读取期间切换分组导致跨任务误投');
    await panel.getByRole('button', { name: '移除附件 group-switch.md' }).click();
    await panel.evaluate(() => {
      File.prototype.text = globalThis.__zaOriginalFileText;
    });

    const framesBeforeAttachmentStop = frameRequests.length;
    await panel.evaluate(() => {
      const original = File.prototype.text;
      Object.assign(globalThis, { __zaOriginalFileText: original });
      File.prototype.text = function delayedText() {
        return new Promise((resolveText) => {
          setTimeout(() => void original.call(this).then(resolveText), 300);
        });
      };
    });
    await attachmentInput.setInputFiles({
      name: 'delayed-policy.md', mimeType: 'text/markdown', buffer: Buffer.from('# delayed attachment'),
    });
    await panel.getByLabel('给 Zen 发送消息').fill('验证附件读取期间停止');
    await panel.getByRole('button', { name: '发送消息' }).click();
    await panel.locator('[data-za-action][data-mode="stop"]:not([disabled])').click();
    await panel.getByText('当前任务已停止', { exact: true }).waitFor();
    await panel.waitForTimeout(400);
    assert(frameRequests.length === framesBeforeAttachmentStop, '附件读取期间停止后仍投递了用户消息');
    assert(typeof stopRequests.at(-1)?.messageId === 'string', '附件读取期间停止未绑定预分配消息编号');
    assert((await panel.locator('[data-za-hitl]').count()) === 0, '停止确认后迟到的 HITL 卡片仍被渲染');
    await panel.evaluate(() => {
      File.prototype.text = globalThis.__zaOriginalFileText;
    });

    await panel.setViewportSize({ width: 320, height: 520 });
    const composerBottomBefore = await panel.locator('.za-composer').evaluate((element) => element.getBoundingClientRect().bottom);
    holdNextTurn = true;
    await panel.getByLabel('给 Zen 发送消息').fill('验证停止与自动滚动');
    await panel.getByRole('button', { name: '发送消息' }).click();
    const stopButton = panel.locator('[data-za-action][data-mode="stop"]:not([disabled])');
    await stopButton.waitFor({ state: 'visible' });
    assert(await stopButton.locator('.za-stop-icon').isVisible(), '停止状态未显示图标');
    await panel.getByText('持续回复第 36 行。', { exact: false }).waitFor();
    const scrollState = await panel.locator('[data-za-messages]').evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    assert(scrollState.scrollTop > 0, '长回复没有让消息区向上滚动');
    assert(scrollState.scrollTop + scrollState.clientHeight >= scrollState.scrollHeight - 2, '消息区没有自动滚动到最新回复');
    const composerBottomAfter = await panel.locator('.za-composer').evaluate((element) => element.getBoundingClientRect().bottom);
    assert(Math.abs(composerBottomAfter - composerBottomBefore) < 1, '长回复把底部输入框撑开或推离固定位置');
    await stopButton.click();
    await panel.getByText('当前任务已停止', { exact: true }).waitFor();
    await panel.locator('[data-za-action][data-mode="send"]').waitFor({ state: 'visible' });
    assert(stopRequests.at(-1)?.messageId === frameRequests.at(-1)?.messageId, '停止请求未绑定当前消息编号');
    const observed = await panel.evaluate(() => globalThis.__zaObservedComposerState);
    assert(observed.waiting, '发送后合并按钮未进入处理中状态');
    assert(observed.thinking, '发送后未即时显示思考中状态');
    await panel.setViewportSize({ width: 280, height: 720 });
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '280px 窄屏出现横向溢出');

    // 矮窗：各行最小高度之和一旦超过面板高度，shell 的 overflow:hidden 会把末行整条裁掉——
    // 输入框是唯一入口，被裁即整个面板不可用，故它必须优先于消息区保住可视区。
    await panel.setViewportSize({ width: 320, height: 300 });
    const composerBox = await panel.locator('.za-composer').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: window.innerHeight };
    });
    assert(composerBox.height > 0, '矮窗下输入框被压成零高度');
    assert(
      composerBox.bottom <= composerBox.viewport + 1,
      `矮窗下输入框被挤出可视区（bottom=${Math.round(composerBox.bottom)} > 视口 ${composerBox.viewport}）`,
    );
    assert(
      await panel.getByLabel('给 Zen 发送消息').isVisible(),
      '矮窗下输入框不可见',
    );

    // 贴边观感：输入框外壳与面板底边之间须留出可见留白，不可紧贴。
    await panel.setViewportSize({ width: 360, height: 720 });
    const bottomGap = await panel.locator('.za-composer-surface').evaluate(
      (element) => window.innerHeight - element.getBoundingClientRect().bottom,
    );
    assert(bottomGap >= 10, `输入框离面板底边过近（仅 ${Math.round(bottomGap)}px，应 >= 10px）`);
    assert(bottomGap <= 64, `输入框离面板底边过远（${Math.round(bottomGap)}px，底部留白失衡）`);

    // 免责小字常驻在最底部：位置在输入框之下，且自身与底边同样留白。
    const disclaimer = panel.locator('.za-composer-disclaimer');
    assert(await disclaimer.isVisible(), '底部免责提示未显示');
    assert(
      (await disclaimer.textContent())?.includes('AI 也可能会犯错'),
      '底部免责提示文案不符',
    );
    const disclaimerGap = await disclaimer.evaluate(
      (element) => window.innerHeight - element.getBoundingClientRect().bottom,
    );
    assert(disclaimerGap >= 8, `免责提示贴底（仅 ${Math.round(disclaimerGap)}px）`);
    const surfaceBottom = await panel.locator('.za-composer-surface').evaluate((element) => element.getBoundingClientRect().bottom);
    const disclaimerTop = await disclaimer.evaluate((element) => element.getBoundingClientRect().top);
    assert(disclaimerTop >= surfaceBottom, '免责提示未排在输入框下方');
    await panel.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('Phase 1A Side Panel E2E 全部场景通过 ✅');
  } catch (error) {
    console.error(`Phase 1A Side Panel E2E 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    if (authServer !== undefined) {
      for (const stream of eventStreams.values()) stream.end();
      await new Promise((resolveClose) => authServer.close(() => resolveClose())).catch(() => {});
    }
  }
}

void main();
