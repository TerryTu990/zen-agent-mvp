import type { ExecInstructionFrame, ExecResultFrame, JsonValue } from './frames.js';
import type { DomStepRunner } from './dom-steps.js';

export interface DelegatedExecutor {
  /**
   * 按签名指令的 request 形态代执行：http（默认）在页面环境以用户既有会话
   * （credentials:include）发出服务端已定值的请求；dom（kind='dom'）经闭集解释器
   * 可见地操作页面。客户端零治理：不校验 signature、不改指令、不预判 riskTier——
   * 核销、resultSchema 校验、nonce 权威全在服务端（U7）。失败如实回报，
   * 错误文案不含 token/签名值（SEC-04）。
   */
  execute(frame: ExecInstructionFrame): Promise<ExecResultFrame>;
}

export function createDelegatedExecutor(
  fetchImpl: typeof fetch = fetch,
  domRunner?: DomStepRunner,
  currentPage: () => { url: string; pageInstanceId: string } = () => ({
    url: globalThis.location?.href ?? '',
    pageInstanceId: '',
  }),
): DelegatedExecutor {
  return {
    async execute(frame) {
      const { sessionId, nonce, request } = frame;

      // 判别：仅 DomExecRequest 带 kind；in 收窄让 else 分支落回 http 形态。
      if ('kind' in request) {
        if (domRunner === undefined) {
          return { type: 'exec-result', sessionId, nonce, ok: false, error: 'dom-runner-unavailable' };
        }
        const page = currentPage();
        if (
          (request.expectedPageUrl !== undefined || request.expectedPageInstanceId !== undefined) &&
          (request.expectedPageUrl !== page.url || request.expectedPageInstanceId !== page.pageInstanceId)
        ) {
          return { type: 'exec-result', sessionId, nonce, ok: false, error: 'context-mismatch' };
        }
        const outcome = await domRunner.run(request.steps);
        const result: ExecResultFrame = { type: 'exec-result', sessionId, nonce, ok: outcome.ok };
        if (outcome.body !== undefined) result.body = outcome.body;
        if (outcome.error !== undefined) result.error = outcome.error;
        return result;
      }

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
