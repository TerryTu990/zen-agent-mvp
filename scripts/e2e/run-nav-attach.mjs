/**
 * 导航落点接入语义 E2E（adr-027 §4 / adr-028）：真实 Chromium + MV3 extension（scoped 授权夹具）+ 真实 gateway 子进程
 * + 内置脚本化 mock LLM。插件只授权 http://127.0.0.1/*：A 站起在 127.0.0.1（可接入），B 站起在 http://localhost
 * （不同 host、不同 origin，未授权 → background 注入必失败 → 页保持 silent）。
 *
 * 剧本（同一 task，一张任务授权卡）：
 *  open_url A（task + plan）→ 批准 → 回喂 attached:true → open_url B（同 task，授权放行）→ 回喂 attached:false
 *  → mock 再发同址 open_url B（服务端 already-open 止损 deny）→ 对 B 句柄定向 page_snapshot 两次（两次拒绝，口径递进）
 *  → 总结（含「点击 Zen 图标」指引）。
 *
 * 判定：
 *  ① A 的回喂 observation 含 "attached":true 与「页面已接入」；
 *  ② B 的回喂 observation 含 "attached":false 与未接入指引；组页面清单里 B 为 silent；B tab 上 chrome.tabs.sendMessage 抛错（无 content）；
 *  ③ 同址再 open_url：审计 tool-decision verdict=deny reason=already-open-not-attached、整回合只出现过一张 HITL 卡、
 *     组内只有一个 B 页（tab 数不变）；
 *  ④ 两次定向快照回喂分别含「最多重试一次」与「不要再重试」，且服务端从未向浏览器广播 snapshot-request 帧；
 *  ⑤ 批准点击内 chrome.permissions.request 恰调用一次、实参 origins=["<all_urls>"]（夹具桩化，立即 resolve(false)）；
 *  ⑥ 面板最终文案含「点击 Zen 图标」指引、无 MOCK- 哨兵；
 *  ⑦ 面板的未接入信号区恰有 B 一行、原因为「尚未取得该站点的访问权限」，点「让 Zen 接入这一页」
 *     在手势内发出 origins=["http://localhost/*"] 的权限询问并触发一次真实补注入——权限仍未授予，
 *     故补注入必然失败，面板如实呈现「仍未接入」且 B 上依旧没有 content。
 *
 * 运行：node scripts/e2e/run-nav-attach.mjs（ZA_E2E_SKIP_BUILD=1 复用既有构建产物）
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
import { failureReason, gitCommit } from './evidence.mjs';
import {
  prepareExtensionDir,
  readPermissionRequests,
  removeExtensionDir,
  stubPermissionRequest,
} from './extension-fixture.mjs';
import { assertPortsFree } from './port-guard.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = process.env.ZA_E2E_EXTENSION_DIR
  ? resolve(process.env.ZA_E2E_EXTENSION_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const SERVER_MAIN = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(REPO_ROOT, '.za', 'e2e', 'e2e-evidence', 'nav-attach'),
);

// 本地 harness 的测试签名密钥：只用于签本进程内的测试 JWT / 代执行签名，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `nav-attach-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-anon';
const SERVER_PORT = Number(process.env.ZA_E2E_SERVER_PORT ?? 8787);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_A_PORT = Number(process.env.ZA_E2E_HOST_PORT ?? 4173);
const HOST_B_PORT = HOST_A_PORT + 1;
const SITE_A_ORIGIN = `http://127.0.0.1:${HOST_A_PORT}`;
const SITE_B_ORIGIN = `http://localhost:${HOST_B_PORT}`;
const SITE_A_URL = `${SITE_A_ORIGIN}/landing.html`;
const SITE_B_URL = `${SITE_B_ORIGIN}/article.html`;
const GRANTED_HOST_PERMISSIONS = ['http://127.0.0.1/*'];
const SITE_B_PERMISSION_PATTERN = 'http://localhost/*';
const ATTACH_REASON_PERMISSION = '尚未取得该站点的访问权限';
const TASK = '先打开 A 站再打开 B 站并读取 B 的内容';
const PLAN = ['打开 A 站', '打开 B 站', '读取 B 页正文并总结'];
const FINAL_REPLY = 'B 页已打开但尚未接入：请在该页点击 Zen 图标授权本站后告诉我，我再继续读取。';
const ALREADY_OPEN = 'already-open-not-attached';

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
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>站点 A</title></head>' +
  '<body><h1 id="landing">站点 A 落点页</h1><button id="next" type="button">下一步</button></body></html>';
const SITE_B_HTML =
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>站点 B</title></head>' +
  '<body><article><h1>站点 B 文章</h1><p>NAV-ATTACH-B-SENTINEL</p></article></body></html>';

/** 本地静态站：host 缺省绑定 127.0.0.1；B 站不指定 host（双栈监听），http://localhost 的 ::1 / 127.0.0.1 解析皆可达。 */
function startSite(port, html, host) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolveSite, rejectSite) => {
    server.once('error', rejectSite);
    const onListen = () => resolveSite({ close: () => new Promise((done) => server.close(() => done())) });
    if (host === undefined) server.listen(port, onListen);
    else server.listen(port, host, onListen);
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
 * 从 system 注入的「# 任务组页面清单」解析行：句柄 | 标题 | origin+path | 状态 | pack。
 * URL 列是 origin+path（去 query/hash）截 80，故按前缀匹配。
 */
function parseGroupPages(sys) {
  const rows = [];
  for (const line of sys.split('\n')) {
    const cells = line.split(' | ');
    if (cells.length < 4 || !/^p\d+$/.test(cells[0])) continue;
    rows.push({ handle: cells[0], url: cells[2], status: cells[3] });
  }
  return rows;
}

/**
 * 内置脚本化 mock LLM（OpenAI chat completions 兼容，仅 stream:true）：按本轮已发出的 tool_call 数推进剧本；
 * 每一步先核对上一步 observation 的接入语义，失配即回 MOCK- 哨兵（面板断言随之红）。
 */
function startScriptedLlm() {
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
      const isBoundary = (m) => m?.role === 'user' && String(m?.content ?? '').startsWith('【站点边界】');
      let tail = messages.length - 1;
      while (tail >= 0 && isBoundary(messages[tail])) tail -= 1;
      const obs = messages[tail]?.role === 'tool' ? String(messages[tail].content ?? '') : null;
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user' && !isBoundary(m));
      const user = String(lastUser?.content ?? '');
      const sys = messages
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content ?? ''))
        .join('\n');
      const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '');
      let step = 0;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === 'user' && !isBoundary(m)) break;
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) step += m.tool_calls.length;
      }
      const groupPages = parseGroupPages(sys);
      requests.push({ user, obs, toolNames, step, groupPages });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-nav-attach',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
      };
      const send = (choice) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });

      const toolCall = (id, name, args) => ({ toolCall: { id, name, arguments: JSON.stringify(args) } });
      const has = (...needles) => obs !== null && needles.every((needle) => obs.includes(needle));
      const bHandle = groupPages.find((row) => row.url.startsWith(SITE_B_ORIGIN))?.handle;
      let decision;
      if (!user.includes('打开')) {
        decision = { text: 'MOCK-DEFAULT' };
      } else if (step === 0) {
        decision = toolNames.includes('open_url')
          ? toolCall('call_open_a', 'open_url', { url: SITE_A_URL, task: TASK, plan: PLAN, reason: '先打开 A 站' })
          : { text: 'MOCK-OPEN-URL-MISSING' };
      } else if (step === 1) {
        decision = has('"attached":true', '页面已接入')
          ? toolCall('call_open_b', 'open_url', { url: SITE_B_URL, task: TASK, reason: '再打开 B 站' })
          : { text: `MOCK-A-NOT-ATTACHED ${obs}` };
      } else if (step === 2) {
        decision = has('"attached":false', '尚未接入', '不要再次打开同一地址', '点击 Zen 图标')
          ? toolCall('call_open_b_again', 'open_url', { url: SITE_B_URL, task: TASK, reason: '再试一次打开 B 站' })
          : { text: `MOCK-B-OBS-UNEXPECTED ${obs}` };
      } else if (step === 3) {
        if (!has(`"error":"${ALREADY_OPEN}"`)) decision = { text: `MOCK-DENY-MISSING ${obs}` };
        else if (bHandle === undefined) decision = { text: `MOCK-B-HANDLE-MISSING ${JSON.stringify(groupPages)}` };
        else decision = toolCall('call_snapshot_b_1', 'page_snapshot', { targetPage: bHandle });
      } else if (step === 4) {
        if (!has('page-not-interactive', '最多重试一次')) decision = { text: `MOCK-SNAP1-UNEXPECTED ${obs}` };
        else if (bHandle === undefined) decision = { text: `MOCK-B-HANDLE-MISSING ${JSON.stringify(groupPages)}` };
        else decision = toolCall('call_snapshot_b_2', 'page_snapshot', { targetPage: bHandle });
      } else if (step === 5) {
        decision = has('page-not-interactive', '不要再重试', '点击 Zen 图标')
          ? { text: FINAL_REPLY }
          : { text: `MOCK-SNAP2-UNEXPECTED ${obs}` };
      } else {
        decision = { text: `MOCK-STEP-OVERFLOW ${step}` };
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

/** 真实 gateway 子进程：落点接入等待取产品默认值（ZA_NAV_ATTACH_WAIT_MS 未设），未接入分支按默认上限收口。 */
function spawnServer({ llmPort, auditPath, stateRoot }) {
  const child = spawn('node', [SERVER_MAIN], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // 落点接入等待取产品默认值：attached 断言依赖它，不随开发者 shell 的取值翻转。
      ZA_NAV_ATTACH_WAIT_MS: undefined,
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

/**
 * harness 侧旁听同一会话的 SSE 下行：服务端对所有订阅者广播同一帧序列，
 * 这里收不到 snapshot-request 即证明浏览器同样收不到。
 */
async function tapDownstream(sessionId, token) {
  const controller = new AbortController();
  const frames = [];
  const response = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert(response.ok, `旁听 SSE 失败：HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              frames.push(JSON.parse(line.slice(5).trim()));
            } catch {
              // 非 JSON 的心跳/注释行忽略
            }
          }
        }
      }
    } catch {
      // 中止即结束旁听
    }
  })();
  return { frames, close: () => controller.abort() };
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-nav-attach-e2e-'));
  const auditPath = join(tempRoot, 'audit.jsonl');
  const cleanups = [];
  let panel;
  let sw;
  rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  try {
    if (process.env.ZA_E2E_SKIP_BUILD === '1') {
      if (!existsSync(SERVER_MAIN)) throw new Error(`ZA_E2E_SKIP_BUILD=1 但 server 未构建：缺 ${SERVER_MAIN}`);
      console.log('[1/7] 跳过构建（ZA_E2E_SKIP_BUILD=1），使用既有产物…');
    } else {
      console.log('[1/7] 构建 server + extension…');
      await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);
      await run('pnpm', ['--filter', '@zen-agent/extension', 'run', 'build']);
    }

    await assertPortsFree([
      { port: SERVER_PORT, label: 'gateway' },
      { port: HOST_A_PORT, label: 'site A' },
      { port: HOST_B_PORT, label: 'site B' },
    ]);
    console.log(`[2/7] 起两站（A ${SITE_A_ORIGIN} 可接入 / B ${SITE_B_ORIGIN} 未授权）、脚本化 mock LLM 与真实 gateway…`);
    const siteA = await startSite(HOST_A_PORT, SITE_A_HTML, '127.0.0.1');
    cleanups.push(() => siteA.close());
    const siteB = await startSite(HOST_B_PORT, SITE_B_HTML);
    cleanups.push(() => siteB.close());
    const mock = await startScriptedLlm();
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

    console.log('[3/7] 真实 Chromium 加载 scoped 授权的 MV3 extension（只授权 http://127.0.0.1/*）…');
    const loadedExtensionDir = prepareExtensionDir(EXTENSION_DIR, { hostPermissions: GRANTED_HOST_PERMISSIONS });
    cleanups.push(() => removeExtensionDir(loadedExtensionDir));
    const loadedManifest = JSON.parse(readFileSync(join(loadedExtensionDir, 'manifest.json'), 'utf8'));
    assert(
      !loadedManifest.host_permissions.includes('<all_urls>'),
      `scoped 夹具清单不应含 <all_urls> host 权限：${JSON.stringify(loadedManifest.host_permissions)}`,
    );
    let context;
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
    const held = await sw.evaluate(async () => ({
      allUrls: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
      loopback: await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }),
    }));
    assert(held.allUrls === false, '浏览器内 <all_urls> 已被持有，scoped 夹具前提不成立');
    assert(held.loopback === true, '浏览器内 http://127.0.0.1/* 未被持有，A 站将无法接入');
    await sw.evaluate(async (base) => {
      await chrome.storage.local.set({ 'za.serverBaseUrl': base });
    }, SERVER_BASE);
    const extensionId = new URL(sw.url()).host;

    console.log('[4/7] 建立空白会话组并打开面板（权限询问桩化）…');
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
    await stubPermissionRequest(panel);
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const stubbed = await panel.evaluate(() => String(chrome.permissions.request).includes('__zaPermissionRequests'));
    assert(stubbed, '面板页的 chrome.permissions.request 未被桩化，批准点击会挂在授权气泡上');
    await panel.locator(`[data-za-shell][data-group-id="${group.groupId}"]`).waitFor({ timeout: 15_000 });
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });
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
    const installId = await sw.evaluate(async () => (await chrome.storage.local.get('za.installId'))['za.installId'] ?? '');
    assert(installId !== '', '插件未生成安装 id（匿名激活未发生）');
    const { token } = await activate(SERVER_BASE, installId);
    let sessionId = null;
    await waitFor(() => {
      const starts = auditEvents(auditPath).filter((event) => event.type === 'session-start');
      if (starts.length === 0) return false;
      sessionId = starts.at(-1).sessionId;
      return true;
    }, '审计出现 session-start');
    const downstream = await tapDownstream(sessionId, token);
    cleanups.push(() => downstream.close());

    console.log('[5/7] 任务指令 → 一张任务授权卡 → 批准（权限询问恰一次）→ A 接入 / B 未接入 / 止损 / 定向快照拒绝…');
    await panel.locator('#za-input').fill(`请先打开 ${SITE_A_URL}，再打开 ${SITE_B_URL} 并读取 B 的内容`);
    await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').click();

    const hitlCard = panel.locator('[data-za-hitl]').last();
    await hitlCard.waitFor({ timeout: 60_000 });
    const hitlText = await hitlCard.innerText();
    assert(hitlText.includes(`授权任务：${TASK}`), `卡未按任务授权卡呈现：${hitlText}`);
    const beforeApprove = await sw.evaluate(async (groupId) => (await chrome.tabs.query({ groupId })).length, group.groupId);
    assert(beforeApprove === 1, `批准前组内应只有那个空白页，实际 ${beforeApprove} 个`);
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'task-grant-card.png'), fullPage: true });
    await hitlCard.locator('[data-za-hitl-approve]').click();

    // contains → request 在点击处理里是一条 promise 链，点击返回时 request 未必已发出。
    await waitFor(
      async () => ((await readPermissionRequests(panel)).length > 0 ? true : 'permissions.request 尚未被调用'),
      '⑤ 批准手势内发起站点访问权限询问',
      5_000,
    );

    await waitFor(
      async () => {
        const state = await sw.evaluate(
          async ({ groupId, tabId }) => {
            const blank = await chrome.tabs.get(tabId).catch(() => null);
            return { groupTabs: (await chrome.tabs.query({ groupId })).length, blankUrl: blank?.url ?? null };
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
        if (text.includes('MOCK-')) throw new Error(`面板出现 mock 哨兵（剧本或产品语义失配）：${text.slice(-600)}`);
        return text.includes(FINAL_REPLY) ? true : text.slice(-160);
      },
      '面板出现含「点击 Zen 图标」指引的总结',
      120_000,
    );
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-final.png'), fullPage: true });

    console.log('[6/7] 断言：回喂接入语义、B silent 无 content、面板未接入原因与手动补接入、止损 deny、定向快照拒绝口径、无 snapshot-request 帧…');
    const stepObs = (step) => mock.requests.find((request) => request.step === step)?.obs ?? null;
    const obsA = stepObs(1);
    assert(obsA !== null && obsA.includes('"attached":true') && obsA.includes('页面已接入'), `① A 的回喂未标记已接入：${obsA}`);
    const obsB = stepObs(2);
    assert(obsB !== null && obsB.includes('"attached":false') && obsB.includes('尚未接入'), `② B 的回喂未标记未接入：${obsB}`);
    const manifestRows = mock.requests.find((request) => request.step === 3)?.groupPages ?? [];
    const rowB = manifestRows.find((row) => row.url.startsWith(SITE_B_ORIGIN));
    assert(rowB !== undefined && rowB.status === 'silent', `② 组页面清单里 B 应为 silent：${JSON.stringify(manifestRows)}`);
    const tabsAfter = await sw.evaluate(async (groupId) => {
      const tabs = await chrome.tabs.query({ groupId });
      return Promise.all(
        tabs.map(async (tab) => {
          let reachable = true;
          try {
            await chrome.tabs.sendMessage(tab.id, { kind: 'refresh-context' });
          } catch {
            reachable = false;
          }
          return { url: tab.url ?? '', reachable };
        }),
      );
    }, group.groupId);
    const tabsB = tabsAfter.filter((tab) => tab.url.startsWith(SITE_B_ORIGIN));
    assert(tabsB.length === 1, `③ 组内应恰有一个 B 页（同址止损不再开页），实际 ${JSON.stringify(tabsAfter)}`);
    assert(tabsB[0].reachable === false, '② B tab 上 content 不应可达（未授权 origin 注入必失败）');
    assert(tabsAfter.some((tab) => tab.url.startsWith(SITE_A_ORIGIN) && tab.reachable), `① A 页应已接入：${JSON.stringify(tabsAfter)}`);
    assert(tabsAfter.length === 2, `③ 组内 tab 应为 A + B 共 2 个，实际 ${tabsAfter.length}`);
    const hitlSeen = await panel.evaluate(() => window.__zaHitlSeen);
    assert(hitlSeen === 1, `③ 整回合应只出现一张 HITL 卡，实际 ${hitlSeen} 张`);
    const permissionRequests = await readPermissionRequests(panel);
    assert(permissionRequests.length === 1, `⑤ permissions.request 应恰调用一次，实际 ${permissionRequests.length} 次`);
    assert(
      JSON.stringify(permissionRequests[0]) === JSON.stringify({ origins: ['<all_urls>'] }),
      `⑤ permissions.request 实参应为 {origins:["<all_urls>"]}，实际 ${JSON.stringify(permissionRequests[0])}`,
    );

    const pageRows = panel.locator('[data-za-pages] [data-za-page-row]');
    await waitFor(
      async () => {
        const rows = await pageRows.allInnerTexts();
        if (rows.length !== 1) return `未接入信号区有 ${rows.length} 行：${JSON.stringify(rows)}`;
        return rows[0].includes(ATTACH_REASON_PERMISSION) ? true : rows[0];
      },
      `⑦ 面板未接入信号区恰有 B 一行且原因为「${ATTACH_REASON_PERMISSION}」`,
      30_000,
    );
    const rowUrl = await pageRows.first().locator('.za-page-name').getAttribute('title');
    assert(
      typeof rowUrl === 'string' && rowUrl.startsWith(SITE_B_ORIGIN),
      `⑦ 未接入行指向的应是 B 页，实际 ${rowUrl}`,
    );
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-unattached-page.png'), fullPage: true });
    // 手动补接入：按钮点击即用户手势，缺权限时先在手势内问该站点权限，再走一次真实注入重试。
    const injectedBeforeRetry = tabsB[0].reachable;
    assert(injectedBeforeRetry === false, '⑦ 重试前 B 就应是未接入态，前置不成立');
    await pageRows.first().locator('[data-za-page-attach]').click();
    await waitFor(
      async () => {
        const requests = await readPermissionRequests(panel);
        return requests.length === 2 ? true : `permissions.request 仍为 ${requests.length} 次`;
      },
      '⑦ 补接入按钮在手势内发出站点权限询问',
      10_000,
    );
    const retryRequests = await readPermissionRequests(panel);
    assert(
      JSON.stringify(retryRequests[1]) === JSON.stringify({ origins: [SITE_B_PERMISSION_PATTERN] }),
      `⑦ 补接入的权限询问实参应为 {origins:["${SITE_B_PERMISSION_PATTERN}"]}，实际 ${JSON.stringify(retryRequests[1])}`,
    );
    await waitFor(
      async () => {
        const notice = await panel.locator('[data-za-composer-notice]').innerText();
        return notice.includes('仍未接入') ? true : notice;
      },
      '⑦ 权限仍未授予时面板如实呈现补接入失败',
      15_000,
    );
    const reachableAfterRetry = await sw.evaluate(async (groupId) => {
      const tabs = await chrome.tabs.query({ groupId });
      for (const tab of tabs) {
        if (!(tab.url ?? '').startsWith('http://localhost:')) continue;
        try {
          await chrome.tabs.sendMessage(tab.id, { kind: 'refresh-context' });
          return true;
        } catch {
          return false;
        }
      }
      return null;
    }, group.groupId);
    assert(reachableAfterRetry === false, `⑦ 未授权的 B 页不应因一次重试就接上：${reachableAfterRetry}`);

    const events = auditEvents(auditPath);
    const decisions = events.filter((event) => event.type === 'tool-decision').map((event) => event.data);
    const denies = decisions.filter((decision) => decision.toolId === 'open_url' && decision.verdict === 'deny');
    assert(denies.length === 1 && denies[0].reason === ALREADY_OPEN, `③ 审计应恰有一条 open_url deny(${ALREADY_OPEN})：${JSON.stringify(denies)}`);
    const decisionSummary = decisions.map((decision) => `${decision.toolId}:${decision.verdict}`);
    assert(
      decisionSummary.join(',') === 'open_url:hitl,open_url:allow,open_url:deny',
      `tool-decision 序列不符：${decisionSummary.join(',')}`,
    );
    const obsSnap1 = stepObs(4);
    const obsSnap2 = stepObs(5);
    assert(obsSnap1 !== null && obsSnap1.includes('最多重试一次'), `④ 首次定向快照拒绝口径不符：${obsSnap1}`);
    assert(obsSnap2 !== null && obsSnap2.includes('不要再重试'), `④ 再次定向快照拒绝口径不符：${obsSnap2}`);
    const snapshotExecutions = events.filter(
      (event) => event.type === 'tool-execution' && event.data?.toolId === 'page_snapshot',
    );
    assert(
      snapshotExecutions.length === 2 && snapshotExecutions.every((event) => event.data.outcome === 'skipped'),
      `④ 两次定向快照应皆为 skipped：${JSON.stringify(snapshotExecutions.map((event) => event.data))}`,
    );
    const snapshotFrames = downstream.frames.filter((frame) => frame.type === 'snapshot-request');
    assert(snapshotFrames.length === 0, `④ 服务端不应广播 snapshot-request：${JSON.stringify(snapshotFrames)}`);
    assert(downstream.frames.some((frame) => frame.type === 'hitl-request'), '旁听 SSE 未收到任何帧，无法证明 snapshot-request 缺席');
    const finalText = await panel.locator('[data-za-messages]').innerText();
    assert(finalText.includes('点击 Zen 图标') && !finalText.includes('MOCK-'), `⑥ 面板最终文案不符：${finalText.slice(-300)}`);

    console.log('[7/7] 证据落盘…');
    const excerpt = events
      .filter((event) => ['session-start', 'assembly', 'tool-decision', 'hitl-verdict', 'tool-execution'].includes(event.type))
      .map((event) => JSON.stringify(event))
      .join('\n');
    assert(!excerpt.includes(installId), '审计片段泄漏了安装 id');
    assert(!/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(excerpt), '审计片段含 JWT 原文');
    writeFileSync(join(EVIDENCE_DIR, 'audit-excerpt.jsonl'), `${excerpt}\n`, 'utf8');
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify(
        {
          case: 'nav-attach',
          status: 'passed',
          ranAt: new Date().toISOString(),
          commit: gitCommit(),
          llm: 'scripted mock (inline)',
          groupId: group.groupId,
          decisions: decisionSummary,
          hitlCards: hitlSeen,
          permissionRequests,
          groupPages: manifestRows,
          attachRetryPermissionRequest: retryRequests[1],
          mockSteps: mock.requests.map((request) => request.step),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`导航落点接入语义 E2E 全部场景通过 ✅（证据：${EVIDENCE_DIR}）`);
  } catch (error) {
    const reason = failureReason(error);
    await panel?.screenshot({ path: join(EVIDENCE_DIR, 'panel-failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(
      join(EVIDENCE_DIR, 'result.json'),
      `${JSON.stringify({ case: 'nav-attach', status: 'failed', ranAt: new Date().toISOString(), commit: gitCommit(), reason }, null, 2)}\n`,
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
  console.error(`导航落点接入语义 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
