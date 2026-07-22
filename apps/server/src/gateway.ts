/**
 * 会话网关：HTTP 上行帧（C3 schema 校验 fail-closed）→ agent 回合 → SSE 下行帧。
 * 每轮注入由 assembly.compose 整段重建覆写（不 append 进历史）；
 * 工具面（guide 内建工具 + 宿主 API 工具）由服务端注入 LLM；宿主 API 代执行的分级/HITL 判定
 * 只在 toolgate、fail-closed（U7），LLM 失败以脱敏文案下发（SEC-04）。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  isDomTool,
  SITE_NAVIGATE_PARAMS_SCHEMA,
  SITE_NAVIGATE_RESULT_SCHEMA,
  SITE_NAVIGATE_TOOL_ID,
} from '@zen-agent/contracts';
import type {
  AssemblyPort,
  AuditEvent,
  AuditPort,
  ComposeResult,
  DomGateContext,
  DomToolDefinition,
  DownstreamFrame,
  ExecutionPreference,
  ExecResultFrame,
  GuideActionKind,
  GuideActionFrame,
  HitlDecisionValue,
  IdentityClaims,
  FulfillmentCoordinatorPort,
  JsonObject,
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  Observation,
  ResolveFeatureResult,
  SiteDescriptor,
  SnapshotReportFrame,
  SnapshotEvidenceRule,
  ToolCardStatus,
  ToolDefinition,
  ToolGatePort,
  UpstreamFrame,
} from '@zen-agent/contracts';
import type { TokenVerifier } from './auth.js';
import { signDemoToken, type DemoTokenSigner } from './demo-token.js';
import {
  BOUNDARY_MARKER,
  compressHistory,
  estimateHistoryTokens,
  shouldCompress,
  type UsageTokens,
} from './compress.js';
import { pruneStaleSnapshots, SNAPSHOT_TOOL_NAME } from './history.js';
import { listApplications, recordApplication } from './applications.js';
import type { SessionState, SessionStore } from './sessions.js';
import {
  executionPreferenceInstruction,
  selectToolsForPreference,
} from './execution-preference.js';
import {
  deriveXianyuFulfillmentInput,
  PREPARE_XIANYU_FULFILLMENT_TOOL_NAME,
  PREPARE_XIANYU_FULFILLMENT_TOOL_SPEC,
} from './xianyu-fulfillment.js';
import {
  deriveXianyuShipmentInput,
  PREPARE_XIANYU_SHIPPING_TOOL_NAME,
  PREPARE_XIANYU_SHIPPING_TOOL_SPEC,
  XIANYU_SHIPPING_EXECUTE_TOOL_ID,
} from './xianyu-shipping.js';

export interface GatewayDeps {
  assembly: AssemblyPort;
  llm: LlmPort;
  toolgate: ToolGatePort;
  fulfillment?: FulfillmentCoordinatorPort;
  /** 闲鱼 itemId → 库存 productKey 的服务端闭集映射；客户端/模型不得覆盖。 */
  fulfillmentProductKeys: Record<string, string>;
  audit: AuditPort;
  verifier: TokenVerifier;
  store: SessionStore;
  heartbeatMs: number;
  /** agent loop 轮数上限：防 LLM 反复触发工具无法收敛而失控烧配额；dom 代操作一批页面操作固定耗 2 轮（操作+复核快照）。 */
  maxTurnRounds: number;
  /** 历史压缩触发的上下文窗口 token 数（ZA_LLM_CONTEXT_WINDOW）。 */
  compressContextWindow: number;
  /** 历史压缩触发阈值比例（ZA_LLM_COMPRESS_THRESHOLD）：估算 token 达 窗口×阈值 即压缩。 */
  compressThreshold: number;
  /** Access-Control-Allow-Origin 响应头值。 */
  corsOrigin: string;
  /** 存在即启用 POST /demo-token（P0-b，env 门控）；缺省=端点关闭（404）。 */
  demoToken?: DemoTokenSigner;
  /** 投递记录（求职 agent 业务日志）落盘目录：record_application 按天写 `<dir>/<date>.jsonl`。 */
  applicationsDir: string;
  /** generic 兜底 pack 准入名单（origin 精确值）；空 = generic 永不激活（fail-closed）。 */
  genericAllowlist: string[];
}

/** 执行结局 → 审计 outcome 闭集映射；deny/reject 不产 tool-execution（未执行），故只映射已执行结果。 */
function execOutcome(observation: Observation): 'ok' | 'error' | 'timeout' | 'invalid-result' {
  if (observation.ok) return 'ok';
  if (observation.error === 'invalid-result') return 'invalid-result';
  if (observation.error === 'timeout') return 'timeout';
  return 'error';
}

export interface Gateway {
  handler(req: IncomingMessage, res: ServerResponse): void;
  /** 结束全部 SSE 长连接并清心跳，使 server.close 可完成。 */
  shutdown(): void;
}

const require = createRequire(import.meta.url);

function createFrameValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  const schemaPath = require.resolve(
    '@zen-agent/contracts/schemas/client-access-layer.schema.json',
  );
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
}

const UPSTREAM_TYPES: ReadonlySet<string> = new Set([
  'context-report',
  'user-message',
  'hitl-decision',
  'exec-result',
  'snapshot-report',
]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * built-in 引导工具：不入 tools.json、不经 toolgate（那是 M3 宿主 API 工具路径）。
 * 仅当 composed.facts 非 null（当前功能有登记锚点）时注入；selector 取自 facts 登记锚点由
 * feature.md 运行期规则约束 LLM，服务端不校验其是否真在 facts 内（失配由客户端降级兜底）。
 */
const GUIDE_TOOL_NAME = 'guide_highlight';

const GUIDE_TOOL_SPEC: LlmToolSpec = {
  name: GUIDE_TOOL_NAME,
  description:
    '当用户询问某操作/入口在页面哪里时，用它高亮或滚动到当前功能页面上 facts 已登记的元素，帮助用户定位。selector 必须取自本功能 facts 中登记的元素锚点（如 #btn-export）；action 用 highlight 高亮或 scroll-to 滚动。',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'selector'],
    properties: {
      action: { enum: ['highlight', 'scroll-to'] },
      selector: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const GUIDE_ACTIONS: ReadonlySet<string> = new Set(['highlight', 'scroll-to']);

/** invalid-tool-args 自愈重试上限（每用户回合累计）：超过即视为不可自愈、按普通错误终结。 */
const MAX_INVALID_ARGS_RETRIES = 2;

/**
 * built-in 页面快照工具（adr-011 观察半程）：工具面含 dom 工具时注入；非终结动作——
 * 快照作为 observation 回喂后回合继续。不经 toolgate（只读观察，无副作用；快照按不可信观察对待）。
 */
const SNAPSHOT_TOOL_SPEC: LlmToolSpec = {
  name: SNAPSHOT_TOOL_NAME,
  description:
    '获取当前页面可交互元素快照（含 ref 编号、角色与可读标签），并附页面当前可见的告警/校验提示文本（notices）。计划页面代操作前必须先调用本工具取得 ref；操作后需要确认页面新状态（含是否被校验提示拦截）时可再次调用。',
  params: { type: 'object', additionalProperties: false, properties: {} },
};

/**
 * built-in 文档读取工具（ADR-013 渐进披露）：仅当激活 pack 有 docs 索引时注入。
 * 服务端执行——调 assembly.readPackDoc 读当前激活 pack 的 docs/（只读该 pack、路径穿越 fail-closed、单次截断）；
 * 非终结动作：正文作 observation 回喂后回合继续。不经 toolgate（只读本地文档、无副作用、无凭证面）。
 */
const PACK_DOC_TOOL_NAME = 'pack_doc';

const PACK_DOC_TOOL_SPEC: LlmToolSpec = {
  name: PACK_DOC_TOOL_NAME,
  description:
    '按需读取当前站点操作文档的正文。path 取自系统提示中"站点操作文档索引"列出的文件名（如 guide.md）；用于获取索引未展开的详细操作步骤/参考信息。仅能读当前站点自带的文档。',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string' } },
  },
};

/**
 * built-in 投递记录工具（求职 agent 业务日志）：pack 激活即注入。非终结、record-only 旁路——
 * 不经 toolgate（写本地业务日志、无宿主副作用、无凭证面），写失败 fail-open 不阻断打招呼主流程。
 * 与审计取证流分立（审计不收工具 params，业务记录需留 company/reason）。
 */
const RECORD_APPLICATION_TOOL_NAME = 'record_application';

const RECORD_APPLICATION_TOOL_SPEC: LlmToolSpec = {
  name: RECORD_APPLICATION_TOOL_NAME,
  description:
    '在成功向某职位打招呼（greet）或用户确认投递后，把这次投递落盘记录，供事后按天回溯"投了哪些公司、JD 摘要、为何判断可投"。逐次一条、每次打招呼成功后调用一次。记录为 record-only 旁路：写失败不影响打招呼流程。',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['company', 'position'],
    properties: {
      company: { type: 'string' },
      position: { type: 'string' },
      jdDigest: { type: 'string' },
      score: { type: 'string' },
      replyOdds: { type: 'string' },
      reason: { type: 'string' },
      decision: { type: 'string' },
    },
  },
};

/**
 * built-in 投递记录查询工具：pack 激活即注入。读某天投递记录并汇总回喂，用于回答"今天/某天投了哪些"。
 */
const LIST_APPLICATIONS_TOOL_NAME = 'list_applications';

