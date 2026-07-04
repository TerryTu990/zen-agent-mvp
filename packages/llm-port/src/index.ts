import type { LlmPort } from '@zen-agent/contracts';

export interface LlmPortOptions {
  /** provider 白名单：白名单外的 model 请求 fail-closed 拒绝；密钥托管在实现侧、经环境变量注入。 */
  allowedProviders: string[];
}

export function createLlmPort(options: LlmPortOptions): LlmPort {
  void options;
  return {
    chat() {
      throw new Error(
        'NOT_IMPLEMENTED: M1 讲解闭环——首个 provider 接入（白名单插拔 + 流式 LlmStreamEvent）',
      );
    },
  };
}
