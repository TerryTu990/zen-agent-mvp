export interface PageContext {
  url: string;
  title: string;
}

export interface ContextReporter {
  /** 采集当前页面 url/title；featureId 权威判定在服务端，sessionId 由 background 组帧时注入。 */
  collect(): PageContext;
}

export function createContextReporter(): ContextReporter {
  return {
    collect() {
      return { url: location.href, title: document.title };
    },
  };
}
