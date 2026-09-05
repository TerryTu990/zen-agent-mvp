/**
 * C6 模块端口——模块间唯一的调用契约（U2：禁直接 import 实现，只经本类型 + 端口注入，组装唯一在 apps/server）。
 *
 * 不变量（U1）：四端口方法的出入参全部 JSON 可序列化——拆服务时端口 → RPC 不改契约。
 * LlmPort 的 AsyncIterable 是流式 RPC（SSE 等）的进程内投影，逐个产出的事件本体仍 JSON 可序列化。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { RiskTier, ToolDefinition } from './tool-definition.js';
import type { UserConfigSubject, UserOverlay } from './user-overlay.js';
import type { IdentityClaims } from './identity-claims.js';
import type {
  DomStep,
  ExecInstructionFrame,
  ExecResultFrame,
  GroupPageEntry,
  SnapshotElement,
  SnapshotEvidence,
} from './client-access-layer.js';
import type { AuditEvent, GateVerdict } from './audit-event.js';
import type { PackAutomation, PackBuiltinTool, PackSource, QuickAction } from './config-snapshot.js';

// ---- AssemblyPort（②会话网关 ← ⑤配置中心：featureId 定位 + 注入组合）----

export interface ResolveFeatureInput {
  url: string;
}

export interface ResolveFeatureResult {
  /** 激活 pack（ADR-013）：origin 精确 + 最长 location 前缀命中的唯一 pack；null = 无 pack 命中（仅基座）。legacy 快照恒为 "default"。 */
  packId: string | null;
  /** 激活 pack 的 semver；packId=null 时为 null。 */
  packVersion: string | null;
  /** null = 激活 pack 的 featureIdRules 无命中（或无 pack），仅装配稳定基座（fail-safe）。 */
  featureId: string | null;
  /** registry/legacy 根版本（区别于 pack 独立版本 packVersion）。 */
  snapshotVersion: string;
  /** true = 激活的是 generic 兜底 pack（无站点 pack 命中）：网关 MUST 按服务端准入名单以活跃页 origin 二次判定（不过即按 packId=null 仅基座，fail-closed）；缺省 = 站点/legacy pack 或无 pack。 */
  generic?: boolean;
}

export interface ComposeInput {
  sessionId: string;
  /** 激活 pack；null = 仅基座（skills/docs/工具面均为空）。取自 resolveFeature 判定，装配对 agent 透明。 */
  packId: string | null;
  featureId: string | null;
  /**
   * L2 归属键（adr-014）：提供时 compose 经 UserConfigStore 单次读取该 subject 的 overlay 并定格
   * revision，合并个人规则/事实与工具面收紧；缺省 = 纯 L1 装配（无 L2 参与）。
   */
  subject?: UserConfigSubject;
  /**
   * 当前页 origin（scheme://host[:port]）：提供时按 L2 全局作用域 siteDenylist 判定站点黑名单，
   * 命中即回落仅基座并置 siteDenied；缺省 = 不做站点判定，装配面与不带本字段时严格等价。
   */
  origin?: string;
}

export interface SkillAsset {
  id: string;
  content: string;
}

/** L2 个人规则/事实的渲染条目（R4）：text 已含来源标注，id 与 InjectionBlock.id、overlay 条目 id 三方对齐。 */
export interface UserInjectionEntry {
  /** overlay 条目 id。 */
  id: string;
  /** 渲染好的注入文本（含来源标注）。 */
  text: string;
}

/**
 * 每轮换出的装配产物：稳定基座 + 功能块 + pack 作用域 skills + 工具白名单 + docs 索引（装配对 agent 透明）。
 * skills/docsIndex 收敛到激活 pack；packId=null 时均为空/null。
 */
