/**
 * 模块化单体的唯一组装点（U2）：全仓只有本包同时 import 全部模块包；
 * 模块间彼此零依赖，只经 @zen-agent/contracts 端口类型在此接线。
 */
import type { AssemblyPort, AuditPort, LlmPort, ToolGatePort } from '@zen-agent/contracts';
import { createAssemblyPort } from '@zen-agent/assembly';
import { createToolGatePort } from '@zen-agent/toolgate';
import { createLlmPort } from '@zen-agent/llm-port';
import { createAuditPort } from '@zen-agent/audit';

export interface ServerOptions {
  snapshotRoot: string;
  auditSinkPath: string;
  allowedProviders: string[];
}

export interface ServerPorts {
  assembly: AssemblyPort;
  toolgate: ToolGatePort;
  llm: LlmPort;
  audit: AuditPort;
}

export function assemblePorts(options: ServerOptions): ServerPorts {
  return {
    assembly: createAssemblyPort({ snapshotRoot: options.snapshotRoot }),
    // 骨架期工具闭集为空；M1 起由 assembly.compose 按 featureId 换出的白名单在每轮注入。
    toolgate: createToolGatePort({ tools: [] }),
    llm: createLlmPort({ allowedProviders: options.allowedProviders }),
    audit: createAuditPort({ sinkPath: options.auditSinkPath }),
  };
}

export function bootstrap(options: ServerOptions): void {
  const ports = assemblePorts(options);
  void ports;
  // 接线位·验签：C2 IdentityClaims——JWT 验签（iss 白名单 fail-closed）后投影 claims，透传给 toolgate.decide。
  // 接线位·装配：每轮对话前 assembly.compose 换出注入（基座+功能块+skills+工具白名单），
  //   describeInjection 同源产出记 audit assembly 事件；装配对 agent 透明。
  // 接线位·SSE：HTTP 上行 4 帧（context-report/user-message/hitl-decision/exec-result）
  //   → agent loop（llm.chat 流式 + toolgate 门禁）→ SSE 下行 5 帧（C3 DownstreamFrame）。
  throw new Error('NOT_IMPLEMENTED: M1 讲解闭环——会话网关（验签/会话生命周期/agent loop/SSE 下发）');
}
