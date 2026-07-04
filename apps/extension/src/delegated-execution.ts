import type { ExecInstructionFrame, ExecResultFrame, JsonValue } from './frames.js';

export interface DelegatedExecutor {
  /**
   * 在页面环境以用户既有会话（credentials:include）发出服务端已定值的请求，结果原样回传。
   * 客户端零治理：不校验 signature、不改指令、不预判 riskTier——核销、resultSchema 校验、
   * nonce 权威全在服务端（U7）。失败如实回报，错误文案不含 token/签名值（SEC-04）。
   */
  execute(frame: ExecInstructionFrame): Promise<ExecResultFrame>;
}

export function createDelegatedExecutor(fetchImpl: typeof fetch = fetch): DelegatedExecutor {
  return {
    async execute(frame) {
      const { sessionId, nonce, request } = frame;
      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          credentials: 'include',
          ...(request.headers ? { headers: request.headers } : {}),
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        });
      } catch {
        return { type: 'exec-result', sessionId, nonce, ok: false, error: '代执行请求发送失败（网络不可达）' };
      }

      let parsedBody: JsonValue | undefined;
      try {
        parsedBody = (await response.json()) as JsonValue;
      } catch {
        parsedBody = undefined;
      }

      const result: ExecResultFrame = {
        type: 'exec-result',
        sessionId,
        nonce,
        ok: response.ok,
        status: response.status,
      };
      if (parsedBody !== undefined) result.body = parsedBody;
      if (!response.ok) result.error = `HTTP ${response.status}`;
      return result;
    },
  };
}
