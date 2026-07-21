import type { DownstreamFrame } from './frames.js';
import type { DelegatedExecutor } from './delegated-execution.js';
import type { PageActionRunner } from './page-action.js';
import type { Snapshotter } from './page-snapshot.js';
import type { ContentToBackgroundMessage } from './messaging.js';

export interface DownstreamRouterDeps {
  pageAction: Pick<PageActionRunner, 'run'>;
  executor: DelegatedExecutor;
  snapshot: Pick<Snapshotter, 'collect'>;
  send: (message: ContentToBackgroundMessage) => void;
}

export type PageDownstreamFrame = Extract<
  DownstreamFrame,
  { type: 'guide-action' | 'exec-instruction' | 'snapshot-request' }
>;

export function isPageDownstreamFrame(frame: DownstreamFrame): frame is PageDownstreamFrame {
  return (
    frame.type === 'guide-action' || frame.type === 'exec-instruction' || frame.type === 'snapshot-request'
  );
}

/**
 * 页面下行帧唯一分发点。Side Panel 帧不会进入 content；代执行结果和页面快照
 * 仍由 background 盖章 sessionId 后回传，治理判定全在服务端（U7）。
 */
export function routeDownstreamFrame(frame: PageDownstreamFrame, deps: DownstreamRouterDeps): void {
  switch (frame.type) {
    case 'guide-action':
      deps.send({ kind: 'page-status', message: deps.pageAction.run(frame).status });
      break;
    case 'exec-instruction':
      void deps.executor
        .execute(frame)
        .then((result) => deps.send({ kind: 'exec-result', result }));
      break;
    case 'snapshot-request': {
      const { url, title, elements, notices } = deps.snapshot.collect();
      deps.send({
        kind: 'snapshot-report',
        report: {
          type: 'snapshot-report',
          sessionId: frame.sessionId,
          requestId: frame.requestId,
          url,
          ...(title !== '' ? { title } : {}),
          elements,
          ...(notices.length > 0 ? { notices } : {}),
        },
      });
      break;
    }
  }
}
