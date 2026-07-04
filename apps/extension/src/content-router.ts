import type { DownstreamFrame } from './frames.js';
import type { ConversationUi } from './conversation-hitl.js';
import type { DelegatedExecutor } from './delegated-execution.js';
import type { PageActionRunner } from './page-action.js';
import type { ContentToBackgroundMessage } from './messaging.js';

export interface DownstreamRouterDeps {
  ui: Pick<ConversationUi, 'appendTextDelta' | 'showStatus' | 'renderToolCard' | 'promptHitl'>;
  pageAction: Pick<PageActionRunner, 'run'>;
  executor: DelegatedExecutor;
  send: (message: ContentToBackgroundMessage) => void;
}

/**
 * 下行帧唯一分发点。代执行与 HITL 均只呈现/执行/回传，治理判定全在服务端（U7）：
 * hitl-request 弹卡收裁决后经 send 回 hitl-decision；exec-instruction 页面环境代执行后回 exec-result。
 */
export function routeDownstreamFrame(frame: DownstreamFrame, deps: DownstreamRouterDeps): void {
  switch (frame.type) {
    case 'text-delta':
      deps.ui.appendTextDelta(frame);
      break;
    case 'guide-action':
      deps.ui.showStatus(deps.pageAction.run(frame).status);
      break;
    case 'tool-card':
      deps.ui.renderToolCard(frame);
      break;
    case 'hitl-request':
      void deps.ui
        .promptHitl(frame)
        .then((decision) => deps.send({ kind: 'hitl-decision', hitlId: frame.hitlId, decision }));
      break;
    case 'exec-instruction':
      void deps.executor
        .execute(frame)
        .then((result) => deps.send({ kind: 'exec-result', result }));
      break;
  }
}
