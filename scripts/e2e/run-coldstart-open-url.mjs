/**
 * 空白组冷启动 open_url E2E：真实 Chromium + MV3 extension + 真实 gateway 子进程 + 脚本化 mock LLM。
 * 会话组内只有一个静默页（chrome://newtab，无 content script 成员），服务端以
 * ZA_GENERIC_ALLOWLIST='*' 启动——静默页冷启动保持仅基座装配、只注入 open_url。
 *
 * 组的建立：Playwright 无法点真实工具栏图标，此处在 service worker 里复刻 handleIconClick 的
 * 可观察产物（tabs.group 建组 + za.zenGroup / za.panelGroup 登记），面板经既有 storage 绑定路径
 * 接入同一组（与 run-sidepanel.mjs 的迟到任务组绑定同口径）。
 *
 * mock LLM 不走 scripts/mock-llm 共享 mock：其 open_url 剧本以 ZA-FEAT-10 marker 门控，
 * 而静默页冷启动是仅基座 sys、无 marker，故内置专用脚本（与 apps/server/test/generic.test.ts
 * 的 startScriptedOpenUrlMock 同口径）：首轮见 open_url 工具即产出调用，回喂轮按 observation 总结。
 *
 * 判定：
 *  ① 首轮送达 LLM 的工具面含 open_url、不含 generic pack 工具（仅基座 + 冷启动注入门）；
 *  ② 面板出现 open_url 的 HITL 确认卡，且卡出现时目标页尚未打开（确认先于执行）；
 *  ③ 批准后 background 直执行 navigate：目标页新开且入本会话组；
 *  ④ agent 收到成功回喂：mock 收到含 {url} 的 observation，面板出现导航成功总结；
 *  ⑤ 落点后装配切到该站：injection 视图变为 generic-web/browse；面板常驻同组、可继续输入；
 *  ⑥ 审计链：tool-decision(open_url, hitl) → hitl-verdict(approve) → tool-execution(ok) 且授权先于执行。
 *
 * 运行：node scripts/e2e/run-coldstart-open-url.mjs（ZA_E2E_SKIP_BUILD=1 复用既有构建产物）
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { activate } from './anon-identity.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = process.env.ZA_E2E_EXTENSION_DIR
  ? resolve(process.env.ZA_E2E_EXTENSION_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const SERVER_MAIN = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence', 'coldstart-open-url'),
);

// 本地 harness 的测试签名密钥：只用于签本进程内的测试 JWT / 代执行 HMAC，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `coldstart-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-anon';
/**
 * gateway 必须起在插件开发构建的默认服务地址上（apps/extension/src/background.ts DEFAULT_SERVER_BASE_URL）：
 * service worker 一启动就会做首次匿名激活，起在同一地址可让这次预取直接命中。
 */
