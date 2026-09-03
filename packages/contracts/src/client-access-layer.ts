/**
 * C3 客户端接入层类型——权威在 schemas/client-access-layer.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 * 五能力与帧闭集不随客户端形态变（U5）；所有帧 JSON 可序列化（U1）。
 */
import type { JsonObject, JsonValue } from './json.js';
import type { HttpMethod, SnapshotEvidenceRule } from './tool-definition.js';
import type { PackSource } from './config-snapshot.js';

/** 五能力闭集（U5）：任何客户端形态实现同一组能力。 */
export type ClientCapability =
  | 'identity'
  | 'context-report'
  | 'conversation-hitl'
  | 'page-action'
  | 'delegated-execution';

export type HitlDecisionValue = 'approve' | 'reject';

export type ExecutionPreference =
  | 'auto'
  | 'dom-only'
  | 'prefer-client-api'
  | 'prefer-server-api';

export type ToolCardStatus = 'running' | 'succeeded' | 'failed';

/** 页面动作闭集（纯引导，无副作用）：填表/替点走 delegated-execution 的 dom 通道（adr-011），不入本闭集。 */
export type GuideActionKind = 'highlight' | 'scroll-to';

// ---- 上行帧（客户端 → 网关，HTTP）----

export interface ContextReportFrame {
  type: 'context-report';
  sessionId: string;
  url: string;
  title?: string;
  /** 客户端推断值仅供参考；权威判定在服务端 manifest.featureIdRules。 */
  featureId?: string;
  /** 白名单快照：仅含功能配置允许采集的字段。 */
  snapshot?: JsonObject;
}

export interface UserMessageFrame {
  type: 'user-message';
  sessionId: string;
  text: string;
  messageId?: string;
  executionPreference?: ExecutionPreference;
  /** 插件后台生成的自动扫描轮次标识；只收紧服务端单轮预算，不授予任何执行权限。 */
  automationRunId?: string;
  /**
   * 发起本自动回合的自动化标识：pack 自动化声明 id（adr-019）或用户自建 watch id（adr-021）；
   * 完成帧 tool-card 以此为 toolId 精确关联。本字段只收紧不授权——服务端解析到只读模板的 watch 即
   * 强制该轮只读工具面；解析不到（既非已声明 pack 自动化也非已存 watch）一律拒绝该轮而非回落普通回合——
   * 回落会把无人值守轮交还完整工具面，R7 只读底线随之失守。
   */
  automationId?: string;
}

export interface HitlDecisionFrame {
  type: 'hitl-decision';
  sessionId: string;
  hitlId: string;
  decision: HitlDecisionValue;
  comment?: string;
}

export interface ExecResultFrame {
  type: 'exec-result';
  sessionId: string;
  /** 关联 exec-instruction，服务端一次性核销（U7）。 */
  nonce: string;
  ok: boolean;
  status?: number;
  body?: JsonValue;
  error?: string;
}

/** 页面可交互元素条目：ref 由客户端分配（za-N），仅当次快照内有效。 */
export interface SnapshotElement {
  ref: string;
  /** 元素角色：标签名，input 附类型（如 input:text）。 */
  role: string;
  /** 可读标签：aria-label / 文本 / placeholder，客户端截断。 */
  label: string;
  /** 仅 a[href] 的绝对 http(s) URL；供服务端把商品/订单证据绑定到可见链接。 */
  href?: string;
  value?: string;
  disabled?: boolean;
}

/** 页面快照上报（dom 代操作的观察半程）：对应下行 snapshot-request 的 requestId。 */
export interface SnapshotReportFrame {
  type: 'snapshot-report';
  sessionId: string;
  requestId: string;
  url: string;
  /** content script 本次页面生命周期的随机标识；导航/刷新/切换标签页后变化。 */
  pageInstanceId?: string;
  title?: string;
  elements: SnapshotElement[];
  /** true=elements 只是配额内的子集，agent MUST NOT 据此断言页面上没有某控件；缺省/false=清单完整。 */
  elementsTruncated?: boolean;
  /** 被配额丢弃的可交互元素个数（0=恰好用满配额而无丢弃）。elementsTruncated 缺席时本字段不得出现。 */
  elementsOmitted?: number;
  /** 客户端快照世代（自 1 起单调递增）：ref 对元素黏附，服务端原样落入 dom 判定上下文标定 ref 闭集的代次。 */
  snapshotEpoch?: number;
  /** 页面当前可见的告警/校验/状态提示文本（客户端去重截断）：供 agent 识别表单校验等拦截性提示。 */
  notices?: string[];
  /** 页面正文纯文本，仅 includeText 请求时采集；未请求或页面无正文一律缺席（空串非法）。与 elements 同属不可信观察。 */
  text?: string;
  /** true=text 仅为正文前缀（客户端已截断）；缺省/false=完整。text 缺席时本字段不得出现。 */
  textTruncated?: boolean;
  evidence?: Record<string, SnapshotEvidence>;
}

