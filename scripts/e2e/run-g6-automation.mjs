/**
 * E2E-F 通用自动化（实施方案 §6 案例 F）浏览器级驱动：真实 Chromium + MV3 extension + 真实 gateway/assembly，
 * 用户自建 page-watch 触发器（adr-021）对**任意站点**（本地 origin，无任何 pack 围栏）周期只读运行。
 * 覆盖两条验收线：
 *  - G5 页面监测模板：首轮建基线不报告 → 页面变化产报告（摘要由服务端机械比对给出，R6）→ 无变化不打扰面板；
 *  - R7 无人值守底线：自动轮次中模型请求写工具 → 服务端结构性拒绝（不签发代执行、不弹 HITL）且审计留痕
 *    （tool-decision.verdict=deny + unattendedReadOnly=true）。
 *
 * LLM 一律走仓库自带确定性 mock（scripts/mock-llm/server.mjs），不加载任何 .env、不接触真实凭证。
 * 越权写调用由 watch.focus 携带 mock 的 '模拟越权写调用' 哨兵触发——真实 LLM 幻觉调用工具面外写工具的
 * 确定性替身（与 apps/server/test/watch-run.test.ts 同口径），被测的是服务端拒绝路径而非模型自觉。
 *
 * 运行：node scripts/e2e/run-g6-automation.mjs [--evidence-dir=<绝对路径>]
 */
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startMockLlm } from '../mock-llm/server.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
/** 被加载的插件目录；ZA_E2E_EXTENSION_DIR 可指向已打包/已解包的发布产物，对同一案例复跑。 */
const EXTENSION_DIR = process.env.ZA_E2E_EXTENSION_DIR
  ? resolve(process.env.ZA_E2E_EXTENSION_DIR)
  : join(REPO_ROOT, 'apps', 'extension');
