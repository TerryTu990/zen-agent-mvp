import type { ToolDefinition, ToolGatePort } from '@zen-agent/contracts';

export interface ToolGateOptions {
  /** 分级判定的工具定义闭集：id 不在集内或 riskTier 未知一律 deny（fail-closed，U7）。 */
  tools: ToolDefinition[];
}

export function createToolGatePort(options: ToolGateOptions): ToolGatePort {
  void options;
  return {
    decide() {
      throw new Error(
        'NOT_IMPLEMENTED: M3 代执行+HITL——分级矩阵判定 fail-closed（auto/hitl/forbidden + 身份/实参校验）',
      );
    },
    issueExecInstruction() {
      throw new Error(
        'NOT_IMPLEMENTED: M3 代执行+HITL——一次性签名指令签发（nonce+ttl+signature，模板代入实参）',
      );
    },
    acceptExecResult() {
      throw new Error(
        'NOT_IMPLEMENTED: M3 代执行+HITL——nonce 核销 + ttl 验收 + resultSchema 校验 + observation 规整',
      );
    },
  };
}
