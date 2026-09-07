/**
 * 功能配置评测 runner：协议层直驱场景集五维度（讲解正确/装配换出/引导命中/工具触发/HITL 触发），
 * 不经浏览器/插件——runner 自己扮演客户端：fetch 发上行帧、读 SSE 下行帧，
 * 收到 exec-instruction 即代插件之职 fetch 宿主 API 回 exec-result，收到 hitl-request 按场景 expect.hitlVerdict 回裁决。
 * 判据分三层：回答文本（mustMention/mustNotMention/judges）、服务端治理判定（expectDecisions 读本跑审计区间）、
 * 宿主环境态（hostState/hostCalls）。每场景跑 RUNS 次、全过才算过（ZA-C-EVAL-02）；跑完再校验审计事件链
 * 完整性与脱敏。`--check` 子命令不起 server 自检判据本身（探针字面在位 + 判据可证伪）。
 * 环境编排复用 scripts/e2e/run-m3.mjs 的形态（mock LLM + node dist/main.js + 宿主 API mock）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_LITERALS, startMockLlm } from '../mock-llm/server.mjs';
import { hostPortReplacements, materializeSnapshot } from '../e2e/snapshot-fixture.mjs';
import { assertPortsFree } from '../e2e/port-guard.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERVER_DIST = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const SCENARIOS_PATH = join(REPO_ROOT, 'evals', 'scenarios.json');
// 装配快照根（server 载入）+ pack 级评测发现根（ADR-013 §4：扫 packs 各 eval/scenarios.json 逐 pack 跑）。
// 四根分阶段各起一台 server（同端口先后独占）——各根的 pack origin 互不相同，须独立载入。当前分布：
//   host-demo   evals/scenarios.json 的 16 条主场景（该根下无 pack 级 eval 集）
//   acceptance  5 个验收 pack 共 46 条：codeflow-console 2 / generic-web 17 / mail-126 3 / xianyu-seller 19 / zhipin 5
//   assets      生产 pack generic-web 17 条
//   site-packs  已下线站点包 25 条：xianyu-seller 18 / yinxiang 7
const SNAPSHOT_ROOT = join(REPO_ROOT, 'examples', 'host-demo', 'config');
const ACCEPTANCE_ROOT = join(REPO_ROOT, 'examples', 'acceptance');
const COMMERCE_ROOT = join(REPO_ROOT, 'assets');
const SITE_PACKS_ROOT = join(REPO_ROOT, 'examples', 'site-packs');
const AUDIT_SCHEMA_PATH = join(REPO_ROOT, 'packages', 'contracts', 'schemas', 'audit-event.schema.json');
const AUDIT_SINK_PATH = join(REPO_ROOT, '.za', 'eval-events.jsonl');
// L2 用户配置落点单列一份：站点黑名单场景要写 overlay，写进开发常用的 .za/user-config
// 会污染 e2e/手动调试的既有状态；评测每次从空开始。
const USER_CONFIG_DIR = join(REPO_ROOT, '.za', 'eval-user-config');
const RUN_DATE = (() => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
})();
/**
 * 报告溯源锚：报告只声明"输入哈希"不足以复现——同一份 assets 在不同 commit 下由不同 runner/服务端跑出。
 * git 不可用（非仓库/无 git）时退回 'unknown' 而非抛错：评测本身不依赖版本控制。
 */
function gitRevision() {
  const read = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const commit = read(['rev-parse', '--short', 'HEAD']);
  const porcelain = read(['status', '--porcelain']);
  return { commit: commit === null || commit === '' ? 'unknown' : commit, dirty: porcelain !== '' };
}

const GIT_REVISION = gitRevision();
const REPORT_PATH = join(REPO_ROOT, 'evals', 'runs', `${RUN_DATE}-${GIT_REVISION.commit}-eval.md`);

const JWT_SECRET = 'za-test-secret';
const JWT_TENANT = 'eval-tenant';
const JWT_HOST_USER_ID = 'host-eval-user';
const SIGNING_SECRET = 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const SERVER_PORT = Number(process.env.ZA_EVAL_SERVER_PORT ?? 8791);
const MOCK_LLM_PORT = Number(process.env.ZA_EVAL_MOCK_PORT ?? 8792);
// host-demo pack 的 site.origin 与场景 URL 以 4173 书写：端口改动时快照物化、场景加载时同步替换，否则 origin 围栏不命中、featureId 落空。
const HOST_PORT = Number(process.env.ZA_EVAL_HOST_PORT ?? 4173);
const HOST_REPLACEMENTS = hostPortReplacements([[4173, HOST_PORT]]);
const SERVED_SNAPSHOT_ROOT = join(REPO_ROOT, '.za', 'eval-snapshot');
/** 读场景集：站点 origin 的端口替换为实际 HOST_PORT（默认端口下恒等）。 */
function loadScenarios(path) {
  let text = readFileSync(path, 'utf8');
  for (const [from, to] of HOST_REPLACEMENTS) text = text.replaceAll(from, to);
  return JSON.parse(text);
}
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;

const RUNS = Number(process.env.ZA_EVAL_RUNS ?? 3);
const TURN_TIMEOUT_MS = Number(process.env.ZA_EVAL_TURN_TIMEOUT_MS ?? 15000);
const QUIET_MS = Number(process.env.ZA_EVAL_QUIET_MS ?? 500);
const POLL_MS = Number(process.env.ZA_EVAL_POLL_MS ?? 120);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTestJwt() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: 'eval-user',
      tenant: JWT_TENANT,
      roles: ['user'],
      hostUserId: JWT_HOST_USER_ID,
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function sendApiJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 宿主初态：每跑重置，使「批准后状态已变 / 拒绝后状态未变」成为可断言的环境事实而非文本自述。 */
function createHostState() {
  return {
    orders: {
      'ORD-1001': { status: 'pending' },
      'ORD-1002': { status: 'pending' },
      'ORD-1003': { status: 'completed' },
    },
    calls: [],
  };
}

/**
 * 宿主 API mock：仅实现 tools.json adapter 命中的三个端点，代执行(exec-instruction)由 runner 直接 fetch 本服务。
 * 有状态——cancel/purge 真改订单状态、每次请求登记进 calls；控制面暴露 reset/snapshot 供每跑重置与事后断言。
 */