export interface ComposeResult {
  snapshotVersion: string;
  /** 激活 pack（ADR-013）；null = 仅基座。 */
  packId: string | null;
  packVersion: string | null;
  systemPrompt: string;
  /** features/<id>/feature.md；无功能命中时为 null。 */
  featureRules: string | null;
  /** features/<id>/facts.md；无功能命中时为 null。 */
  facts: string | null;
  /** 激活 pack 的 skills（pack 作用域，非全局）。 */
  skills: SkillAsset[];
  tools: ToolDefinition[];
  /** 激活 pack 的 docs/ 渐进披露索引（frontmatter 标题+摘要）；docs/ 为空或无 pack 时为 null。 */
  docsIndex: string | null;
  /**
   * 激活 pack 声明的平台内建工具族（pack.json capabilities.builtinTools）：网关据此按声明注入内建工具面。
   * 缺省 = 未声明或无 pack 激活 → 不注入任何内建工具面（缺省即不注入，非缺省即全给）。
   */
  builtinTools?: PackBuiltinTool[];
  /**
   * 已安装站点索引（渐进披露第一层，跨功能稳定）：列出平台可辅助的全部带 site 的 pack（用途+可达 URL），
   * 当前激活 pack 标注（当前）。仅 ≥2 个带 site 的 pack 时非 null（单 site/legacy 无跨站意义 → null）。
   */
  sitesIndex: string | null;
  /**
   * 本轮定格的 L2 overlay revision（内容 hash）：注入透明视图/审计/工具判定三方互证（R4）。
   * 缺省 = 纯 L1 装配（无 L2 参与）或 degraded（读失败无缓存，以 userConfigDegraded 标注替代）。
   */
  userConfigRevision?: string;
  /**
   * L2 生效偏好的渲染条目（id = 偏好键，如 "verbosity"）：pack 作用域覆盖 "*" 全局后逐项渲染，
   * 注入序居 L2 段首（个人规则可再覆盖粗粒度偏好）；缺省 = 无 L2 参与、未设偏好或读失败降级。
   */
  userPreferences?: UserInjectionEntry[];
  /**
   * 当前激活 pack 的用户配置渲染条目（id = 配置键）：只含该 pack 在 pack.json configSchema 中
   * 已声明的键——未声明键逐条失效并收入 invalidRefs（pack 更新后收窄声明空间时的运行期兜底）。
   * 缺省 = 无 L2 参与、pack 未声明可配置点或用户未填值。
   */
  packConfig?: UserInjectionEntry[];
  /** L2 个人规则渲染块（按当前 featureId 过滤，注入序在 L1 之后、"*" 先于 pack 级）；缺省 = 无 L2 参与或读失败 fail-open。 */
  userRules?: UserInjectionEntry[];
  /** L2 个人事实渲染块；语义同 userRules。 */
  userFacts?: UserInjectionEntry[];
  /** true = 本轮激活 pack 被用户 enabled:false 关停而回落仅基座（packId 已为 null）；审计与网关据此区分「无 pack」与「已关停」。 */
  packDisabled?: true;
  /** 被关停的 packId（随 packDisabled 一同产出）：关停轮 packId 已回落 null，审计与配置中心据此追溯是哪个 pack 被关停；缺省 = 非关停轮。 */
  disabledPackId?: string;
  /**
   * true = 入参 origin 命中用户 L2 站点黑名单，本轮按仅基座装配（packId 已为 null）——
   * 与 packDisabled 分列：前者是「用户不让 Zen 出现在这个站点」，后者是「用户关停了这个 pack」。
   * 缺省 = 未传 origin、未命中黑名单或 L2 未参与。
   */
  siteDenied?: true;
  /**
   * 工具面逐项生效分级（与 describeInjection 的 tools 同源同值）：disabledTools 条目从 agent 可见
   * tools 移除但在此保留并置 effectiveTier:'forbidden'（幻觉调用仍被拒）；缺省 = 无 L2 参与。
   */
  effectiveTools?: InjectionToolDescriptor[];
  /** L2 越界引用（toolId 已不在 L1 工具面）清单：逐条失效不阻断其余条目，网关据此落审计；缺省 = 无。 */
  invalidRefs?: string[];
  /** true = 本轮 overlay 取自最近一次成功读取的缓存（读失败降级），网关须落审计标注 stale；缺省 = 新鲜读取。 */
  userConfigStale?: true;
  /**
   * 'fail-open-closed' = L2 读失败且无缓存的拆分降级：rules/facts fail-open 纯 L1 注入，
   * effectiveTools 全部置 effectiveTier:'forbidden'（tightenedBy:'storage-failure'）——
   * 存储故障不得放宽治理（U7）；缺省 = 无降级。
   */
  userConfigDegraded?: 'fail-open-closed';
}