const DEFAULT_EVIDENCE_DIR = '/Users/terrytu/Workspace2025/Working/tmp/zen-agent/e2e-evidence/e2e-f';
const EVIDENCE_DIR = resolve(
  process.argv.find((arg) => arg.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ??
    process.env.ZA_E2E_EVIDENCE_DIR ??
    DEFAULT_EVIDENCE_DIR,
);

// 本地 harness 的测试签名密钥：只用于签本次进程内的测试 JWT / 代执行 HMAC，非任何真实凭证。
const [JWT_SECRET, SIGNING_SECRET] = ['jwt', 'signing'].map(
  (role) => `g6-automation-e2e-${role}-${randomBytes(16).toString('hex')}`,
);
const JWT_ISS = 'zen-agent-demo';
const TENANT = 'g6-automation-tenant';
const HOST_USER_ID = 'g6-automation-user';

const STATUS_WATCH_ID = 'watch-status-board';
const GUARD_WATCH_ID = 'watch-guard-board';
/** mock LLM 的越权写调用哨兵与它会请求的写工具 id（该工具不在本轮任何工具面内）。 */
const WRITE_SENTINEL = '模拟越权写调用';
const WRITE_TOOL_ID = 'order-list.cancel-order';
/** 单轮自动化从触发到完成的等待上界：含 MV3 alarm 唤醒 + 快照往返 + mock LLM 回合。 */
const ROUND_TIMEOUT_MS = 120_000;

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
    iss: JWT_ISS, exp: Math.floor(Date.now() / 1000) + 3600,
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

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

/** 被监测的「任意站点」：普通业务看板页，无任何 pack 声明、不在 generic 准入名单内。 */
function boardHtml(title, prefix) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
    <h1>${title}</h1>
    <table>
      <thead><tr><th>商品</th><th>状态</th></tr></thead>
      <tbody id="rows">
        <tr><td>${prefix}-1001</td><td>在售</td></tr>
        <tr><td>${prefix}-1002</td><td>在售</td></tr>
      </tbody>
    </table>
  </body></html>`;
}

function startFixtureSite() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const body = path === '/guard'
      ? boardHtml('风控看板', 'RSK')
      : boardHtml('库存看板', 'SKU');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolveSite) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveSite({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function auditEvents(auditPath) {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function runEventsOf(auditPath, automationId) {
  return auditEvents(auditPath).filter(
    (event) => event.type === 'tool-execution' && event.data?.toolId === automationId,
  );
}

async function waitServiceWorker(context) {
  return context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
}

async function toolCards(panel) {
  return panel.locator('[data-za-toolcard]').allTextContents();
}

/** 面板上的 agent 回复气泡（自动回合的报告正文落此处）；无变化轮不应新增。 */
async function reportBubbles(panel) {
  return panel.locator('[data-za-messages] [data-role="assistant"]').allTextContents();
}

/**
 * 触发一轮自动化：写一次性 alarm（与生产同一条 chrome.alarms.onAlarm → triggerAutomation 路径）。
 * 轮次收尾以审计里该实例的新一轮 tool-execution 为准——面板只在「有变化」轮才收到报告卡与正文，
 * 故不能拿面板当收尾信号。expectReport 决定是等报告出现，还是留静默窗口证伪「不该有的打扰」。
 * 若期间出现服务端 toolId 兜底的完成卡（'已完成：automation'），说明本轮没被当作自动回合，
 * 立即报错而不空等——那是 automationId 未随上行帧送达。
 */
async function driveRound(sw, panel, auditPath, automationId, label, expectReport) {
  const runsBefore = runEventsOf(auditPath, automationId).length;
  const cardsBefore = await toolCards(panel);
  const bubblesBefore = await reportBubbles(panel);
  await sw.evaluate(
    (name) => chrome.alarms.create(name, { when: Date.now() + 100 }),
    `zen-agent.auto-scan.${automationId}`,
  );
  await waitFor(async () => {
    if (runEventsOf(auditPath, automationId).length > runsBefore) return true;
    const cards = await toolCards(panel);
    if (cards.slice(cardsBefore.length).some((card) => card.includes('已完成：automation'))) {
      throw new Error(
        `${label}：本轮未被服务端识别为自动回合——面板出现服务端兜底完成卡「已完成：automation」，` +
        `审计中没有 toolId=${automationId} 的 tool-execution；` +
        '自动回合的 automationId 没有随上行 user-message 帧送达服务端，R7 只读强制整条不可达',
      );
    }
    return false;
  }, `${label}：审计出现本轮 tool-execution`, ROUND_TIMEOUT_MS);
  if (expectReport) {
    await waitFor(
      async () => (await toolCards(panel)).length > cardsBefore.length,
      `${label}：面板出现带变化摘要的报告卡`,
      30_000,
    );
  }
  // 静默窗口：给面板留出渲染时间，使「无新增卡片/无新增回复」成为可证伪的断言而非竞态。
  await new Promise((settle) => setTimeout(settle, 2_000));
  return {
    event: runEventsOf(auditPath, automationId)[runsBefore],
    newCards: (await toolCards(panel)).slice(cardsBefore.length),
    newReports: (await reportBubbles(panel)).slice(bubblesBefore.length),
  };
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'zen-g6-automation-e2e-'));
  const sessionDir = join(tempRoot, 'sessions');
  const userConfigDir = join(tempRoot, 'user-config');
  const auditPath = join(tempRoot, 'audit.jsonl');
  const cleanups = [];
  let panel;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  try {
    console.log('[1/7] 构建 workspace（server + extension）…');
    await run('pnpm', ['-r', 'build']);

    console.log('[2/7] 启动被监测站点夹具、mock LLM 与真实 gateway…');
    const site = await startFixtureSite();
    cleanups.push(() => site.close());
    const statusUrl = `${site.origin}/status`;
    const guardUrl = `${site.origin}/guard`;

    const mock = await startMockLlm({ port: 0 });
    cleanups.push(() => mock.close());
    process.env.ZA_LLM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.ZA_LLM_MODEL = 'mock-model';
    const { startServer } = await import(pathToFileURL(join(REPO_ROOT, 'apps/server/dist/index.js')).href);
    const server = await startServer({
      port: 0, jwtSecret: JWT_SECRET, signingSecret: SIGNING_SECRET, issAllowlist: [JWT_ISS],
      snapshotRoot: join(REPO_ROOT, 'assets'), systemPromptPath: join(REPO_ROOT, 'assets/system-prompt.md'),
      auditSinkPath: auditPath, sessionDir, userConfigDir, heartbeatMs: 60_000,
      allowedProviders: ['openai-compatible'],
    });
    cleanups.push(() => server.close());
    const serverBase = `http://127.0.0.1:${server.port}`;
    const token = signTestJwt();

    console.log('[3/7] 写入用户自建触发器（PUT /v1/user-config，走 L2 双校验链）…');
    const overlay = {
      schemaVersion: 1,
      subject: { tenant: TENANT, hostUserId: HOST_USER_ID },
      packs: {},
      watches: [
        {
          id: STATUS_WATCH_ID, templateId: 'page-watch', url: statusUrl,
          minutes: 5, enabled: true, focus: '关注在售商品条目的增减',
        },
        {
          // focus 携带 mock 哨兵：驱动无人值守轮次里的越权写工具请求（模型幻觉的确定性替身）。
          id: GUARD_WATCH_ID, templateId: 'page-watch', url: guardUrl,
          minutes: 5, enabled: true, focus: `风控条目变化时${WRITE_SENTINEL}`,
        },
      ],
    };
    const written = await fetch(`${serverBase}/v1/user-config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(overlay),
    });
    assert(written.status === 200, `触发器写入失败：${written.status} ${await written.text()}`);

    console.log('[4/7] 真实 Chromium 加载 MV3 extension 并激活被监测页…');
    let context;
    let sw;
    for (const headless of [true, false]) {
      const profile = join(tempRoot, `profile-${headless}`);
      const candidate = await chromium.launchPersistentContext(profile, {
        headless,
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      let selected = false;
      try {
        const page = candidate.pages()[0] ?? await candidate.newPage();
        await page.goto(statusUrl);
        const worker = await waitServiceWorker(candidate);
        if (worker !== null) {
          context = candidate;
          sw = worker;
          selected = true;
          break;
        }
      } finally {
        if (!selected) await candidate.close().catch(() => {});
      }
    }
    if (context === undefined || sw === undefined) throw new Error('Chromium 未加载扩展 service worker');
    cleanups.push(() => context.close());

    await sw.evaluate(async ([authToken, base, origin]) => {
      await chrome.storage.local.set({
        'za.token': authToken, 'za.serverBaseUrl': base, 'za.autoActivate': [origin],
      });
    }, [token, serverBase, site.origin]);
    const page = context.pages()[0];
    await page.reload({ waitUntil: 'load' });
    const extensionId = new URL(sw.url()).host;
    panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 780 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });

    console.log('[5/7] 校验触发器已被本机调度接管（描述符合并 + alarm 排程）…');
    await waitFor(async () => {
      const descriptors = await sw.evaluate(async () => {
        const items = await chrome.storage.local.get('za.automationDescriptors');
        return items['za.automationDescriptors'] ?? [];
      });
      return [STATUS_WATCH_ID, GUARD_WATCH_ID].every(
        (id) => Array.isArray(descriptors) && descriptors.some((entry) => entry?.automation?.id === id),
      );
    }, '用户自建触发器派生出调度描述符', 30_000);
    const descriptors = await sw.evaluate(async () => {
      const items = await chrome.storage.local.get('za.automationDescriptors');
      return items['za.automationDescriptors'];
    });
    const statusDescriptor = descriptors.find((entry) => entry.automation.id === STATUS_WATCH_ID);
    assert(statusDescriptor.packId === 'user-watch', 'watch 派生描述符不应归属任何 pack');
    assert(statusDescriptor.origin === site.origin, 'watch 描述符围栏必须取实例 URL 的 origin');
    assert(statusDescriptor.automation.executionPreference === 'dom-only', 'watch 轮次必须走 dom-only');

    await sw.evaluate(async (ids) => {
      const entries = {};
      for (const id of ids) {
        entries[`za.autoScan.${id}.enabled`] = true;
        entries[`za.autoScan.${id}.minutes`] = 5;
      }
      await chrome.storage.local.set(entries);
    }, [STATUS_WATCH_ID, GUARD_WATCH_ID]);
    await waitFor(async () => {
      const alarms = await sw.evaluate(() => chrome.alarms.getAll());
      return [STATUS_WATCH_ID, GUARD_WATCH_ID].every(
        (id) => alarms.some((alarm) => alarm.name === `zen-agent.auto-scan.${id}`),
      );
    }, '两个触发器均已排程 alarm', 30_000);

    console.log('[6/7] E2E-F 主线：任意站点周期只读运行 → 首轮建基线 / 变化报告 / 无变化不打扰…');
    const baseline = await driveRound(sw, panel, auditPath, STATUS_WATCH_ID, '首轮建基线', false);
    assert(baseline.event.data.outcome === 'ok', `首轮未成功：${JSON.stringify(baseline.event.data)}`);
    assert(baseline.event.data.execution === 'server', '自动回合应记为服务端发起');
    assert(baseline.newCards.length === 0, `首轮建基线不应产报告卡：${baseline.newCards.join('|')}`);
    assert(baseline.newReports.length === 0, `首轮建基线不应产报告正文：${baseline.newReports.join('|')}`);

    await page.evaluate(() => {
      document.querySelector('#rows').insertAdjacentHTML(
        'beforeend', '<tr><td>SKU-1003</td><td>在售</td></tr>',
      );
    });
    const changed = await driveRound(sw, panel, auditPath, STATUS_WATCH_ID, '变化轮', true);
    assert(changed.event.data.outcome === 'ok', `变化轮未成功：${JSON.stringify(changed.event.data)}`);
    assert(changed.newCards.length === 1, `变化轮应恰好产一张报告卡：${changed.newCards.join('|')}`);
    assert(changed.newCards[0].includes('新增'), `报告卡缺服务端比对摘要：${changed.newCards[0]}`);
    assert(changed.newCards[0].includes('SKU-1003'), `变化摘要未指向新增要素：${changed.newCards[0]}`);
    assert(changed.newReports.length === 1, '检出变化后未向面板产出报告正文');
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-change-report.png'), fullPage: true });

    const stable = await driveRound(sw, panel, auditPath, STATUS_WATCH_ID, '无变化轮', false);
    assert(stable.event.data.outcome === 'ok', `无变化轮未成功：${JSON.stringify(stable.event.data)}`);
    assert(stable.newCards.length === 0, `无变化轮不应打扰面板：${stable.newCards.join('|')}`);
    assert(stable.newReports.length === 0, `无变化轮不应产报告正文：${stable.newReports.join('|')}`);

    console.log('[7/7] R7 无人值守底线：自动轮次中的写工具请求被拒且审计留痕…');
    await page.goto(guardUrl, { waitUntil: 'load' });
    await page.locator('#rows').waitFor();
    await panel.locator('#za-input:not([disabled])').waitFor({ timeout: 15_000 });
    const guardBaseline = await driveRound(sw, panel, auditPath, GUARD_WATCH_ID, 'R7 首轮建基线', false);
    assert(guardBaseline.event.data.outcome === 'ok', 'R7 首轮建基线未成功');
    assert(guardBaseline.newCards.length === 0, 'R7 首轮建基线不应产报告卡');

    await page.evaluate(() => {
      document.querySelector('#rows').insertAdjacentHTML(
        'beforeend', '<tr><td>RSK-1003</td><td>待复核</td></tr>',
      );
    });
    const guarded = await driveRound(sw, panel, auditPath, GUARD_WATCH_ID, 'R7 越权写调用轮', true);
    assert(guarded.event.data.outcome === 'ok', `R7 轮未收束：${JSON.stringify(guarded.event.data)}`);
    assert(guarded.newCards[0].includes('新增'), `R7 轮仍应如实报告变化：${guarded.newCards[0]}`);

    const events = auditEvents(auditPath);
    const denials = events.filter(
      (event) => event.type === 'tool-decision' &&
        event.data?.toolId === WRITE_TOOL_ID &&
        event.data?.verdict === 'deny',
    );
    assert(denials.length > 0, '无人值守轮次的写工具请求没有留下 deny 审计');
    assert(
      denials.every((event) => event.data.unattendedReadOnly === true),
      '拒绝事件缺 unattendedReadOnly 标记，无法被审计流机械识别为 R7 拒绝',
    );
    assert(
      String(denials[0].data.reason ?? '') !== '',
      'deny 审计缺可判读的拒绝理由',
    );
    const executions = events.filter(
      (event) => event.type === 'tool-execution' && event.data?.toolId === WRITE_TOOL_ID,
    );
    assert(executions.length === 0, `写工具在无人值守轮次被执行了 ${executions.length} 次`);
    assert(
      (await panel.locator('[data-za-hitl]').count()) === 0,
      '无人值守轮次弹出了 HITL 确认卡（无人可确认，等价拒绝）',
    );
    const cardTexts = (await toolCards(panel)).join('|');
    assert(!cardTexts.includes(WRITE_TOOL_ID), `面板出现了写工具执行卡：${cardTexts}`);
    await panel.screenshot({ path: join(EVIDENCE_DIR, 'panel-r7-denied.png'), fullPage: true });

    const watchIds = new Set([STATUS_WATCH_ID, GUARD_WATCH_ID]);
    const excerpt = events.filter(
      (event) => watchIds.has(event.data?.toolId) ||
        (event.type === 'tool-decision' && event.data?.toolId === WRITE_TOOL_ID) ||
        (event.type === 'assembly' && event.automationId !== undefined),
    );
    const excerptText = excerpt.map((event) => JSON.stringify(event)).join('\n');
    assert(!excerptText.includes(token), '审计片段泄漏了访问令牌');
    assert(!excerptText.includes(JWT_SECRET) && !excerptText.includes(SIGNING_SECRET), '审计片段泄漏了本地测试密钥');
    writeFileSync(join(EVIDENCE_DIR, 'audit-excerpt.jsonl'), `${excerptText}\n`, 'utf8');
    writeFileSync(join(EVIDENCE_DIR, 'result.json'), `${JSON.stringify({
      case: 'E2E-F', status: 'passed',
      ranAt: new Date().toISOString(),
      llm: 'deterministic mock (scripts/mock-llm/server.mjs)',
      watchedOrigin: site.origin,
      rounds: {
        baseline: { cards: baseline.newCards, outcome: baseline.event.data.outcome },
        changed: { cards: changed.newCards, outcome: changed.event.data.outcome },
        stable: { cards: stable.newCards, outcome: stable.event.data.outcome },
        r7Baseline: { cards: guardBaseline.newCards, outcome: guardBaseline.event.data.outcome },
        r7Denied: { cards: guarded.newCards, outcome: guarded.event.data.outcome },
      },
      r7: {
        denials: denials.length,
        unattendedReadOnly: denials.every((event) => event.data.unattendedReadOnly === true),
        writeToolExecutions: executions.length,
        hitlCards: 0,
      },
    }, null, 2)}\n`, 'utf8');

    console.log(`E2E-F 通用自动化 Chromium E2E 全部场景通过 ✅（证据：${EVIDENCE_DIR}）`);
  } catch (error) {
    // 失败也归档现场：面板截图 + 本次审计全量，供主进程判定是驱动问题还是产品缺陷。
    const reason = error instanceof Error ? error.message : String(error);
    await panel?.screenshot({ path: join(EVIDENCE_DIR, 'panel-failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(EVIDENCE_DIR, 'result.json'), `${JSON.stringify({
      case: 'E2E-F', status: 'failed', ranAt: new Date().toISOString(), reason,
      llm: 'deterministic mock (scripts/mock-llm/server.mjs)',
    }, null, 2)}\n`, 'utf8');
    writeFileSync(
      join(EVIDENCE_DIR, 'audit-excerpt.jsonl'),
      auditEvents(auditPath).map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
    throw error;
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`E2E-F 通用自动化 E2E 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