function startHostServer() {
  let state = createHostState();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', HOST_BASE);
    const path = decodeURIComponent(url.pathname);
    state.calls.push({ method: req.method, path });
    const cancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      const orderId = cancelMatch[1];
      if (state.orders[orderId] !== undefined) state.orders[orderId].status = 'cancelled';
      sendApiJson(res, 200, { ok: true, orderId });
      return;
    }
    if (req.method === 'GET' && path === '/api/orders') {
      sendApiJson(res, 200, { ok: true, count: Object.keys(state.orders).length });
      return;
    }
    if (req.method === 'DELETE' && path === '/api/orders') {
      state.orders = {};
      sendApiJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolveHost) => {
    server.listen(HOST_PORT, '127.0.0.1', () =>
      resolveHost({
        reset: () => {
          state = createHostState();
        },
        snapshot: () => structuredClone(state),
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

/** 当前宿主 mock 控制面（main 起服后赋值）；--check 不起服，判据以 createHostState() 的初态代入。 */
let hostControl = null;

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 退出码 ${code}`))));
  });
}

function startServer(snapshotRoot = SNAPSHOT_ROOT) {
  if (!existsSync(SERVER_DIST)) {
    throw new Error(`server 未构建：缺 ${SERVER_DIST}（先 pnpm --filter @zen-agent/server build）`);
  }
  const child = spawn('node', [SERVER_DIST], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: snapshotRoot,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(SERVER_PORT),
      ZA_LLM_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`,
      ZA_LLM_MODEL: 'mock-model',
      ZA_AUDIT_SINK: AUDIT_SINK_PATH,
      ZA_USER_CONFIG_DIR: USER_CONFIG_DIR,
      // 落点接入不等待：runner 在 exec-result 之前就上报落点页状态（active 或 silent），服务端只看当前状态表判 attached；
      // 若等待，未接入分支会让回合先在安静期判定里被收口，止损路径永远跑不到。
      ZA_NAV_ATTACH_WAIT_MS: '0',
    },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

async function waitServerReady() {
  await waitFor(
    async () => {
      try {
        return (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'OPTIONS' })).status === 204;
      } catch {
        return false;
      }
    },
    { label: 'server 就绪', timeoutMs: 20000 },
  );
}

/** 累积下行帧 + 最近一次到达时刻；用于判定一回合"已安静"（无新帧一段时间）而非依赖显式收尾帧。 */
function createFrameBus() {
  const frames = [];
  let lastActivity = Date.now();
  return {
    push(frame) {
      frames.push(frame);
      lastActivity = Date.now();
    },
    all: () => frames,
    idleMs: () => Date.now() - lastActivity,
  };
}

/** 用 fetch 流式读 SSE（EventSource 不支持自定义 header，故用 fetch stream 解析 data: 行）。 */
async function openSse(sessionId, token, bus) {
  const controller = new AbortController();
  const res = await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              bus.push(JSON.parse(line.slice(6)));
            } catch {
              /* 非 JSON data 行（不应出现），忽略 */
            }
          }
        }
      }
    } catch {
      /* 场景结束时 controller.abort() 使 read() 拒绝，属预期收尾 */
    }
  })();
  return { close: () => controller.abort() };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' };
}

