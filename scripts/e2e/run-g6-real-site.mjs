/**
 * E2E-E 真实站点主案例（实施方案 §6 案例 E）驱动：goofish.com 搜索 AI 相关商品 → 提取商品清单 →
 * 经 HITL 确认后写入飞书云盘 `zen-agent-test` 文件夹下的文档正文。真实 LLM + 真实站点 + 真实用户会话，
 * 全链路只经既有 generic pack `browse.page-operate`（riskTier=hitl，hitlMode=every-call）代操作。
 *
 * 写入落点是**文档正文**而非表格：飞书表格与多维表格的网格为 canvas 渲染，DOM 内既无单元格节点、
 * innerText 也读不到格内文本，DOM 工具面对其既不可观察也不可操作（实测：canvas=1、gridcell=0、
 * 键入内容不进 body 文本）。这是 DOM agent 对 canvas 类应用的能力边界，不是本脚本的取舍。
 *
 * 本脚本**不在 G6 自动批次内执行**：它依赖真实 LLM 凭证与操作者已登录的飞书/闲鱼页面会话，
 * 由操作者本人运行。平台零特权：不存任何 provider token，身份全部由持久化 Chromium profile 的
 * 页面会话承载（SEC-02）。
 *
 * 所需环境变量（**只列名字，值一律不写入本仓**；置于测试根 `.env`，以 --env-file 注入）：
 *   ZF_LLM_BASE_URL / ZF_LLM_API_KEY / ZF_LLM_MODEL   真实 provider 凭证，进程内映射为 ZA_LLM_*
 * 可选覆盖（无则用下方默认值）：
 *   ZA_E2E_PROFILE_DIR      持久化 Chromium 用户目录（须已登录 goofish 与飞书），默认 .za/e2e-profile-real-site
 *   ZA_E2E_FEISHU_DOC_URL   目标飞书文档 URL（zen-agent-test 文件夹内新建的空白文档，形如 /docx/<id>）
 *   ZA_E2E_SEARCH_KEYWORD   闲鱼搜索关键词，默认 “AI”
 *   ZA_E2E_ITEM_COUNT       要求提取并写入的商品条数，默认 5
 *   ZA_E2E_RUNS             重复跑次数，默认 3（通过门要求 ≥3 次全通过）
 *   ZA_E2E_EVIDENCE_DIR     证据归档目录，默认 <测试根>/e2e-evidence/e2e-e
 *
 * 单行运行命令（操作者在仓库根执行，<测试根> 换成自己存放 .env 的目录）：
 *   node scripts/e2e/run-g6-real-site.mjs --login          # 首次：在持久化 profile 里登录 goofish 与飞书
 *   node --env-file=<测试根>/.env scripts/e2e/run-g6-real-site.mjs --runs=3
 * 证据默认落 <repo>/.za/e2e/e2e-evidence/e2e-e；要落到别处用 ZA_E2E_TEST_ROOT 或 --evidence-dir=。
 *
 * 判定口径（四段式，全部满足才算该次通过；连续 3 次全通过才满足 §6 通过门）：
 *   前置：profile 已登录 goofish 与飞书；目标文档存在且正文为空；LLM 凭证可用。
 *   步骤：闲鱼搜索页 → 提取 N 条（标题+价格）→ 打开飞书文档并拖入同一任务组 → 指令追加 N 行，
 *         每行以本次运行标记 ZA-E2E-<runId> 开头。
 *   断言：① 文档中出现且恰好出现 N 处本次运行标记（新增行数 == 提取数）；
 *         ② 每一次写入批次都先出现 HITL 确认卡、且卡片出现时文档标记数仍为 0（确认先于写入）；
 *         ③ 审计含全链路：assembly → hitl-verdict(decision=approve) 与任务级复用的 tool-decision(verdict=allow, riskTier=hitl) → tool-execution(outcome=ok)，
 *            且逐条授权先于其代执行；
 *         ④ 面板提取清单条目数 == N（模型没有少提或编造）。
 *   证据：每次运行归档 面板截图 + 文档截图 + 脱敏审计片段 + result-<run>.json 到证据目录。
 *
 * oracle 可读性已实测：文档正文写入后进入 `document.body.innerText`，标记可数。
 * 尚未验证：闲鱼搜索结果页与飞书文档页的可交互要素能否被 page_snapshot 稳定采集、模型能否在
 * maxTurnRounds 内完成 N 行写入。文档正文的 `contenteditable=true` 只在聚焦后出现，未聚焦时
 * 快照里没有可写目标——模型须先点进正文，这一步能否稳定完成由首跑判定。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const EXTENSION_DIR = join(REPO_ROOT, 'apps', 'extension');
// 证据默认落仓内（.za 已在 gitignore）；机器专属位置由运行者以 ZA_E2E_TEST_ROOT 传入，
// 不写进源码——发布门脚本须能被他人在别的机器上复跑取证。
const TEST_ROOT = resolve(process.env.ZA_E2E_TEST_ROOT ?? join(REPO_ROOT, '.za', 'e2e'));

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
const FEISHU_DOC_URL = process.env.ZA_E2E_FEISHU_DOC_URL ?? '';

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

/**
 * 证据落盘前统一脱敏。本驱动是四个里唯一在真实 ZF_LLM_API_KEY 下运行的，
 * 证据又要长期留存作发布凭据——按 SEC-01/04 一律过滤，不依赖「当前事件体不含凭证」这一时点事实。
 */
