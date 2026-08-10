/**
 * adr-023 D3 定向副作用 E2E（流程 B/C/D/E）：真实 Chromium + MV3 extension + 真实 gateway 子进程 + 脚本化 mock LLM。
 * 本地测试站同源三页组成任务组：/board.html（活跃页）、/ticket.html（背景页）、/silent.html
 * （建组前已完成"不激活"裁决、建组后不重载——入组但无 content 端口，即通道分级拒签的那类 silent 页）。
 *
 * 组的建立走 za.autoActivate 真实激活路径（content 首载自动建组/入组），不复刻图标点击。
 * mock LLM 内置专用脚本（与 run-coldstart-open-url.mjs 同口径）：按 user 指令 + observation
 * 内容驱动状态机，句柄一律从系统注入的「# 任务组页面清单」机械解析（不硬编码）。
 *
 * 判定：
 *  流程 B（定向副作用，同围栏多 tab）：
 *   ① agent 先定向快照 ticket 页（observation 带 [来自 <句柄>] 页标注）再定向 dom 操作；
 *   ② HITL 卡呈现目标页标注「目标页：工单 4521（origin）」，区别于当前页措辞（缺省卡无此行）；
 *   ③ 批准前目标页 DOM 未变（确认先于执行）；批准后指令单播目标页执行（ticket 页表单被填写提交）；
 *   ④ 活跃页 DOM 零变化负锚（board 页同构表单未被触碰）；
 *   ⑤ 结果回喂（completedSteps）且审计三类事件带 {page:{handle,origin}}，授权先于执行。
 *  流程 C（silent 页定向的拒签与引导）：
 *   ⑥ 对 silent 页定向 dom → 签发前拒签，回喂引导文案（目标页不可交互），无新增 HITL 卡、无执行事件、
 *      silent 页 URL 未变；
 *   ⑦ agent 改为定向 navigate（open_url 带 targetPage）→ HITL 卡带目标地址+目标页标注 → 批准后
 *      background 对句柄钉死的那一个 tab 直执行换 URL（不新开、不夺焦），结果回喂成功。
 *  流程 D（定向失败不改道）：
 *   ⑧ HITL 卡弹出后关闭目标页（状态表退役句柄）→ 批准 → 签发时刻重校验拒签（page-not-in-group）
 *      如实回喂、不签发指令；其余 tab DOM 零变化、组内不多开 tab；审计 tool-execution outcome=error 无 nonce。
 *      （签发后才不可达的超时语义由 apps/server 流程 D 单测覆盖。）
 *  流程 E（有端口成员的定向 navigate 落点钉死）：
 *   ⑨ 定向 navigate 到有 content 端口的组内页 → background 对句柄钉死的那一个 tab 换 URL：
 *      不经 content 委托复用判定、不改投同源他页、不夺焦、不新开 tab；审计 tool-execution outcome=ok 带目标页。
 *
 * 运行：node scripts/e2e/run-d3-directed.mjs（ZA_E2E_SKIP_BUILD=1 复用既有构建产物）
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = process.env.ZA_E2E_EXTENSION_DIR
  ? resolve(process.env.ZA_E2E_EXTENSION_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const SERVER_MAIN = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence', 'd3-directed'),
);

// 本地 harness 的测试签名密钥：只用于签本进程内的测试 JWT / 代执行签名，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `d3-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-anon';
/** gateway 必须起在插件开发构建的默认服务地址上（apps/extension/src/background.ts DEFAULT_SERVER_BASE_URL）。 */
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

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

/**
 * 本地测试站：board（活跃页）与 ticket / landing（定向落点）刻意同构——同名表单控件 +
 * 各自独立的完成哨兵，指令一旦落错页立即在错页哨兵上现形（改投/误播负锚可机械断言）。
 */
