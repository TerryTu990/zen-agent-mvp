/**
 * C1 工具定义类型——权威在 schemas/tool-definition.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */
import type { JsonObject } from './json.js';

/** 执行通道闭集（U3）：client 与 server 均已实现；client 内按 adapter.kind 分形（http / dom）。 */
export type ToolExecution = 'client' | 'server';

/** 操作分级闭集（分级矩阵落点）：服务端 fail-closed 判定（U7），未知值一律 deny。 */
export type RiskTier = 'auto' | 'hitl' | 'forbidden';

/**
 * HITL 授权粒度（仅 riskTier=hitl 有意义，缺省 per-task）：
 * per-task=同任务首批确认后自动放行；every-call=对外不可撤回动作，次次挂起单独确认、不复用授权。
 */
export type HitlMode = 'per-task' | 'every-call';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** client 通道适配：宿主 API 请求模板，{{param}} 占位符由服务端代入实参后签名下发。 */
export interface ClientAdapter {
  method: HttpMethod;
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: JsonObject | string;
}

/** server 通道适配（服务端直调，已实现）：凭证只写引用名，真值由执行器边界运行时注入。 */
export interface ServerAdapter {
  method: HttpMethod;
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: JsonObject | string;
  credentialRef?: string;
}

/**
 * dom 通道适配（adr-011 可见页面代操作）：无请求模板——步骤由 agent 按页面快照临场决策、
 * 服务端逐批 fail-closed 校验后一次性签名下发（U7 治理链路与 client HTTP 代执行同构）。
 */
export interface DomAdapter {
  kind: 'dom';
  /** URL 路径前缀围栏：快照页路径不在围栏内即 deny，操作面不越出功能页面范围。 */
  pathPrefixes: string[];
  /** pack 声明的只读结构化证据配方；客户端按消息容器去重并只返回状态枚举，不返回正文。 */
  snapshotEvidence?: SnapshotEvidenceRule[];
}

export interface SnapshotEvidenceRule {
  id: string;
  itemSelector: string;
  statusSelector: string;
  statuses: string[];
}

interface ToolDefinitionBase {
  id: string;
  featureIds: string[];
  /** 面向 LLM 的工具说明，装配期原样进 tool spec。 */
  description: string;
  /** 入参契约：内联 JSON Schema（draft 2020-12）。 */
  params: JsonObject;
  riskTier: RiskTier;
  /** 缺省 per-task；every-call 使 toolgate 对本工具跳过任务级授权复用、次次挂起确认（对外不可撤回动作）。 */
  hitlMode?: HitlMode;
  /** 结果契约：exec-result.body 校验不过即 invalid-result、不回喂 agent（U7）。 */
  resultSchema: JsonObject;
}

export interface ClientToolDefinition extends ToolDefinitionBase {
  execution: 'client';
  adapter: ClientAdapter;
}

/** dom 代操作工具：client 通道下按 adapter.kind='dom' 分形（可见执行，走同一签名指令链路）。 */
export interface DomToolDefinition extends ToolDefinitionBase {
  execution: 'client';
  adapter: DomAdapter;
}

export interface ServerToolDefinition extends ToolDefinitionBase {
  execution: 'server';
  adapter: ServerAdapter;
}

/** 按 execution（client 下再按 adapter.kind）判别的联合，对应 schema 根级 if/then 分形。 */
export type ToolDefinition = ClientToolDefinition | DomToolDefinition | ServerToolDefinition;

export function isDomTool(tool: ToolDefinition): tool is DomToolDefinition {
  return 'kind' in tool.adapter && tool.adapter.kind === 'dom';
}

/**
 * 内建跨站导航工具的结构契约（ADR-013 渐进披露第一层配套）：不入 pack tools.json，由网关注入工具面、
 * toolgate 专路裁决与签发。此处只放结构（id + 入/出参 schema）——面向 LLM 的说明属运行期提示，随注入点定义，
 * 不落此结构契约。params.url 为索引中已安装站点的目标绝对 URL；result.url 与 navigate dom 步的回传本体同构（U7 回收）。
 */
export const SITE_NAVIGATE_TOOL_ID = 'site_navigate';

