/**
 * adr-028 任务级一次授权 E2E：真实 Chromium + MV3 extension + 真实 gateway 子进程 + 内置脚本化 mock LLM。
 * 两个本地静态站：A（搜索框 + 客户端渲染的结果链接）、B（文章页，正文带哨兵）。
 * 从空白页冷启动（组内唯一成员 chrome://newtab，silent），用户说「在 A 搜索 X 并打开结果 B，告诉我核心内容」。
 *
 * 金路径（整回合只有一张确认卡）：
 *  open_url A（task + 整任务 plan）→ 任务授权卡 → 批准（空白页原地导航到 A，A 接入）
 *  → page_snapshot → browse.page-operate（同 task，fill + click；无卡自动执行）
 *  → open_url B（同 task；无卡，任务授权命中）→ B 新开入组并接入
 *  → page_snapshot(includeText) 取到哨兵 → browse.page-operate（同 task，B 站作用域；无卡）→ 面板出现总结。
 *
 * 判定：
 *  ① 卡按任务授权卡呈现：标题「授权任务：<task>」、「将先打开：<A>」、计划清单、按钮「授权执行」；批准前 A 未打开；
 *  ② 批准后空白页原地导航到 A（组内 tab 数不变）；
 *  ③ 整回合面板只出现过一张 HITL 卡；面板最终出现含 B 哨兵的总结；
 *  ④ 审计：hitl-verdict 恰 1 条（approve）；其后 tool-decision 一律 allow；tool-execution 一律 ok；
 *     B 站作用域下的页面操作 allow 且事件落点页 origin = B（授权随任务导航延续到了新作用域）；
 *  ⑤ 两次非定向导航（A / B）的回喂 observation 均含 attached:true——落点页真实注入并上报接入后服务端才这样回喂，
 *     未接入即 mock 回 MOCK-NOT-ATTACHED 红；harness 侧 waitAttached 只是快照时序保险，不替代该判定。
 *
 * 运行：node scripts/e2e/run-task-grant.mjs（ZA_E2E_SKIP_BUILD=1 复用既有构建产物）
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { unwrapObs } from '../mock-llm/server.mjs';
import { prepareExtensionDir, removeExtensionDir } from './extension-fixture.mjs';
import { assertPortsFree } from './port-guard.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = process.env.ZA_E2E_EXTENSION_DIR
  ? resolve(process.env.ZA_E2E_EXTENSION_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const SERVER_MAIN = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence', 'task-grant'),
);

// 本地 harness 的测试签名密钥：只用于签本进程内的测试 JWT / 代执行签名，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `task-grant-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-anon';
/**
 * gateway 起在插件开发构建的默认服务地址上（apps/extension/src/background.ts DEFAULT_SERVER_BASE_URL）：
 * service worker 一启动就会做首次匿名激活，起在同一地址可让这次预取直接命中。
 */
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_A_PORT = Number(process.env.ZA_E2E_HOST_PORT ?? 4173);
const HOST_B_PORT = HOST_A_PORT + 1;
const SITE_A_ORIGIN = `http://127.0.0.1:${HOST_A_PORT}`;
const SITE_B_ORIGIN = `http://127.0.0.1:${HOST_B_PORT}`;
const SITE_A_URL = `${SITE_A_ORIGIN}/search.html`;
const SITE_B_URL = `${SITE_B_ORIGIN}/article.html`;
const KEYWORD = 'zen agent 任务授权';
const SENTINEL = 'TASK-GRANT-SENTINEL-7f3a';
const TASK = '在 A 站搜索并打开结果 B 读取核心内容';
const PLAN = ['打开 A 站搜索页', `填入关键词「${KEYWORD}」并点击搜索`, '打开搜索结果 B', '读取 B 页正文并总结核心内容'];
const SUMMARY_PREFIX = '核心内容：';

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

