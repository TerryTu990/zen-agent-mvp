import type { GuideActionFrame } from './frames.js';

/** page-action 触达宿主页元素的最小面：只做视觉标记与滚动，绝不改元素其它属性/值（D9）。 */
export interface GuideTarget {
  /** 加 za- 前缀临时高亮标记（不改元素其它属性）。 */
  highlight(): void;
  /** 移除本模块加的高亮标记以还原元素。 */
  unhighlight(): void;
  scrollIntoView(): void;
}

/** 宿主页元素查询面，便于把命中/降级逻辑与真实 DOM 解耦测试。 */
export interface GuidePage {
  querySelector(selector: string): GuideTarget | null;
}

export interface PageActionResult {
  /** selector 是否在宿主页命中；未命中时不改任何 DOM 高亮。 */
  hit: boolean;
  /** 面板 status 展示的定位反馈或如实降级文案（不含 token/密钥值，SEC-04）。 */
  status: string;
}

export interface PageActionRunner {
  /** 高亮/滚动到目标元素；selector 未命中时静默降级为文字说明，不假装成功。 */
  run(frame: GuideActionFrame): PageActionResult;
}

const MISS_STATUS = '未能在当前页面定位到该元素';

export function createPageActionRunner(page: GuidePage): PageActionRunner {
  // 单例记住上一次高亮元素，命中新目标前清除，避免高亮累积。
  let highlighted: GuideTarget | null = null;

  return {
    run(frame) {
      const target = page.querySelector(frame.selector);
      if (target === null) {
        return { hit: false, status: frame.message ?? MISS_STATUS };
      }
      if (highlighted !== null) highlighted.unhighlight();
      target.highlight();
      if (frame.action === 'scroll-to') target.scrollIntoView();
      highlighted = target;
      return {
        hit: true,
        status: frame.message === undefined ? '已为你定位到该元素' : `已为你定位：${frame.message}`,
      };
    },
  };
}

const HIGHLIGHT_CLASS = 'za-guide-highlight';
const HIGHLIGHT_STYLE_ID = 'za-guide-style';
const HIGHLIGHT_CSS = `.${HIGHLIGHT_CLASS}{outline:3px solid #0969da !important;outline-offset:2px;box-shadow:0 0 0 4px rgba(9,105,218,0.35) !important;transition:outline-color .15s;}`;

function ensureHighlightStyle(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  (doc.head ?? doc.documentElement).append(style);
}

/** 宿主页 document 支撑的 GuidePage：高亮只切换 za- 前缀 class，不触碰元素其它属性/值（D9）。 */
export function createDomGuidePage(doc: Document = document): GuidePage {
  return {
    querySelector(selector) {
      const el = doc.querySelector(selector);
      if (el === null) return null;
      return {
        highlight() {
          ensureHighlightStyle(doc);
          el.classList.add(HIGHLIGHT_CLASS);
        },
        unhighlight() {
          el.classList.remove(HIGHLIGHT_CLASS);
        },
        scrollIntoView() {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      };
    },
  };
}