export interface InjectionBlock {
  /**
   * 'user-rules'/'user-facts' = L2 个人条目（每条一个 block，id=条目 id，origin:'L2'）；
   * 'user-preferences'/'pack-config' 同为每项一个 block，id 分别为偏好键与配置键。
   */
  kind:
    | 'system-prompt'
    | 'sites-index'
    | 'feature-rules'
    | 'facts'
    | 'user-preferences'
    | 'pack-config'
    | 'user-rules'
    | 'user-facts'
    | 'skill'
    | 'docs-index';
  id?: string;
  bytes: number;
  /** 注入段来源层（R4 透明视图）：L0 基座 / L1 pack / L2 用户覆盖层；缺省 = 未标注（legacy 产出）。 */
  origin?: 'L0' | 'L1' | 'L2';
}

/** 工具面条目自省（R4）：设计稿「自动执行 → 需确认 · 已收紧」箭头的数据源。 */
export interface InjectionToolDescriptor {
  toolId: string;
  /** L1 声明的原始分级。 */
  baseTier: RiskTier;
  /** L2 收紧合并后的生效分级：max(L1, L2)，恒 ≥ baseTier。 */
  effectiveTier: RiskTier;
  /** 工具定义来源层：L0 内建 / L1 pack——L2 结构上无工具定义表达力（adr-014），故不在此闭集。 */
  origin: 'L0' | 'L1';
  /**
   * effectiveTier 高于 baseTier 时的收紧来源：user-overlay 作用域键（packId），或哨兵值
   * 'storage-failure'（L2 读失败无缓存的治理降级，U7 存储故障不得放宽治理）；未收紧省略。
   */
  tightenedBy?: string;
}

/** 注入自省：与 compose 同源产出，供审计 assembly 事件与调试查看。 */
export interface InjectionDescription {
  snapshotVersion: string;
  /** 激活 pack；null = 仅基座。 */
  packId: string | null;
  featureId: string | null;
  blocks: InjectionBlock[];
  toolIds: string[];
  /** 工具面逐项描述（baseTier/effectiveTier/收紧来源）；与 toolIds 并存，缺省 = 未产出（legacy）。 */
  tools?: InjectionToolDescriptor[];
  /** 激活 pack 的 semver（注入视图版本徽章数据源）；无 pack 时省略。 */
  packVersion?: string;
  /** 激活 pack 的人读名（pack.json name）；未声明或无 pack 时省略，展示回退 packId。 */
  packName?: string;
  /** 激活 pack 的 registry 来源（来源徽章数据源）；无 pack 时省略。 */
  packSource?: PackSource;
  /** 激活功能的人读标题（feature.md frontmatter title）；未声明或无功能时省略，展示回退 featureId。 */
  featureTitle?: string;
  /** 本轮定格的 L2 overlay revision：与 ComposeResult.userConfigRevision 同源同值（R4 三方互证）；缺省 = 无 L2 参与或读失败降级。 */
  userConfigRevision?: string;
  /** 被关停的 packId（与 ComposeResult.disabledPackId 同源同值）：关停轮 packId 已回落 null，透明视图据此如实呈现「已关停」而非「无 pack」；缺省 = 非关停轮。 */
  disabledPackId?: string;
  /**
   * 本轮装配面之所以如此的原因闭集（R4 透明性）：'pack' 站点包命中 / 'generic' 通用兜底包 /
   * 'base-only' 无 pack 命中仅基座 / 'pack-disabled' 用户关停后回落仅基座 /
   * 'site-denied' 本页 origin 命中用户站点黑名单后回落仅基座。后两者同属「用户主动导致的回落」，
   * 分列使透明视图能说清是关停了哪个 pack 还是整站不辅助；黑名单命中优先——
   * 纵使该 pack 同时被关停，本站也仍会回落仅基座。
   * 服务端判定，客户端只呈现不推断（U7）；缺省 = 旧版本服务端未标注。
   */
  reason?: 'pack' | 'generic' | 'base-only' | 'pack-disabled' | 'site-denied';
}