const LIST_APPLICATIONS_TOOL_SPEC: LlmToolSpec = {
  name: LIST_APPLICATIONS_TOOL_NAME,
  description:
    '查询某一天的投递记录并汇总。当用户问"今天/某天投了哪些公司、都是些什么岗位、为什么投"时调用。date 可选，格式 YYYY-MM-DD，缺省为今天；给定值须为合法日期。',
  params: {
    type: 'object',
    additionalProperties: false,
    properties: { date: { type: 'string' } },
  },
};

/**
 * built-in 跨站导航工具（ADR-013 渐进披露第一层配套）：不入 pack tools.json，仅当装配注入了"已安装站点索引"
 * （≥2 个带 site 的 pack）时随之注入。经 toolgate 专路裁决（hitl + 目标围栏 fail-closed）与一次性签名下发，
 * 构造 navigate dom 指令复用客户端跨窗口开页入组（U7）。dom 形态使 toolgate 免要求宿主身份、结果过 resultSchema 回收。
 */
const SITE_NAVIGATE_TOOL_DEF: DomToolDefinition = {
  id: SITE_NAVIGATE_TOOL_ID,
  featureIds: [],
  description:
    '当用户任务需要在其他站点协作完成时，用它导航到系统提示"已安装站点索引"中列出的目标站点。url 必须取自该索引中列出的可达 URL；只能导航到索引内的站点。task 填本次导航所属的任务标题（与页面操作工具的 task 保持一致）：已获用户授权的任务内导航无需再次确认。导航成功后你的可用功能与工具立即切换为新站点配置，直接继续当前任务（先 page_snapshot 观察新页面）。',
  params: SITE_NAVIGATE_PARAMS_SCHEMA,
  execution: 'client',
  riskTier: 'hitl',
  adapter: { kind: 'dom', pathPrefixes: ['/'] },
  resultSchema: SITE_NAVIGATE_RESULT_SCHEMA,
};

const SITE_NAVIGATE_TOOL_SPEC: LlmToolSpec = {
  name: SITE_NAVIGATE_TOOL_DEF.id,
  description: SITE_NAVIGATE_TOOL_DEF.description,
  params: SITE_NAVIGATE_TOOL_DEF.params,
};

/** 快照 URL → 围栏比对用路径；解析失败返回 ''（围栏必不匹配，fail-closed）。 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * 准入名单比对用 origin 归一：仅 www 与裸域互认（剥一层前导 www.），其余子域不互认——
 * 站点常以两种形态对外服务，精确匹配会各挡一半；scheme/port 仍须精确。
 * 只用于名单比对；dom 围栏与 genericOrigin 保持页面真实 origin。
 */
export function canonicalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.hostname = url.hostname.replace(/^www\./, '');
    return url.origin;
  } catch {
    return origin;
  }
}

/** 快照 URL → origin（dom origin 围栏比对用）；解析失败返回 ''（围栏必不匹配，fail-closed）。 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 模型安全投影：输入值与链接都不进入 LLM/history；href 只留给服务端可信连接器机械派生。 */
export function redactSnapshotValues(elements: SnapshotReportFrame['elements']): SnapshotReportFrame['elements'] {
  return elements.map(({ value: _value, href: _href, ...element }) => element);
}

/** toolgate/可信连接器投影：仍剥离输入值；href 后续必须由站点连接器按 origin/path/query 白名单消费。 */
function trustedSnapshotElements(elements: SnapshotReportFrame['elements']): SnapshotReportFrame['elements'] {
  return elements.map(({ value: _value, ...element }) => element);
}

/**
 * 把 guide_highlight tool-call 的实参规整为下行页面动作帧；message 缺省则省略（U1 纯数据）。
 * action 越 highlight|scroll-to 闭集或 selector 非非空串 → null：服务端不下发违反 C3 契约的帧
 * （LLM 幻觉出的非法引导参数在此被拦，改走文本降级）。
 */
function guideFrame(sessionId: string, params: Record<string, unknown>): GuideActionFrame | null {
  const action = params['action'];
  const selector = params['selector'];
  if (typeof action !== 'string' || !GUIDE_ACTIONS.has(action)) return null;
  if (typeof selector !== 'string' || selector === '') return null;
  const message = params['message'];
  return {
    type: 'guide-action',
    sessionId,
    action: action as GuideActionKind,
    selector,
    ...(typeof message === 'string' ? { message } : {}),
  };
}

function buildSystemContent(composed: ComposeResult): string {
  const parts = [composed.systemPrompt];
  // 站点索引居基座之后、功能块之前：跨功能稳定的跨站发现层（渐进披露第一层）。
  if (composed.sitesIndex !== null) parts.push(composed.sitesIndex);
  if (composed.featureRules !== null) parts.push(composed.featureRules);
  if (composed.facts !== null) parts.push(composed.facts);
  for (const skill of composed.skills) parts.push(skill.content);
  if (composed.docsIndex !== null) parts.push(composed.docsIndex);
  return parts.join('\n\n');
}

/**
 * 回合 system 注入：仅基座（无 pack 命中）时附注当前站点上下文——
 * 站点索引常驻注入，缺此附注时模型易从索引臆断所在站点。
 */
function systemContentFor(composed: ComposeResult, pack: PackRef, activeUrl: string): string {
  const base = buildSystemContent(composed);
  if (pack.packId !== null) return base;
  const origin = originOf(activeUrl);
  const where = origin === '' ? '当前站点' : `当前活跃页位于 ${origin}，该站点`;
  return `${base}\n\n${where}无专属功能配置（仅基座）：没有本站点的专属知识与页面代操作工具；不得臆断当前站点的身份或归属，需要站点身份而未知时如实说明。`;
}

/** 激活 pack 定位（审计与 docs 读取用）；packId=null 表仅基座。 */
interface PackRef {
  packId: string | null;
  packVersion: string | null;
  /** generic pack 激活时绑定的活跃页 origin：packScope 以此作 packOrigin 围栏；缺省 = 站点/legacy pack。 */
  genericOrigin?: string;
}

/** 宿主 API 工具定义 → LLM 工具面：name=toolId，装配对 agent 透明（LLM 不感知分级/通道）。 */
function toLlmToolSpec(tool: ToolDefinition): LlmToolSpec {
  return { name: tool.id, description: tool.description, params: tool.params };
}

interface SessionRuntime {
  subscribers: Set<ServerResponse>;
  /** 同会话回合串行链：user-message 依次排队，避免历史交错。 */
  turnChain: Promise<void>;
  pendingTurns: number;
  /** 当前进程实际接管的有编号回合；用于区分重启遗留 pending 与本进程活动回合。 */
  activeMessageIds: Set<string>;
  /** 用户请求停止的消息编号；排队与执行中的回合都在服务端边界检查。 */
  cancelledMessageIds: Set<string>;
  /** 串行链上当前真正执行的消息编号。 */
  runningMessageId: string | null;
  /** 可中断的非 LLM 长等待；messageId → 取消信号。 */
  cancelWaiters: Map<string, () => void>;
  /** HITL 挂起等待器：hitlId → resolver；hitl-decision 到达时解析，回合恢复。 */
  pendingHitl: Map<string, (decision: HitlDecisionValue) => void>;
  /** 代执行挂起等待器：nonce → resolver；exec-result 到达时解析，回合恢复。 */
  pendingExec: Map<string, (result: ExecResultFrame) => void>;
  /** 快照挂起等待器：requestId → resolver；snapshot-report 到达时解析。 */
  pendingSnapshot: Map<string, (report: SnapshotReportFrame | null) => void>;
  /** 最近一次快照的判定上下文（ref 闭集 + 页路径）；dom 签发校验依据，无快照即 deny。 */
  domContext: DomGateContext | null;
  /** 自动扫描状态由服务端持有，供 MV3 service worker 重启后查询恢复单飞锁。 */
  automationRuns: Map<string, { status: 'running' | 'succeeded' | 'failed'; updatedAt: number }>;
}

const SNAPSHOT_TIMEOUT_MS = 15_000;