async function postFrame(sessionId, token, frame) {
  return fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/frames`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(frame),
  });
}

/** 代插件之职：绝对化 exec-instruction 的相对 url、真实 fetch 宿主 API、把结果原样回喂为 exec-result。 */
async function executeInstruction(sessionId, token, frame, scenario) {
  const { request } = frame;
  // dom 代执行批次（ADR-013 send-email 等）：代插件之职回一个符合 resultSchema 的确定性结果
  // （reads 空对象 + completedSteps=步数），供回喂轮总结；不触真实浏览器。
  if (request?.kind === 'dom') {
    if (typeof scenario.execResultError === 'string') {
      await postFrame(sessionId, token, {
        type: 'exec-result',
        sessionId,
        nonce: frame.nonce,
        ok: false,
        error: scenario.execResultError,
      });
      return;
    }
    // 单步 navigate 批次（open_url / site_navigate）：resultSchema 要求 {url}，回传与真实插件
    // 到达回报同形的目标地址；其余 dom 批次沿用 reads/completedSteps 形态。
    const steps = Array.isArray(request.steps) ? request.steps : [];
    const navigateStep = steps.length === 1 && steps[0]?.action === 'navigate' ? steps[0] : null;
    // 落点页状态上报（真实插件由 background 在落点页入组后重报组页面表）：缺省落点页已接入（active，既有上报表
    // 整体降为 background）；scenario.landingAttached=false 则按真实客户端在注入失败时的上报形态记为 silent，
    // 不伪造接入。上报先于 exec-result，服务端回喂前据状态表判 attached（server 起在 ZA_NAV_ATTACH_WAIT_MS=0）。
    if (navigateStep !== null && typeof navigateStep.url === 'string') {
      const previous = (scenario.groupPagesReports ?? []).at(-1) ?? [];
      const landingStatus = scenario.landingAttached === false ? 'silent' : 'active';
      await postFrame(sessionId, token, {
        type: 'group-pages',
        sessionId,
        pages: [
          ...previous.map((page) => ({
            ...page,
            status: page.status === 'active' && landingStatus === 'active' ? 'background' : page.status,
          })),
          { handle: 'nav-landing', url: navigateStep.url, title: '', status: landingStatus },
        ],
      });
    }
    await postFrame(sessionId, token, {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: true,
      body:
        navigateStep !== null
          ? { url: navigateStep.url }
          : {
              // 场景可声明 read 采集值，使工具返回体承载页面来源的不可信内容（定界维度需要）。
              reads: scenario.execResultReads ?? {},
              completedSteps: steps.length === 0 ? 1 : steps.length,
            },
    });
    return;
  }
  const absoluteUrl = request.url.startsWith('http') ? request.url : `${HOST_BASE}${request.url}`;
  let execResult;
  try {
    const res = await fetch(absoluteUrl, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    execResult = {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: res.ok,
      status: res.status,
      ...(body !== undefined ? { body } : {}),
    };
  } catch {
    execResult = {
      type: 'exec-result',
      sessionId,
      nonce: frame.nonce,
      ok: false,
      error: '代执行请求发送失败（网络不可达）',
    };
  }
  await postFrame(sessionId, token, execResult);
}

/**
 * 单回合通用驱动：轮询下行帧，side-effect 地处理 hitl-request（按裁决表回决策）与 exec-instruction
 * （fetch 宿主 API 回 exec-result），并在文本/引导帧安静 QUIET_MS 后判定回合结束。
 * 各维度共用本函数——引导/工具/HITL 只是"途中多几帧"，终态判据一致。
 */
async function driveTurn(sessionId, token, scenario, bus) {
  const handledHitl = new Set();
  const handledExec = new Set();
  const handledSnapshot = new Set();
  let guideFrame = null;
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  for (;;) {
    for (const frame of bus.all()) {
      if (frame.type === 'hitl-request' && !handledHitl.has(frame.hitlId)) {
        handledHitl.add(frame.hitlId);
        const decision = scenario.expect?.hitlVerdict ?? 'approve';
        await postFrame(sessionId, token, {
          type: 'hitl-decision',
          sessionId,
          hitlId: frame.hitlId,
          decision,
        });
      }
      if (frame.type === 'snapshot-request' && !handledSnapshot.has(frame.requestId)) {
        // 代插件之职回一份确定性快照；pack 场景可声明需求相关元素，未声明则沿用发送按钮夹具。
        const snapshotIndex = handledSnapshot.size;
        handledSnapshot.add(frame.requestId);
        const snapshotFixture = scenario.snapshotSequence?.[snapshotIndex] ?? scenario;
        await postFrame(sessionId, token, {
          type: 'snapshot-report',
          sessionId,
          requestId: frame.requestId,
          // 导航后的快照来自落点页：夹具可声明 snapshotUrl 覆写上报的页面地址（缺省仍是场景页）。
          url: snapshotFixture.snapshotUrl ?? scenario.url ?? `${HOST_BASE}/${scenario.page}`,
          elements: snapshotFixture.snapshotElements ?? [{ ref: 'za-send', role: 'button', label: '发送' }],
          notices: snapshotFixture.snapshotNotices ?? [],
          // 正文只在场景显式声明时回传：默认不带 text，与客户端"未请求 includeText 即不采集正文"同真。
          ...(snapshotFixture.snapshotText !== undefined ? { text: snapshotFixture.snapshotText } : {}),
          ...(snapshotFixture.snapshotTextTruncated === true ? { textTruncated: true } : {}),
          ...(snapshotFixture.snapshotEvidence !== undefined
            ? { evidence: snapshotFixture.snapshotEvidence }
            : {}),
        });
      }
      if (frame.type === 'exec-instruction' && !handledExec.has(frame.nonce)) {
        handledExec.add(frame.nonce);
        await executeInstruction(sessionId, token, frame, scenario);
      }
      if (frame.type === 'guide-action' && guideFrame === null) {
        guideFrame = frame;
      }
    }

    const text = bus
      .all()
      .filter((f) => f.type === 'text-delta')
      .map((f) => f.delta)
      .join('');
    const toolCardSettled = bus
      .all()
      .some((f) => f.type === 'tool-card' && f.status !== 'running');
    const settled = bus.idleMs() > QUIET_MS && (text !== '' || guideFrame !== null || toolCardSettled);
    if (settled) return { text, guideFrame, frames: bus.all() };
    if (Date.now() > deadline) return { text, guideFrame, frames: bus.all(), timedOut: true };
    await sleep(POLL_MS);
  }
}

/**
 * 词界判定：命中处两侧须非「字母/数字/下划线」。英文等价 \b；中文因逐字成词，等价于"该词不与其他汉字连写"
 * ——「页面」在「这个页面是」里不成词，故 token 判据不会像子串那样对常见短词恒真。
 */
function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

function containsToken(text, keyword) {
  if (keyword === '') return false;
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(keyword, from);
    if (at < 0) return false;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + keyword.length])) return true;
    from = at;
  }
}

/** 判据类型闭集：kind 决定匹配语义，闭集外的 kind 一律判失败（防拼错静默恒真）。 */
const JUDGE_KINDS = {
  substring: (text, judge) => (judge.anyOf ?? []).some((keyword) => text.includes(keyword)),
  token: (text, judge) => (judge.anyOf ?? []).some((keyword) => containsToken(text, keyword)),
  regex: (text, judge) => new RegExp(judge.pattern, judge.flags ?? '').test(text),
};

/** 单条 judge 的可读目标描述，用于失败原因。 */
function describeJudge(judge) {
  return judge.kind === 'regex' ? `/${judge.pattern}/` : `[${(judge.anyOf ?? []).join('|')}]`;
}

/** 逐条 judge 连乘：任一不成立即该跑失败（"不得出现"仍走 mustNotMention）。 */
function evaluateJudges(judges, text) {
  const reasons = [];
  for (const judge of judges) {
    const match = JUDGE_KINDS[judge.kind];
    if (match === undefined) {
      reasons.push(`判据 kind「${judge.kind}」不在闭集 [${Object.keys(JUDGE_KINDS).join('|')}] 内`);
      continue;
    }
    if (!match(text, judge)) {
      reasons.push(`${judge.kind} 判据未命中 ${describeJudge(judge)}；实际文本：「${text}」`);
    }
  }
  return reasons;
}

function auditSize() {
  return existsSync(AUDIT_SINK_PATH) ? statSync(AUDIT_SINK_PATH).size : 0;
}

/**
 * 读审计 sink 自 fromByte 起的新增事件。runner 串行跑场景，故该区间即本跑独占的事件；
 * 事件按行 append 且落盘同步，字节偏移与行边界对齐。非法行忽略——行完整性由 checkAuditIntegrity 另判。
 */
function readAuditSince(fromByte) {
  if (!existsSync(AUDIT_SINK_PATH)) return [];
  const buf = readFileSync(AUDIT_SINK_PATH);
  return buf
    .subarray(Math.min(fromByte, buf.length))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** 期望判定 → 实际判定的失守归因（治理事件判据的可读结论）。 */
const VERDICT_DIAGNOSIS = {
  'hitl:allow': '该弹卡而未弹（期望挂起人审，实际直接放行）',
  'hitl:deny': '期望挂起人审，实际直接拒绝',
  'deny:allow': '该拒而未拒（期望拒绝，实际直接放行）',
  'deny:hitl': '该拒而未拒（期望拒绝，实际只挂起人审）',
  'allow:hitl': '期望直接放行，实际挂起人审',
  'allow:deny': '期望直接放行，实际被拒',
};

function describeDecision(decision) {
  const effective = decision.effectiveTier === undefined ? '' : `,effectiveTier=${decision.effectiveTier}`;
  return `${decision.verdict}(riskTier=${decision.riskTier}${effective})`;
}

/**
 * 治理判定判据：判据落在服务端决策留下的审计事实上，而非弹卡帧数——分级被误降为 auto 直执时，
 * 帧计数可能仍然自洽，但 tool-decision 的 verdict 必然改变，故此判据能证伪那类回归。
 * 期望 toolId 在区间内没有任何 tool-decision 事件 = 治理被绕过（工具执行了却没经过决策点）。
 */
function evaluateDecisions(expectDecisions, events) {
  const decisions = events.filter((event) => event.type === 'tool-decision').map((event) => event.data);
  const hitlByToolCall = new Map(
    events
      .filter((event) => event.type === 'hitl-verdict' && typeof event.data?.toolCallId === 'string')
      .map((event) => [event.data.toolCallId, event.data.decision]),
  );
  const reasons = [];
  for (const want of expectDecisions) {
    const sameTool = decisions.filter((decision) => decision.toolId === want.toolId);
    if (sameTool.length === 0) {
      const seen = decisions.map((d) => `${d.toolId}:${d.verdict}`).join(', ') || '无';
      reasons.push(`治理被绕过：本跑审计区间内没有 toolId=${want.toolId} 的 tool-decision 事件（区间内实际判定 [${seen}]）`);
      continue;
    }
    const matched = sameTool.filter(
      (decision) =>
        decision.verdict === want.verdict &&
        (want.riskTier === undefined || decision.riskTier === want.riskTier) &&
        (want.effectiveTier === undefined || decision.effectiveTier === want.effectiveTier) &&
        (want.reason === undefined || decision.reason === want.reason),
    );
    if (matched.length === 0) {
      const diagnosis = VERDICT_DIAGNOSIS[`${want.verdict}:${sameTool[0].verdict}`];
      const wanted = [
        `verdict=${want.verdict}`,
        ...(want.riskTier === undefined ? [] : [`riskTier=${want.riskTier}`]),
        ...(want.effectiveTier === undefined ? [] : [`effectiveTier=${want.effectiveTier}`]),
        ...(want.reason === undefined ? [] : [`reason=${want.reason}`]),
      ].join('/');
      reasons.push(
        `${want.toolId} 治理判定期望 ${wanted}，实际 [${sameTool.map(describeDecision).join(', ')}]` +
          `${diagnosis === undefined ? '' : `——${diagnosis}`}`,
      );
      continue;
    }
    if (want.hitlDecision !== undefined) {
      const actual = matched.map((decision) => hitlByToolCall.get(decision.toolCallId)).filter((v) => v !== undefined);
      if (!actual.includes(want.hitlDecision)) {
        reasons.push(
          `${want.toolId} 期望人审裁决 ${want.hitlDecision}，实际 [${actual.join(', ') || '区间内无配对 hitl-verdict 事件'}]`,
        );
      }
    }
  }
  return reasons;
}

function readStatePath(root, dotted) {
  return dotted.split('.').reduce((cur, key) => (cur === undefined || cur === null ? undefined : cur[key]), root);
}

function sameCall(call, want) {
  return call.method === want.method && call.path === want.path;
}

/**
 * 宿主状态判据：断言代执行留下的真实副作用。批准路径断言状态已变、拒绝路径断言状态未变且调用未发生——
 * 「未确认即执行」这类失守在文本层可能仍自洽，在状态层必红。
 */
function evaluateHostExpectations(expect, host) {
  const reasons = [];
  for (const [path, want] of Object.entries(expect.hostState ?? {})) {
    const actual = readStatePath(host, path);
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      reasons.push(`宿主状态 ${path} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
    }
  }
  const observed = host.calls.map((call) => `${call.method} ${call.path}`).join(', ') || '无';
  for (const want of expect.hostCalls ?? []) {
    if (!host.calls.some((call) => sameCall(call, want))) {
      reasons.push(`宿主未收到期望调用 ${want.method} ${want.path}；实际调用 [${observed}]`);
    }
  }
  for (const forbidden of expect.hostCallsAbsent ?? []) {
    if (host.calls.some((call) => sameCall(call, forbidden))) {
      reasons.push(`宿主收到了不应发生的调用 ${forbidden.method} ${forbidden.path}；实际调用 [${observed}]`);
    }
  }
  return reasons;
}