/** pack docs 正文按需读取（渐进披露的 pack_doc 内建工具后端）：只读当前激活 pack 的 docs/。 */
export interface ReadPackDocInput {
  /** 当前激活 pack（网关注入，agent 不可跨 pack 指定——只读当前激活 pack 的 docs/）。 */
  packId: string | null;
  /** docs/ 内相对路径（如 "guide.md"）；路径穿越出 docs/ → fail-closed 拒读。 */
  docPath: string;
}

export interface ReadPackDocResult {
  ok: boolean;
  /** ok=true 时的正文（单次截断上限内）。 */
  content?: string;
  /** true = 正文超单次上限被截断。 */
  truncated?: boolean;
  /** ok=false 时的失败原因（不含敏感路径细节）。 */
  error?: string;
}

/** 已安装带 site 围栏的 pack 描述（ADR-013 任务组）：per-origin 身份路由与 navigate 越界校验的依据；legacy 无 site 的 pack 不列入。 */
export interface SiteDescriptor {
  packId: string;
  /** 精确匹配的页面 origin（scheme://host[:port]）。 */
  origin: string;
  /** claims.tenant → origin 路由键；缺省=该 pack 不参与 per-origin 身份路由（宿主身份回退平台 claims）。 */
  tenant?: string;
  /** 已归一路径前缀围栏（'/' 表整站）。 */
  locations: string[];
}

/** 工具→归属 pack 登记（未去重，逐 pack 列出）：toolgate 载入期据此建立命名空间纪律、检测跨 pack 同名 toolId。 */
export interface ToolOwnership {
  packId: string;
  toolId: string;
}

/** pack 周期自动化描述符（adr-019）：客户端调度与展示用的纯数据；治理（一单预算/run 状态机）全在服务端。 */
export interface AutomationDescriptor {
  packId: string;
  /** 所属 pack 的 site.origin：客户端工作页判定的 origin 围栏。 */
  origin: string;
  automation: PackAutomation;
}

/** pack 内功能投影：title 缺省时展示回退 featureId。 */
export interface PackFeatureDescriptor {
  featureId: string;
  title?: string;
}

/** pack 工具面投影：baseTier 是 L2 收紧矩阵每行的档位下界（低于它的档位不可选，R1 只收紧）。 */
export interface PackToolDescriptor {
  toolId: string;
  baseTier: RiskTier;
  description: string;
}

/** pack 自动化投影（区别于 AutomationDescriptor：后者含调度所需 PackAutomation 全量）：仅展示与周期下限所需字段。 */
export interface PackAutomationDescriptor {
  id: string;
  /** pack 预设唤醒周期；L2 minutes 下限 = max(本值, 平台下限)。 */
  defaultPeriodMinutes?: number;
}

/**
 * 已安装 pack 的展示投影（配置中心 L1 数据源）：只投影展示与 L2 编辑所需字段，
 * 不含 skills/docs/feature 正文与工具 adapter（配置中心不需要，且避免把执行细节外泄到客户端）。
 */
export interface PackDescriptor {
  packId: string;
  /** pack.json name；缺省 = 展示回退 packId。 */
  name?: string;
  version: string;
  /** registry 登记来源（来源徽章数据源）。 */
  source: PackSource;
  summary?: string;
  /** site.origin；generic 兜底 pack 与 legacy 缺省 pack 无围栏，省略。 */
  origin?: string;
  /** 已归一路径前缀围栏；无 site 时省略。 */
  locations?: string[];
  /** true = generic 兜底 pack（无站点围栏，由网关运行时绑定活跃页 origin）。 */
  generic?: true;
  features: PackFeatureDescriptor[];
  /** 该 pack 各 feature 工具的并集（按 toolId 去重）。 */
  tools: PackToolDescriptor[];
  automations: PackAutomationDescriptor[];
  /** pack 声明的用户可配置点（adr-020）；未声明时省略。 */
  configSchema?: JsonObject;
  /**
   * pack 预置的快捷提问（R-5）：纯展示/查表投影，不参与 compose 的任何注入产物——
   * 装配引擎只在本投影里透出它，网关据此展开用户轮消息，配置中心据此列出可停用条目。未声明时省略。
   */
  quickActions?: QuickAction[];
}

