import type { ContextReportFrame } from './frames.js';

export interface ContextReporter {
  /** 采集当前页面 url/title 与白名单快照上报网关；featureId 权威判定在服务端。 */
  report(sessionId: string): Promise<ContextReportFrame>;
}

export function createContextReporter(): ContextReporter {
  return {
    report() {
      throw new Error('NOT_IMPLEMENTED: M1 讲解闭环——上下文上报（url + 白名单快照）');
    },
  };
}