const SITE_A_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>站点 A 搜索</title></head><body>' +
  '<h1>站点 A</h1><form id="search" onsubmit="return false">' +
  '<label for="q">关键词</label><input id="q" name="q" type="text" aria-label="关键词">' +
  '<button id="go" type="button">搜索</button></form><ul id="results"></ul>' +
  `<script>document.getElementById('go').addEventListener('click',()=>{` +
  `const q=document.getElementById('q').value;const ul=document.getElementById('results');ul.textContent='';` +
  `const li=document.createElement('li');const a=document.createElement('a');a.href='${SITE_B_URL}';` +
  `a.textContent='结果 B：'+q;li.append(a);ul.append(li);document.body.dataset.searched=q;});</script>` +
  '</body></html>';

const SITE_B_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>站点 B 文章</title></head><body>' +
  `<article><h1 id="headline">文章 B</h1><p>本文核心观点：${SENTINEL}。任务授权随导航延续，整任务只确认一次。</p>` +
  '<button id="expand" type="button">展开全文</button></article></body></html>';

/** 本地静态站：单页应答，body 带哨兵便于取证。 */
function startSite(port, html) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolveSite, rejectSite) => {
    server.once('error', rejectSite);
    server.listen(port, '127.0.0.1', () => {
      resolveSite({ close: () => new Promise((done) => server.close(() => done())) });
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

function parseSnapshot(obs) {
  try {
    return JSON.parse(unwrapObs(obs));
  } catch {
    return null;
  }
}

/**
 * 任务授权专用脚本化 mock LLM（OpenAI chat completions 兼容，仅 stream:true）：
 * 按本轮已发出的 tool_call 数逐步推进剧本；导航之后的观察步先等 harness 报告落点页已接入
 * （真实插件在页加载完成后注入 content，快照请求须落到已接入的活跃页），再产出 page_snapshot。
 */
function startScriptedLlm({ waitAttached }) {
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
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const isBoundary = (m) => m?.role === 'user' && String(m?.content ?? '').startsWith('【站点边界】');
      let tail = messages.length - 1;
      while (tail >= 0 && isBoundary(messages[tail])) tail -= 1;
      const obs = messages[tail]?.role === 'tool' ? String(messages[tail].content ?? '') : null;
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && !isBoundary(m));
      const user = String(lastUser?.content ?? '');
      const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '');
      let step = 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === 'user' && !isBoundary(m)) break;
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) step += m.tool_calls.length;
      }
      requests.push({ user, obs, toolNames, step });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-task-grant',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });

      const toolCall = (id, name, args) => ({ toolCall: { id, name, arguments: JSON.stringify(args) } });
      const browse = (id, steps, summary) =>
        toolCall(id, 'browse__page-operate', { task: TASK, plan: PLAN, steps, summary });
      let decision;
      if (!user.includes('搜索')) {
        decision = { text: 'MOCK-DEFAULT' };
      } else if (obs !== null && obs.includes('"error"')) {
        decision = { text: `MOCK-ERROR ${obs}` };
      } else if ((step === 1 || step === 4) && !obs.includes('"attached":true')) {
        decision = { text: `MOCK-NOT-ATTACHED ${obs}` };
      } else if (step === 0) {
        decision = toolNames.includes('open_url')
          ? toolCall('call_open_a', 'open_url', { url: SITE_A_URL, task: TASK, plan: PLAN, reason: '先打开 A 站搜索页' })
          : { text: 'MOCK-OPEN-URL-MISSING' };
      } else if (step === 1) {
        await waitAttached(SITE_A_URL);
        decision = toolCall('call_snapshot_a', 'page_snapshot', {});
      } else if (step === 2) {
        const snap = parseSnapshot(obs);
        const elements = Array.isArray(snap?.elements) ? snap.elements : [];
        const input = elements.find((e) => String(e?.role ?? '').startsWith('input'));
        const button = elements.find((e) => e?.role === 'button' && String(e?.label ?? '').includes('搜索'));
        decision =
          input === undefined || button === undefined
            ? { text: `MOCK-A-ELEMENTS-MISSING ${obs}` }
            : browse(
                'call_search_a',
                [
                  { action: 'fill', ref: input.ref, value: KEYWORD },
                  { action: 'click', ref: button.ref },
                ],
                '在 A 站填入关键词并点击搜索',
              );
      } else if (step === 3) {
        decision = toolCall('call_open_b', 'open_url', { url: SITE_B_URL, task: TASK, reason: '打开搜索结果 B' });
      } else if (step === 4) {
        await waitAttached(SITE_B_URL);
        decision = toolCall('call_snapshot_b', 'page_snapshot', { includeText: true });
      } else if (step === 5) {
        const snap = parseSnapshot(obs);
        const elements = Array.isArray(snap?.elements) ? snap.elements : [];
        const expand = elements.find((e) => e?.role === 'button');
        const text = String(snap?.text ?? '');
        decision =
          expand === undefined || !text.includes(SENTINEL)
            ? { text: `MOCK-B-SNAPSHOT-MISMATCH ${obs}` }
            : browse('call_read_b', [{ action: 'read', ref: expand.ref, name: 'expandLabel' }], '读取 B 页元素');
      } else {
        decision = { text: `${SUMMARY_PREFIX}${SENTINEL}（来自 ${SITE_B_URL}）` };
      }

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

