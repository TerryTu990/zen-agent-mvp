import type { GuideActionFrame } from './frames.js';

export interface PageActionRunner {
  /** 高亮/滚动到目标元素；selector 未命中时如实回报、静默降级为文字说明，不假装成功。 */
  run(frame: GuideActionFrame): Promise<{ hit: boolean }>;
}

export function createPageActionRunner(): PageActionRunner {
  return {
    run() {
      throw new Error('NOT_IMPLEMENTED: M2 引导——页面动作执行（highlight / scroll-to）');
    },
  };
}