function redact(text) {
  let out = text;
  for (const secret of [JWT_SECRET, SIGNING_SECRET, process.env.ZF_LLM_API_KEY]) {
    if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('[redacted-secret]');
  }
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]');
}

/**
 * 面板最后一条回复里的清单条目数。
 * 数的是渲染后的 DOM 列表项而非正文里的行首数字——面板 markdown 渲染器把「1. 」编号吃进 `<ol>`，
 * 而 innerText 不含 `<ol>` 的序号 marker，按文本数编号会恒为 0。
 * 模型不用列表语法时回退到按行首编号数正文行。
 */
async function countListItems(panel) {
  const last = panel.locator('[data-za-messages] .za-msg').last();
  if ((await last.count()) === 0) return 0;
  const rendered = await last.locator('ol > li, ul > li').count();
  if (rendered > 0) return rendered;
  const text = await last.innerText();
  const seen = new Set();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d{1,2})[.、)]/.exec(line);
    if (match !== null) seen.add(Number(match[1]));
  }
  return seen.size;
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

/**
 * 一次性登录引导（`--login`）：用同一 profile 目录开一个带扩展的 Chromium，操作者在其中登录
 * goofish 与飞书后关闭窗口即可；登录态留在 profile 里供后续每次 E2E 复用。
 * 平台零特权前提不变——凭证只存在于这个本机 profile，既不入仓也不经服务端（SEC-02）。
 */
async function bootstrapLogin() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const goofish = context.pages()[0] ?? (await context.newPage());
  await goofish.goto(GOOFISH_ORIGIN).catch(() => {});
  const feishu = await context.newPage();
  await feishu.goto(FEISHU_DOC_URL === '' ? 'https://feishu.cn' : FEISHU_DOC_URL).catch(() => {});
  console.log(`profile 目录：${PROFILE_DIR}`);
  console.log('在打开的窗口里分别登录 goofish 与飞书（飞书需能打开目标文档），完成后关闭整个浏览器窗口。');
  await new Promise((settle) => context.once('close', settle));
  console.log('登录态已写入 profile；接着跑：node --env-file=<测试根>/.env scripts/e2e/run-g6-real-site.mjs --runs=3');
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
 * 发一条指令并等回合收敛：期间出现的每张 HITL 卡都先记录「卡片出现时的文档标记数」再批准——
 * 「确认先于写入」是本案例的核心断言，不能只看卡片出现过。
 */