/**
 * 内建导航的任务级计划（与 dom 代操作工具的 plan 同义：整任务将执行的操作清单）。
 * 与 task 同现时导航卡按任务授权卡呈现、批准即登记任务级授权；单独出现无治理意义。
 * 口径与 browse.page-operate.plan 一致（items string、不设上限），空清单不构成计划。
 */
const TASK_PLAN_SCHEMA: JsonObject = { type: 'array', minItems: 1, items: { type: 'string' } };

export const SITE_NAVIGATE_PARAMS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string' },
    reason: { type: 'string' },
    task: { type: 'string' },
    plan: TASK_PLAN_SCHEMA,
    // 定向目标成员页句柄（adr-023 D3）：内建 navigate 可定向任意组内页（含 silent，导航即其激活通路）；
    // 约束与 C3 句柄同界（1..64，无 pattern——不透明，U5），解析/拒签在 toolgate 签发前完成。
    targetPage: { type: 'string', minLength: 1, maxLength: 64 },
  },
};

export const SITE_NAVIGATE_RESULT_SCHEMA: JsonObject = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
};

/**
 * 内建通用页面导航工具的结构契约（generic pack 配套）：不入 pack tools.json，由网关在 generic 激活时注入、
 * toolgate 专路裁决与签发（协议闭集 http/https + 禁内嵌凭证；带 task 且任务已获授权即放行，否则确认）。
 * params 与 site_navigate 同形；result 独立同形 schema（{url} 必填），按 toolId 独立选校验器，两工具契约可各自演进。
 */
export const OPEN_URL_TOOL_ID = 'open_url';

export const OPEN_URL_PARAMS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string' },
    reason: { type: 'string' },
    task: { type: 'string' },
    plan: TASK_PLAN_SCHEMA,
    // 语义同 SITE_NAVIGATE_PARAMS_SCHEMA.targetPage（adr-023 D3 定向）。
    targetPage: { type: 'string', minLength: 1, maxLength: 64 },
  },
};

export const OPEN_URL_RESULT_SCHEMA: JsonObject = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
};

/**
 * 内建配置草稿工具的结构契约（adr-014 teach 流，U8）：agent 识别用户表达的稳定偏好后调用，
 * 只产草稿卡（config-draft 帧下发）、零副作用——真正的确认是上行 config-decision，故 riskTier=auto、
 * 不复用 hitl 裁决链路。不入 pack tools.json，由网关注入工具面并在服务端专路处理（条目 id/origin/
 * createdAt/change 均服务端构造，客户端只回传 draftId+decision）。
 * params 字段约束与 user-overlay.schema.json 同源对齐（text/featureId/toolId/riskTierRaise 值域），
 * 保证草稿通过本入参校验后构造出的 overlay 片段不因结构越界在写入期被拒。
 * rules/facts/riskTierRaise 至少一项非空（anyOf 强制）。
 */
export const CONFIG_DRAFT_TOOL_ID = 'config_draft';

export const CONFIG_DRAFT_PARAMS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['packId'],
  // anyOf 分支内的 properties 空 stub 满足 ajv strictRequired（required 属性须在同层 properties 声明）。
  anyOf: [
    { required: ['rules'], properties: { rules: true } },
    { required: ['facts'], properties: { facts: true } },
    { required: ['riskTierRaise'], properties: { riskTierRaise: true } },
  ],
  properties: {
    packId: { type: 'string', pattern: '^(\\*|[a-z][a-z0-9-]*)$' },
    featureId: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    facts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    riskTierRaise: {
      type: 'object',
      minProperties: 1,
      propertyNames: { pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$' },
      additionalProperties: { type: 'string', enum: ['hitl', 'forbidden'] },
    },
  },
};

export const CONFIG_DRAFT_RESULT_SCHEMA: JsonObject = {
  type: 'object',
  required: ['draftId', 'status'],
  properties: {
    draftId: { type: 'string' },
    /** 唯一合法结局：草稿已发出等待用户裁决；写入结果不经本工具回传（accept 走 config-decision 专路）。 */
    status: { type: 'string', enum: ['pending-decision'] },
  },
};
