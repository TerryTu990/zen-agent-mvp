/**
 * C1 工具定义类型——权威在 schemas/tool-definition.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */
import type { JsonObject } from './json.js';

/** 执行通道闭集（U3）：MVP 只实现 client，server 枚举保留不删。 */
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

/** server 通道适配（U3 保留段，MVP 定形不实现）：凭证只写引用名，真值运行时注入。 */
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

export const SITE_NAVIGATE_PARAMS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string' },
    reason: { type: 'string' },
    task: { type: 'string' },
  },
};

export const SITE_NAVIGATE_RESULT_SCHEMA: JsonObject = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
};