function startTargetSite() {
  const formPage = (title, heading, doneMarker) =>
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + title + '</title></head><body>' +
    `<h1>${heading}</h1>` +
    '<input aria-label="处理意见" id="opinion">' +
    `<button onclick="document.getElementById('done').textContent='${doneMarker}'">提交处理</button>` +
    '<div id="done"></div></body></html>';
  const pages = {
    '/board.html': formPage('控制台首页', '控制台', 'BOARD-SUBMITTED'),
    '/ticket.html': formPage('工单 4521', '工单详情', 'TICKET-SUBMITTED'),
    '/landing.html': formPage('激活落点页', '落点', 'LANDING-SUBMITTED'),
    '/silent.html':
      '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>静默文档页</title></head>' +
      '<body><h1>静默文档</h1><button id="silent-btn">静默按钮</button></body></html>',
  };
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
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

/** 系统注入中「# 任务组页面清单」行解析：`句柄 | 标题 | URL | 状态 | pack` 五列。 */
function parseManifestRows(systemContent) {
  const rows = [];
  for (const line of systemContent.split('\n')) {
    const parts = line.split(' | ');
    if (parts.length !== 5) continue;
    if (!['active', 'background', 'silent'].includes(parts[3])) continue;
    rows.push({ handle: parts[0], title: parts[1], url: parts[2], status: parts[3], pack: parts[4] });
  }
  return rows;
}

/**
 * D3 专用脚本化 mock LLM（OpenAI chat completions 兼容，仅 stream:true）：
 * 首轮按 user 指令开局、回喂轮按 observation 内容推进；句柄/状态全部机械解析自
 * 「# 任务组页面清单」，任何前提缺失即产出 MOCK- 哨兵（面板侧一见即失败）。
 */
function startScriptedLlm(siteOrigin) {
  const requests = [];
  const state = { ticketHandle: null, silentHandle: null, ticketRefs: null, lastRows: [], phase: null };

  const decide = (body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const system = String(messages.find((m) => m?.role === 'system')?.content ?? '');
    const rows = parseManifestRows(system);
    state.lastRows = rows;
    const last = messages[messages.length - 1];
    const obs = last?.role === 'tool' ? String(last.content ?? '') : null;
    const user = String([...messages].reverse().find((m) => m?.role === 'user')?.content ?? '');
    const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '');
    requests.push({ user, obs, toolNames, rows });
    const rowByPath = (path) => rows.find((row) => row.url.endsWith(path));

    if (obs === null) {
      const probe = /^状态检查 #(\d+)/.exec(user);
      if (probe !== null) {
        const tools =
          toolNames.includes('browse__page-operate') && toolNames.includes('page_snapshot')
            ? 'tools:ok'
            : `tools:missing(${toolNames.join(',')})`;
        const summary = rows
          .map((row) => {
            try {
              return `${row.status}:${new URL(row.url).pathname}`;
            } catch {
              return `${row.status}:${row.url}`;
            }
          })
          .sort()
          .join(' ');
        return { text: `PROBE#${probe[1]} ${tools} ${summary}` };
      }
      if (user.includes('关闭测试')) {
        const row = rowByPath('/ticket.html');
        if (row === undefined || state.ticketRefs === null) return { text: 'MOCK-D-PRECONDITION-MISSING' };
        state.ticketHandle = row.handle;
        return {
          toolCall: {
            id: 'call_d_operate',
            name: 'browse__page-operate',
            arguments: JSON.stringify({
              task: '关闭页操作',
              plan: ['再次点击工单页的提交处理按钮'],
              steps: [{ action: 'click', ref: state.ticketRefs.click }],
              summary: '再次在后台工单页点击提交处理',
              targetPage: row.handle,
            }),
          },
        };
      }
      if (user.includes('静默页')) {
        const row = rows.find((candidate) => candidate.status === 'silent');
        if (row === undefined) return { text: 'MOCK-C-NO-SILENT-ROW' };
        state.silentHandle = row.handle;
        return {
          toolCall: {
            id: 'call_c_dom',
            name: 'browse__page-operate',
            arguments: JSON.stringify({
              task: '静默页操作',
              plan: ['点击静默页上的按钮'],
              steps: [{ action: 'click', ref: 'za-1' }],
              summary: '在静默页点击按钮',
              targetPage: row.handle,
            }),
          },
        };
      }
      if (user.includes('落点页导航')) {
        const row = rowByPath('/landing.html');
        if (row === undefined) return { text: 'MOCK-E-NO-LANDING-ROW' };
        state.phase = 'e';
        return {
          toolCall: {
            id: 'call_e_nav',
            name: 'open_url',
            arguments: JSON.stringify({
              url: `${siteOrigin}/ticket.html`,
              task: '把落点页导航到工单页',
              reason: '在组内落点页上直接打开工单页',
              targetPage: row.handle,
            }),
          },
        };
      }
      if (user.includes('工单页')) {
        const row = rowByPath('/ticket.html');
        if (row === undefined) return { text: 'MOCK-B-NO-TICKET-ROW' };
        state.ticketHandle = row.handle;
        return {
          toolCall: {
            id: 'call_b_snapshot',
            name: 'page_snapshot',
            arguments: JSON.stringify({ targetPage: row.handle }),
          },
        };
      }
      return { text: 'MOCK-DEFAULT' };
    }

    if (obs.startsWith('[来自 ')) {
      const newline = obs.indexOf('\n');
      let parsed;
      try {
        parsed = JSON.parse(obs.slice(newline + 1));
      } catch {
        return { text: 'MOCK-B-SNAPSHOT-UNPARSABLE' };
      }
      const elements = Array.isArray(parsed?.elements) ? parsed.elements : [];
      const fill = elements.find((el) => el?.label === '处理意见');
      const click = elements.find((el) => el?.label === '提交处理');
      if (fill === undefined || click === undefined) {
        return { text: `MOCK-B-REFS-MISSING ${JSON.stringify(elements)}` };
      }
      state.ticketRefs = { fill: fill.ref, click: click.ref };
      return {
        toolCall: {
          id: 'call_b_operate',
          name: 'browse__page-operate',
          arguments: JSON.stringify({
            task: '工单填报',
            plan: ['在工单页填写处理意见', '点击提交处理'],
            steps: [
              { action: 'fill', ref: fill.ref, value: '同意处理' },
              { action: 'click', ref: click.ref },
            ],
            summary: '在后台工单页填写处理意见并提交',
            targetPage: state.ticketHandle,
          }),
        },
      };
    }
    if (obs.includes('"completedSteps"')) return { text: '已在后台工单页完成提交，处理意见已填写。' };
    if (obs.includes('目标页不可交互')) {
      const row = state.lastRows.find((candidate) => candidate.status === 'silent');
      const handle = row?.handle ?? state.silentHandle;
      if (handle == null) return { text: 'MOCK-C-SILENT-ROW-GONE' };
      return {
        toolCall: {
          id: 'call_c_openurl',
          name: 'open_url',
          arguments: JSON.stringify({
            url: `${siteOrigin}/landing.html`,
            task: '激活静默页',
            reason: '目标页不可交互，先定向导航激活',
            targetPage: handle,
          }),
        },
      };
    }
    if (obs.includes('"error":"timeout"')) return { text: '目标页已不可达，操作执行超时失败。' };
    if (obs.includes('page-not-in-group')) return { text: '目标页已被关闭，签发已拒绝，未执行任何操作。' };
    if (obs.includes('user-rejected')) return { text: '已取消本次操作。' };
    if (obs.includes('"url"')) {
      return state.phase === 'e'
        ? { text: '已把落点页定向导航到工单页。' }
        : { text: '已将静默页导航到激活落点页。' };
    }
    return { text: `MOCK-OBS-UNMATCHED ${obs.slice(0, 160)}` };
  };

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
      const decision = decide(JSON.parse(raw));
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-d3',
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
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 真实 gateway 子进程：ZA_GENERIC_ALLOWLIST='*' 使本地测试站激活 generic-web pack。 */
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-d3-e2e-'));
  const auditPath = join(tempRoot, 'audit.jsonl');
  const cleanups = [];
  let panel;
  rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  try {
    if (process.env.ZA_E2E_SKIP_BUILD === '1') {
      if (!existsSync(SERVER_MAIN)) throw new Error(`ZA_E2E_SKIP_BUILD=1 但 server 未构建：缺 ${SERVER_MAIN}`);
      console.log('[1/9] 跳过构建（ZA_E2E_SKIP_BUILD=1），使用既有产物…');
    } else {
      console.log('[1/9] 构建 server + extension…');
      await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
      await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);
    }

    console.log('[2/9] 起本地测试站、脚本化 mock LLM 与真实 gateway（ZA_GENERIC_ALLOWLIST=*）…');
    const site = await startTargetSite();
    cleanups.push(() => site.close());
    const mock = await startScriptedLlm(site.origin);
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

    console.log('[3/9] 真实 Chromium 加载 MV3 extension…');
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

    // 图标点击建组无法在 Playwright 内自动化：与 run-coldstart-open-url.mjs 同口径，在 SW 里
    // 复刻 handleIconClick 的可观察产物（建组 + zenGroup/panelGroup 登记）。三页先于建组载入，
    // content 首载激活请求得 'none' 而保持沉默；建组后重载 board/ticket 令其经 reconnect 激活接入，
    // silent 页刻意不重载——入组但无 content 端口，即通道分级拒签的那类 silent 页。
    console.log('[4/9] 同源三页建组：board（活跃）/ ticket（背景）/ silent（不激活，无端口）…');
    const tabByPath = async (path) =>
      await sw.evaluate(
        async (suffix) =>
          (await chrome.tabs.query({}))
            .map((t) => ({ id: t.id, url: t.url ?? '', groupId: t.groupId, active: t.active }))
            .find((t) => t.url.includes(suffix)) ?? null,
        path,
      );

    const pageBoard = await context.newPage();
    await pageBoard.goto(`${site.origin}/board.html`);
    const pageTicket = await context.newPage();
    await pageTicket.goto(`${site.origin}/ticket.html`);
    const pageSilent = await context.newPage();
    await pageSilent.goto(`${site.origin}/silent.html`);
    // 三页 content 的首载激活请求（request-activate）必须先于建组得到 'none' 裁决，
    // silent 页才不会在建组后经 reconnect 路径接入端口（转 background/active 的竞态源头）。
    await sleep(1_500);

    const group = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const pick = (suffix) => tabs.find((t) => (t.url ?? '').includes(suffix));
      const board = pick('/board.html');
      const ticket = pick('/ticket.html');
      const silent = pick('/silent.html');
      if (!board?.id || !ticket?.id || !silent?.id) return null;
      const groupId = await chrome.tabs.group({ tabIds: [board.id, ticket.id, silent.id] });
      await chrome.tabGroups.update(groupId, { title: 'Zen', color: 'purple' }).catch(() => {});
      await chrome.storage.session.set({
        ['za.zenGroup.g' + groupId]: true,
        ['za.panelGroup.w' + board.windowId]: groupId,
      });
      return { groupId };
    });
    assert(group !== null, '未能建立三页会话组');
    const groupId = group.groupId;

    await pageTicket.reload();
    await pageBoard.reload();
    // board 回到台前成为活跃页（可见页 context-report → markActive）；ticket 隐藏接入为 background。
    await pageBoard.bringToFront();
    await sleep(800);

    console.log('[5/9] 打开面板并以探测轮确认服务端状态表（active/background/silent 三态就绪）…');
    panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator(`[data-za-context][data-group-id="${groupId}"]`).waitFor({ timeout: 15_000 });
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });
    // 本 harness 全程轮询各页 DOM（含 60s ttl 等待窗），而系统内存压力下 Chrome 会自动
    // discard 非焦点 tab——target 被销毁，Playwright 视为页面已关闭、轮询即抛错。
    // 钉住 autoDiscardable 关闭自动 discard（tab 属性随导航保留，landing 换 URL 后仍生效）。
    const pinned = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id !== undefined) await chrome.tabs.update(tab.id, { autoDiscardable: false });
      }
      return (await chrome.tabs.query({})).every((tab) => tab.autoDiscardable === false);
    });
    assert(pinned, '未能将全部 tab 钉为 autoDiscardable=false');

    const messagesText = () => panel.locator('[data-za-messages]').innerText();
    const sendMessage = async (text) => {
      // 回合结束后按钮回到 send 态；填入文本后按钮解禁再点击。
      await panel.locator('[data-za-action][data-mode="send"]').waitFor({ timeout: 30_000 });
      await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 30_000 });
      await panel.locator('#za-input').fill(text);
      await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').click({ timeout: 15_000 });
    };
    const failOnSentinel = (text) => {
      if (text.includes('MOCK-')) throw new Error(`面板出现 mock 哨兵（剧本或注入失配）：${text.slice(-300)}`);
    };

    const expectedProbe = 'tools:ok active:/board.html background:/ticket.html silent:/silent.html';
    let probeOk = false;
    let lastProbeLine = '';
    for (let attempt = 1; attempt <= 12 && !probeOk; attempt += 1) {
      await sendMessage(`状态检查 #${attempt}`);
      await waitFor(
        async () => ((await messagesText()).includes(`PROBE#${attempt} `) ? true : '探测回复未到'),
        `探测轮 #${attempt} 回复`,
        20_000,
      );
      const text = await messagesText();
      lastProbeLine =
        text.split('\n').find((candidate) => candidate.startsWith(`PROBE#${attempt} `)) ?? '';
      if (lastProbeLine === `PROBE#${attempt} ${expectedProbe}`) probeOk = true;
      else {
        // 常见滞后：board 的可见性上报晚于面板开启——重新置前触发 visibilitychange 补报。
        await pageBoard.bringToFront();
        await sleep(1_000);
      }
    }
    assert(probeOk, `状态表未达预期三态（期望「${expectedProbe}」，最后探测「${lastProbeLine}」）`);

    console.log('[6/9] 流程 B：定向背景页 dom 操作 → HITL 目标页标注 → 批准 → 单播执行 → 回喂与审计…');
    const hitlCount = async () => await panel.locator('[data-za-hitl]').count();
    const cardsBeforeB = await hitlCount();
    await sendMessage('请在后台工单页提交处理意见');
    const cardB = panel.locator('[data-za-hitl]').last();
    await waitFor(async () => ((await hitlCount()) > cardsBeforeB ? true : 'HITL 卡未出现'), '流程 B HITL 卡', 30_000);
    const cardBText = await cardB.innerText();
    assert(cardBText.includes('目标页：'), `流程 B HITL 卡缺目标页标注：${cardBText}`);
    assert(cardBText.includes('工单 4521'), `流程 B 目标页标注缺目标页标题：${cardBText}`);
    assert(cardBText.includes(site.origin), `流程 B 目标页标注缺 origin：${cardBText}`);
    // 确认先于执行：卡片出现时目标页 DOM 必须未变。
    assert(
      (await pageTicket.locator('#done').textContent()) === '',
      '流程 B：HITL 批准前目标页已被执行（确认未先于执行）',
    );
    // 定向快照回喂带页标注（observation 首行 [来自 <句柄> · origin]）。
    const snapshotFeedback = mock.requests.find((request) => request.obs?.startsWith('[来自 '));
    assert(snapshotFeedback !== undefined, '流程 B：mock 未收到定向快照回喂（[来自 …] 页标注缺失）');
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'hitl-flow-b.png'), fullPage: true });
    await cardB.locator('[data-za-hitl-approve]').click();

    await waitFor(
      async () => {
        const text = await messagesText();
        failOnSentinel(text);
        return text.includes('已在后台工单页完成提交') ? true : text.slice(-120);
      },
      '流程 B 面板出现成功总结',
      30_000,
    );
    assert(
      (await pageTicket.locator('#done').textContent()) === 'TICKET-SUBMITTED',
      '流程 B：目标页表单未被提交（指令未送达目标页）',
    );
    assert(
      (await pageTicket.locator('#opinion').inputValue()) === '同意处理',
      '流程 B：目标页输入框未被填写',
    );
    // 活跃页 DOM 零变化负锚：同构表单不得被触碰。
    assert((await pageBoard.locator('#done').textContent()) === '', '流程 B：活跃页 DOM 被触碰（哨兵非空）');
    assert((await pageBoard.locator('#opinion').inputValue()) === '', '流程 B：活跃页输入框被填写');
    const operateFeedback = mock.requests.find((request) => request.obs?.includes('"completedSteps"'));
    assert(operateFeedback !== undefined, '流程 B：mock 未收到执行结果回喂（completedSteps）');
    const ticketHandle = mock.state.ticketHandle;
    assert(typeof ticketHandle === 'string' && ticketHandle !== '', '流程 B：未从清单解析到 ticket 句柄');

    console.log('[7/9] 流程 C：silent 页定向 dom 拒签引导 → 改定向 navigate → 获签直执行…');
    const silentHandleC = mock.state.silentHandle ?? null;
    const cardsBeforeC = await hitlCount();
    await sendMessage('请在静默页上点击按钮');
    // 拒签直接回喂、随后才出 open_url 卡：本回合恰好新增一张 HITL 卡（dom 拒签不弹卡）。
    await waitFor(async () => ((await hitlCount()) > cardsBeforeC ? true : 'open_url HITL 卡未出现'), '流程 C HITL 卡', 30_000);
    assert((await hitlCount()) === cardsBeforeC + 1, '流程 C：silent 页 dom 拒签仍弹出了 HITL 卡');
    const silentDenyFeedback = mock.requests.find((request) => request.obs?.includes('目标页不可交互'));
    assert(silentDenyFeedback !== undefined, '流程 C：mock 未收到 silent 拒签引导回喂');
    const cardC = panel.locator('[data-za-hitl]').last();
    const cardCText = await cardC.innerText();
    assert(cardCText.includes(`目标地址：${site.origin}/landing.html`), `流程 C 卡缺目标地址：${cardCText}`);
    assert(cardCText.includes('目标页：'), `流程 C 卡缺目标页标注：${cardCText}`);
    // 拒签无帧下发：批准前 silent 页 URL 未变。
    const silentBeforeApprove = await tabByPath('/silent.html');
    assert(silentBeforeApprove !== null, '流程 C：silent 页在批准前已消失');
    const groupTabsBeforeC = await sw.evaluate(
      async (gid) => (await chrome.tabs.query({ groupId: gid })).length,
      groupId,
    );
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'hitl-flow-c.png'), fullPage: true });
    await cardC.locator('[data-za-hitl-approve]').click();

    await waitFor(
      async () => {
        const tab = await tabByPath('/landing.html');
        if (tab === null) return 'landing 未落地';
        return tab.groupId === groupId ? true : `landing groupId=${tab.groupId}`;
      },
      '流程 C：silent 页被定向换 URL 且仍在组内',
      30_000,
    );
    await waitFor(
      async () => {
        const text = await messagesText();
        failOnSentinel(text);
        return text.includes('已将静默页导航到激活落点页') ? true : text.slice(-120);
      },
      '流程 C 面板出现导航成功总结',
      30_000,
    );
    const landingTab = await tabByPath('/landing.html');
    assert(landingTab.active === false, '流程 C：定向 navigate 不应夺焦激活目标页');
    const groupTabsAfterC = await sw.evaluate(
      async (gid) => (await chrome.tabs.query({ groupId: gid })).length,
      groupId,
    );
    assert(groupTabsAfterC === groupTabsBeforeC, '流程 C：定向 navigate 不应新开 tab');

    console.log('[8/9] 流程 D：HITL 弹出后关闭目标页 → 批准 → 签发时刻重校验拒签、不改投…');
    const cardsBeforeD = await hitlCount();
    await sendMessage('关闭测试：请再次操作工单页');
    await waitFor(async () => ((await hitlCount()) > cardsBeforeD ? true : 'HITL 卡未出现'), '流程 D HITL 卡', 30_000);
    const cardD = panel.locator('[data-za-hitl]').last();
    const cardDText = await cardD.innerText();
    assert(cardDText.includes('目标页：') && cardDText.includes('工单 4521'), `流程 D 卡缺目标页标注：${cardDText}`);
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'hitl-flow-d.png'), fullPage: true });
    // 批准前关闭目标页；等句柄表防抖对齐（300ms 防抖 + 上报），帧到达时已无成员可投。
    await pageTicket.close();
    await sleep(1_500);
    const pageLanding = context.pages().find((page) => page.url().includes('/landing.html'));
    assert(pageLanding !== undefined, '流程 D：找不到 landing 页（负锚无从断言）');
    await cardD.locator('[data-za-hitl-approve]').click();

    // 状态表已退役目标句柄：签发时刻重校验拒签（page-not-in-group），不签发指令、如实回喂。
    await waitFor(
      async () => {
        const text = await messagesText();
        failOnSentinel(text);
        return text.includes('签发已拒绝') ? true : text.slice(-120);
      },
      '流程 D 面板出现拒签总结',
      30_000,
    );
    const refusalFeedback = mock.requests.find((request) => request.obs?.includes('page-not-in-group'));
    assert(refusalFeedback !== undefined, '流程 D：mock 未收到签发拒绝回喂');
    // 不改投负锚：其余 tab DOM 零变化（board / landing 的同构表单哨兵都为空）、组内不多开 tab。
    assert((await pageBoard.locator('#done').textContent()) === '', '流程 D：活跃页被改投执行（哨兵非空）');
    assert((await pageBoard.locator('#opinion').inputValue()) === '', '流程 D：活跃页输入框被改投填写');
    assert((await pageLanding.locator('#done').textContent()) === '', '流程 D：landing 页被改投执行（哨兵非空）');
    assert((await pageLanding.locator('#opinion').inputValue()) === '', '流程 D：landing 页输入框被改投填写');
    const groupTabsAfterD = await sw.evaluate(
      async (gid) => (await chrome.tabs.query({ groupId: gid })).length,
      groupId,
    );
    assert(groupTabsAfterD === groupTabsAfterC - 1, `流程 D：组内 tab 数异常（${groupTabsAfterD}）`);

    console.log('[9/9] 流程 E：定向 navigate 有端口成员 → 落点钉死该页（不改投同源他页、不夺焦）…');
    const landingBeforeE = await tabByPath('/landing.html');
    assert(landingBeforeE !== null, '流程 E：landing 页缺失');
    const boardBeforeE = await tabByPath('/board.html');
    assert(boardBeforeE !== null, '流程 E：board 页缺失');
    const cardsBeforeE = await hitlCount();
    await sendMessage('请把落点页导航到工单页');
    await waitFor(async () => ((await hitlCount()) > cardsBeforeE ? true : 'HITL 卡未出现'), '流程 E HITL 卡', 30_000);
    const cardE = panel.locator('[data-za-hitl]').last();
    const cardEText = await cardE.innerText();
    assert(cardEText.includes(`目标地址：${site.origin}/ticket.html`), `流程 E 卡缺目标地址：${cardEText}`);
    await cardE.locator('[data-za-hitl-approve]').click();
    // 落点钉死：换 URL 的必须是句柄指向的 landing tab 本身（有 content 端口也不走复用判定）。
    await waitFor(
      async () => {
        const tab = await tabByPath('/ticket.html');
        if (tab === null) return 'ticket URL 未落地';
        return tab.id === landingBeforeE.id ? true : `落错页 tabId=${tab.id}`;
      },
      '流程 E：landing 页被定向换 URL',
      30_000,
    );
    await waitFor(
      async () => {
        const text = await messagesText();
        failOnSentinel(text);
        return text.includes('已把落点页定向导航到工单页') ? true : text.slice(-120);
      },
      '流程 E 面板出现导航成功总结',
      30_000,
    );
    const boardAfterE = await tabByPath('/board.html');
    assert(boardAfterE !== null && boardAfterE.id === boardBeforeE.id, '流程 E：活跃页被改投导航（board URL 已变）');
    const landingAfterE = await tabByPath('/ticket.html');
    assert(landingAfterE.active === false, '流程 E：定向 navigate 不应激活目标页（夺焦）');
    const groupTabsAfterE = await sw.evaluate(
      async (gid) => (await chrome.tabs.query({ groupId: gid })).length,
      groupId,
    );
    assert(groupTabsAfterE === groupTabsAfterD, '流程 E：定向 navigate 不应新开 tab');
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-final.png'), fullPage: true });

    // —— 审计链断言（C5 旁路，D3 目标页字段）——
    const events = auditEvents(auditPath);
    const byCall = (toolCallId, type) =>
      events.filter((event) => event.type === type && event.data?.toolCallId === toolCallId);

    // 流程 B：tool-decision(hitl) → hitl-verdict(approve) → tool-execution(ok)，三类都带目标页 {handle, origin}。
    const decisionB = byCall('call_b_operate', 'tool-decision')[0];
    assert(decisionB !== undefined, '审计缺流程 B 的 tool-decision');
    assert(decisionB.data.verdict === 'hitl', `流程 B 判定应为 hitl，实际 ${decisionB.data.verdict}`);
    assert(
      decisionB.page?.handle === ticketHandle && decisionB.page?.origin === site.origin,
      `流程 B tool-decision 目标页标注不符：${JSON.stringify(decisionB.page)}`,
    );
    const executionB = byCall('call_b_operate', 'tool-execution')[0];
    assert(executionB !== undefined, '审计缺流程 B 的 tool-execution');
    assert(executionB.data.outcome === 'ok', `流程 B 执行未成功：${JSON.stringify(executionB.data)}`);
    assert(
      executionB.page?.handle === ticketHandle && executionB.page?.origin === site.origin,
      `流程 B tool-execution 目标页标注不符：${JSON.stringify(executionB.page)}`,
    );
    const approvalB = events.find(
      (event) =>
        event.type === 'hitl-verdict' &&
        event.data?.toolCallId === 'call_b_operate' &&
        event.data?.decision === 'approve',
    );
    assert(approvalB !== undefined, '审计缺流程 B 的 hitl-verdict(approve)');
    assert(approvalB.page?.handle === ticketHandle, '流程 B hitl-verdict 缺目标页标注');
    assert(approvalB.ts <= executionB.ts, '流程 B 代执行未在人审放行之后发生');

    // 流程 C：dom 拒签（deny + silent 引导 reason、无执行事件）→ open_url 定向执行 ok。
    const decisionCDom = byCall('call_c_dom', 'tool-decision')[0];
    assert(decisionCDom !== undefined, '审计缺流程 C silent dom 的 tool-decision');
    assert(decisionCDom.data.verdict === 'deny', `流程 C silent dom 应拒签，实际 ${decisionCDom.data.verdict}`);
    assert(
      String(decisionCDom.data.reason ?? '').includes('目标页不可交互'),
      `流程 C 拒签 reason 非 silent 引导文案：${decisionCDom.data.reason}`,
    );
    assert(byCall('call_c_dom', 'tool-execution').length === 0, '流程 C：拒签调用不应有 tool-execution 事件');
    const executionC = byCall('call_c_openurl', 'tool-execution')[0];
    assert(executionC !== undefined, '审计缺流程 C open_url 的 tool-execution');
    assert(executionC.data.outcome === 'ok', `流程 C open_url 执行未成功：${JSON.stringify(executionC.data)}`);
    assert(typeof executionC.page?.handle === 'string', '流程 C open_url tool-execution 缺目标页标注');

    // 流程 D：批准后签发时刻重校验拒签 → tool-execution outcome=error 且无 nonce（未签发指令）。
    const executionD = byCall('call_d_operate', 'tool-execution')[0];
    assert(executionD !== undefined, '审计缺流程 D 的 tool-execution');
    assert(executionD.data.outcome === 'error', `流程 D 应签发拒绝，实际 ${JSON.stringify(executionD.data)}`);
    assert(executionD.data.nonce === undefined, '流程 D：拒签不应签发指令（审计带 nonce）');
    assert(executionD.page?.handle === ticketHandle, '流程 D tool-execution 缺目标页标注');
    const approvalD = events.find(
      (event) =>
        event.type === 'hitl-verdict' &&
        event.data?.toolCallId === 'call_d_operate' &&
        event.data?.decision === 'approve',
    );
    assert(approvalD !== undefined, '审计缺流程 D 的 hitl-verdict(approve)');

    // 流程 E：有端口成员的定向 navigate 落点钉死 → tool-execution outcome=ok 带目标页句柄。
    const executionE = byCall('call_e_nav', 'tool-execution')[0];
    assert(executionE !== undefined, '审计缺流程 E 的 tool-execution');
    assert(executionE.data.outcome === 'ok', `流程 E 执行未成功：${JSON.stringify(executionE.data)}`);
    assert(typeof executionE.page?.handle === 'string', '流程 E tool-execution 缺目标页标注');

    // U5 负锚：审计流不含形态标识；SEC 负锚：不含安装 id 与 JWT 原文。
    const allEventsSerialized = events.map((event) => JSON.stringify(event)).join('\n');
    assert(!allEventsSerialized.includes('"tabId"'), '审计事件泄漏 tabId（U5）');
    const installId = await sw.evaluate(
      async () => (await chrome.storage.local.get('za.installId'))['za.installId'] ?? '',
    );
    assert(installId !== '', '插件未生成安装 id（匿名激活未发生）');
    const excerpt = events
      .filter(
        (event) =>
          event.type === 'session-start' ||
          event.type === 'hitl-verdict' ||
          ['call_b_operate', 'call_c_dom', 'call_c_openurl', 'call_d_operate'].includes(
            event.data?.toolCallId,
          ),
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
          case: 'd3-directed',
          status: 'passed',
          ranAt: new Date().toISOString(),
          llm: 'scripted mock (inline)',
          groupId,
          siteOrigin: site.origin,
          handles: { ticket: ticketHandle, silentAtFlowC: silentHandleC ?? mock.state.silentHandle },
          flows: {
            b: 'directed dom exec on background page (HITL target-page annotation, unicast, audit page ref)',
            c: 'silent dom denied with guidance, directed open_url background-executed',
            d: 'target closed before approve, issuance refused at signing time (page-not-in-group), no re-targeting',
            e: 'directed navigate to ported member pinned to its own tab (no reuse redirect, no focus steal)',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`adr-023 D3 定向副作用 E2E（流程 B/C/D/E）全部场景通过 ✅（证据：${EVIDENCE_DIR}）`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await panel?.screenshot({ path: join(EVIDENCE_DIR, 'panel-failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify({ case: 'd3-directed', status: 'failed', ranAt: new Date().toISOString(), reason }, null, 2)}\n`,
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
  console.error(`adr-023 D3 定向副作用 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
