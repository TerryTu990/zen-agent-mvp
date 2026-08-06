/**
 * 页面正文纯文本抽取：仅在下行 snapshot-request 显式带 includeText 的那一轮调用
 * （正文体量远大于元素快照，每轮采集会灌爆上下文）。
 * 正文根按语义优先 article > main > [role=main]，三者皆无才退回 body——退回面噪声最大，
 * 故一律剔除导航/页眉页脚/侧栏与脚本样式。可见性按声明式属性 + 内联样式判定，
 * 不依赖布局测量：jsdom 可测，且不因宿主 CSS 花活漏剔。
 * 采集面与元素快照同界：同源 iframe 逐帧下钻，跨源帧取不到。
 */
import { MAX_PAGE_TEXT_LENGTH } from './tuning.js';

const ROOT_SELECTORS = ['article', 'main', '[role="main"]'];

/** noscript 在脚本可用时不渲染，与 script/style 同属"页面上看不见的文本"。 */
const EXCLUDED_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside']);

export interface PageText {
  text: string;
  /** true = text 只是正文前缀（超 MAX_PAGE_TEXT_LENGTH 被截断）。 */
  truncated: boolean;
}

/**
 * 自顶向下遍历时逐层判定即覆盖祖先不可见的情形，无需回溯 parentElement。
 * 判定一律走 nodeType/属性/鸭子类型：iframe 子文档的节点属另一 realm，
 * `instanceof Element`/`HTMLElement` 对其恒为 false，用之会把整帧正文静默丢掉。
 */
function isHiddenNode(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const style = (el as Partial<HTMLElement>).style;
  return style?.display === 'none' || style?.visibility === 'hidden';
}

function collectText(node: Node, pieces: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      pieces.push(child.nodeValue ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (EXCLUDED_TAGS.has(el.tagName.toLowerCase()) || isHiddenNode(el)) continue;
    collectText(el, pieces);
  }
}

/**
 * 候选根与 iframe 不经 collectText 的逐层过滤，故其自身与祖先链须单独判两件事：
 * 不可见——SPA 路由残留、A/B 分支、打印模板常把旧正文留成隐藏的 <article>，选中即取回页面上看不见的文本；
 * 落在被剔除区域内——侧栏/导航常用 <article> 包推荐卡，选中即把一张卡片当成整页正文。
 */
function isDisqualifiedSubtree(el: Element): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (isHiddenNode(node) || EXCLUDED_TAGS.has(node.tagName.toLowerCase())) return true;
  }
  return false;
}

/**
 * 无正文根即无正文：XML/SVG 文档（RSS、同源 .svg）的 `body` 恒为 null，
 * 返回 null 让调用方整份跳过——这类文档不承载文章正文，且取回来只会当噪声混进正文。
 */
function findRoot(doc: Document): Element | null {
  for (const selector of ROOT_SELECTORS) {
    for (const candidate of doc.querySelectorAll(selector)) {
      if (!isDisqualifiedSubtree(candidate)) return candidate;
    }
  }
  return doc.body ?? null;
}

/** 零尺寸帧（埋点/工具帧的常见形态）不承载正文；宽高属性或内联样式为 0 即不下钻。 */
function isZeroSizedFrame(iframe: Element): boolean {
  const zero = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && /^0(?:px|%)?$/.test(value.trim());
  const style = (iframe as Partial<HTMLElement>).style;
  return (
    zero(iframe.getAttribute('width')) ||
    zero(iframe.getAttribute('height')) ||
    zero(style?.width) ||
    zero(style?.height)
  );
}

/**
 * 同源 iframe 的子文档（ADR-013 批次④ 方案 A）：contentDocument 可达即同源、返回其 document；
 * 跨源浏览器返回 null 或抛安全错误——一律视为不可下钻、跳过。
 * 元素快照与正文抽取共用本判定，两处"同源"语义不得分叉。
 */
export function sameOriginDoc(iframe: Element): Document | null {
  try {
    return (iframe as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

/**
 * 各帧正文按文档序追加；长度上限跨帧全局共享（截断在拼接后统一施加）。
 * 帧只从**已选正文根之内**取：根收窄到 article/main 后，根外的小部件/广告/埋点帧同样不属正文——
 * 若按整份文档扫帧，这些内容会无边界地拼进正文，而调用方无从与真正文区分。
 */
function collectDocText(doc: Document, pieces: string[]): void {
  const root = findRoot(doc);
  if (root === null) return;
  collectText(root, pieces);
  for (const iframe of root.querySelectorAll('iframe')) {
    if (isDisqualifiedSubtree(iframe) || isZeroSizedFrame(iframe)) continue;
    const childDoc = sameOriginDoc(iframe);
    if (childDoc === null) continue;
    collectDocText(childDoc, pieces);
  }
}

export function extractPageText(doc: Document = document): PageText {
  const pieces: string[] = [];
  collectDocText(doc, pieces);
  // 相邻块级文本在源码里靠标签分隔，拼接前补空格避免段落首尾字粘连成假词。
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_PAGE_TEXT_LENGTH
    ? { text: text.slice(0, MAX_PAGE_TEXT_LENGTH), truncated: true }
    : { text, truncated: false };
}