/** 真实 gateway 子进程：生产快照（assets）下 generic-web 兜底装配 + 静默页冷启动的 open_url 注入门。 */
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-task-grant-e2e-'));
  const auditPath = join(tempRoot, 'audit.jsonl');
  const cleanups = [];
  let panel;
  let sw;
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

    await assertPortsFree([
      { port: SERVER_PORT, label: 'gateway' },
      { port: HOST_A_PORT, label: 'site A' },
      { port: HOST_B_PORT, label: 'site B' },
    ]);
    console.log(`[2/6] 起两站静态夹具（A ${HOST_A_PORT} / B ${HOST_B_PORT}）、脚本化 mock LLM 与真实 gateway…`);
    const siteA = await startSite(HOST_A_PORT, SITE_A_HTML);
    cleanups.push(() => siteA.close());
    const siteB = await startSite(HOST_B_PORT, SITE_B_HTML);
    cleanups.push(() => siteB.close());
    /** 落点页已接入 = 该 url 的 tab 上 content 能收扩展消息（真实注入路径，非 harness 代注入）。 */
    const waitAttached = (url) =>
      waitFor(
        async () => {
          if (sw === undefined) return 'service worker 尚未就绪';
          return sw.evaluate(async (target) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((t) => (t.url ?? '') === target);
            if (tab === undefined) return `尚无 url=${target} 的 tab`;
            try {
              await chrome.tabs.sendMessage(tab.id, { kind: 'refresh-context' });
              return true;
            } catch {
              return `tab ${tab.id} 的 content 尚未接入`;
            }
          }, url);
        },
        `落点页接入：${url}`,
        30_000,
      ).then(() => new Promise((settle) => setTimeout(settle, 500)));
    const mock = await startScriptedLlm({ waitAttached });
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
    const loadedExtensionDir = prepareExtensionDir(EXTENSION_DIR);
    cleanups.push(() => removeExtensionDir(loadedExtensionDir));
    for (const headless of [true, false]) {
      const profile = join(tempRoot, `profile-${headless}`);
      const candidate = await chromium.launchPersistentContext(profile, {
        headless,
        args: [`--disable-extensions-except=${loadedExtensionDir}`, `--load-extension=${loadedExtensionDir}`],
      });
      const worker =
        candidate.serviceWorkers()[0] ??
        (await candidate.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null));
      if (worker !== null) {
        context = candidate;
        sw = worker;
        console.log(`  扩展已加载（headless=${headless}）`);
        break;
      }
      await candidate.close();
    }
    if (context === undefined || sw === undefined) {
      throw new Error('Chromium 无法加载扩展（headless 与 headed 均失败）');
    }
    cleanups.push(() => context.close());
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': base });
    }, SERVER_BASE);
    const extensionId = new URL(sw.url()).host;

    console.log('[4/6] 建立空白会话组（新标签页入组，无 content 成员）并打开面板…');
    const group = await sw.evaluate(async () => {
      const tab = await chrome.tabs.create({ active: true });
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: 'Zen', color: 'purple' }).catch(() => {});
      await chrome.storage.session.set({
        ['za.zenGroup.g' + groupId]: true,
        ['za.panelGroup.w' + tab.windowId]: groupId,
      });
      return { groupId, windowId: tab.windowId, tabId: tab.id, tabUrl: tab.pendingUrl ?? tab.url ?? '' };
    });
    assert(typeof group.groupId === 'number', '未能建立会话组');
    assert(!/^https?:/.test(group.tabUrl), `组内唯一成员应为静默页，实际 ${group.tabUrl}`);

    panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator(`[data-za-shell][data-group-id="${group.groupId}"]`).waitFor({ timeout: 15_000 });
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });
    // 整回合出现过的 HITL 卡计数（卡裁决后即从 DOM 移除，事后查不到，须在场观察）。
    await panel.evaluate(() => {
      window.__zaHitlSeen = 0;
      const seen = new WeakSet();
      const count = () => {
        for (const card of document.querySelectorAll('[data-za-hitl]')) {
          if (!seen.has(card)) {
            seen.add(card);
            window.__zaHitlSeen += 1;
          }
        }
      };
      new MutationObserver(count).observe(document.body, { childList: true, subtree: true });
      count();
    });

    console.log('[5/6] 任务指令 → 唯一一张任务授权卡 → 批准 → 同任务内导航与页面操作自动执行…');
    await panel.locator('#za-input').fill(`在 A 搜索 ${KEYWORD} 并打开结果 B，告诉我核心内容`);
    await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').click();

    const hitlCard = panel.locator('[data-za-hitl]').last();
    await hitlCard.waitFor({ timeout: 60_000 });
    const hitlText = await hitlCard.innerText();
    assert(hitlText.includes(`授权任务：${TASK}`), `卡未按任务授权卡呈现标题：${hitlText}`);
    assert(hitlText.includes(`将先打开：${SITE_A_URL}`), `卡未呈现首步落点：${hitlText}`);
    for (const item of PLAN) assert(hitlText.includes(item), `卡未列出计划项「${item}」：${hitlText}`);
    const approveLabel = (await hitlCard.locator('[data-za-hitl-approve]').innerText()).trim();
    assert(approveLabel === '授权执行', `任务授权卡按钮应为「授权执行」，实际「${approveLabel}」`);
    const beforeApprove = await sw.evaluate(
      async ({ origin, groupId }) => ({
        targetTabs: (await chrome.tabs.query({})).filter((t) => (t.url ?? '').startsWith(origin)).length,
        groupTabs: (await chrome.tabs.query({ groupId })).length,
      }),
      { origin: SITE_A_ORIGIN, groupId: group.groupId },
    );
    assert(beforeApprove.targetTabs === 0, 'HITL 批准前 A 站页已被打开（确认未先于执行）');
    assert(beforeApprove.groupTabs === 1, `批准前组内应只有那个空白页，实际 ${beforeApprove.groupTabs} 个`);
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'task-grant-card.png'), fullPage: true });
    await hitlCard.locator('[data-za-hitl-approve]').click();

    await waitFor(
      async () => {
        const state = await sw.evaluate(
          async ({ groupId, tabId }) => {
            const blank = await chrome.tabs.get(tabId).catch(() => null);
            return {
              groupTabs: (await chrome.tabs.query({ groupId })).length,
              blankUrl: blank === null ? null : (blank.url ?? ''),
            };
          },
          { groupId: group.groupId, tabId: group.tabId },
        );
        if (state.blankUrl === null) return '原空白 tab 已不存在';
        if (!state.blankUrl.startsWith(SITE_A_ORIGIN)) return `原空白 tab url=${state.blankUrl}`;
        return state.groupTabs === 1 ? true : `组内 tab 数变为 ${state.groupTabs}`;
      },
      '空白页原地导航到 A（组内 tab 数不变）',
      30_000,
    );

    await waitFor(
      async () => {
        const text = await panel.locator('[data-za-messages]').innerText();
        if (text.includes('MOCK-')) throw new Error(`面板出现 mock 哨兵（剧本或注入失配）：${text.slice(-400)}`);
        return text.includes(`${SUMMARY_PREFIX}${SENTINEL}`) ? true : text.slice(-160);
      },
      '面板出现含 B 哨兵的总结（整任务在一次授权下跑完）',
      120_000,
    );
    const hitlSeen = await panel.evaluate(() => window.__zaHitlSeen);
    assert(hitlSeen === 1, `整回合应只出现一张 HITL 卡，实际 ${hitlSeen} 张`);
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-final.png'), fullPage: true });

    const tabsAfter = await sw.evaluate(async (groupId) => {
      const tabs = await chrome.tabs.query({ groupId });
      return tabs.map((t) => t.url ?? '');
    }, group.groupId);
    assert(tabsAfter.some((url) => url.startsWith(SITE_A_ORIGIN)), `组内缺 A 站页：${tabsAfter}`);
    assert(tabsAfter.some((url) => url.startsWith(SITE_B_ORIGIN)), `组内缺 B 站页（同任务导航未开出 B）：${tabsAfter}`);
    const searched = await (async () => {
      const page = context.pages().find((p) => p.url() === SITE_A_URL);
      return page === undefined ? null : page.evaluate(() => document.body.dataset.searched ?? null);
    })();
    assert(searched === KEYWORD, `A 站页面操作未生效（应填入并搜索「${KEYWORD}」，实际 ${searched}）`);

    console.log('[6/6] 审计链：hitl-verdict 恰 1、其后判定一律 allow、执行一律 ok、B 站作用域放行…');
    const events = auditEvents(auditPath);
    const verdicts = events.filter((event) => event.type === 'hitl-verdict');
    assert(verdicts.length === 1, `hitl-verdict 应恰 1 条，实际 ${verdicts.length}`);
    assert(verdicts[0].data?.decision === 'approve', `hitl-verdict 应为 approve：${JSON.stringify(verdicts[0].data)}`);
    const decisions = events.filter((event) => event.type === 'tool-decision');
    const decisionSummary = decisions.map((event) => `${event.data.toolId}:${event.data.verdict}`);
    assert(
      decisionSummary.join(',') ===
        'open_url:hitl,browse.page-operate:allow,open_url:allow,browse.page-operate:allow',
      `tool-decision 序列不符：${decisionSummary.join(',')}`,
    );
    assert(verdicts[0].ts <= decisions[1].ts, '首个自动放行的判定应在人审放行之后');
    const executions = events.filter((event) => event.type === 'tool-execution');
    assert(
      executions.length === 4 && executions.every((event) => event.data?.outcome === 'ok'),
      `tool-execution 应 4 条且全部 ok：${JSON.stringify(executions.map((e) => [e.data?.toolId, e.data?.outcome]))}`,
    );
    const lastBrowse = decisions[3];
    assert(
      lastBrowse.page?.origin === SITE_B_ORIGIN,
      `B 站作用域下的页面操作应在 B 页放行，实际落点 ${JSON.stringify(lastBrowse.page)}`,
    );
    const assemblies = events.filter((event) => event.type === 'assembly');
    assert(assemblies.some((event) => event.packId === 'generic-web'), '落点后未装配 generic-web');

    const excerpt = events
      .filter(
        (event) =>
          event.type === 'session-start' ||
          event.type === 'assembly' ||
          event.type === 'tool-decision' ||
          event.type === 'hitl-verdict' ||
          event.type === 'tool-execution',
      )
      .map((event) => JSON.stringify(event))
      .join('\n');
    assert(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(excerpt), '审计片段含 JWT 原文');
    writeFileSync(join(EVIDENCE_DIR, 'audit-excerpt.jsonl'), `${excerpt}\n`, 'utf8');
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify(
        {
          case: 'task-grant',
          status: 'passed',
          ranAt: new Date().toISOString(),
          llm: 'scripted mock (inline)',
          groupId: group.groupId,
          decisions: decisionSummary,
          hitlCards: hitlSeen,
          mockSteps: mock.requests.map((request) => request.step),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`任务级一次授权 E2E 全部场景通过 ✅（证据：${EVIDENCE_DIR}）`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await panel?.screenshot({ path: join(EVIDENCE_DIR, 'panel-failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify({ case: 'task-grant', status: 'failed', ranAt: new Date().toISOString(), reason }, null, 2)}\n`,
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
  console.error(`任务级一次授权 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