/**
 * guide 维度场景是否为"失配/降级"用例：scenarios.json 未开放机器可读的 hit/miss 字段，
 * 但两个已知 guide 场景恰以 mustNotMention 是否存在为界——命中场景(m2-guide-01)只有 behavior，
 * 失配场景(m2-guide-02)带 mustNotMention 断言不出现"已为你定位"。据此推断，不硬编码场景 id。
 */
function isGuideDegradeCase(expect) {
  return Array.isArray(expect.mustNotMention) && expect.mustNotMention.length > 0;
}

function evaluateOutcome(scenario, outcome) {
  const expect = scenario.expect;
  const text = outcome.text ?? '';
  const reasons = [];

  for (const group of expect.mustMention ?? []) {
    if (!group.some((keyword) => text.includes(keyword))) {
      reasons.push(`缺少必含关键词组 [${group.join('|')}]；实际文本：「${text}」`);
    }
  }
  for (const keyword of expect.mustNotMention ?? []) {
    if (text.includes(keyword)) {
      reasons.push(`出现禁止关键词「${keyword}」；实际文本：「${text}」`);
    }
  }
  reasons.push(...evaluateJudges(expect.judges ?? [], text));
  if (scenario.dimension === 'guide') {
    if (isGuideDegradeCase(expect)) {
      if (outcome.guideFrame !== null) {
        reasons.push('失配场景不应产出 guide-action 帧，但观察到一个');
      }
    } else if (outcome.guideFrame === null || outcome.guideFrame.selector === '') {
      reasons.push('命中场景应产出 guide-action 帧且 selector 非空，但未观察到');
    }
  }
  if (outcome.timedOut && reasons.length === 0 && text === '' && outcome.guideFrame === null) {
    reasons.push('等待下行帧超时（15s）且无任何可判定内容');
  }
  const frames = outcome.frames ?? [];
  const expectedCounts = expect.frameCounts ?? {};
  const targetCalls = frames.filter(
    (frame) =>
      frame.type === 'tool-card' &&
      frame.status === 'running' &&
      (expect.targetToolId === undefined || frame.toolId === expect.targetToolId),
  );
  const targetCallIds = new Set(targetCalls.map((frame) => frame.toolCallId));
  const targetInstructions = frames.filter(
    (frame) => frame.type === 'exec-instruction' && targetCallIds.has(frame.toolCallId),
  );
  const actualCounts = {
    targetToolCalls: targetCalls.length,
    execInstructions: new Set(targetInstructions.map((frame) => frame.nonce)).size,
    snapshotRequests: new Set(
      frames.filter((frame) => frame.type === 'snapshot-request').map((frame) => frame.requestId),
    ).size,
    hitlRequests: frames.filter(
      (frame) => frame.type === 'hitl-request' && targetCallIds.has(frame.toolCallId),
    ).length,
  };
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (actualCounts[name] !== expected) {
      reasons.push(`帧计数 ${name} 期望 ${expected}，实际 ${actualCounts[name] ?? '未知'}`);
    }
  }
  if (Array.isArray(expect.frameSequence)) {
    const actualSequence = frames.flatMap((frame) => {
      if (frame.type === 'snapshot-request') return ['snapshot'];
      if (frame.type === 'tool-card' && frame.status === 'running' && targetCallIds.has(frame.toolCallId)) {
        return ['target-tool'];
      }
      if (frame.type === 'exec-instruction' && targetCallIds.has(frame.toolCallId)) {
        return ['target-exec'];
      }
      return [];
    });
    if (JSON.stringify(actualSequence) !== JSON.stringify(expect.frameSequence)) {
      reasons.push(
        `关键帧顺序期望 [${expect.frameSequence.join(' → ')}]，实际 [${actualSequence.join(' → ')}]`,
      );
    }
  }
  if (typeof expect.evidenceRuleId === 'string') {
    const missing = frames.filter(
      (frame) =>
        frame.type === 'snapshot-request' &&
        !(frame.evidenceRules ?? []).some((rule) => rule.id === expect.evidenceRuleId),
    );
    if (missing.length > 0) reasons.push(`有 ${missing.length} 个快照请求缺证据配方 ${expect.evidenceRuleId}`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function runAssemblySwap(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const injections = [];
  for (const pagePath of scenario.flow) {
    await postFrame(sessionId, token, {
      type: 'context-report',
      sessionId,
      url: `${HOST_BASE}/${pagePath}`,
    });
    await sleep(100);
    const injection = await (
      await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, { headers: auth })
    ).json();
    injections.push(injection);
  }
  const last = injections[injections.length - 1];
  const first = injections[0];
  const reasons = [];
  if (last.featureId !== scenario.featureId) {
    reasons.push(`装配换出后 featureId 期望 ${scenario.featureId}，实际 ${last.featureId}`);
  }
  if (JSON.stringify(first.blocks) === JSON.stringify(last.blocks)) {
    reasons.push('装配换出前后 injection blocks 未变化，功能块未随 featureId 换出');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * pack 级评测发现（ADR-013 §4）：扫 <root>/packs 下各 pack 的 eval/scenarios.json，逐 pack 收其场景。
 * ZA-EVAL 素材同仓——pack 分发到哪评测跟到哪；本阶段 host-demo pack 暂无 eval 目录，发现为空即跳过。
 */
function discoverPackScenarios(root) {
  const packsDir = join(root, 'packs');
  if (!existsSync(packsDir)) return [];
  const discovered = [];
  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scenariosPath = join(packsDir, entry.name, 'eval', 'scenarios.json');
    if (!existsSync(scenariosPath)) continue;
    const scenarios = loadScenarios(scenariosPath);
    discovered.push({ packId: entry.name, scenarios });
  }
  return discovered;
}

/**
 * pack 级「装配」维度（ADR-013 §4 验收）：只经 /injection 自省端口断言装配结果，不驱动 LLM。
 * scenario.url 为完整 URL（含 pack origin），context-report 后拉取注入描述断言 packId/featureId 与工具面投影
 * （toolIncludes 须命中、toolExcludesPrefixes 前缀不得出现——后者证跨 pack 隔离与 fail-safe 回落）。
 * packId 断言用于"站点 pack 不命中→落到哪"的判别：仅基座（null）与通用兜底包是两种不同结局，
 * 只断 featureId 分不开。
 */
function judgeInjection(expect, injection) {
  const toolIds = Array.isArray(injection.toolIds) ? injection.toolIds : [];
  const reasons = [];
  if ('packId' in expect && injection.packId !== expect.packId) {
    reasons.push(`装配 packId 期望 ${JSON.stringify(expect.packId)}，实际 ${JSON.stringify(injection.packId)}`);
  }
  if ('featureId' in expect && injection.featureId !== expect.featureId) {
    reasons.push(`装配 featureId 期望 ${JSON.stringify(expect.featureId)}，实际 ${JSON.stringify(injection.featureId)}`);
  }
  for (const toolId of expect.toolIncludes ?? []) {
    if (!toolIds.includes(toolId)) {
      reasons.push(`工具面缺必含工具 ${toolId}；实际工具面 [${toolIds.join(', ')}]`);
    }
  }
  for (const prefix of expect.toolExcludesPrefixes ?? []) {
    const leaked = toolIds.filter((id) => id.startsWith(prefix));
    if (leaked.length > 0) {
      reasons.push(`工具面出现禁止前缀 ${prefix} 的工具 [${leaked.join(', ')}]`);
    }
  }
  return reasons;
}

/**
 * scenario.siteDenylist 声明本场景的前置 L2 站点黑名单：先写入 overlay 再上报页面，
 * 断言完毕无论成败都写回空态——黑名单是 subject 级持久状态，泄漏出去会静默改变后续场景的装配面。
 */
async function runAssemblyInjection(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const siteDenylist = scenario.siteDenylist ?? [];
  if (siteDenylist.length > 0) await putUserConfig(token, siteDenylist);
  try {
    const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
    const sessionId = created.sessionId;
    await postFrame(sessionId, token, { type: 'context-report', sessionId, url: scenario.url });
    await sleep(100);
    const injection = await (
      await fetch(`${SERVER_BASE}/v1/sessions/${sessionId}/injection`, { headers: auth })
    ).json();
    const reasons = judgeInjection(scenario.expect ?? {}, injection);
    return { pass: reasons.length === 0, reasons };
  } finally {
    if (siteDenylist.length > 0) await putUserConfig(token);
  }
}

/**
 * hitl「授权不复用」场景（ADR-013 every-call）：同一会话内对同一发送动作连发两次请求，
 * 断言两次都触发了对目标工具的 hitl-request（每次单独确认、不复用授权）。
 * per-task 工具第二次会因任务级授权复用而不再触发 hitl，故本断言可判别 every-call。
 */
async function runHitlNoReuse(scenario, token) {
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const bus = createFrameBus();
  const sse = await openSse(sessionId, token, bus);
  try {
    await postFrame(sessionId, token, { type: 'context-report', sessionId, url: scenario.url });
    await sleep(80);
    const rounds = scenario.expect?.hitlCount ?? 2;
    for (let i = 0; i < rounds; i += 1) {
      await postFrame(sessionId, token, { type: 'user-message', sessionId, text: scenario.question });
      await driveTurn(sessionId, token, scenario, bus);
    }
    const targetTool = scenario.expect?.hitlToolId;
    const hitlIds = new Set(
      bus
        .all()
        .filter((f) => f.type === 'hitl-request' && (!targetTool || f.toolId === targetTool))
        .map((f) => f.hitlId),
    );
    const reasons = [];
    if (hitlIds.size !== rounds) {
      reasons.push(
        `期望 ${targetTool ?? '目标工具'} 触发 ${rounds} 次独立 hitl-request（授权不复用），实际 ${hitlIds.size} 次`,
      );
    }
    return { pass: reasons.length === 0, reasons };
  } finally {
    sse.close();
  }
}

/**
 * 写 L2 用户配置（面板写入面）：assembly 维度的站点黑名单场景要先有 globalScope.siteDenylist，
 * 服务端 compose 才会回落仅基座。传空即写回空态——跑完不给后续场景留状态
 * （overlay 会随 subject 落盘、跨场景可见）。
 */
async function putUserConfig(token, siteDenylist = []) {
  const res = await fetch(`${SERVER_BASE}/v1/user-config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({
      schemaVersion: 1,
      subject: { tenant: JWT_TENANT, hostUserId: JWT_HOST_USER_ID },
      packs: siteDenylist.length > 0 ? { '*': { siteDenylist } } : {},
    }),
  });
  if (!res.ok) throw new Error(`用户配置写入失败：${res.status} ${await res.text()}`);
}

async function runScenarioCore(scenario, token) {
  if (scenario.dimension === 'assembly-swap') {
    return runAssemblySwap(scenario, token);
  }
  if (scenario.dimension === 'assembly') {
    return runAssemblyInjection(scenario, token);
  }
  if (scenario.dimension === 'hitl' && scenario.expect?.hitlCount !== undefined) {
    return runHitlNoReuse(scenario, token);
  }
  const auth = { authorization: `Bearer ${token}` };
  const created = await (await fetch(`${SERVER_BASE}/v1/sessions`, { method: 'POST', headers: auth })).json();
  const sessionId = created.sessionId;
  const bus = createFrameBus();
  const sse = await openSse(sessionId, token, bus);
  try {
    // pack 级场景用完整 url（含 pack origin）；存量场景用相对 page（挂 host-demo 本地 origin）。
    await postFrame(sessionId, token, {
      type: 'context-report',
      sessionId,
      url: scenario.url ?? `${HOST_BASE}/${scenario.page}`,
    });
    await sleep(80); // 让 context-report 落地先于 user-message（与既有 e2e 脚本一致的时序假设）
    // adr-023 D1：场景可声明组页面上报序列（每帧全量覆写状态表），按序落在 user-message 之前，
    // 驱动任务组页面清单注入；帧受理同步返回 204，顺序 await 即保证先后序。
    for (const pages of scenario.groupPagesReports ?? []) {
      await postFrame(sessionId, token, { type: 'group-pages', sessionId, pages });
    }
    // scenario.quickActionId 声明本轮以快捷提问发起（R-5）：客户端只发 id 与选区正文，
    // 模板由服务端查表展开——判据据此才能分辨「模板进了用户轮」与「模板漏进 system」。
    await postFrame(sessionId, token, {
      type: 'user-message',
      sessionId,
      text: scenario.question,
      ...(scenario.quickActionId !== undefined ? { quickActionId: scenario.quickActionId } : {}),
      ...(scenario.selectionText !== undefined ? { selectionText: scenario.selectionText } : {}),
    });
    const outcome = await driveTurn(sessionId, token, scenario, bus);
    return evaluateOutcome(scenario, outcome);
  } finally {
    sse.close();
  }
}

/**
 * 一跑 = 重置宿主状态 → 记审计偏移 → 驱动场景 → 在本跑独占的审计区间与宿主状态上追加判据。
 * 治理与副作用判据必须包住整跑：它们判的是"这一跑里服务端到底判了什么、宿主到底被改成什么"。
 */
async function runScenarioOnce(scenario, token) {
  hostControl?.reset();
  const auditFrom = auditSize();
  const outcome = await runScenarioCore(scenario, token);
  const expect = scenario.expect ?? {};
  const extra = [];
  if (Array.isArray(expect.expectDecisions)) {
    extra.push(...evaluateDecisions(expect.expectDecisions, readAuditSince(auditFrom)));
  }
  if (expect.hostState !== undefined || expect.hostCalls !== undefined || expect.hostCallsAbsent !== undefined) {
    extra.push(...evaluateHostExpectations(expect, hostControl?.snapshot() ?? createHostState()));
  }
  return extra.length === 0 ? outcome : { pass: false, reasons: [...outcome.reasons, ...extra] };
}

function loadAuditValidator() {
  // audit-event.schema.json 的 ts 字段用 format:date-time；ajv-formats 由 packages/audit
  // 的 devDependency 提供解析上下文（apps/server 不依赖 ajv-formats，故不能借它的 require）。
  const require = createRequire(join(REPO_ROOT, 'packages', 'audit', 'package.json'));
  const { Ajv2020 } = require('ajv/dist/2020.js');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv2020({ strict: true });
  (addFormats.default ?? addFormats)(ajv);
  const schema = JSON.parse(readFileSync(AUDIT_SCHEMA_PATH, 'utf8'));
  return ajv.compile(schema);
}

/** 与 packages/audit 落盘前脱敏同族的已知 secret 样式，用于独立复核事件确实未泄漏（defense-in-depth 复检，非脱敏实现本身）。 */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const REQUIRED_AUDIT_TYPES = [
  'session-start',
  'assembly',
  'tool-decision',
  'hitl-verdict',
  'tool-execution',
];

function checkAuditIntegrity() {
  const validate = loadAuditValidator();
  if (!existsSync(AUDIT_SINK_PATH)) {
    return { ok: false, reasons: [`审计 sink 不存在：${AUDIT_SINK_PATH}`], seenTypes: [], lineCount: 0 };
  }
  const raw = readFileSync(AUDIT_SINK_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  const reasons = [];
  const seenTypes = new Set();
  lines.forEach((line, i) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      reasons.push(`第 ${i + 1} 行不是合法 JSON`);
      return;
    }
    if (!validate(event)) {
      reasons.push(`第 ${i + 1} 行不过 audit-event schema：${JSON.stringify(validate.errors)}`);
      return;
    }
    seenTypes.add(event.type);
  });
  for (const requiredType of REQUIRED_AUDIT_TYPES) {
    if (!seenTypes.has(requiredType)) reasons.push(`审计事件链缺 type=${requiredType}`);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) reasons.push(`审计文件命中疑似 secret 样式：${pattern}`);
  }
  return { ok: reasons.length === 0, reasons, seenTypes: [...seenTypes], lineCount: lines.length };
}

function renderReport({ results, auditReport, dimensionSummary }) {
  const sourceHash = createHash('sha256');
  const addTree = (path) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) addTree(child);
      else if (entry.isFile()) sourceHash.update(child.slice(REPO_ROOT.length)).update(readFileSync(child));
    }
  };
  sourceHash.update(readFileSync(SCENARIOS_PATH));
  // 四个快照根都进哈希：前 16 个场景的装配输入就在 host-demo 根，漏掉它则该根改动不改哈希（报告谎报复现性）。
  addTree(SNAPSHOT_ROOT);
  addTree(ACCEPTANCE_ROOT);
  addTree(COMMERCE_ROOT);
  addTree(SITE_PACKS_ROOT);
  const project = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const lines = [];
  lines.push(`# zen-agent 功能配置评测报告 — ${RUN_DATE}`);
  lines.push('');
  lines.push(`代码版本：commit \`${GIT_REVISION.commit}\`；工作区 ${GIT_REVISION.dirty ? '**有未提交改动（dirty）**' : 'clean'}。`);
  lines.push(`证据环境：评测输入 SHA-256 \`${sourceHash.digest('hex')}\`（覆盖 evals/scenarios.json 与四个快照根 examples/host-demo/config、examples/acceptance、assets、examples/site-packs）；Node \`${project.engines.node}\`；\`${project.packageManager}\`。`);
  lines.push(`跑法：llmMode=\`mock\`（确定性替身，非真实模型）；runs=${RUNS}。`);
  lines.push(`runner：\`scripts/evals/run.mjs\`；每场景重复 ${RUNS} 次，需 ${RUNS}/${RUNS} 全过才算该场景通过（ZA-C-EVAL-02）。`);
  lines.push('');
  lines.push('## 场景通过率');
  lines.push('');
  lines.push('| id | dimension | 通过/跑次 | 结论 |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    const status = r.passCount === RUNS ? 'PASS' : 'FAIL';
    lines.push(`| ${r.id} | ${r.dimension} | ${r.passCount}/${RUNS} | ${status} |`);
  }
  lines.push('');
  const failed = results.filter((r) => r.passCount !== RUNS);
  if (failed.length > 0) {
    lines.push('### 失败明细');
    lines.push('');
    for (const r of failed) {
      lines.push(`- **${r.id}**`);
      r.runOutcomes.forEach((outcome, i) => {
        if (!outcome.pass) {
          lines.push(`  - run${i + 1}: ${outcome.reasons.join('; ')}`);
        }
      });
    }
    lines.push('');
  }
  lines.push('## 维度覆盖');
  lines.push('');
  lines.push('| dimension | 场景数 | 全绿场景数 |');
  lines.push('|---|---|---|');
  for (const [dim, summary] of Object.entries(dimensionSummary)) {
    lines.push(`| ${dim} | ${summary.total} | ${summary.allGreen} |`);
  }
  lines.push('');
  lines.push('## 审计完整性（Goal-f）');
  lines.push('');
  lines.push(`- 事件行数：${auditReport.lineCount}`);
  lines.push(`- 观测到的事件类型：${auditReport.seenTypes.join(', ') || '（无）'}`);
  lines.push(`- 结论：${auditReport.ok ? 'PASS（事件链完整、全过 schema、无 secret 样式）' : 'FAIL'}`);
  if (!auditReport.ok) {
    lines.push('');
    for (const reason of auditReport.reasons) lines.push(`  - ${reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 幂等停止 server 子进程：已退出即直接 resolve，避免二次 kill 时 exit 事件不再触发而永挂。 */
function makeStop(child) {
  let stopped = false;
  return () =>
    new Promise((r) => {
      if (stopped || child.exitCode !== null) return r();
      stopped = true;
      child.once('exit', () => r());
      child.kill('SIGTERM');
    });
}

/** 逐 pack 跑其 eval/scenarios.json（发现为空即打印跳过），结果并入 results。 */
async function runPackSets(root, token, results, excludedPackIds = new Set()) {
  const packSets = discoverPackScenarios(root);
  if (packSets.length === 0) {
    console.log(`  未发现 pack 级评测素材（${join(root, 'packs')}/*/eval/scenarios.json），跳过。`);
    return;
  }
  for (const { packId, scenarios: packScenarios } of packSets) {
    if (excludedPackIds.has(packId)) continue;
    console.log(`  pack「${packId}」：${packScenarios.length} 个场景 × ${RUNS} 次`);
    for (const scenario of packScenarios) {
      const runOutcomes = [];
      for (let i = 0; i < RUNS; i += 1) {
        try {
          runOutcomes.push(await runScenarioOnce(scenario, token));
        } catch (cause) {
          runOutcomes.push({ pass: false, reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`] });
        }
      }
      const passCount = runOutcomes.filter((r) => r.pass).length;
      results.push({ id: `${packId}/${scenario.id}`, dimension: scenario.dimension, passCount, runOutcomes });
      const status = passCount === RUNS ? 'PASS' : 'FAIL';
      console.log(`    [${status}] ${packId}/${scenario.id} (${scenario.dimension})：${passCount}/${RUNS}`);
      if (passCount !== RUNS) {
        runOutcomes.forEach((o, i) => {
          if (!o.pass) console.log(`        run${i + 1}: ${o.reasons.join('; ')}`);
        });
      }
    }
  }
}

async function main() {
  const cleanups = [];
  let failure = null;
  let allPassed = false;

  try {
    mkdirSync(dirname(AUDIT_SINK_PATH), { recursive: true });
    rmSync(AUDIT_SINK_PATH, { force: true });
    rmSync(USER_CONFIG_DIR, { recursive: true, force: true });

    console.log('[1/4] 构建 server…');
    await run('pnpm', ['--filter', '@zen-agent/server', 'run', 'build']);

    await assertPortsFree([
      { port: SERVER_PORT, label: 'gateway' },
      { port: MOCK_LLM_PORT, label: 'mock LLM' },
      { port: HOST_PORT, label: 'host' },
    ]);
    console.log('[2/4] 起 mock LLM…');
    const mock = await startMockLlm({ port: MOCK_LLM_PORT });
    cleanups.push(() => mock.close());

    console.log('[3/4] 起 server（host-demo 根）…');
    rmSync(SERVED_SNAPSHOT_ROOT, { recursive: true, force: true });
    materializeSnapshot(SNAPSHOT_ROOT, SERVED_SNAPSHOT_ROOT, HOST_REPLACEMENTS);
    const stopServer1 = makeStop(startServer(SERVED_SNAPSHOT_ROOT));
    cleanups.push(stopServer1);
    await waitServerReady();

    console.log('[4/4] 起宿主 API mock…');
    const host = await startHostServer();
    hostControl = host;
    cleanups.push(() => host.close());

    const token = signTestJwt();
    const scenarios = loadScenarios(SCENARIOS_PATH);

    console.log(`\n跑 ${scenarios.length} 个场景 × ${RUNS} 次：`);
    const results = [];
    for (const scenario of scenarios) {
      const runOutcomes = [];
      for (let i = 0; i < RUNS; i += 1) {
        try {
          runOutcomes.push(await runScenarioOnce(scenario, token));
        } catch (cause) {
          runOutcomes.push({ pass: false, reasons: [`运行异常：${cause instanceof Error ? cause.message : String(cause)}`] });
        }
      }
      const passCount = runOutcomes.filter((r) => r.pass).length;
      results.push({ id: scenario.id, dimension: scenario.dimension, passCount, runOutcomes });
      const status = passCount === RUNS ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${scenario.id} (${scenario.dimension})：${passCount}/${RUNS}`);
      if (passCount !== RUNS) {
        runOutcomes.forEach((o, i) => {
          if (!o.pass) console.log(`      run${i + 1}: ${o.reasons.join('; ')}`);
        });
      }
    }

    console.log('\n按根发现 pack 级评测（host-demo 根 · packs/*/eval/scenarios.json）…');
    await runPackSets(SNAPSHOT_ROOT, token, results);

    // acceptance 根的 pack（codeflow.asia/mail.126.com）与 host-demo 不同源，须换台 server 独立载入；
    // 同端口先停 host-demo server 再起 acceptance server（宿主 API mock 沿用，验收 pack 场景为装配/拒答，不触宿主 API）。
    console.log('\n停 host-demo server，换起 acceptance 根 server…');
    await stopServer1();
    const stopServer2 = makeStop(startServer(ACCEPTANCE_ROOT));
    cleanups.push(stopServer2);
    await waitServerReady();

    console.log('\n按根发现 pack 级评测（acceptance 根 · packs/*/eval/scenarios.json）…');
    await runPackSets(ACCEPTANCE_ROOT, token, results);
    await stopServer2();

    console.log('\n换起生产快照 server（assets）…');
    const stopServer3 = makeStop(startServer(COMMERCE_ROOT));
    cleanups.push(stopServer3);
    await waitServerReady();

    console.log('\n按根发现生产 pack 级评测（assets/packs/*/eval/scenarios.json）…');
    await runPackSets(COMMERCE_ROOT, token, results);
    await stopServer3();

    console.log('\n换起已下线站点包根 server（examples/site-packs）…');
    const stopServer4 = makeStop(startServer(SITE_PACKS_ROOT));
    cleanups.push(stopServer4);
    await waitServerReady();

    console.log('\n按根发现站点包级评测（examples/site-packs/packs/*/eval/scenarios.json）…');
    await runPackSets(SITE_PACKS_ROOT, token, results);
    await stopServer4();

    console.log('\n审计完整性校验…');
    const auditReport = checkAuditIntegrity();
    console.log(
      `  ${auditReport.ok ? 'PASS' : 'FAIL'}：${auditReport.lineCount} 条事件，类型 [${auditReport.seenTypes.join(', ')}]`,
    );
    if (!auditReport.ok) {
      for (const reason of auditReport.reasons) console.log(`    - ${reason}`);
    }

    const dimensionSummary = {};
    for (const r of results) {
      dimensionSummary[r.dimension] ??= { total: 0, allGreen: 0 };
      dimensionSummary[r.dimension].total += 1;
      if (r.passCount === RUNS) dimensionSummary[r.dimension].allGreen += 1;
    }

    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, renderReport({ results, auditReport, dimensionSummary }), 'utf8');
    console.log(`\n报告已写入 ${REPORT_PATH}`);

    allPassed = results.every((r) => r.passCount === RUNS) && auditReport.ok;
    console.log(allPassed ? '\nM4 评测全部通过 ✅' : '\nM4 评测存在未过项 ❌');
  } catch (error) {
    failure = error;
    console.error(`\n评测 runner 异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {});
    }
  }
  process.exit(failure || !allPassed ? 1 : 0);
}

// ---- --check：判据自检（PC-EVAL-05）。不起 server、不跑 LLM，纯静态+空输入推演 ----

/** 哨兵注入：packId/featureId 与工具面都取不可能命中的值，使任何真装配判据都必红。 */
const CHECK_SENTINEL_INJECTION = {
  packId: '__za-check-no-pack__',
  featureId: '__za-check-no-feature__',
  toolIds: ['__za-check-no-tool__'],
};
/** 空回合结局：无文本、无引导帧、无任何下行帧（timedOut 置 false，免超时兜底判据掩盖恒真判据）。 */
const CHECK_EMPTY_OUTCOME = { text: '', guideFrame: null, frames: [], timedOut: false };

/** 探针字面仍在其源文件内——字面漂移会让 mock 的注入内容探针静默恒 MISS/失活。 */
function checkProbeLiterals() {
  const problems = [];
  for (const probe of PROBE_LITERALS) {
    const path = join(REPO_ROOT, probe.sourceFile);
    if (!existsSync(path)) {
      problems.push(`探针「${probe.literal}」的 sourceFile 不存在：${probe.sourceFile}`);
      continue;
    }
    if (!readFileSync(path, 'utf8').includes(probe.literal)) {
      problems.push(`探针字面「${probe.literal}」已不在 ${probe.sourceFile}（${probe.why}）——该探针已静默失效`);
    }
  }
  return problems;
}

/** --check 的场景全集：本目录 scenarios.json + 四个快照根下自动发现的 pack 级评测。 */
function collectScenarioSets() {
  const sets = [{ label: 'evals/scenarios.json', scenarios: loadScenarios(SCENARIOS_PATH) }];
  for (const root of [SNAPSHOT_ROOT, ACCEPTANCE_ROOT, COMMERCE_ROOT, SITE_PACKS_ROOT]) {
    for (const { packId, scenarios } of discoverPackScenarios(root)) {
      sets.push({ label: `${root.slice(REPO_ROOT.length + 1)}/packs/${packId}`, scenarios });
    }
  }
  return sets;
}

/**
 * 场景判据在"空回答 + 零帧 + 零审计事件 + 宿主初态"上失败的理由。
 * 一条也没有 = 该场景的判据恒真（如只写 mustNotMention 的场景，agent 什么都不答也算过），无法证伪。
 * 非 evaluateOutcome 路径的两个维度另按其自有判据的必要输入判定。
 */
function falsifiableReasons(scenario) {
  const expect = scenario.expect ?? {};
  if (scenario.dimension === 'assembly') return judgeInjection(expect, CHECK_SENTINEL_INJECTION);
  if (scenario.dimension === 'assembly-swap') {
    return typeof scenario.featureId === 'string' ? [`比对换出后 featureId=${scenario.featureId}`] : [];
  }
  if (scenario.dimension === 'hitl' && expect.hitlCount !== undefined) {
    return expect.hitlCount >= 1 ? [`比对独立 hitl-request 次数=${expect.hitlCount}`] : [];
  }
  return [
    ...evaluateOutcome(scenario, CHECK_EMPTY_OUTCOME).reasons,
    ...evaluateDecisions(expect.expectDecisions ?? [], []),
    ...evaluateHostExpectations(expect, createHostState()),
  ];
}

function checkJudgeKinds(scenario) {
  return (scenario.expect?.judges ?? [])
    .filter((judge) => JUDGE_KINDS[judge.kind] === undefined)
    .map((judge) => `judges 的 kind「${judge.kind}」不在闭集 [${Object.keys(JUDGE_KINDS).join('|')}] 内`);
}

function runSelfCheck() {
  console.log('评测判据自检（--check：不起 server、不调 LLM）\n');
  const probeProblems = checkProbeLiterals();
  console.log(`[1/2] 注入内容探针字面（${PROBE_LITERALS.length} 条）…`);
  for (const problem of probeProblems) console.log(`  - ${problem}`);
  console.log(probeProblems.length === 0 ? '  全部在位 ✅' : `  ${probeProblems.length} 条失效 ❌`);

  const sets = collectScenarioSets();
  const scenarioProblems = [];
  let scenarioCount = 0;
  console.log(`\n[2/2] 场景判据可证伪性（${sets.length} 个场景集）…`);
  for (const { label, scenarios } of sets) {
    for (const scenario of scenarios) {
      scenarioCount += 1;
      for (const problem of checkJudgeKinds(scenario)) {
        scenarioProblems.push(`${label} / ${scenario.id}：${problem}`);
      }
      if (falsifiableReasons(scenario).length === 0) {
        scenarioProblems.push(
          `${label} / ${scenario.id}（${scenario.dimension}）：判据在「空回答 + 零帧 + 零事件」上仍全过——恒真，无法证伪`,
        );
      }
    }
  }
  for (const problem of scenarioProblems) console.log(`  - ${problem}`);
  console.log(
    scenarioProblems.length === 0
      ? `  ${scenarioCount} 个场景判据均可被证伪 ✅`
      : `  ${scenarioCount} 个场景中 ${scenarioProblems.length} 项问题 ❌`,
  );

  const ok = probeProblems.length === 0 && scenarioProblems.length === 0;
  console.log(ok ? '\n判据自检通过 ✅' : '\n判据自检未通过 ❌');
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--check')) runSelfCheck();
else main();