export interface AssemblyPort {
  resolveFeature(input: ResolveFeatureInput): Promise<ResolveFeatureResult>;
  compose(input: ComposeInput): Promise<ComposeResult>;
  describeInjection(input: ComposeInput): Promise<InjectionDescription>;
  /** 读当前激活 pack 的 docs/ 单篇正文；只可读该 pack、路径穿越 fail-closed、单次截断上限。 */
  readPackDoc(input: ReadPackDocInput): Promise<ReadPackDocResult>;
  /** 全 pack 工具并集（toolgate fail-closed 判定的工具闭集来源，U7）；跨 pack 按 toolId 去重。 */
  allTools(): Promise<ToolDefinition[]>;
  /** 已安装带 site 围栏的 pack 列表（ADR-013）：per-origin 身份路由 + navigate 围栏校验用。 */
  listSites(): Promise<SiteDescriptor[]>;
  /** 逐 pack 列出工具归属（未去重）：toolgate 载入期命名空间纪律检测用。 */
  listToolOwnership(): Promise<ToolOwnership[]>;
  /** 全 pack 自动化描述符（adr-019）：id 跨 pack 唯一（载入期查重拒载）；generic pack 无（schema 禁声明）。 */
  listAutomations(): Promise<AutomationDescriptor[]>;
  /**
   * packId → pack.json 声明的 configSchema（adr-020）；未声明的 pack 不入表。
   * L2 写入通道以此表调 validateUserOverlay 做 packConfig 写入期校验（无表项即拒，fail-closed）。
   */
  listConfigSchemas(): Promise<Record<string, JsonObject>>;
  /** 已安装 pack 的展示投影（配置中心站点包页/个人定制页的 L1 数据源）：含未激活与被用户关停的 pack（关停状态属 L2，不在本投影）。 */
  listPacks(): Promise<PackDescriptor[]>;
}

// ---- ToolGatePort（③工具执行层：唯一决策点 + 代执行指令签发/回收）----

/** dom 代操作的判定上下文（adr-011）：网关自最近一次 snapshot-report 提取，toolgate 据此校验 ref 与围栏。 */
export interface DomGateContext {
  /** 最近快照的元素 ref 闭集：步骤引用越出即 deny。 */
  refs: string[];
  /** 快照页 URL 路径：不在 DomAdapter.pathPrefixes 围栏内即 deny。 */
  path: string;
  /** 快照页 origin（ADR-013）：site pack 的非 navigate dom 步须 === 工具所属 pack origin，越界即 deny。 */
  origin?: string;
  /** 最近快照元素的最小语义：按 ref 反查 role，判定敏感控件与确认卡「将发生什么」。 */
  elements?: SnapshotElement[];
  /** 最近快照按 pack 配方生成的结构化证据：只含闭集状态统计，不含消息正文。 */
  evidence?: Record<string, SnapshotEvidence>;
}

/**
 * ADR-013 任务组：工具所属激活 pack 的 site 上下文（网关按激活 pack 计算传入）。
 * packOrigin 缺省=legacy 无 site pack（沿用平台 claims 身份、不校 origin 围栏）。
 */