const SERVER_PORT = 8787;
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';
  for (;;) {
    const result = await predicate();
    if (result === true) return;
    if (typeof result === 'string') lastDetail = result;
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}${lastDetail === '' ? '' : `（最后观察：${lastDetail}）`}`);
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
}

/** 被打开的目标站：本地静态页，titles/body 带哨兵便于取证。 */
function startTargetSite() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>冷启动落点站</title></head>' +
        '<body><h1 id="landing">冷启动 open_url 落点页</h1></body></html>',
    );
  });
  return new Promise((resolveSite) => {
    server.listen(0, '127.0.0.1', () => {
      resolveSite({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function splitInThree(text) {
  const chars = Array.from(text);
  const step = Math.ceil(chars.length / 3);
  const parts = [];
  for (let i = 0; i < chars.length; i += step) parts.push(chars.slice(i, i + step).join(''));
  while (parts.length < 3) parts.push('');
  return parts;
}

/**
 * 冷启动专用脚本化 mock LLM（OpenAI chat completions 兼容，仅 stream:true）：
 * 首轮（尾部非 role:tool）用户说「打开 <url>」且工具面含 open_url → 产出 open_url 调用；
 * 工具面缺 open_url 时产出 MOCK- 哨兵（注入缺失即机械可检）；回喂轮按 observation 总结。
 */
function startScriptedLlm(targetUrl, successReply) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const last = messages[messages.length - 1];
      const obs = last?.role === 'tool' ? String(last.content ?? '') : null;
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      const user = String(lastUser?.content ?? '');
      const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '');
      requests.push({ user, obs, toolNames });

      let decision;
      if (obs !== null) {
        if (obs.includes('"url"')) decision = { text: successReply };
        else if (obs.includes('user-rejected')) decision = { text: '已取消打开该页面。' };
        else decision = { text: `MOCK-OPEN-OBS ${obs}` };
      } else if (user.includes('打开') && toolNames.includes('open_url')) {
        decision = {
          toolCall: {
            id: 'call_coldstart_open_url',
            name: 'open_url',
            arguments: JSON.stringify({
              url: targetUrl,
              task: '打开用户指定的本地测试站',
              reason: '当前没有可操作页面，需要先打开目标站点',
            }),
          },
        };
      } else if (user.includes('打开')) {
        decision = { text: 'MOCK-OPEN-URL-MISSING' };
      } else {
        decision = { text: 'MOCK-DEFAULT' };
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-coldstart',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
      if (decision.toolCall) {
        splitInThree(decision.toolCall.arguments).forEach((fragment, index) => {
          const tc =
            index === 0
              ? {
                  index: 0,
                  id: decision.toolCall.id,
                  type: 'function',
                  function: { name: decision.toolCall.name, arguments: fragment },
                }
              : { index: 0, function: { arguments: fragment } };
          send({ index: 0, delta: { tool_calls: [tc] }, finish_reason: null });
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
    server.listen(0, '127.0.0.1', () => {
      resolveMock({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 真实 gateway 子进程：静默页冷启动的准入名单经进程 env 下发（ZA_GENERIC_ALLOWLIST 含字面 '*'）。 */
function spawnServer({ llmPort, auditPath, stateRoot }) {
  const child = spawn('node', [SERVER_MAIN], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: join(REPO_ROOT, 'assets'),
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      ZA_LLM_MODEL: 'mock-model',
      ZA_AUDIT_SINK: auditPath,
      ZA_SESSION_DIR: join(stateRoot, 'sessions'),
      ZA_USER_CONFIG_DIR: join(stateRoot, 'user-config'),
      ZA_APPLICATIONS_DIR: join(stateRoot, 'applications'),
      ZA_GENERIC_ALLOWLIST: '*',
    },
  });
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return {
    kill: () => {
      child.kill('SIGTERM');
      return exited;
    },
  };
}

function auditEvents(auditPath) {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-coldstart-e2e-'));
  const auditPath = join(tempRoot, 'audit.jsonl');
  const cleanups = [];
  let panel;
  let installId = '';
  rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  try {
    if (process.env.ZA_E2E_SKIP_BUILD === '1') {
      if (!existsSync(SERVER_MAIN)) throw new Error(`ZA_E2E_SKIP_BUILD=1 但 server 未构建：缺 ${SERVER_MAIN}`);
      console.log('[1/6] 跳过构建（ZA_E2E_SKIP_BUILD=1），使用既有产物…');
    } else {
      console.log('[1/6] 构建 server + extension…');
      await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
      await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);
    }

    console.log('[2/6] 起目标站夹具、脚本化 mock LLM 与真实 gateway（ZA_GENERIC_ALLOWLIST=*）…');
    const site = await startTargetSite();
    cleanups.push(() => site.close());
    const targetUrl = `${site.origin}/landing`;
    const successReply = `已打开 ${targetUrl}，可以继续在新页面上操作。`;
    const mock = await startScriptedLlm(targetUrl, successReply);
    cleanups.push(() => mock.close());
    const server = spawnServer({ llmPort: mock.port, auditPath, stateRoot: tempRoot });
    cleanups.push(() => server.kill());
    await waitFor(
      async () => {
        try {
          return (await fetch(`${SERVER_BASE}/healthz`)).status === 200;
        } catch {
          return false;
        }
      },
      'server 就绪',
      25_000,
    );

    console.log('[3/6] 真实 Chromium 加载 MV3 extension…');
    let context;
    let sw;
    for (const headless of [true, false]) {
      const profile = join(tempRoot, `profile-${headless}`);
      const candidate = await chromium.launchPersistentContext(profile, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      sw =
        candidate.serviceWorkers()[0] ??
        (await candidate.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null));
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
    cleanups.push(() => context.close());
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': base });
    }, SERVER_BASE);
    const extensionId = new URL(sw.url()).host;

    console.log('[4/6] 建立空白会话组（新标签页入组，无 content 成员）并打开面板…');
    // 图标点击建组无法在 Playwright 内自动化：在 SW 里复刻 handleIconClick 的可观察产物
    // （建组 + zenGroup/panelGroup 登记）；chrome://newtab 无 content script，组内零可代执行成员。
    const group = await sw.evaluate(async () => {
      const tab = await chrome.tabs.create({ active: true });
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: 'Zen', color: 'purple' }).catch(() => {});
      await chrome.storage.session.set({
        ['za.zenGroup.g' + groupId]: true,
        ['za.panelGroup.w' + tab.windowId]: groupId,
      });
      return { groupId, windowId: tab.windowId, tabUrl: tab.pendingUrl ?? tab.url ?? '' };
    });
    assert(typeof group.groupId === 'number', '未能建立会话组');
    assert(!/^https?:/.test(group.tabUrl), `组内唯一成员应为静默页，实际 ${group.tabUrl}`);

    panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator(`[data-za-context][data-group-id="${group.groupId}"]`).waitFor({ timeout: 15_000 });
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });

    console.log('[5/6] 冷启动指令 → open_url HITL 卡 → 批准 → background 直执行 navigate…');
    await panel.locator('#za-input').fill(`请帮我打开 ${targetUrl}`);
    await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').click();

    const hitlCard = panel.locator('[data-za-hitl]').last();
    await hitlCard.waitFor({ timeout: 60_000 });
    // 卡片正文仅呈现 params.task（mock 固定值）；目标 URL 归属由批准后目标页 origin 检查与回喂 observation 的 targetUrl 间接覆盖。
    const hitlText = await hitlCard.innerText();
    assert(hitlText.includes('打开用户指定的本地测试站'), `HITL 卡未呈现导航任务：${hitlText}`);
    // 确认先于执行：卡片出现时目标页必须尚未打开。
    const tabsBeforeApprove = await sw.evaluate(
      async (origin) => (await chrome.tabs.query({})).filter((t) => (t.url ?? '').startsWith(origin)).length,
      site.origin,
    );
    assert(tabsBeforeApprove === 0, 'HITL 批准前目标页已被打开（确认未先于执行）');
    const firstRequest = mock.requests[0];
    assert(firstRequest !== undefined, 'mock LLM 未收到首轮请求');
    assert(firstRequest.toolNames.includes('open_url'), `首轮工具面缺 open_url：${firstRequest.toolNames}`);
    assert(
      !firstRequest.toolNames.includes('browse__page-operate'),
      `静默页冷启动应保持仅基座，首轮却出现 generic pack 工具：${firstRequest.toolNames}`,
    );
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'hitl-card.png'), fullPage: true });
    await hitlCard.locator('[data-za-hitl-approve]').click();

    await waitFor(
      async () => {
        const tabs = await sw.evaluate(
          async (origin) =>
            (await chrome.tabs.query({})).map((t) => ({ url: t.url ?? '', groupId: t.groupId })).filter((t) => t.url.startsWith(origin)),
          site.origin,
        );
        if (tabs.length === 0) return '目标页未打开';
        return tabs[0].groupId === group.groupId ? true : `目标页 groupId=${tabs[0].groupId}`;
      },
      '目标页新开且入本会话组',
      30_000,
    );

    await waitFor(
      async () => {
        const text = await panel.locator('[data-za-messages]').innerText();
        if (text.includes('MOCK-')) throw new Error(`面板出现 mock 哨兵（剧本或注入失配）：${text.slice(-200)}`);
        return text.includes(successReply) ? true : text.slice(-120);
      },
      '面板出现导航成功总结（agent 收到成功回喂）',
      30_000,
    );
    const feedback = mock.requests.find((request) => request.obs !== null);
    assert(feedback !== undefined, 'mock LLM 未收到代执行回喂轮');
    assert(
      feedback.obs.includes('"url"') && feedback.obs.includes(targetUrl),
      `回喂 observation 缺导航结果：${feedback.obs}`,
    );

    console.log('[6/6] 落点后装配切站、面板常驻与审计链…');
    installId = await sw.evaluate(async () => (await chrome.storage.local.get('za.installId'))['za.installId'] ?? '');
    assert(installId !== '', '插件未生成安装 id（匿名激活未发生）');
    const { token } = await activate(SERVER_BASE, installId);
    let sessionId = null;
    await waitFor(() => {
      const starts = auditEvents(auditPath).filter((event) => event.type === 'session-start');
      if (starts.length === 0) return false;
      sessionId = starts.at(-1).sessionId;
      return true;
    }, '审计出现 session-start');
    await waitFor(
      async () => {
        const response = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return `injection HTTP ${response.status}`;
        const injection = await response.json();
        return injection.packId === 'generic-web' && injection.featureId === 'browse'
          ? true
          : `packId=${injection.packId} featureId=${injection.featureId}`;
      },
      '落点后装配切到 generic-web/browse',
      30_000,
    );
    await panel.locator(`[data-za-context][data-group-id="${group.groupId}"]`).waitFor({ timeout: 5_000 });
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-final.png'), fullPage: true });

    const events = auditEvents(auditPath);
    const decision = events.find(
      (event) => event.type === 'tool-decision' && event.data?.toolId === 'open_url',
    );
    assert(decision !== undefined, '审计缺 open_url 的 tool-decision');
    assert(decision.data.verdict === 'hitl', `open_url 判定应为 hitl，实际 ${decision.data.verdict}`);
    const approval = events.find(
      (event) => event.type === 'hitl-verdict' && event.data?.decision === 'approve',
    );
    assert(approval !== undefined, '审计缺 hitl-verdict(approve)');
    const execution = events.find(
      (event) => event.type === 'tool-execution' && event.data?.toolId === 'open_url',
    );
    assert(execution !== undefined, '审计缺 open_url 的 tool-execution');
    assert(execution.data.outcome === 'ok', `open_url 代执行未成功：${JSON.stringify(execution.data)}`);
    assert(approval.ts <= execution.ts, '代执行未在人审放行之后发生');

    const excerpt = events
      .filter(
        (event) =>
          event.type === 'session-start' ||
          event.type === 'assembly' ||
          event.data?.toolId === 'open_url' ||
          event.type === 'hitl-verdict',
      )
      .map((event) => JSON.stringify(event))
      .join('\n');
    assert(!excerpt.includes(installId), '审计片段泄漏了安装 id');
    assert(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(excerpt), '审计片段含 JWT 原文');
    writeFileSync(join(EVIDENCE_DIR, 'audit-excerpt.jsonl'), `${excerpt}\n`, 'utf8');
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify(
        {
          case: 'coldstart-open-url',
          status: 'passed',
          ranAt: new Date().toISOString(),
          llm: 'scripted mock (inline)',
          groupId: group.groupId,
          targetUrl,
          firstTurnTools: firstRequest.toolNames,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`空白组冷启动 open_url E2E 全部场景通过 ✅（证据：${EVIDENCE_DIR}）`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await panel?.screenshot({ path: join(EVIDENCE_DIR, 'panel-failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify({ case: 'coldstart-open-url', status: 'failed', ranAt: new Date().toISOString(), reason }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(EVIDENCE_DIR, 'audit-failure.jsonl'),
      auditEvents(auditPath)
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
      'utf8',
    );
    throw error;
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`空白组冷启动 open_url E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
