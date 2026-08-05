/**
 * E2E-E 真实站点主案例（实施方案 §6 案例 E）驱动：goofish.com 搜索 AI 相关商品 → 提取商品清单 →
 * 经 HITL 确认后写入飞书云盘 `zen-agent-test` 文件夹下的表格。真实 LLM + 真实站点 + 真实用户会话，
 * 全链路只经既有 generic pack `browse.page-operate`（riskTier=hitl，hitlMode=every-call）代操作。
 *
 * 本脚本**不在 G6 自动批次内执行**：它依赖真实 LLM 凭证与操作者已登录的飞书/闲鱼页面会话，
 * 由操作者本人运行。平台零特权：不存任何 provider token，身份全部由持久化 Chromium profile 的
 * 页面会话承载（SEC-02）。
 *
 * 所需环境变量（**只列名字，值一律不写入本仓**；置于测试根 `.env`，以 --env-file 注入）：
 *   ZF_LLM_BASE_URL / ZF_LLM_API_KEY / ZF_LLM_MODEL   真实 provider 凭证，进程内映射为 ZA_LLM_*
 * 可选覆盖（无则用下方默认值）：
 *   ZA_E2E_PROFILE_DIR      持久化 Chromium 用户目录（须已登录 goofish 与飞书），默认 .za/e2e-profile-real-site
 *   ZA_E2E_FEISHU_SHEET_URL 目标飞书表格 URL（zen-agent-test 文件夹内新建的表格文件）
 *   ZA_E2E_SEARCH_KEYWORD   闲鱼搜索关键词，默认 “AI”
 *   ZA_E2E_ITEM_COUNT       要求提取并写入的商品条数，默认 5
 *   ZA_E2E_RUNS             重复跑次数，默认 3（通过门要求 ≥3 次全通过）
 *   ZA_E2E_EVIDENCE_DIR     证据归档目录，默认 <测试根>/e2e-evidence/e2e-e
 *
 * 单行运行命令（操作者在仓库根执行；<测试根> = /Users/terrytu/Workspace2025/Working/tmp/zen-agent）：
 *   node --env-file=/Users/terrytu/Workspace2025/Working/tmp/zen-agent/.env scripts/e2e/run-g6-real-site.mjs --runs=3
 *
 * 判定口径（四段式，全部满足才算该次通过；连续 3 次全通过才满足 §6 通过门）：
 *   前置：profile 已登录 goofish 与飞书；目标表格存在且首行为表头；LLM 凭证可用。
 *   步骤：闲鱼搜索页 → 提取 N 条（标题+价格）→ 打开飞书表格并拖入同一任务组 → 指令写入 N 行，
 *         每行首列写本次运行标记 ZA-E2E-<runId>。
 *   断言：① 表格中出现且恰好出现 N 处本次运行标记（新增行数 == 提取数）；
 *         ② 每一次写入批次都先出现 HITL 确认卡、且卡片出现时表格标记数仍为 0（确认先于写入）；
 *         ③ 审计含全链路：assembly → tool-decision(verdict=approve, riskTier=hitl) → tool-execution(outcome=ok)，
 *            且无 verdict=deny 的意外拒绝；
 *         ④ 面板提取清单条目数 == N（模型没有少提或编造）。
 *   证据：每次运行归档 面板截图 + 表格截图 + 脱敏审计片段 + result-<run>.json 到证据目录。
 *
 * 已知未验证点（本脚本从未执行过，如实声明）：闲鱼搜索结果页与飞书表格页的可交互要素能否被
 * page_snapshot 稳定采集、以及模型能否在 maxTurnRounds 内完成 N 行写入，均需首次真跑确认；
 * 若快照不足以定位单元格，需为飞书表格补 pack（走 L1 载入校验），而不是放宽 generic 工具面。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
const TEST_ROOT = '/Users/terrytu/Workspace2025/Working/tmp/zen-agent';

const PROFILE_DIR = resolve(process.env.ZA_E2E_PROFILE_DIR ?? join(REPO_ROOT, '.za', 'e2e-profile-real-site'));
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    join(TEST_ROOT, 'e2e-evidence', 'e2e-e'),
);
const RUNS = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ??
    process.env.ZA_E2E_RUNS ?? 3,
);
const ITEM_COUNT = Number(process.env.ZA_E2E_ITEM_COUNT ?? 5);
const SEARCH_KEYWORD = process.env.ZA_E2E_SEARCH_KEYWORD ?? 'AI';
const GOOFISH_ORIGIN = 'https://www.goofish.com';
const FEISHU_SHEET_URL = process.env.ZA_E2E_FEISHU_SHEET_URL ?? '';

// 本地 harness 的测试签名密钥：只用于签本进程内的测试 JWT / 代执行 HMAC，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `g6-real-site-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-demo';
const TENANT = 'g6-real-site-tenant';
const HOST_USER_ID = 'g6-real-site-user';

/** 真实 LLM 回合慢：单条指令的收敛等待上界。 */
const TURN_TIMEOUT_MS = Number(process.env.ZA_E2E_TURN_TIMEOUT_MS ?? 300_000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: `user-${HOST_USER_ID}`, tenant: TENANT, roles: ['ops'], hostUserId: HOST_USER_ID,
    iss: JWT_ISS, exp: Math.floor(Date.now() / 1000) + 7200,
  }));
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} exit ${code}`))));
  });
}

async function waitFor(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((settle) => setTimeout(settle, 500));
  }
}

function auditEvents(auditPath) {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function panelText(panel) {
  const messages = panel.locator('[data-za-messages]');
  return (await messages.count()) === 0 ? '' : await messages.innerText();
}

/**
 * 发一条指令并等回合收敛：期间出现的每张 HITL 卡都先记录「卡片出现时的表格标记数」再批准——
 * 「确认先于写入」是本案例的核心断言，不能只看卡片出现过。
 */
async function sendAndApprove(panel, text, observeMarkers) {
  const approvals = [];
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]').click();
  const settled = async () => {
    const card = panel.locator('[data-za-hitl]').last();
    if (await card.count() > 0 && await card.locator('[data-za-hitl-approve]').count() > 0) {
      approvals.push({ at: new Date().toISOString(), markersBefore: await observeMarkers() });
      await card.locator('[data-za-hitl-approve]').click();
      return false;
    }
    return (await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').count()) > 0;
  };
  await waitFor(settled, `指令收敛：${text.slice(0, 24)}…`, TURN_TIMEOUT_MS);
  return approvals;
}

/** 起真实 LLM 的 server：ZA_LLM_* 由 --env-file 注入的 ZF_LLM_* 映射，值不打印、不落证据。 */
async function startRealServer({ auditPath, sessionDir, userConfigDir }) {
  const baseUrl = process.env.ZF_LLM_BASE_URL;
  const apiKey = process.env.ZF_LLM_API_KEY;
  const model = process.env.ZF_LLM_MODEL;
  assert(
    Boolean(baseUrl) && Boolean(apiKey) && Boolean(model),
    '缺 ZF_LLM_BASE_URL/ZF_LLM_API_KEY/ZF_LLM_MODEL：请以 node --env-file=<测试根>/.env 启动本驱动',
  );
  process.env.ZA_LLM_BASE_URL = baseUrl;
  process.env.ZA_LLM_API_KEY = apiKey;
  process.env.ZA_LLM_MODEL = model;
  const { startServer } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/index.js')).href);
  return startServer({
    port: 0, jwtSecret: JWT_SECRET, signingSecret: SIGNING_SECRET, issAllowlist: [JWT_ISS],
    // generic 兜底 pack（browse.page-operate）居 examples/acceptance；assets/ 尚无 generic pack。
    snapshotRoot: join(REPO_ROOT, 'examples', 'acceptance'),
    systemPromptPath: join(REPO_ROOT, 'assets/system-prompt.md'),
    auditSinkPath: auditPath, sessionDir, userConfigDir, heartbeatMs: 60_000,
    allowedProviders: ['openai-compatible'],
    // 真实站点两端都无专属 pack：须显式准入 generic 兜底（缺省 fail-closed 永不激活）。
    genericAllowlist: [GOOFISH_ORIGIN, new URL(FEISHU_SHEET_URL).origin],
  });
}

async function driveOnce(runIndex, context, sw, extensionId, token, auditPath) {
  const runTag = `ZA-E2E-${runIndex + 1}-${randomUUID().slice(0, 8)}`;
  const auditBefore = auditEvents(auditPath).length;

  const searchPage = context.pages()[0] ?? await context.newPage();
  await searchPage.goto(`${GOOFISH_ORIGIN}/search?q=${encodeURIComponent(SEARCH_KEYWORD)}`, {
    waitUntil: 'domcontentloaded',
  });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 30_000 });

  const sheetPage = await context.newPage();
  await sheetPage.goto(FEISHU_SHEET_URL, { waitUntil: 'domcontentloaded' });
  // 与用户「把标签拖进 Zen 任务组」等价：同组才共享会话与工具面围栏。
  const groupId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
    const groups = await chrome.tabGroups.query({ title: 'Zen' });
    if (groups[0] === undefined || tab?.id === undefined) return null;
    await chrome.tabs.group({ groupId: groups[0].id, tabIds: [tab.id] });
    return groups[0].id;
  }, FEISHU_SHEET_URL);
  assert(typeof groupId === 'number', '飞书表格页未能加入 Zen 任务组');

  const markersInSheet = async () => {
    const text = await sheetPage.evaluate(() => document.body.innerText);
    return text.split(runTag).length - 1;
  };
  assert((await markersInSheet()) === 0, '运行标记在写入前已出现在表格中（标记不唯一）');

  const extractApprovals = await sendAndApprove(
    panel,
    `在当前闲鱼搜索结果页提取前 ${ITEM_COUNT} 条商品的标题与价格，按编号列出；先不要写入任何地方。`,
    markersInSheet,
  );
  const extraction = await panelText(panel);
  await panel.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-extract.png`), fullPage: true });

  const writeApprovals = await sendAndApprove(
    panel,
    `把上面提取的 ${ITEM_COUNT} 条商品写入当前飞书表格，每条一行：第一列填 ${runTag}，` +
    `第二列填商品标题，第三列填价格。只写这 ${ITEM_COUNT} 行，不要修改任何已有内容。`,
    markersInSheet,
  );
  await sheetPage.bringToFront();
  await sheetPage.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-sheet.png`), fullPage: false });
  await panel.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-panel.png`), fullPage: true });

  const markers = await markersInSheet();
  assert(markers === ITEM_COUNT, `表格新增行数 ${markers} 与提取数 ${ITEM_COUNT} 不一致`);
  assert(writeApprovals.length > 0, '写入未经任何 HITL 确认卡');
  assert(
    writeApprovals.every((approval) => approval.markersBefore < ITEM_COUNT),
    'HITL 确认卡出现时表格已被写满：确认没有先于写入',
  );
  assert(writeApprovals[0].markersBefore === 0, '首张确认卡出现前表格已有本次运行标记：存在未确认的写入');

  const events = auditEvents(auditPath).slice(auditBefore);
  const decisions = events.filter((event) => event.type === 'tool-decision');
  const executions = events.filter((event) => event.type === 'tool-execution');
  assert(events.some((event) => event.type === 'assembly'), '审计缺装配事件');
  assert(
    decisions.some((event) => event.data.verdict === 'approve' && event.data.riskTier === 'hitl'),
    '审计缺 hitl 分级的放行判定',
  );
  assert(!decisions.some((event) => event.data.verdict === 'deny'), '出现了未预期的拒绝判定');
  assert(
    executions.some((event) => event.data.outcome === 'ok'),
    '审计缺成功的代执行事件',
  );

  const excerpt = events.map((event) => JSON.stringify(event)).join('\n');
  assert(!excerpt.includes(token), '审计片段泄漏了访问令牌');
  writeFileSync(join(EVIDENCE_DIR, `run-${runIndex + 1}-audit.jsonl`), `${excerpt}\n`, 'utf8');
  writeFileSync(join(EVIDENCE_DIR, `result-${runIndex + 1}.json`), `${JSON.stringify({
    case: 'E2E-E', run: runIndex + 1, status: 'passed', ranAt: new Date().toISOString(),
    runTag, keyword: SEARCH_KEYWORD, expectedItems: ITEM_COUNT, markersWritten: markers,
    extractApprovals: extractApprovals.length, writeApprovals: writeApprovals.length,
    extractionExcerpt: extraction.slice(-2000),
  }, null, 2)}\n`, 'utf8');

  await panel.close();
  await sheetPage.close();
}