export interface SnapshotEvidence {
  count: number;
  latest: string;
}

export type GroupPageStatus = 'active' | 'background' | 'silent';

/** 任务组成员页条目：handle 为会话作用域不透明句柄——服务端只作等值比对，禁解析内部结构（U5）。 */
export interface GroupPageEntry {
  handle: string;
  url: string;
  /** 客户端截断后的页面标题；缺省 = 无标题。 */
  title?: string;
  /** active=当前活跃成员；background=content 会话端口在场的非活跃成员；silent=入组但无 content script 交互保证。 */
  status: GroupPageStatus;
}

/**
 * 任务组页面清单上报（adr-023 D1）：组内成员页全量列表，服务端以每帧整体重建组页面状态表
 * （无增量语义）。清单是数据不是指令（U8）：只驱动状态表与清单注入，不改变任何治理判定。
 */
export interface GroupPagesFrame {
  type: 'group-pages';
  sessionId: string;
  pages: GroupPageEntry[];
}

export type ConfigDecisionValue = 'accept' | 'reject';

/** 配置草稿裁决回传（adr-014 teach 流）：对应下行 config-draft 的 draftId；accept 后服务端才执行写入链路。 */
export interface ConfigDecisionFrame {
  type: 'config-decision';
  sessionId: string;
  draftId: string;
  decision: ConfigDecisionValue;
}

export type UpstreamFrame =
  | ContextReportFrame
  | UserMessageFrame
  | HitlDecisionFrame
  | ExecResultFrame
  | SnapshotReportFrame
  | GroupPagesFrame
  | ConfigDecisionFrame;

// ---- 下行帧（网关 → 客户端，SSE）----

export interface TextDeltaFrame {
  type: 'text-delta';
  sessionId: string;
  delta: string;
  /** 停止后仍须呈现的人工核对告警；仅服务端赋值。 */
  priority?: 'safety';
}

/**
 * 回合终止原因闭集：面板据此分流后续动作（如 max-rounds 提示「继续」），
 * 评测按取值断言而非 grep 文案。服务端唯一产出，客户端只渲染、不判定（U7）。
 */
export type TurnCompleteReason =
  | 'completed'
  | 'stopped'
  | 'max-rounds'
  | 'consecutive-failures'
  | 'llm-error'
  | 'llm-timeout'
  | 'tool-not-available';

export interface TurnCompleteFrame {
  type: 'turn-complete';
  sessionId: string;
  messageId?: string;
  idle: boolean;
  /** 缺省=未标注（旧客户端兼容）。 */
  reason?: TurnCompleteReason;
}

export interface ToolCardFrame {
  type: 'tool-card';
  sessionId: string;
  toolCallId: string;
  toolId: string;
  status: ToolCardStatus;
  /** 面向用户的已脱敏摘要；不下发完整 params/body。 */
  summary?: string;
  /** UI 分组用调用模式（纯展示，不承载判定）：client 用户会话代执行 / server 服务端直调。 */
  mode?: 'client' | 'server';
}

/**
 * HITL 卡目标页展示（adr-023 D3）：服务端自组页面状态表组装并消毒（U8），插件只渲染不判定。
 * 仅定向到非活跃页时下发；缺省 = 副作用落在当前活跃页，不加目标页措辞（ADR §5）。
 */
export interface HitlPageDisplay {
  /** 状态表目标页标题（服务端消毒截断）；无标题省略。 */
  title?: string;
  /** 目标页 origin；URL 不可解析时省略。 */
  origin?: string;
}

