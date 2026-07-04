import type { ExecInstructionFrame, ExecResultFrame } from './frames.js';

export interface DelegatedExecutor {
  /**
   * 校验 signature 后在页面环境以用户既有会话发出服务端已定值的请求；
   * 结果原样回传（成败如实），核销与 resultSchema 校验在服务端（U7）。
   */
  execute(frame: ExecInstructionFrame): Promise<ExecResultFrame>;
}

export function createDelegatedExecutor(): DelegatedExecutor {
  return {
    execute() {
      throw new Error('NOT_IMPLEMENTED: M3 代执行+HITL——签名指令校验与页面环境代执行');
    },
  };
}