export function createGateway(deps: GatewayDeps): Gateway {
  const validateFrame = createFrameValidator();
  const runtimes = new Map<string, SessionRuntime>();
  const openStreams = new Map<ServerResponse, () => void>();
  const corsHeaders = { 'access-control-allow-origin': deps.corsOrigin } as const;

  // 已安装 site 列表（快照不可变，惰性载入一次缓存）：per-origin 身份路由 + navigate 围栏 + 边界标记 origin 用。
  let sitesPromise: Promise<SiteDescriptor[]> | undefined;
  const getSites = (): Promise<SiteDescriptor[]> => (sitesPromise ??= deps.assembly.listSites());

  /**
   * generic 兜底的服务端准入（U7 fail-closed）：活跃页 origin 不在名单内（含取不到 origin）即回落仅基座。
   */
  function gateGeneric(
    resolved: ResolveFeatureResult,
    url: string,
  ): {
    packId: string | null;
    packVersion: string | null;
    featureId: string | null;
    genericOrigin?: string;
  } {
    const { packId, packVersion, featureId } = resolved;
    if (resolved.generic !== true) return { packId, packVersion, featureId };
    const origin = originOf(url);
    const admitted =
      origin !== '' &&
      deps.genericAllowlist.some((entry) => canonicalizeOrigin(entry) === canonicalizeOrigin(origin));
    if (!admitted) {
      return { packId: null, packVersion: null, featureId: null };
    }
    return { packId, packVersion, featureId, genericOrigin: origin };
  }

  /**
   * 计算工具所属激活 pack 的 site 作用域（ADR-013）：
   *  - packOrigin：激活 pack 的 site.origin（有 site 才有值），驱动 toolgate 的 origin 围栏与 per-origin 身份口径；
   *  - claimsForOrigin：tenant'd pack 取会话 per-origin 身份（路由命中才有），no-tenant site pack 回退平台 claims。
   * generic pack → packOrigin 取激活时绑定的活跃页 origin、不带 claimsForOrigin（dom 免身份；混入 http/server 工具时 toolgate 因缺身份直接 deny）。
   * legacy 无 site pack → 两者皆空，toolgate 沿用平台 claims、不校 origin。
   */
  async function packScope(
    session: SessionState,
    pack: PackRef,
    claims: IdentityClaims,
  ): Promise<{ packOrigin?: string; claimsForOrigin?: IdentityClaims }> {
    if (pack.packId === null) return {};
    if (pack.genericOrigin !== undefined) return { packOrigin: pack.genericOrigin };
    const site = (await getSites()).find((s) => s.packId === pack.packId);
    if (site === undefined) return {};
    const claimsForOrigin =
      site.tenant !== undefined ? session.claimsByOrigin[site.origin] : claims;
    return {
      packOrigin: site.origin,
      ...(claimsForOrigin !== undefined ? { claimsForOrigin } : {}),
    };
  }

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders });
    res.end(JSON.stringify(body));
  };

  const sendNoContent = (res: ServerResponse): void => {
    res.writeHead(204, corsHeaders);
    res.end();
  };

  const runtimeOf = (sessionId: string): SessionRuntime => {
    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        subscribers: new Set(),
        turnChain: Promise.resolve(),
        pendingTurns: 0,
        activeMessageIds: new Set(),
        cancelledMessageIds: new Set(),
        runningMessageId: null,
        cancelWaiters: new Map(),
        pendingHitl: new Map(),
        pendingExec: new Map(),
        pendingSnapshot: new Map(),
        domContext: null,
        automationRuns: new Map(),
      };
      runtimes.set(sessionId, runtime);
    }
    return runtime;
  };

  const broadcast = (sessionId: string, frame: DownstreamFrame): void => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const subscriber of runtime.subscribers) subscriber.write(payload);
  };

  const notify = (sessionId: string, notice: string): void => {
    broadcast(sessionId, { type: 'text-delta', sessionId, delta: notice });
  };

  /**
   * 记一条审计事件（record-only 旁路，U6/C5）：网关只传 schema 允许字段（不含实参/响应体/签名/secret），
   * 脱敏前置由此构造保证、audit sink 再兜一层。eventId/ts 就地生成；audit.record 契约不抛，无需 try/catch。
   */
  const recordEvent = (
    sessionId: string,
    claims: IdentityClaims,
    featureId: string | null,
    body: Pick<AuditEvent, 'type' | 'data'>,
    pack?: PackRef,
  ): void => {
    deps.audit.record({
      eventId: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      userId: claims.hostUserId,
      tenant: claims.tenant,
      ...(pack?.packId != null ? { packId: pack.packId } : {}),
      ...(pack?.packVersion != null ? { packVersion: pack.packVersion } : {}),
      ...(featureId !== null ? { featureId } : {}),
      ...body,
    } as AuditEvent);
  };

  /** 等待客户端 hitl-decision；resolver 先注册再下发帧，避免决策先于等待器到达而丢帧。 */
  function waitForHitl(sessionId: string, hitlId: string): Promise<HitlDecisionValue> {
    const runtime = runtimeOf(sessionId);
    return new Promise((resolve) => runtime.pendingHitl.set(hitlId, resolve));
  }

  /** 等待客户端 exec-result；同理先注册 nonce 等待器，再下发 exec-instruction 帧。 */
  function waitForExec(sessionId: string, nonce: string, ttl: number): Promise<ExecResultFrame> {
    const runtime = runtimeOf(sessionId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtime.pendingExec.delete(nonce);
        resolve({
          type: 'exec-result',
          sessionId,
          nonce,
          ok: false,
          error: 'exec-result-timeout',
        });
      }, ttl);
      runtime.pendingExec.set(nonce, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** 等待客户端 snapshot-report；超时即摘除等待器，迟到帧按过期请求拒绝。 */
  function waitForSnapshot(
    sessionId: string,
    requestId: string,
    timeoutMs = SNAPSHOT_TIMEOUT_MS,
  ): Promise<SnapshotReportFrame | null> {
    const runtime = runtimeOf(sessionId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        runtime.pendingSnapshot.delete(requestId);
        resolve(null);
      }, Math.max(1, timeoutMs));
      runtime.pendingSnapshot.set(requestId, (report) => {
        clearTimeout(timer);
        resolve(report);
      });
    });
  }

  /**
   * 单个宿主 API 工具调用的代执行子流程：一切分级/HITL/结果判定都在 toolgate（U7 fail-closed），
   * 网关只按判定下发帧、挂起等待客户端回传、把规整后的 observation 交回 agent loop。
   * tool-card 摘要仅取 toolId（不含实参值，SEC-04）；deny/reject 时自造 ok:false observation。
   */
  async function runExecSubflow(
    session: SessionState,
    claims: IdentityClaims,
    featureId: string | null,
    pack: PackRef,
    tool: ToolDefinition,
    call: { toolCallId: string; params: JsonObject },
    evidenceRules: SnapshotEvidenceRule[],
    cancelled: () => boolean,
  ): Promise<Observation> {
    const { sessionId } = session;
    const { toolCallId, params } = call;
    if (cancelled()) {
      return { toolCallId, ok: false, content: null, error: 'user-stopped' };
    }
    // UI 分组用调用模式（纯展示，不承载判定）：直接取 execution 通道。
    const mode = tool.execution;
    broadcast(sessionId, {
      type: 'tool-card',
      sessionId,
      toolCallId,
      toolId: tool.id,
      status: 'running',
      summary: tool.id,
      mode,
    });
    const finish = (status: ToolCardStatus): void => {
      broadcast(sessionId, { type: 'tool-card', sessionId, toolCallId, toolId: tool.id, status, mode });
    };
    const boundedIntentId =
      tool.authorization?.kind === 'bounded-fulfillment' && typeof params['intentId'] === 'string'
        ? params['intentId']
        : null;
    const isShipment = tool.id === XIANYU_SHIPPING_EXECUTE_TOOL_ID;
    let inventoryBegun = false;
    const settleInventory = async (
      outcome: 'sent' | 'manual',
      note?: string,
    ): Promise<boolean> => {
      if (boundedIntentId === null || deps.fulfillment === undefined) return true;
      try {
        const result = await deps.fulfillment.settle({
          intentId: boundedIntentId,
          outcome,
          ...(note !== undefined ? { note } : {}),
        });
        return result.ok;
      } catch {
        return false;
      }
    };
    const stopped = async (): Promise<Observation> => {
      const inventoryOk = inventoryBegun ? await settleInventory('manual', 'user-stopped') : true;
      finish('failed');
      return {
        toolCallId,
        ok: false,
        content: null,
        error: inventoryOk ? 'user-stopped' : 'fulfillment-inventory-backfill-failed',
      };
    };

    // dom 工具判定上下文来自最近一次快照（未观察不操作：无快照 toolgate 即 deny）。
    const domContext = isDomTool(tool) ? (runtimeOf(sessionId).domContext ?? undefined) : undefined;
    // 工具所属激活 pack 的 site 作用域（ADR-013）：origin 围栏 + per-origin 身份口径。
    const scope = await packScope(session, pack, claims);
    if (cancelled()) return stopped();
    const decision = await deps.toolgate.decide({
      sessionId,
      toolCallId,
      toolId: tool.id,
      params,
      claims,
      ...scope,
      ...(domContext !== undefined ? { domContext } : {}),
    });
    if (cancelled()) return stopped();
    recordEvent(sessionId, claims, featureId, {
      type: 'tool-decision',
      data: {
        toolCallId,
        toolId: tool.id,
        riskTier: tool.riskTier,
        verdict: decision.verdict,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
    }, pack);
    if (decision.verdict === 'deny') {
      const inventoryOk = await settleInventory('manual', 'toolgate-denied');
      finish('failed');
      return {
        toolCallId,
        ok: false,
        content: null,
        error: inventoryOk ? (decision.reason ?? 'denied') : 'fulfillment-inventory-backfill-failed',
      };
    }
    if (decision.verdict === 'hitl') {
      const hitlId = randomUUID();
      const decided = waitForHitl(sessionId, hitlId);
      broadcast(sessionId, {
        type: 'hitl-request',
        sessionId,
        hitlId,
        toolCallId,
        toolId: tool.id,
        params,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      });
      const verdict = await decided;
      recordEvent(sessionId, claims, featureId, {
        type: 'hitl-verdict',
        data: { hitlId, toolCallId, decision: verdict },
      }, pack);
      if (cancelled()) return stopped();
      if (verdict === 'reject') {
        const inventoryOk = await settleInventory('manual', 'user-rejected');
        finish('failed');
        return {
          toolCallId,
          ok: false,
          content: null,
          error: inventoryOk ? 'user-rejected' : 'fulfillment-inventory-backfill-failed',
        };
      }
      // 批准即任务级授权：登记 grant，同会话同任务的后续调用（跨工具，含 navigate）decide 直接放行。
      // 两类批准只覆盖本次调用、不登记：every-call 工具（确认卡语义是"这一次"，不得顺带解锁同名任务）；
      // site_navigate（导航卡只呈现目标 URL，用户未见任务计划，不构成任务级知情授权）。
      if (
        tool.hitlMode !== 'every-call' &&
        tool.id !== SITE_NAVIGATE_TOOL_ID &&
        typeof params['task'] === 'string'
      ) {
        await deps.toolgate.grantHitl({ sessionId, task: params['task'] });
        if (cancelled()) return stopped();
      }
    }

    // 浏览器副作用前先把发货/发送尝试写入飞书。写入或回读不确定即停，不签发任何指令；
    // 该持久化闩锁让进程在点击后、回执前崩溃时重启也不能自动重放。
    if (boundedIntentId !== null && deps.fulfillment !== undefined) {
      if (cancelled()) return stopped();
      let begun = false;
      try {
        begun = (await (isShipment
          ? deps.fulfillment.beginShipment(boundedIntentId)
          : deps.fulfillment.beginDelivery(boundedIntentId))).ok;
      } catch {
        begun = false;
      }
      if (!begun) {
        finish('failed');
        return {
          toolCallId,
          ok: false,
          content: null,
          error: 'fulfillment-inventory-backfill-failed',
        };
      }
      inventoryBegun = true;
      if (cancelled()) return stopped();
    }

    const startedAt = Date.now();
    // 放行后按通道分支：client 签发一次性签名指令、等客户端回传；server 服务端直调、无 nonce/无客户端回传（U3/U7）。
    let observation: Observation;
    let nonce: string | undefined;
    let status: number | undefined;
    let instructionExpiresAt: number | undefined;
    if (tool.execution === 'server') {
      observation = await deps.toolgate.executeServer({
        sessionId,
        toolCallId,
        toolId: tool.id,
        params,
        claims,
        ...scope,
      });
      if (cancelled()) return stopped();
    } else {
      const instruction = await deps.toolgate.issueExecInstruction({
        sessionId,
        toolCallId,
        toolId: tool.id,
        params,
        claims,
        ...scope,
        ...(domContext !== undefined ? { domContext } : {}),
      });
      if (cancelled()) return stopped();
      nonce = instruction.nonce;
      instructionExpiresAt = instruction.expiresAt;
      const result = waitForExec(sessionId, instruction.nonce, instruction.ttl);
      broadcast(sessionId, instruction);
      const execResult = await result;
      if (cancelled()) return stopped();
      if (typeof execResult.status === 'number') status = execResult.status;
      observation = await deps.toolgate.acceptExecResult({ sessionId, result: execResult });
      if (cancelled()) return stopped();
    }
    // 有界履约的 DOM 成功只表示点击已发生，不表示状态已变更或消息已送达。网关立即强制取新快照，
    // 并在原指令绝对时限内完成页面实例绑定确认；超时/换页/证据不符一律 uncertain。
    if (tool.authorization?.kind === 'bounded-fulfillment' && observation.ok) {
      const requestId = randomUUID();
      const remainingMs = Math.max(1, (instructionExpiresAt ?? Date.now()) - Date.now());
      const reported = waitForSnapshot(sessionId, requestId, remainingMs);
      broadcast(sessionId, {
        type: 'snapshot-request',
        sessionId,
        requestId,
        ...(evidenceRules.length > 0 ? { evidenceRules } : {}),
      });
      const report = await reported;
      if (cancelled()) return stopped();
      const confirmation = await (isShipment
        ? deps.toolgate.confirmShipmentStatus({
            sessionId,
            toolCallId,
            pageUrl: report?.url ?? '',
            pageInstanceId: report?.pageInstanceId ?? '',
            evidence: report?.evidence ?? {},
          })
        : deps.toolgate.confirmFulfillmentReceipt({
        sessionId,
        toolCallId,
        pageUrl: report?.url ?? '',
        pageInstanceId: report?.pageInstanceId ?? '',
        evidence: report?.evidence ?? {},
          }));
      if (cancelled()) return stopped();
      observation = confirmation.confirmed
        ? { toolCallId, ok: true, content: isShipment ? { shipmentConfirmed: true } : { deliveryConfirmed: true } }
        : {
            toolCallId,
            ok: false,
            content: null,
            error: report === null
              ? (isShipment ? 'shipment-status-timeout' : 'fulfillment-receipt-timeout')
              : (isShipment ? 'shipment-status-unconfirmed' : 'fulfillment-receipt-unconfirmed'),
          };
    }
    if (cancelled()) return stopped();
    if (boundedIntentId !== null) {
      let inventoryOk: boolean;
      if (isShipment && observation.ok && deps.fulfillment !== undefined) {
        try {
          inventoryOk = (await deps.fulfillment.confirmShipment(boundedIntentId)).ok;
        } catch {
          inventoryOk = false;
        }
      } else {
        inventoryOk = await settleInventory(
          observation.ok ? 'sent' : 'manual',
          observation.ok ? undefined : (observation.error ?? 'fulfillment-unconfirmed'),
        );
      }
      if (!inventoryOk) {
        observation = {
          toolCallId,
          ok: false,
          content: null,
          error: 'fulfillment-inventory-backfill-failed',
        };
      }
    }
    finish(observation.ok ? 'succeeded' : 'failed');
    recordEvent(sessionId, claims, featureId, {
      type: 'tool-execution',
      data: {
        toolCallId,
        toolId: tool.id,
        execution: tool.execution,
        ...(nonce !== undefined ? { nonce } : {}),
        outcome: execOutcome(observation),
        ...(status !== undefined ? { status } : {}),
        durationMs: Date.now() - startedAt,
      },
    }, pack);
    return observation;
  }

  async function runTurn(
    session: SessionState,
    text: string,
    claims: IdentityClaims,
    executionPreference: ExecutionPreference,
    messageId: string | undefined,
  ): Promise<boolean> {
    const { sessionId } = session;
    const runtime = runtimeOf(sessionId);
    const cancelled = (): boolean => messageId !== undefined && runtime.cancelledMessageIds.has(messageId);
    const cancellation = messageId === undefined
      ? new Promise<void>(() => {})
      : new Promise<void>((resolve) => {
          if (cancelled()) resolve();
          else runtime.cancelWaiters.set(messageId, resolve);
        });
    const llmRequestId = messageId === undefined ? undefined : `${sessionId}:${messageId}`;
    const cancellablePreparation = async <T extends { ok: boolean; intentId?: string }>(
      operation: Promise<T>,
    ): Promise<{ value: T | null; stopped: boolean }> => {
      const outcome = await Promise.race([
        operation.then((value) => ({ kind: 'value' as const, value })),
        cancellation.then(() => ({ kind: 'cancelled' as const })),
      ]);
      if (outcome.kind === 'cancelled') {
        void operation.then(async (value) => {
          if (value.ok && value.intentId !== undefined && deps.fulfillment !== undefined) {
            await deps.fulfillment.settle({ intentId: value.intentId, outcome: 'manual', note: 'user-stopped' });
          }
        }).catch(() => {});
        return { value: null, stopped: true };
      }
      if (cancelled()) {
        if (outcome.value.ok && outcome.value.intentId !== undefined && deps.fulfillment !== undefined) {
          await deps.fulfillment.settle({
            intentId: outcome.value.intentId,
            outcome: 'manual',
            note: 'user-stopped',
          }).catch(() => ({ ok: false }));
        }
        return { value: null, stopped: true };
      }
      return { value: outcome.value, stopped: false };
    };
    const preferenceInstruction = executionPreferenceInstruction(executionPreference);
    const withPreference = (content: string): string =>
      preferenceInstruction === null ? content : `${content}\n\n${preferenceInstruction}`;
    // 按 URL 装配一轮上下文（回合开始与 navigate 落点换装共用）：解析功能、组装注入、建工具面。
    const assembleFor = async (url: string) => {
      const resolved = await deps.assembly.resolveFeature({ url });
      const { packId, packVersion, featureId, genericOrigin } = gateGeneric(resolved, url);
      const pack: PackRef = {
        packId,
        packVersion,
        ...(genericOrigin !== undefined ? { genericOrigin } : {}),
      };
      const composed = await deps.assembly.compose({ sessionId, packId, featureId });
      // 注入自省与 compose 同源：审计 assembly 事件记录本轮 agent 看到了什么（只记 id 与版本，不落全文）。
      const injection = await deps.assembly.describeInjection({ sessionId, packId, featureId });
      recordEvent(sessionId, claims, featureId, {
        type: 'assembly',
        data: {
          snapshotVersion: injection.snapshotVersion,
          featureId,
          toolIds: injection.toolIds,
          skillIds: composed.skills.map((skill) => skill.id),
        },
      }, pack);
      const selectedHostTools = selectToolsForPreference(composed.tools, executionPreference);
      const hostToolsById = new Map(selectedHostTools.map((tool) => [tool.id, tool]));
      const evidenceById = new Map<string, SnapshotEvidenceRule>();
      for (const tool of selectedHostTools) {
        if (!isDomTool(tool)) continue;
        for (const rule of tool.adapter.snapshotEvidence ?? []) {
          if (!evidenceById.has(rule.id)) evidenceById.set(rule.id, rule);
        }
      }
      const evidenceRules = [...evidenceById.values()];
      const guideTools: LlmToolSpec[] = composed.facts !== null ? [GUIDE_TOOL_SPEC] : [];
      // 快照工具只在工具面含 dom 工具时注入：无 dom 操作面就不给观察入口（最小工具面）。
      const snapshotTools: LlmToolSpec[] = selectedHostTools.some(isDomTool) ? [SNAPSHOT_TOOL_SPEC] : [];
      // pack_doc 只在激活 pack 有 docs 索引时注入（渐进披露）：无索引则不给读取入口。
      const docTools: LlmToolSpec[] = composed.docsIndex !== null ? [PACK_DOC_TOOL_SPEC] : [];
      // site_navigate 与站点索引同门：仅当注入了"已安装站点索引"（≥2 site）时给跨站导航入口；单 site 无跨站意义。
      const navTools: LlmToolSpec[] =
        composed.sitesIndex !== null &&
        (executionPreference === 'auto' || executionPreference === 'dom-only')
          ? [SITE_NAVIGATE_TOOL_SPEC]
          : [];
      // 投递记录（业务日志）：pack 激活即注入读写入口，供求职 agent 落盘/回溯投递。
      const appTools: LlmToolSpec[] =
        composed.packId !== null
          ? [RECORD_APPLICATION_TOOL_SPEC, LIST_APPLICATIONS_TOOL_SPEC]
          : [];
      const fulfillmentPrepareTools: LlmToolSpec[] =
        deps.fulfillment !== undefined && Object.keys(deps.fulfillmentProductKeys).length > 0 &&
        selectedHostTools.some((tool) => tool.authorization?.kind === 'bounded-fulfillment')
          ? featureId === 'xianyu-fulfillment'
            ? [PREPARE_XIANYU_FULFILLMENT_TOOL_SPEC]
            : featureId === 'xianyu-orders'
              ? [PREPARE_XIANYU_SHIPPING_TOOL_SPEC]
              : []
          : [];
      const tools: LlmToolSpec[] = [
        ...guideTools,
        ...snapshotTools,
        ...docTools,
        ...navTools,
        ...appTools,
        ...fulfillmentPrepareTools,
        ...selectedHostTools.map(toLlmToolSpec),
      ];
      return { pack, featureId, composed, hostToolsById, tools, evidenceRules };
    };
    // 站点边界标记（ADR-013）：激活 pack 或 generic 绑定 origin 变更时向历史注入一行标记，
    // 防跨站历史误导（generic pack 多 origin 间切换 packId 恒定，须并比 genericOrigin）；
    // 复用 compress.ts BOUNDARY_MARKER 常量，摘要器识别后整句保留。prev=null（首回合）不注入。
    const boundaryFor = async (
      pack: PackRef,
      previousPackId: string | null,
      previousGenericOrigin: string | null,
    ): Promise<LlmMessage | null> => {
      if (previousPackId === null || pack.packId === null) return null;
      if (previousPackId === pack.packId && (pack.genericOrigin ?? null) === previousGenericOrigin) {
        return null;
      }
      const origin =
        pack.genericOrigin ??
        (await getSites()).find((s) => s.packId === pack.packId)?.origin ??
        pack.packId;
      return { role: 'user', content: `${BOUNDARY_MARKER}\n以下对话发生在 ${origin} 站点。` };
    };

    let { pack, featureId, composed, hostToolsById, tools, evidenceRules } = await assembleFor(session.currentUrl ?? '');
    const prevPackId = session.lastPackId;
    const prevGenericOrigin = session.lastGenericOrigin;
    const boundary = await boundaryFor(pack, prevPackId, prevGenericOrigin);
    const boundaryMessages: LlmMessage[] = boundary !== null ? [boundary] : [];
    if (
      pack.packId !== null &&
      (pack.packId !== prevPackId || (pack.genericOrigin ?? null) !== prevGenericOrigin)
    ) {
      deps.store.setLastPackId(sessionId, pack.packId, pack.genericOrigin);
    }
    const systemContent = systemContentFor(composed, pack, session.currentUrl ?? '');
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: withPreference(systemContent),
      },
      ...session.history,
      ...boundaryMessages,
      { role: 'user', content: text },
    ];
    // 本回合待落 history 的消息序列（含工具轮）：回合内只追加不回改，落盘边界统一瘦身。
    // 边界标记随本回合落 history（进入下回合上下文与 P1 摘要保留集）。
    const turnMessages: LlmMessage[] = [...boundaryMessages, { role: 'user', content: text }];
    // 终结轮（纯文本/引导/未知工具/截断）的气泡文本；工具轮的 roundText 进各自 assistant 回声，不入此。
    let tailText = '';
    // 回合是否自然收尾（纯文本/引导/未知工具终结）；false=轮数耗尽被截断，须显式告知用户而非静默停。
    let settled = false;
    // 本回合最近一次完整消费到 done 的 usage 实数（工具轮在 tool-call 处提前 break、不含 usage）；
    // 落盘边界压缩触发估算优先用它，缺省回退字符近似。
    let lastUsage: UsageTokens | undefined;

    // invalid-tool-args 自愈重试预算：模型偶发产出截断/坏 JSON 实参时回喂修正提示重试，
    // 连续超限则按不可自愈终结（防同因空转烧轮数；maxTurnRounds 仍是总兜底）。
    let invalidArgsRetries = 0;
    let automationFailed = false;
    // 所有用户回合统一最多选择一个 bounded intent；客户端标识只做运行关联，不改变治理约束（U7）。
    let fulfillmentBudget: { attempted: boolean; intentId?: string } = { attempted: false };
    turnLoop: for (let round = 0; round < deps.maxTurnRounds; round += 1) {
      if (cancelled()) break;
      let roundText = '';
      let call: { toolCallId: string; name: string; params: JsonObject } | null = null;
      let recoverableError: string | null = null;
      const request = tools.length > 0
        ? { messages, tools, ...(llmRequestId !== undefined ? { requestId: llmRequestId } : {}) }
        : { messages, ...(llmRequestId !== undefined ? { requestId: llmRequestId } : {}) };
      for await (const event of deps.llm.chat(request)) {
        if (cancelled()) break turnLoop;
        if (event.kind === 'text-delta') {
          roundText += event.delta;
          broadcast(sessionId, { type: 'text-delta', sessionId, delta: event.delta });
        } else if (event.kind === 'tool-call') {
          call = { toolCallId: event.toolCallId, name: event.name, params: event.params };
          break;
        } else if (event.kind === 'done') {
          if (event.usage !== undefined) lastUsage = event.usage;
          if (event.stopReason === 'error') {
            automationFailed = true;
            if (event.errorKind === 'invalid-tool-args' && invalidArgsRetries < MAX_INVALID_ARGS_RETRIES) {
              recoverableError = event.error ?? 'invalid-tool-args';
            } else {
              // llm-port 错误文案契约上只含键名/状态类别，不含 env 值与密钥（SEC-04）
              const notice = `服务暂时不可用（${event.error ?? '未知错误'}）`;
              roundText += notice;
              notify(sessionId, notice);
            }
          }
        }
      }
      if (cancelled()) break;
      // 可自愈错误（模型实参 JSON 非法/截断）：不终结回合——把失败与修正要求回喂，下一轮重新发起调用。
      if (call === null && recoverableError !== null) {
        invalidArgsRetries += 1;
        const correction: LlmMessage = {
          role: 'user',
          content: `（系统提示）你上一次的工具调用未能执行：${recoverableError}。实参 JSON 无效或被截断。请重新发起该工具调用，输出完整合法的 JSON 实参；若内容过长，缩短本批内容、分多批完成。`,
        };
        if (roundText !== '') {
          messages.push({ role: 'assistant', content: roundText });
          turnMessages.push({ role: 'assistant', content: roundText });
        }
        messages.push(correction);
        turnMessages.push(correction);
        continue;
      }
      // 无工具调用（纯文本/错误收尾）：本回合终结，本轮文本即气泡。
      if (call === null) {
        tailText += roundText;
        settled = true;
        break;
      }

      if (call.name === SNAPSHOT_TOOL_NAME) {
        // 观察半程（非终结）：等活跃页回传快照，存判定上下文，快照作 observation 回喂后继续本回合。
        const requestId = randomUUID();
        const reported = waitForSnapshot(sessionId, requestId);
        broadcast(sessionId, {
          type: 'snapshot-request',
          sessionId,
          requestId,
          ...(evidenceRules.length > 0 ? { evidenceRules } : {}),
        });
        const report = await reported;
        if (report === null) {
          automationFailed = true;
          broadcast(sessionId, {
            type: 'tool-card',
            sessionId,
            toolCallId: call.toolCallId,
            toolId: SNAPSHOT_TOOL_NAME,
            status: 'failed',
            mode: 'client',
          });
          const snapshotEcho: LlmMessage = {
            role: 'assistant',
            content: roundText,
            toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
          };
          const snapshotObs: LlmMessage = {
            role: 'tool',
            toolCallId: call.toolCallId,
            content: JSON.stringify({ error: 'snapshot-timeout' }),
          };
          messages.push(snapshotEcho, snapshotObs);
          turnMessages.push(snapshotEcho, snapshotObs);
          continue;
        }
        const trustedElements = trustedSnapshotElements(report.elements);
        const safeElements = redactSnapshotValues(report.elements);
        const runtime = runtimeOf(sessionId);
        runtime.domContext = {
          refs: trustedElements.map((element) => element.ref),
          path: pathOf(report.url),
          origin: originOf(report.url),
          url: report.url,
          ...(report.pageInstanceId !== undefined ? { pageInstanceId: report.pageInstanceId } : {}),
          elements: trustedElements,
          ...(report.evidence !== undefined ? { evidence: report.evidence } : {}),
        };
        const snapshotEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
        };
        const snapshotObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify({
            url: report.url,
            title: report.title ?? '',
            elements: safeElements,
            ...(report.notices !== undefined ? { notices: report.notices } : {}),
            ...(report.evidence !== undefined ? { evidence: report.evidence } : {}),
          }),
        };
        messages.push(snapshotEcho, snapshotObs);
        turnMessages.push(snapshotEcho, snapshotObs);
        continue;
      }

      if (call.name === PREPARE_XIANYU_FULFILLMENT_TOOL_NAME) {
        broadcast(sessionId, {
          type: 'tool-card',
          sessionId,
          toolCallId: call.toolCallId,
          toolId: PREPARE_XIANYU_FULFILLMENT_TOOL_NAME,
          status: 'running',
          summary: PREPARE_XIANYU_FULFILLMENT_TOOL_NAME,
          mode: 'server',
        });
        const context = runtimeOf(sessionId).domContext;
        const boundedTools = [...hostToolsById.values()].filter(
          (tool) => tool.authorization?.kind === 'bounded-fulfillment',
        );
        let prepared: Awaited<ReturnType<NonNullable<typeof deps.fulfillment>['prepare']>> | null = null;
        let prepareError: string | null = null;
        let preparationStopped = false;
        if (fulfillmentBudget.attempted) {
          prepareError = 'automation-order-limit';
        } else {
          fulfillmentBudget = { attempted: true };
        }
        if (prepareError === null && deps.fulfillment !== undefined) {
          try {
            const derived = deriveXianyuFulfillmentInput({
              claims,
              context,
              boundedTools,
              evidenceRules,
              productKeys: deps.fulfillmentProductKeys,
              params: call.params,
              now: Date.now(),
            });
            if (derived !== null) {
              const outcome = await cancellablePreparation(deps.fulfillment.prepare(derived));
              prepared = outcome.value;
              preparationStopped = outcome.stopped;
            }
          } catch {
            prepared = null;
          }
        }
        if (cancelled()) preparationStopped = true;
        if (preparationStopped) {
          broadcast(sessionId, {
            type: 'tool-card', sessionId, toolCallId: call.toolCallId,
            toolId: PREPARE_XIANYU_FULFILLMENT_TOOL_NAME, status: 'failed', mode: 'server',
          });
          automationFailed = true;
          settled = true;
          break;
        }
        if (prepared?.ok === true) fulfillmentBudget = { attempted: true, intentId: prepared.intentId };
        else automationFailed = true;
        const prepareEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: {} }],
        };
        const prepareObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify(
            prepared?.ok === true
              ? { intentId: prepared.intentId }
              : { error: prepareError ?? prepared?.error ?? 'fulfillment-prepare-denied' },
          ),
        };
        broadcast(sessionId, {
          type: 'tool-card',
          sessionId,
          toolCallId: call.toolCallId,
          toolId: PREPARE_XIANYU_FULFILLMENT_TOOL_NAME,
          status: prepared?.ok === true ? 'succeeded' : 'failed',
          mode: 'server',
        });
        messages.push(prepareEcho, prepareObs);
        turnMessages.push(prepareEcho, prepareObs);
        continue;
      }

      if (call.name === PREPARE_XIANYU_SHIPPING_TOOL_NAME) {
        broadcast(sessionId, {
          type: 'tool-card', sessionId, toolCallId: call.toolCallId,
          toolId: PREPARE_XIANYU_SHIPPING_TOOL_NAME, status: 'running',
          summary: PREPARE_XIANYU_SHIPPING_TOOL_NAME, mode: 'server',
        });
        const context = runtimeOf(sessionId).domContext;
        const boundedTools = [...hostToolsById.values()].filter(
          (tool) => tool.authorization?.kind === 'bounded-fulfillment',
        );
        let prepared: Awaited<ReturnType<NonNullable<typeof deps.fulfillment>['prepareShipment']>> | null = null;
        let prepareError: string | null = null;
        let preparationStopped = false;
        if (fulfillmentBudget.attempted) prepareError = 'automation-order-limit';
        else fulfillmentBudget = { attempted: true };
        if (prepareError === null && deps.fulfillment !== undefined) {
          try {
            const derived = deriveXianyuShipmentInput({
              claims, context, boundedTools, evidenceRules,
              productKeys: deps.fulfillmentProductKeys, params: call.params, now: Date.now(),
            });
            if (derived !== null) {
              const outcome = await cancellablePreparation(deps.fulfillment.prepareShipment(derived));
              prepared = outcome.value;
              preparationStopped = outcome.stopped;
            }
          } catch {
            prepared = null;
          }
        }
        if (cancelled()) preparationStopped = true;
        if (preparationStopped) {
          broadcast(sessionId, {
            type: 'tool-card', sessionId, toolCallId: call.toolCallId,
            toolId: PREPARE_XIANYU_SHIPPING_TOOL_NAME, status: 'failed', mode: 'server',
          });
          automationFailed = true;
          settled = true;
          break;
        }
        if (prepared?.ok === true) fulfillmentBudget = { attempted: true, intentId: prepared.intentId };
        else automationFailed = true;
        const prepareEcho: LlmMessage = {
          role: 'assistant', content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: {} }],
        };
        const prepareObs: LlmMessage = {
          role: 'tool', toolCallId: call.toolCallId,
          content: JSON.stringify(prepared?.ok === true
            ? { intentId: prepared.intentId }
            : { error: prepareError ?? prepared?.error ?? 'shipping-prepare-denied' }),
        };
        broadcast(sessionId, {
          type: 'tool-card', sessionId, toolCallId: call.toolCallId,
          toolId: PREPARE_XIANYU_SHIPPING_TOOL_NAME,
          status: prepared?.ok === true ? 'succeeded' : 'failed', mode: 'server',
        });
        messages.push(prepareEcho, prepareObs);
        turnMessages.push(prepareEcho, prepareObs);
        continue;
      }

      if (call.name === PACK_DOC_TOOL_NAME) {
        // 渐进披露（非终结）：服务端读当前激活 pack 的 docs/ 正文，作 observation 回喂后继续本回合。
        const docPath = typeof call.params['path'] === 'string' ? call.params['path'] : '';
        const doc = await deps.assembly.readPackDoc({ packId: pack.packId, docPath });
        const docEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
        };
        const docObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify(
            doc.ok ? { content: doc.content ?? '', truncated: doc.truncated === true } : { error: doc.error ?? '读取失败' },
          ),
        };
        messages.push(docEcho, docObs);
        turnMessages.push(docEcho, docObs);
        continue;
      }

      if (call.name === RECORD_APPLICATION_TOOL_NAME) {
        // 业务日志（非终结、record-only 旁路）：把投递落盘当天文件，结果作 observation 回喂后继续本回合。
        const p = call.params;
        const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
        const optStr = (k: string): string | undefined =>
          typeof p[k] === 'string' ? (p[k] as string) : undefined;
        const result = recordApplication(deps.applicationsDir, {
          company: str('company'),
          position: str('position'),
          ...(optStr('jdDigest') !== undefined ? { jdDigest: optStr('jdDigest')! } : {}),
          ...(optStr('score') !== undefined ? { score: optStr('score')! } : {}),
          ...(optStr('replyOdds') !== undefined ? { replyOdds: optStr('replyOdds')! } : {}),
          ...(optStr('reason') !== undefined ? { reason: optStr('reason')! } : {}),
          ...(optStr('decision') !== undefined ? { decision: optStr('decision')! } : {}),
        });
        const recEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
        };
        const recObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify(
            result.ok
              ? { recorded: true, date: result.date }
              : { recorded: false, note: result.error ?? '记录失败，不影响打招呼' },
          ),
        };
        messages.push(recEcho, recObs);
        turnMessages.push(recEcho, recObs);
        continue;
      }

      if (call.name === LIST_APPLICATIONS_TOOL_NAME) {
        // 业务日志查询（非终结）：读某天投递记录汇总回喂后继续本回合。
        const date = typeof call.params['date'] === 'string' ? (call.params['date'] as string) : undefined;
        const result = listApplications(deps.applicationsDir, date);
        const listEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
        };
        const listObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify(
            result.ok
              ? { date: result.date, count: result.count, items: result.items }
              : { error: result.error ?? '查询失败' },
          ),
        };
        messages.push(listEcho, listObs);
        turnMessages.push(listEcho, listObs);
        continue;
      }

      if (call.name === GUIDE_TOOL_NAME) {
        // 引导是终结动作：直接下发页面动作帧，本回合结束——不回喂 observation、不再等 LLM。
        tailText += roundText;
        const frame = guideFrame(sessionId, call.params);
        if (frame !== null) {
          broadcast(sessionId, frame);
        } else {
          const notice = '未能定位到目标元素。';
          tailText += notice;
          notify(sessionId, notice);
        }
        settled = true;
        break;
      }

      if (call.name === SITE_NAVIGATE_TOOL_ID) {
        // 跨站导航（非终结）：经 toolgate 专路裁决 hitl + 一次性签名 navigate 指令，结果 {url} 过 resultSchema 回收后回喂本回合。
        const observation = await runExecSubflow(
          session,
          claims,
          featureId,
          pack,
          SITE_NAVIGATE_TOOL_DEF,
          call,
          evidenceRules,
          cancelled,
        );
        const navEcho: LlmMessage = {
          role: 'assistant',
          content: roundText,
          toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
        };
        const navObs: LlmMessage = {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: JSON.stringify(observation.ok ? observation.content : { error: observation.error }),
        };
        messages.push(navEcho, navObs);
        turnMessages.push(navEcho, navObs);
        // 导航成功＝激活站点即刻切换：回合内按落点 URL 重新装配（规则/事实/工具面随站换出），
        // 系统注入整段覆写、边界标记入历史——LLM 下一轮就持有新站上下文，不必等用户再发言。
        if (observation.ok) {
          const landedUrl = String((observation.content as JsonObject | null)?.['url'] ?? '');
          if (landedUrl !== '') {
            deps.store.setContext(sessionId, landedUrl);
            const previousPackId = pack.packId;
            const previousGenericOrigin = pack.genericOrigin ?? null;
            ({ pack, featureId, composed, hostToolsById, tools, evidenceRules } = await assembleFor(landedUrl));
            messages[0] = {
              role: 'system',
              content: withPreference(systemContentFor(composed, pack, landedUrl)),
            };
            const navBoundary = await boundaryFor(pack, previousPackId, previousGenericOrigin);
            if (navBoundary !== null) {
              messages.push(navBoundary);
              turnMessages.push(navBoundary);
            }
            if (
              pack.packId !== null &&
              (pack.packId !== previousPackId || (pack.genericOrigin ?? null) !== previousGenericOrigin)
            ) {
              deps.store.setLastPackId(sessionId, pack.packId, pack.genericOrigin);
            }
          }
        }
        continue;
      }

      const tool = hostToolsById.get(call.name);
      if (tool === undefined) {
        // 白名单外的工具名（LLM 幻觉）：如实告知不支持，回合终结、不 fail。
        const notice = '该操作暂未支持。';
        tailText += roundText + notice;
        notify(sessionId, notice);
        automationFailed = true;
        settled = true;
        break;
      }

      const boundedIntentId =
        tool.authorization?.kind === 'bounded-fulfillment' && typeof call.params['intentId'] === 'string'
          ? call.params['intentId']
          : null;
      let observation: Observation;
      if (
        boundedIntentId !== null &&
        fulfillmentBudget.attempted &&
        fulfillmentBudget.intentId !== boundedIntentId
      ) {
        broadcast(sessionId, {
          type: 'tool-card', sessionId, toolCallId: call.toolCallId, toolId: tool.id,
          status: 'running', summary: tool.id, mode: tool.execution,
        });
        broadcast(sessionId, {
          type: 'tool-card', sessionId, toolCallId: call.toolCallId, toolId: tool.id,
          status: 'failed', mode: tool.execution,
        });
        observation = { toolCallId: call.toolCallId, ok: false, content: null, error: 'fulfillment-order-limit' };
      } else {
        if (boundedIntentId !== null && !fulfillmentBudget.attempted) {
          fulfillmentBudget = { attempted: true, intentId: boundedIntentId };
        }
        observation = await runExecSubflow(
          session,
          claims,
          featureId,
          pack,
          tool,
          call,
          evidenceRules,
          cancelled,
        );
      }
      if (!observation.ok) automationFailed = true;
      // 回喂 agent：assistant 调用轮回声本轮 tool_calls（OpenAI 兼容 API 要求 role:tool 须有前置
      // 带 tool_calls 的 assistant 消息，否则拒绝孤儿 tool 消息）+ observation（仅规整结果，U7）。
      const execEcho: LlmMessage = {
        role: 'assistant',
        content: roundText,
        toolCalls: [{ id: call.toolCallId, name: call.name, params: call.params }],
      };
      const execObs: LlmMessage = {
        role: 'tool',
        toolCallId: call.toolCallId,
        content: JSON.stringify(observation.ok ? observation.content : { error: observation.error }),
      };
      messages.push(execEcho, execObs);
      turnMessages.push(execEcho, execObs);
    }

    if (cancelled()) {
      const notice = '已停止当前任务。';
      tailText += notice;
      notify(sessionId, notice);
      automationFailed = true;
      settled = true;
    } else if (!settled) {
      // 轮数耗尽被截断：显式收尾而非静默停（用户视角"卡住"），并留在历史里供下回合衔接。
      const notice = '本轮操作步数已达上限，我先停在这里；回复「继续」可接着做。';
      tailText += notice;
      notify(sessionId, notice);
      automationFailed = true;
    }
    if (tailText !== '') {
      turnMessages.push({ role: 'assistant', content: tailText });
    }
    // 回合落盘边界：追加工具轮并瘦身（仅留最近一次快照观测全文），护 prompt 缓存前缀不回改。
    const pruned = pruneStaleSnapshots([...session.history, ...turnMessages]);
    // 达阈值再压缩：较早回合压滚动摘要、最近 K 轮留原文；摘要生成失败 fail-open（原样落盘，下回合再试）。
    const estimate = estimateHistoryTokens(
      lastUsage !== undefined ? { history: pruned, usage: lastUsage } : { history: pruned },
    );
    const toStore = !cancelled() && shouldCompress(estimate, deps.compressContextWindow, deps.compressThreshold)
      ? await compressHistory(pruned, {
          llm: deps.llm,
          ...(llmRequestId !== undefined ? { requestId: llmRequestId } : {}),
        })
      : pruned;
    deps.store.setHistory(sessionId, toStore);
    return !automationFailed;
  }

  async function handleFrames(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionState,
    claims: IdentityClaims,
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!validateFrame(frame)) {
      sendJson(res, 400, { error: '帧不过 client-access-layer 契约' });
      return;
    }
    const type = (frame as { type: string }).type;
    if (!UPSTREAM_TYPES.has(type)) {
      sendJson(res, 400, { error: '仅接受上行帧' });
      return;
    }
    const upstream = frame as UpstreamFrame;
    if (upstream.sessionId !== session.sessionId) {
      sendJson(res, 400, { error: '帧 sessionId 与路径不一致' });
      return;
    }
    switch (upstream.type) {
      case 'context-report':
        deps.store.setContext(session.sessionId, upstream.url);
        sendNoContent(res);
        return;
      case 'user-message': {
        const runtime = runtimeOf(session.sessionId);
        if (upstream.messageId !== undefined) {
          const reservation = deps.store.reserveMessageTurn(session.sessionId, upstream.messageId);
          if (reservation === 'storage-failed') {
            sendJson(res, 503, { error: '消息幂等占位不可用，未启动回合' });
            return;
          }
          if (reservation === 'pending' && !runtime.activeMessageIds.has(upstream.messageId)) {
            sendJson(res, 409, {
              error: '上一回合因服务重启中断，状态无法安全恢复；请核对业务状态后重新发起',
              messageState: 'interrupted',
              idle: true,
            });
            return;
          }
          if (reservation === 'pending' || reservation === 'complete') {
            sendJson(res, 202, {
              accepted: true,
              duplicate: true,
              messageState: reservation,
              idle: runtime.pendingTurns === 0,
            });
            return;
          }
          if (reservation !== 'reserved') {
            sendJson(res, 503, { error: '消息幂等状态异常，未启动回合' });
            return;
          }
          const messageTurns = Object.entries(session.messageTurns);
          if (messageTurns.length > 256) {
            const completed = messageTurns.find(([, state]) => state === 'complete');
            if (completed !== undefined) deps.store.setMessageTurn(session.sessionId, completed[0], null);
          }
        }
        if (upstream.automationRunId !== undefined) {
          if (runtime.automationRuns.has(upstream.automationRunId)) {
            sendJson(res, 409, { error: '自动扫描轮次已存在' });
            return;
          }
          runtime.automationRuns.set(upstream.automationRunId, { status: 'running', updatedAt: Date.now() });
        }
        runtime.pendingTurns += 1;
        if (upstream.messageId !== undefined) runtime.activeMessageIds.add(upstream.messageId);
        runtime.turnChain = runtime.turnChain
          .then(async () => {
            runtime.runningMessageId = upstream.messageId ?? null;
            try {
              const succeeded = await runTurn(
                session,
                upstream.text,
                claims,
                upstream.executionPreference ?? 'auto',
                upstream.messageId,
              );
              if (upstream.automationRunId !== undefined) {
                runtime.automationRuns.set(upstream.automationRunId, {
                  status: succeeded ? 'succeeded' : 'failed',
                  updatedAt: Date.now(),
                });
                broadcast(session.sessionId, {
                  type: 'tool-card',
                  sessionId: session.sessionId,
                  toolCallId: upstream.automationRunId,
                  toolId: 'xianyu-auto-scan',
                  status: succeeded ? 'succeeded' : 'failed',
                  mode: 'server',
                });
              }
            } catch (cause) {
              if (upstream.automationRunId !== undefined) {
                runtime.automationRuns.set(upstream.automationRunId, { status: 'failed', updatedAt: Date.now() });
                broadcast(session.sessionId, {
                  type: 'tool-card',
                  sessionId: session.sessionId,
                  toolCallId: upstream.automationRunId,
                  toolId: 'xianyu-auto-scan',
                  status: 'failed',
                  mode: 'server',
                });
              }
              throw cause;
            }
          })
          .catch((cause) => {
            // 回合内部异常不外泄细节（SEC-04）：客户端只见类别，明细留本地日志
            console.error('agent 回合异常：', cause);
            broadcast(session.sessionId, {
              type: 'text-delta',
              sessionId: session.sessionId,
              delta: '服务暂时不可用（内部错误）',
            });
          })
          .finally(() => {
            if (runtime.runningMessageId === (upstream.messageId ?? null)) runtime.runningMessageId = null;
            if (upstream.messageId !== undefined) runtime.cancelWaiters.delete(upstream.messageId);
            runtime.pendingTurns = Math.max(0, runtime.pendingTurns - 1);
            if (upstream.messageId !== undefined) {
              runtime.activeMessageIds.delete(upstream.messageId);
              runtime.cancelledMessageIds.delete(upstream.messageId);
              deps.store.setMessageTurn(session.sessionId, upstream.messageId, 'complete');
            }
            broadcast(session.sessionId, {
              type: 'turn-complete',
              sessionId: session.sessionId,
              ...(upstream.messageId !== undefined ? { messageId: upstream.messageId } : {}),
              idle: runtime.pendingTurns === 0,
            });
          });
        sendJson(res, 202, {
          accepted: true,
          messageState: 'pending',
          idle: false,
        });
        return;
      }
      case 'hitl-decision': {
        // 解析挂起的 HITL 等待器使回合恢复；无对应等待器＝已决策/失效，409（不改回合状态）。
        const resolve = runtimeOf(session.sessionId).pendingHitl.get(upstream.hitlId);
        if (resolve === undefined) {
          sendJson(res, 409, { error: 'HITL 决策无对应挂起回合（已处理或失效）' });
          return;
        }
        runtimeOf(session.sessionId).pendingHitl.delete(upstream.hitlId);
        resolve(upstream.decision);
        sendJson(res, 202, { accepted: true });
        return;
      }
      case 'exec-result': {
        // nonce 等待器在网关层即为一次性：命中即摘除，二次到达（重放）无等待器→409、不再入 toolgate。
        const resolve = runtimeOf(session.sessionId).pendingExec.get(upstream.nonce);
        if (resolve === undefined) {
          sendJson(res, 409, { error: '代执行结果无对应挂起回合（已处理、重放或伪造 nonce）' });
          return;
        }
        runtimeOf(session.sessionId).pendingExec.delete(upstream.nonce);
        resolve(upstream);
        sendJson(res, 202, { accepted: true });
        return;
      }
      case 'snapshot-report': {
        // requestId 等待器一次性：命中即摘除；无等待器＝过期/伪造，409。
        const resolve = runtimeOf(session.sessionId).pendingSnapshot.get(upstream.requestId);
        if (resolve === undefined) {
          sendJson(res, 409, { error: '快照上报无对应挂起请求（已处理或失效）' });
          return;
        }
        runtimeOf(session.sessionId).pendingSnapshot.delete(upstream.requestId);
        resolve(upstream);
        sendJson(res, 202, { accepted: true });
        return;
      }
    }
  }

  async function handleStop(req: IncomingMessage, res: ServerResponse, session: SessionState): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '停止请求不是合法 JSON' });
      return;
    }
    const messageId = typeof body === 'object' && body !== null && 'messageId' in body
      ? (body as { messageId?: unknown }).messageId
      : undefined;
    if (typeof messageId !== 'string' || messageId === '' || messageId.length > 200) {
      sendJson(res, 400, { error: '停止请求缺少合法 messageId' });
      return;
    }
    const runtime = runtimeOf(session.sessionId);
    runtime.cancelledMessageIds.add(messageId);
    if (runtime.cancelledMessageIds.size > 256) {
      const oldest = runtime.cancelledMessageIds.values().next().value as string | undefined;
      if (oldest !== undefined) runtime.cancelledMessageIds.delete(oldest);
    }
    deps.llm.cancel(`${session.sessionId}:${messageId}`);
    runtime.cancelWaiters.get(messageId)?.();
    if (runtime.runningMessageId === messageId) {
      for (const [hitlId, resolve] of [...runtime.pendingHitl]) {
        runtime.pendingHitl.delete(hitlId);
        resolve('reject');
      }
      for (const [nonce, resolve] of [...runtime.pendingExec]) {
        runtime.pendingExec.delete(nonce);
        resolve({
          type: 'exec-result',
          sessionId: session.sessionId,
          nonce,
          ok: false,
          error: 'user-stopped',
        });
      }
      for (const [requestId, resolve] of [...runtime.pendingSnapshot]) {
        runtime.pendingSnapshot.delete(requestId);
        resolve(null);
      }
    }
    sendJson(res, 202, { accepted: true });
  }

  async function handleEvents(res: ServerResponse, session: SessionState): Promise<void> {
    const verification = await deps.toolgate.getExecVerificationKey();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-zen-agent-exec-algorithm': verification.algorithm,
      'x-zen-agent-exec-public-key': verification.publicKey,
      'access-control-expose-headers': 'x-zen-agent-exec-algorithm,x-zen-agent-exec-public-key',
      ...corsHeaders,
    });
    res.write(': ping\n\n');
    const runtime = runtimeOf(session.sessionId);
    runtime.subscribers.add(res);
    const timer = setInterval(() => {
      res.write(': ping\n\n');
    }, deps.heartbeatMs);
    timer.unref();
    const cleanup = (): void => {
      clearInterval(timer);
      runtime.subscribers.delete(res);
      openStreams.delete(res);
    };
    openStreams.set(res, cleanup);
    res.on('close', cleanup);
  }

  async function handleInjection(res: ServerResponse, session: SessionState): Promise<void> {
    const url = session.currentUrl ?? '';
    const resolved = await deps.assembly.resolveFeature({ url });
    const { packId, featureId } = gateGeneric(resolved, url);
    const description = await deps.assembly.describeInjection({
      sessionId: session.sessionId,
      packId,
      featureId,
    });
    sendJson(res, 200, description);
  }

  function handleAutomationRun(res: ServerResponse, session: SessionState, runId: string): void {
    const run = runtimeOf(session.sessionId).automationRuns.get(runId);
    if (run === undefined) {
      sendJson(res, 404, { error: '自动扫描轮次不存在' });
      return;
    }
    sendJson(res, 200, run);
  }

  function handleTurnState(res: ServerResponse, session: SessionState): void {
    sendJson(res, 200, { running: runtimeOf(session.sessionId).pendingTurns > 0 });
  }

  /**
   * P0-b demo-token 签发（demo 级）：有意不要求 authorization——此端点就是发 token 的，故须先于 verifier 判定。
   * 信任模型见 demo-token.ts：真实鉴权在代执行时靠用户 cookie，伪造 hostUserId 只会被下游宿主拒绝。
   */
  async function handleDemoToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signer = deps.demoToken;
    if (signer === undefined) {
      sendJson(res, 404, { error: '未知路由' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    const hostUserId = (body as { hostUserId?: unknown }).hostUserId;
    if (typeof hostUserId !== 'string' || !/^[\w-]{1,64}$/.test(hostUserId)) {
      sendJson(res, 400, { error: 'hostUserId 缺失或格式非法' });
      return;
    }
    const token = await signDemoToken(signer, hostUserId);
    sendJson(res, 200, { token });
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }
    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    // 存活探针（容器/编排健康检查用）：无鉴权、无副作用、不触任何端口——仅证明进程在监听。
    if (req.method === 'GET' && requestPath === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && requestPath === '/demo-token') {
      return handleDemoToken(req, res);
    }
    const claims = await deps.verifier.verify(req.headers.authorization);
    if (claims === null) {
      sendJson(res, 401, { error: '身份校验未通过' });
      return;
    }
    const pathname = requestPath;
    if (req.method === 'POST' && pathname === '/v1/sessions') {
      const session = deps.store.create(claims);
      recordEvent(session.sessionId, claims, null, {
        type: 'session-start',
        data: { clientKind: 'extension', iss: claims.iss },
      });
      sendJson(res, 201, { sessionId: session.sessionId });
      return;
    }
    const automationMatch = /^\/v1\/sessions\/([^/]+)\/automation-runs\/([^/]+)$/.exec(pathname);
    const match = /^\/v1\/sessions\/([^/]+)\/(frames|events|injection|turn-state|stop)$/.exec(pathname);
    if (automationMatch && req.method === 'GET') {
      const sessionId = decodeURIComponent(automationMatch[1]!);
      const session = deps.store.get(sessionId);
      if (!session || session.ownerSub !== claims.sub) {
        sendJson(res, 404, { error: '会话不存在' });
        return;
      }
      deps.store.refreshClaims(sessionId, claims);
      return handleAutomationRun(res, session, decodeURIComponent(automationMatch[2]!));
    }
    if (match) {
      const sessionId = decodeURIComponent(match[1]!);
      const session = deps.store.get(sessionId);
      if (!session || session.ownerSub !== claims.sub) {
        sendJson(res, 404, { error: '会话不存在' });
        return;
      }
      // 每次请求以当前验签结果刷新会话身份，代执行门禁始终按最新有效 claims 判定（U7）。
      deps.store.refreshClaims(sessionId, claims);
      // per-origin 身份路由（ADR-013 任务组）：claims.tenant 匹配 pack.tenant 的 site → 记该 origin 的宿主身份；
      // 无 tenant 的 pack 不参与（其 http/server 工具由 toolgate 回退平台 claims）。
      for (const site of await getSites()) {
        if (site.tenant !== undefined && site.tenant === claims.tenant) {
          deps.store.setOriginClaims(sessionId, site.origin, claims);
        }
      }
      if (match[2] === 'frames' && req.method === 'POST') return handleFrames(req, res, session, claims);
      if (match[2] === 'stop' && req.method === 'POST') return handleStop(req, res, session);
      if (match[2] === 'events' && req.method === 'GET') return await handleEvents(res, session);
      if (match[2] === 'injection' && req.method === 'GET') return handleInjection(res, session);
      if (match[2] === 'turn-state' && req.method === 'GET') return handleTurnState(res, session);
    }
    sendJson(res, 404, { error: '未知路由' });
  }

  return {
    handler(req, res) {
      void dispatch(req, res).catch((cause) => {
        console.error('请求处理异常：', cause);
        if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
        else res.end();
      });
    },
    shutdown() {
      for (const [stream, cleanup] of [...openStreams]) {
        cleanup();
        stream.end();
      }
    },
  };
}