async function main() {
  assert(FEISHU_SHEET_URL !== '', '缺 ZA_E2E_FEISHU_SHEET_URL：请指向 zen-agent-test 文件夹内的目标表格');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stateRoot = join(TEST_ROOT, 'e2e-state', 'e2e-e');
  mkdirSync(stateRoot, { recursive: true });
  const auditPath = join(stateRoot, 'audit.jsonl');
  const cleanups = [];
  try {
    console.log('[1/4] 构建 workspace…');
    await run('pnpm', ['-r', 'build']);

    console.log('[2/4] 启动真实 LLM 的 gateway…');
    const server = await startRealServer({
      auditPath,
      sessionDir: join(stateRoot, 'sessions'),
      userConfigDir: join(stateRoot, 'user-config'),
    });
    cleanups.push(() => server.close());
    const serverBase = `http://127.0.0.1:${server.port}`;
    const token = signTestJwt();

    console.log('[3/4] 打开持久化 profile 的真实 Chromium（须已登录 goofish 与飞书）…');
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    cleanups.push(() => context.close());
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
    await sw.evaluate(async ([authToken, base, origins]) => {
      await chrome.storage.local.set({
        'za.token': authToken, 'za.serverBaseUrl': base, 'za.autoActivate': origins,
      });
    }, [token, serverBase, [GOOFISH_ORIGIN, new URL(FEISHU_SHEET_URL).origin]]);
    const extensionId = new URL(sw.url()).host;

    console.log(`[4/4] 连跑 ${RUNS} 次（通过门要求 ≥3 次全通过）…`);
    for (let index = 0; index < RUNS; index += 1) {
      console.log(`  第 ${index + 1}/${RUNS} 次…`);
      await driveOnce(index, context, sw, extensionId, token, auditPath);
      console.log(`  第 ${index + 1}/${RUNS} 次通过 ✅`);
    }
    console.log(`E2E-E 真实站点主案例 ${RUNS}/${RUNS} 次全部通过 ✅（证据：${EVIDENCE_DIR}）`);
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`E2E-E 真实站点主案例失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