/**
 * 确认卡机械摘要条目：服务端把 toolgate 校验后的净化终值步骤按最近快照元素表反解所得（U8）。
 * 用户裁决的是「将真正发生什么」，不是模型在 params 里自述的 summary/plan。
 */
export interface HitlEffect {
  /** 动作措辞（点击/填写/读取/导航到…），取自服务端闭集映射。 */
  action: string;
  /** 目标描述：元素反解为「标签（角色）」；导航步为目标地址；反解不出即如实标注目标未知，不猜测。 */
  target: string;
  /** fill/select 的写入值摘要（消毒+截断）；密码/文件类控件与反解不出的目标一律省略（fail-closed）。 */
  valuePreview?: string;
}

/** 确认卡来源 pack 展示（R4 作用站点与来源 pack）：服务端组装消毒，客户端只渲染徽章与措辞。 */
export interface HitlPackDisplay {
  packId: string;
  /** pack.json name；未声明时省略，展示回退 packId。 */
  name?: string;
  /** registry 登记来源（来源徽章数据源）。 */
  source?: PackSource;
  /** 作用站点：site pack 取 site.origin，generic pack 取激活时绑定的活跃页 origin；无围栏时省略。 */
  origin?: string;
}

export interface HitlRequestFrame {
  type: 'hitl-request';
  sessionId: string;
  hitlId: string;
  toolCallId?: string;
  toolId: string;
  /** 本次调用实参：用户须看到真实将发生什么。 */
  params: JsonObject;
  reason?: string;
  /** 定向到非活跃页的副作用目标页展示；缺省 = 活跃页（不加措辞）。 */
  targetPage?: HitlPageDisplay;
  /** navigate 类调用（open_url/site_navigate/单步 navigate 批次）的目标 URL：卡正文 MUST 呈现，服务端已消毒。 */
  targetUrl?: string;
  /** 服务端反解的机械摘要：卡正文 MUST 优先呈现，params 内模型自述只作次要信息。 */
  effects?: HitlEffect[];
  /** 工具所属激活 pack 的展示信息；无 pack（仅基座）时省略。 */
  pack?: HitlPackDisplay;
  /** 风险行文案（UI 规范 §5 五要素之一）：服务端按净化终值机械派生，不取模型自述。 */
  risk?: string;
  /** 本次确认由用户自己收紧分级而来时标注（R4 可追溯）；pack 默认即需确认时省略。 */
  tightenedBy?: 'L2';
  /** 批准后签发的一次性指令有效期（毫秒）：治理小字据此标注有效期。 */
  ttlMs?: number;
}

/** 服务端已定值的最终请求，客户端不做模板求值。 */
export interface ExecRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: JsonValue;
}

/**
 * dom 步骤动作闭集（adr-011）：navigate/waitFor 契约保留、②-a 未实现——
 * toolgate fail-closed 拒绝（锚点=②-b 跨导航续跑），对齐 U3"枚举保留、未实现拒绝"惯例。
 */
export type DomStepAction =
  | 'navigate'
  | 'waitFor'
  | 'click'
  | 'fill'
  | 'select'
  | 'read'
  | 'scroll'
  | 'highlight';

export interface DomStep {
  action: DomStepAction;
  /** 目标元素引用：必须取自最近一次 snapshot-report 的 ref（服务端签发前校验）。navigate 步免除。 */
  ref?: string;
  /** navigate 目标绝对 URL（ADR-013 批次④启用）：须落在某已安装 pack 的 site 围栏内，服务端签发前校验。 */
  url?: string;
  /** navigate 目标（同源路径，②-b 保留字段）。 */
  to?: string;
  /** fill/select 的输入值。 */
  value?: string;
  /** read 结果键名：exec-result.body.reads 按此键回传采集值。 */
  name?: string;
}

/** dom 代执行请求：服务端已校验的步骤批次，客户端闭集解释执行、不 eval 任意代码。 */
export interface DomExecRequest {
  kind: 'dom';
  steps: DomStep[];
  /**
   * 副作用指令的机械执行围栏：服务端只钉可核对的维度（有界履约钉 URL+页面实例，定向批次钉状态表目标页 URL），
   * 客户端逐字段等值比较、未钉维度不参与判定，不承担治理判定。
   */
  expectedPageUrl?: string;
  expectedPageInstanceId?: string;
}