async function sendAndApprove(panel, text, observeMarkers, label) {
  const approvals = [];
  await panel.locator('#za-input').fill(text);
  await panel.locator('[data-za-action][data-mode="send"]').click();
  // 真实回合分钟级：无心跳时「模型在流式输出」与「回合彻底卡死」在日志上不可区分，
  // 而浏览器一旦中途关闭现场就全丢——心跳是唯一能穿过进程边界留下的进度证据。
  const startedAt = Date.now();
  let beatAt = 0;
  const heartbeat = async () => {
    const now = Date.now();
    if (now - beatAt < 20_000) return;
    beatAt = now;
    const chars = (await panelText(panel).catch(() => '')).length;
    const cards = await panel.locator('[data-za-hitl]').count().catch(() => -1);
    console.log(`    [${label} t+${Math.round((now - startedAt) / 1000)}s] 面板字数=${chars} HITL卡=${cards}`);
  };
  const settled = async () => {
    await heartbeat();
    const card = panel.locator('[data-za-hitl]').last();
    if (await card.count() > 0 && await card.locator('[data-za-hitl-approve]').count() > 0) {
      approvals.push({ at: new Date().toISOString(), markersBefore: await observeMarkers() });
      await card.locator('[data-za-hitl-approve]').click();
      return false;
    }
    return (await panel.locator('[data-za-action][data-mode="send"]:not([disabled])').count()) > 0;
  };
  try {
    await waitFor(settled, `指令收敛：${text.slice(0, 24)}…`, TURN_TIMEOUT_MS);
  } catch (error) {
    // 不收敛时面板是唯一现场：回合停在哪一步只能从它读出来，进程退出后无法重建。
    await panel.screenshot({ path: join(EVIDENCE_DIR, `failure-${label}.png`), fullPage: true }).catch(() => {});
    const shot = await panelText(panel).catch(() => '(面板文本读取失败)');
    writeFileSync(join(EVIDENCE_DIR, `failure-${label}.txt`), `${redact(shot)}\n`, 'utf8');
    console.error(`失败现场已归档：${EVIDENCE_DIR}/failure-${label}.{png,txt}`);
    console.error(`面板末尾：${shot.slice(-800)}`);
    throw error;
  }
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
    genericAllowlist: [GOOFISH_ORIGIN, new URL(FEISHU_DOC_URL).origin],
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

  const docPage = await context.newPage();
  await docPage.goto(FEISHU_DOC_URL, { waitUntil: 'domcontentloaded' });
  // 与用户「把标签拖进 Zen 任务组」等价：同组才共享会话与工具面围栏。
  const groupId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
    const groups = await chrome.tabGroups.query({ title: 'Zen' });
    if (groups[0] === undefined || tab?.id === undefined) return null;
    await chrome.tabs.group({ groupId: groups[0].id, tabIds: [tab.id] });
    return groups[0].id;
  }, FEISHU_DOC_URL);
  assert(typeof groupId === 'number', '飞书文档页未能加入 Zen 任务组');

  const markersInDoc = async () => {
    const text = await docPage.evaluate(() => document.body.innerText);
    return text.split(runTag).length - 1;
  };
  assert((await markersInDoc()) === 0, '运行标记在写入前已出现在文档中（标记不唯一）');

  const extractApprovals = await sendAndApprove(
    panel,
    `在当前闲鱼搜索结果页提取前 ${ITEM_COUNT} 条商品的标题与价格，按编号列出；先不要写入任何地方。`,
    markersInDoc,
    `extract-${runIndex + 1}`,
  );
  const extraction = await panelText(panel);
  // 条目数必须在提取轮结束时取——写入轮的回复会成为最后一条消息。
  const extractedItems = await countListItems(panel);
  await panel.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-extract.png`), fullPage: true });

  const writeApprovals = await sendAndApprove(
    panel,
    `把上面提取的 ${ITEM_COUNT} 条商品追加到当前飞书文档的正文末尾，每条占一行，` +
    `行格式为「${runTag} | 商品标题 | 价格」。只追加这 ${ITEM_COUNT} 行，不要修改任何已有内容。`,
    markersInDoc,
    `write-${runIndex + 1}`,
  );
  await docPage.bringToFront();
  await docPage.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-doc.png`), fullPage: false });
  await panel.screenshot({ path: join(EVIDENCE_DIR, `run-${runIndex + 1}-panel.png`), fullPage: true });

  // 提取数取自面板实际清单而非常量——否则「模型少提或编造补足」这条产品承诺零覆盖：
  // 拿 ITEM_COUNT 和 ITEM_COUNT 比恒真。
  assert(
    extractedItems === ITEM_COUNT,
    `面板提取清单为 ${extractedItems} 条，与要求的 ${ITEM_COUNT} 条不符（模型少提或多报）`,
  );
  const markers = await markersInDoc();
  assert(markers === extractedItems, `文档新增行数  与实际提取数  不一致`);
  assert(writeApprovals.length > 0, '写入未经任何 HITL 确认卡');
  assert(writeApprovals[0].markersBefore === 0, '首张确认卡出现前文档已有本次运行标记：存在未确认的写入');

  const events = auditEvents(auditPath).slice(auditBefore);
  const decisions = events.filter((event) => event.type === 'tool-decision');
  const executions = events.filter((event) => event.type === 'tool-execution');
  assert(events.some((event) => event.type === 'assembly'), '审计缺装配事件');
  assert(
    decisions.some((event) => event.data.riskTier === 'hitl'),
    '审计缺 hitl 分级的判定：本案例的写工具应为需确认档',
  );
  // 「确认先于写入」须按审计流逐条配对：只断言「存在人审放行」「存在代执行」无法区分
  // 「逐次确认」与「一次确认放行五次写入」——后者有四次写入无人确认。
  //
  // 人审放行只出现在 hitl-verdict.decision（tool-decision.verdict 闭集是 allow|hitl|deny，无 approve）；
  // 同一任务内的后续调用由 toolgate 以任务级授权复用放行，落 tool-decision.verdict='allow' 且 riskTier='hitl'，
  // 二者合起来才是「本次运行被授权过的写入次数」。
  const approvals = events.filter(
    (event) =>
      (event.type === 'hitl-verdict' && event.data.decision === 'approve') ||
      (event.type === 'tool-decision' && event.data.verdict === 'allow' && event.data.riskTier === 'hitl'),
  );
  assert(approvals.length > 0, '审计缺人审放行事件：写入未经任何确认');
  const okExecutions = executions.filter((event) => event.data.outcome === 'ok');
  assert(okExecutions.length > 0, '审计缺成功的代执行事件');
  assert(
    approvals.length >= okExecutions.length,
    `授权 ${approvals.length} 次少于成功代执行 ${okExecutions.length} 次：存在未经确认的写入`,
  );
  for (const [index, execution] of okExecutions.entries()) {
    const approval = approvals[index];
    assert(
      approval !== undefined && approval.ts <= execution.ts,
      `第 ${index + 1} 次代执行没有先于它的授权`,
    );
  }

  const excerpt = events.map((event) => JSON.stringify(event)).join('\n');
  assert(!excerpt.includes(token), '审计片段泄漏了访问令牌');
  writeFileSync(join(EVIDENCE_DIR, `run-${runIndex + 1}-audit.jsonl`), `${redact(excerpt)}\n`, 'utf8');
  writeFileSync(join(EVIDENCE_DIR, `result-${runIndex + 1}.json`), `${redact(JSON.stringify({
    case: 'E2E-E', run: runIndex + 1, status: 'passed', ranAt: new Date().toISOString(),
    runTag, keyword: SEARCH_KEYWORD, expectedItems: ITEM_COUNT, extractedItems, markersWritten: markers,
    extractApprovals: extractApprovals.length, writeApprovals: writeApprovals.length,
    approvals: approvals.length, executions: executions.length,
    extractionExcerpt: extraction.slice(-2000),
  }, null, 2))}\n`, 'utf8');

  await panel.close();
  await docPage.close();
}

async function main() {
  if (process.argv.includes('--login')) {
    await bootstrapLogin();
    return;
  }
  assert(FEISHU_DOC_URL !== '', '缺 ZA_E2E_FEISHU_DOC_URL：请指向 zen-agent-test 文件夹内的目标文档');
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
    }, [token, serverBase, [GOOFISH_ORIGIN, new URL(FEISHU_DOC_URL).origin]]);
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