interface PackScopeInput {
  /** 工具所属激活 pack 的 id（取自装配结果，非模型自述）：任务级授权的作用域指纹分量；缺省=无 pack 作用域。 */
  packId?: string;
  /** 工具所属激活 pack 的 origin 围栏：站点 pack = site.origin；generic pack = 网关以活跃页 origin 填充；有值即启用 origin 围栏 + per-origin 身份口径。 */
  packOrigin?: string;
  /**
   * packOrigin 对应的宿主身份：tenant'd pack 取 per-origin 路由 claims（缺失/过期即 fail-closed），
   * no-tenant site pack 由网关回退为平台 claims。http/server 工具据此渲染与校验；dom 工具不用。
   */
  claimsForOrigin?: IdentityClaims;
}

/**
 * compose 定格的 L2 生效面（封 TOCTOU）：toolgate MUST NOT 依赖 UserConfigStore（U2），只消费本入参；
 * 判定 riskTier = max(静态定义值, effectiveTiers[toolId] ?? 静态值)——端口入参只能收紧不能放宽（U7 防御纵深）。
 */
export interface GateUserConfigInput {
  /** compose 本轮定格的 overlay revision（内容 hash）；与 assembly/tool-decision 审计事件同值互证（R4）。degraded 时缺省。 */
  revision?: string;
  /** true = L2 读失败且无缓存的拆分降级轮（工具面已全 forbidden，U7）；此时 revision 缺省，审计以 userConfigDegraded 标注互证。 */
  degraded?: true;
  /** toolId → L2 合并后的生效分级（含 disabledTools 置 forbidden 的条目）；未列出的 toolId 用静态定义值。 */
  effectiveTiers: Record<string, RiskTier>;
}

export interface GateDecisionInput extends PackScopeInput {
  sessionId: string;
  toolCallId: string;
  toolId: string;
  params: JsonObject;
  claims: IdentityClaims;
  /**
   * dom 工具的判定上下文（未观察不操作）；http/server 工具忽略。
   * 定向调用（params.targetPage 有值，adr-023 D3）时须为目标页定向快照的上下文；定向单步 navigate 批次免缺省即 deny 语义。
   */
  domContext?: DomGateContext;
  /** 本轮定格的 L2 生效面；缺省 = 无 L2 参与（纯静态分级判定）。 */
  userConfig?: GateUserConfigInput;
  /**
   * 会话组页面状态表快照（adr-023 D3 定向目标解析基准）：句柄只作等值比对（U5）。
   * params.targetPage 有值而本表缺省/未命中一律拒签（U7 fail-closed，禁回退活跃页）；无 targetPage 的调用不消费本表。
   */
  groupPages?: GroupPageEntry[];
  /**
   * 本回合无人在场（adr-024 D1，网关按 automationRun 判定后传入）：生效档为 hitl 一律 deny
   * 且不消费任务级授权；缺省=人工回合，判定逐字节同基线。
   */
  unattended?: true;
}

/** 判定结果：分级矩阵 + 身份/实参校验，任一不过即 deny（fail-closed，U7）。 */
export interface GateDecision {
  verdict: GateVerdict;
  reason?: string;
  /**
   * hitl 判定随附的净化终值步骤（已剥模型幻觉键、ref 已验出自最近快照）：网关据此组装确认卡的
   * 机械摘要——用户批准的必须是将被签发执行的内容，而非模型在 params 里自述的 summary/plan。
   * 纯数据、不参与任何判定；非 hitl 判定一律缺省。
   */
  sanitizedSteps?: DomStep[];
  /** 随 sanitizedSteps 下发的一次性指令有效期（毫秒）：确认卡治理小字据此如实标注，客户端不自拟。 */
  instructionTtlMs?: number;
}

export interface IssueExecInstructionInput extends PackScopeInput {
  sessionId: string;
  toolCallId: string;
  toolId: string;
  params: JsonObject;
  /** 已验签身份：adapter 模板可经 {{hostUserId}} 等占位注入身份到请求头/URL/体（身份优先于 params，防工具冒充）。 */
  claims: IdentityClaims;
  /** dom 工具必需：签发是治理终点，签名前独立重校验（不依赖 decide 已通过的假设，U7）；定向语义同 GateDecisionInput.domContext。 */
  domContext?: DomGateContext;
  /** 本轮定格的 L2 生效面（与 decide 同一冻结值）；缺省 = 无 L2 参与。 */
  userConfig?: GateUserConfigInput;
  /** 会话组页面状态表快照：签发前独立重解析定向目标（语义同 GateDecisionInput.groupPages，U7 封 TOCTOU）。 */
  groupPages?: GroupPageEntry[];
  /** 本回合无人在场（语义同 GateDecisionInput.unattended）；缺省=人工回合。 */
  unattended?: true;
}

