/**
 * C1 工具定义类型——权威在 schemas/tool-definition.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */
import type { JsonObject } from './json.js';

/** 执行通道闭集（U3）：MVP 只实现 client，server 枚举保留不删。 */
export type ToolExecution = 'client' | 'server';

/** 操作分级闭集（分级矩阵落点）：服务端 fail-closed 判定（U7），未知值一律 deny。 */
export type RiskTier = 'auto' | 'hitl' | 'forbidden';

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

interface ToolDefinitionBase {
  id: string;
  featureIds: string[];
  /** 面向 LLM 的工具说明，装配期原样进 tool spec。 */
  description: string;
  /** 入参契约：内联 JSON Schema（draft 2020-12）。 */
  params: JsonObject;
  riskTier: RiskTier;
  /** 结果契约：exec-result.body 校验不过即 invalid-result、不回喂 agent（U7）。 */
  resultSchema: JsonObject;
  /** UI 调用模式分组标签（纯展示，不参与 U7 治理判定）；缺省时网关按 execution 推断为 client|server。 */
  apiMode?: 'client' | 'server' | 'mcp';
}

export interface ClientToolDefinition extends ToolDefinitionBase {
  execution: 'client';
  adapter: ClientAdapter;
}

export interface ServerToolDefinition extends ToolDefinitionBase {
  execution: 'server';
  adapter: ServerAdapter;
}

/** 按 execution 判别的联合，对应 schema 根级 if/then 分形。 */
export type ToolDefinition = ClientToolDefinition | ServerToolDefinition;