export interface ExecInstructionFrame {
  type: 'exec-instruction';
  sessionId: string;
  nonce: string;
  /** 服务端签发绝对时间与失效绝对时间；客户端在任何副作用前验签并验 expiresAt。 */
  issuedAt: number;
  expiresAt: number;
  /** 自签发起的存活毫秒数，过期作废（U7）。 */
  ttl: number;
  /** Ed25519 对 {sessionId,nonce,issuedAt,expiresAt,ttl,toolCallId,targetPage?,request} 规范化序列的签名（targetPage 取本帧 page 值）：定向落点同受签名保护，篡改即验签失败。 */
  signature: string;
  toolCallId: string;
  /**
   * 定向副作用目标成员页句柄（adr-023 D3）：会话作用域不透明字符串，客户端只作等值比对单播成员（U5）。
   * 缺省=现活跃页路由语义（含 fail-safe 回退链）逐字节不变；有值时句柄成员不可达则不投递，禁改投其他成员。
   * 服务端仅对状态表命中且围栏/通道分级通过的句柄签发本字段（U7 fail-closed 在签发前完成）。
   */
  page?: string;
  request: ExecRequest | DomExecRequest;
}

export interface GuideActionFrame {
  type: 'guide-action';
  sessionId: string;
  action: GuideActionKind;
  /** CSS 选择器；与 ref 二选一。未命中时客户端静默降级为文字说明，不中断会话。 */
  selector?: string;
  /** 最近一次页面快照的元素 ref；无登记 selector 的站点走此路径，映射作废即降级。 */
  ref?: string;
  message?: string;
  /**
   * 定向引导目标成员页句柄（adr-023 D3）：语义同 exec-instruction.page；纯引导无副作用，无签名面。缺省=活跃页路由。
   * 预留未接线——服务端不填充本字段，引导恒落活跃页；接线锚点＝出现「引导用户查看组内非活跃页元素」的真实场景时。
   */
  page?: string;
}

/**
 * 页面快照请求：客户端以 snapshot-report 回传（requestId 关联）。
 * 缺省（无 page）路由到组内活跃页；带 page 时按句柄单播目标成员页（adr-023 D2）。
 */
export interface SnapshotRequestFrame {
  type: 'snapshot-request';
  sessionId: string;
  requestId: string;
  /**
   * 定向观察目标成员页句柄：会话作用域不透明字符串，客户端只作等值比对定位成员（U5）。
   * 缺省=现活跃页路由语义不变；有值时句柄成员不在组内则不投递，禁回退活跃页。
   * 服务端仅对状态表命中且非 silent 的句柄下发（U7 fail-closed 在签发前完成）。
   */
  page?: string;
  /** 缺省 false：正文体量大，只在需要阅读页面内容的那一轮开启；开启不改变任何治理判定。 */
  includeText?: boolean;
  evidenceRules?: SnapshotEvidenceRule[];
}

/**
 * L2 配置草稿卡（adr-014 teach 流，U8）：对话内容永不直写配置——服务端产草稿下发本帧，
 * 用户经上行 config-decision 显式确认后才走写入链路（落盘前仍过 user-overlay 组合校验与只收紧校验）。
 * 只复用插件卡片 UI 呈现，不复用 hitl-request 帧语义与 toolgate 裁决链路。
 */
export interface ConfigDraftFrame {
  type: 'config-draft';
  sessionId: string;
  draftId: string;
  /** 拟写入作用域：packId="*" 为全局作用域；featureId 缺省 = 整 pack 生效；title 为人读作用域标签（服务端按 pack.name/feature 标题渲染）。 */
  scope: { packId: string; featureId?: string; title?: string };
  /** 拟写入的 overlay 片段（user-overlay 作用域子结构，纯数据）；用户须看到真实将写入什么。服务端 MUST 保证与 scope 一致（scope 是 change 的机械投影），accept 落库前校验。 */
  change: JsonObject;
  /** 人读摘要，确认卡展示用（已脱敏）。 */
  summary: string;
}

export type DownstreamFrame =
  | TextDeltaFrame
  | TurnCompleteFrame
  | ToolCardFrame
  | HitlRequestFrame
  | ExecInstructionFrame
  | GuideActionFrame
  | SnapshotRequestFrame
  | ConfigDraftFrame;

export type ClientAccessFrame = UpstreamFrame | DownstreamFrame;