export interface AcceptExecResultInput {
  sessionId: string;
  result: ExecResultFrame;
}

/** 规整后的 observation：仅校验通过的结果才回喂 agent（U7）。 */
export interface Observation {
  toolCallId: string;
  ok: boolean;
  content: JsonValue;
  error?: string;
}

/**
 * 任务级 HITL 授权登记：hitl 获批后记 grant，同会话同 pack 同 origin 的同任务后续调用（跨工具）
 * decide 直接放行（一任务一授权）。作用域指纹 = (sessionId, packId, packOrigin, task)——
 * 前三项是服务端自持事实，唯一由模型提供的 task 不做归一化。
 */
export interface HitlGrantInput {
  sessionId: string;
  /** agent 声明的任务标题（params.task）：授权作用域即用户在确认卡上看到并批准的这个任务。 */
  task: string;
  /** 批准时激活 pack 的 id（语义同 GateDecisionInput.packId）；缺省须与 decide 侧同样缺省才命中。 */
  packId?: string;
  /** 批准时激活 pack 的 origin（语义同 GateDecisionInput.packOrigin）；缺省须与 decide 侧同样缺省才命中。 */
  packOrigin?: string;
}

export interface ToolGatePort {
  /** 插件经已鉴权 SSE 响应取得的 Ed25519 SPKI 公钥；仅用于指令验签。 */
  getExecVerificationKey(): Promise<{ algorithm: 'Ed25519'; publicKey: string }>;
  decide(input: GateDecisionInput): Promise<GateDecision>;
  /**
   * 批准恢复期复核（adr-024 D3）：approve 之后、签发之前以当轮最新上下文重跑判定链
   * （分级 + L2 收紧终值 + 身份 + 围栏 + dom 步骤 ref 出自最近快照）。
   * 通过=allow；任一不过=deny reason `approval-stale`（用户批准的是当时那个动作，不是长期通行证）。
   * 只判定不落状态：既不登记也不消费任务级授权。
   */
  reconfirmApproval(input: GateDecisionInput): Promise<GateDecision>;
  /**
   * 登记任务级授权：同 (sessionId,packId,packOrigin,task) 的后续 decide 放行（跨工具共享，every-call 工具除外），
   * 滑动 TTL 过期 / 用户停止吊销后回到 hitl。
   */
  grantHitl(input: HitlGrantInput): Promise<void>;
  /**
   * 吊销本会话全部任务级授权（adr-024 D2）：用户点停止即收回自动执行授权，后续同任务回到 hitl。
   * 幂等；无授权的会话是无操作。
   */
  revokeHitlGrants(sessionId: string): Promise<void>;
  /** 前提：decide 已放行（allow 或 hitl 获批）。签发即登记一次性 nonce。 */
  issueExecInstruction(input: IssueExecInstructionInput): Promise<ExecInstructionFrame>;
  /** 核销 nonce、验 ttl、按 resultSchema 校验后规整；任一不过返回 ok=false 的 observation。 */
  acceptExecResult(input: AcceptExecResultInput): Promise<Observation>;
  /**
   * server 通道服务端直调：前提 decide 已放行。按 ServerAdapter 渲染请求、解析 credentialRef 注入凭证
   * （真值只存于本次请求构造，MUST NOT 落日志/审计/Context），响应体过 resultSchema 校验后规整为 observation。
   * 不经 nonce/客户端回传（那是 client 通道）；凭证解析不到时按未配置处理返回 ok=false。
   */
  executeServer(input: IssueExecInstructionInput): Promise<Observation>;
}

// ---- UserConfigStore（L2 用户覆盖层存储端口，adr-014：事实源在服务端，换实现不换端口）----

export interface UserConfigReadResult {
  /** null = 该 subject 尚无 overlay。 */
  overlay: UserOverlay | null;
  /** overlay 内容 hash；空 overlay 亦有稳定 revision——compose 每回合定格该值，注入透明视图/审计/工具判定三方互证（R4）。 */
  revision: string;
  /** true = 本次读取失败、返回的是最近一次成功读取的结果（lastGood）——消费方须落审计标注；缺省 = 新鲜读取。 */
  stale?: true;
}

export interface UserConfigWriteResult {
  revision: string;
}

/**
 * L2 覆盖层读写端口（U1：出入参全 JSON 可序列化；U2：toolgate 不直接依赖本端口，
 * 定格结果经端口入参传递封 TOCTOU）。restrictions/enabled 读失败语义 fail-closed（U7）由消费方承担。
 */
export interface UserConfigStore {
  read(subject: UserConfigSubject): Promise<UserConfigReadResult>;
  /** 前提：overlay 已过 validateUserOverlay 组合校验与只收紧校验（写入期拒绝低于 L1 的声明）。 */
  write(subject: UserConfigSubject, overlay: UserOverlay): Promise<UserConfigWriteResult>;
}

// ---- LlmPort（④LLM 接入层：provider 白名单插拔，密钥托管在实现侧）----

/** assistant 回合发起的工具调用回声；供回喂轮把 role:tool 观察关联到其发起调用（OpenAI 兼容 API 要求）。 */
export interface LlmToolCall {
  id: string;
  name: string;
  params: JsonObject;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时关联的调用。 */
  toolCallId?: string;
  /** role=assistant 且本轮发起了工具调用时的回声；缺省=纯文本轮。 */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** 内联 JSON Schema，来自 ToolDefinition.params。 */
  params: JsonObject;
}

export interface LlmChatRequest {
  /** 省略 = 实现侧默认 provider/model（白名单内）。 */
  model?: string;
  /** 可选调用标识；调用方可用同一 JSON 标识请求取消仍在流式输出的调用。 */
  requestId?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
}

/**
 * 上游失败类别闭集：消费侧据此如实分流（配置错误不得渲染成服务故障，R6），
 * 类别本身不含任何响应体原文与凭证形态（SEC-04）。
 * invalid-tool-args=模型产出的实参 JSON 非法/截断，可回喂重试自愈。
 */
export type LlmErrorKind =
  | 'invalid-tool-args'
  | 'context-overflow'
  | 'rate-limit'
  | 'quota'
  | 'auth'
  | 'endpoint-invalid'
  | 'transport'
  | 'stream-interrupted'
  | 'timeout';

export type LlmStreamEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; toolCallId: string; name: string; params: JsonObject }
  | {
      kind: 'done';
      stopReason: 'end' | 'tool-call' | 'error';
      error?: string;
      /** 错误类别（stopReason=error 时可选）。 */
      errorKind?: LlmErrorKind;
      /**
       * errorKind='invalid-tool-args' 时随附出错调用的标识：消费侧据此以「同 toolCallId 的 role:tool 观测」
       * 回喂错误让模型自纠，而不必伪造用户消息或另起 id。
       */
      invalidToolCall?: { toolCallId: string; name: string };
      /** 上游因输出长度上限截断本次回答（finish_reason=length）；消费侧须如实告知用户回答不完整。 */
      truncated?: true;
      /** 上游返回 token 用量时透传（缺省=上游未报，消费侧回退字符近似估算）。 */
      usage?: { inputTokens: number; outputTokens: number };
    };

export interface LlmPort {
  chat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
  /** 取消对应流式调用；未知或已结束 requestId 无操作。 */
  cancel(requestId: string): void;
}

// ---- AuditPort（⑦观测审计：record-only 旁路）----

export interface AuditPort {
  /** 旁路铁律：实现不抛异常、失败仅本地日志，故障不进控制流；事件已由调用方脱敏。 */
  record(event: AuditEvent): void;
}
