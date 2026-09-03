/**
 * 页面正文纯文本抽取：仅在下行 snapshot-request 显式带 includeText 的那一轮调用
 * （正文体量远大于元素快照，每轮采集会灌爆上下文）。
 * 正文根按语义优先 article > main > [role=main]；同类候选 ≥2（信息流/评论列表/搜索结果）取其最近
 * 公共祖先，三类皆无才退回 body——退回面噪声最大，故导航/页眉/页脚/侧栏在此面上整体剔除；
 * 语义根之内的 header/aside 是文章头与文内旁注，属正文予以保留。
 * 输出保留块级边界（块级元素成行、表格单元格以 | 分隔、标题带 # 前缀），只折叠行内空白，
 * 使调用方能按行辨认段落、表格行与价格/库存文案。
 * 可见性有布局时按计算样式判定、无布局（jsdom）退回属性与内联样式，两种世界都不误剔可见正文。
 * 采集面与元素快照同界：同源 iframe 与 open shadow root 逐层下钻，跨源帧与 closed root 取不到。
 */
import { MAX_PAGE_TEXT_LENGTH } from './tuning.js';

const ROOT_SELECTORS = ['article', 'main', '[role="main"]'];

/** noscript 在脚本可用时不渲染，与 script/style 同属"页面上看不见的文本"。 */
const EXCLUDED_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'footer']);
/** 退回 body 面无任何语义收窄，页眉与侧栏在此面上按整块噪声剔除；亦是正文根候选的资格判定面。 */
const BODY_EXCLUDED_TAGS = new Set([...EXCLUDED_TAGS, 'header', 'aside']);

/** 成行的块级元素闭集：块级边界是段落/列表项/表格行在纯文本里唯一可辨的痕迹。 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const CELL_TAGS = new Set(['td', 'th']);
const HEADING = /^h([1-6])$/;

const LINE_BREAK = '\n';
const CELL_SEPARATOR = '|';

export interface PageText {
  text: string;
  /** true = text 只是正文前缀（超 MAX_PAGE_TEXT_LENGTH 被截断）。 */
  truncated: boolean;
}

/**
 * 布局引擎可用性：jsdom 不排版——盒子恒 0、getClientRects 恒空，
 * 按布局判定会把整页判成不可见。探到无布局即整份退回属性 + 内联判定。
 */
export function hasLayout(doc: Document): boolean {
  const root = doc.documentElement as Element | null;
  if (root === null || typeof root.getBoundingClientRect !== 'function') return false;
  const rect = root.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * 元素自身的显隐。判定一律走属性/鸭子类型：iframe 子文档的节点属另一 realm，
 * `instanceof HTMLElement` 对其恒为 false，用之会把整帧内容静默丢掉。
 * 有布局时接计算样式与实际盒子——宿主用 class 隐藏的折叠面板/非活跃 tab 只有这条抓得到；
 * display:contents 无盒子但子树照常渲染，故不按盒子判它不可见。
 */
export function isHiddenElement(el: Element, layout: boolean): boolean {
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const inline = (el as Partial<HTMLElement>).style;
  if (inline?.display === 'none' || inline?.visibility === 'hidden') return true;
  if (!layout) return false;
  const view = el.ownerDocument?.defaultView ?? null;
  if (view === null || typeof view.getComputedStyle !== 'function') return false;
  const computed = view.getComputedStyle(el);
  if (computed.display === 'none' || computed.visibility === 'hidden') return true;
  if (computed.opacity !== '' && Number.parseFloat(computed.opacity) === 0) return true;
  if (computed.display === 'contents') return false;
  return typeof el.getClientRects === 'function' && el.getClientRects().length === 0;
}

/** open shadow root；closed root 与非 Element 宿主一律取不到（不臆造穿透能力）。 */
export function openShadowRootOf(el: Element): ShadowRoot | null {
  return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * 根与其内部所有 open shadow root：Web Components 站点的控件、提示与帧都在影子树里。
 * 元素快照、notices/evidence 与正文帧扫描共用本函数，采集面不分叉。
 */
export function scopesOf(root: ParentNode): ParentNode[] {
  const scopes: ParentNode[] = [root];
  for (let i = 0; i < scopes.length; i += 1) {
    for (const el of scopes[i]?.querySelectorAll('*') ?? []) {
      const shadow = openShadowRootOf(el);
      if (shadow !== null) scopes.push(shadow);
    }
  }
  return scopes;
}

function collectNodeText(
  node: Node,
  pieces: string[],
  excluded: Set<string>,
  layout: boolean,
): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // 源码换行/缩进在浏览器里按空格渲染；就地折叠，使成品里的换行只可能来自块级边界。
      pieces.push((child.nodeValue ?? '').replace(/\s+/g, ' '));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (excluded.has(tag) || isHiddenElement(el, layout)) continue;
    if (tag === 'br') {
      pieces.push(LINE_BREAK);
      continue;
    }
    const block = BLOCK_TAGS.has(tag);
    if (CELL_TAGS.has(tag)) pieces.push(CELL_SEPARATOR);
    else if (block) {
      pieces.push(LINE_BREAK);
      const heading = HEADING.exec(tag);
      if (heading !== null) pieces.push(`${'#'.repeat(Number(heading[1]))} `);
    }
    collectElementText(el, pieces, excluded, layout);
    if (block) pieces.push(LINE_BREAK);
  }
}

function collectElementText(
  el: Element,
  pieces: string[],
  excluded: Set<string>,
  layout: boolean,
): void {
  const shadow = openShadowRootOf(el);
  if (shadow !== null) {
    collectNodeText(shadow, pieces, excluded, layout);
    // 无 <slot> 的影子树不投影轻 DOM 子节点，那些子节点在页面上不渲染，不属正文。
    if (shadow.querySelector('slot') === null) return;
  }
  collectNodeText(el, pieces, excluded, layout);
}

/**
 * 候选根与 iframe 不经逐层过滤，故其自身与祖先链须单独判两件事：
 * 不可见——SPA 路由残留、A/B 分支、打印模板常把旧正文留成隐藏的 <article>，选中即取回页面上看不见的文本；
 * 落在非正文区域内——侧栏/导航常用 <article> 包推荐卡，选中即把一张卡片当成整页正文。
 */
function isDisqualifiedSubtree(el: Element, layout: boolean): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (isHiddenElement(node, layout) || BODY_EXCLUDED_TAGS.has(node.tagName.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** 含自身的最近公共祖先：嵌套候选（外层 article 已含内层）不会被上提到更外层。 */
function commonAncestorOf(candidates: Element[]): Element | null {
  let ancestor: Element | null = candidates[0] ?? null;
  for (const candidate of candidates.slice(1)) {
    while (ancestor !== null && !ancestor.contains(candidate)) ancestor = ancestor.parentElement;
  }
  return ancestor;
}

/**
 * 无正文根即无正文：XML/SVG 文档（RSS、同源 .svg）的 `body` 恒为 null，
 * 返回 null 让调用方整份跳过——这类文档不承载文章正文，且取回来只会当噪声混进正文。
 */
function findRoot(doc: Document, layout: boolean): Element | null {
  for (const selector of ROOT_SELECTORS) {
    const candidates = [...doc.querySelectorAll(selector)].filter(
      (candidate) => !isDisqualifiedSubtree(candidate, layout),
    );
    const first = candidates[0];
    if (first === undefined) continue;
    // 信息流/评论列表/搜索结果页有多张同类卡片，取首张即只剩一条正文；上提到公共祖先才是整页正文。
    return candidates.length === 1 ? first : commonAncestorOf(candidates) ?? doc.body ?? first;
  }
  return doc.body ?? null;
}

/** 零尺寸帧（埋点/工具帧的常见形态）不承载正文；宽高属性或内联样式为 0 即不下钻。 */
export function isZeroSizedFrame(iframe: Element): boolean {
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
  const layout = hasLayout(doc);
  const root = findRoot(doc, layout);
  if (root === null) return;
  collectElementText(root, pieces, root === doc.body ? BODY_EXCLUDED_TAGS : EXCLUDED_TAGS, layout);
  for (const scope of scopesOf(root)) {
    for (const iframe of scope.querySelectorAll('iframe')) {
      if (isDisqualifiedSubtree(iframe, layout) || isZeroSizedFrame(iframe)) continue;
      const childDoc = sameOriginDoc(iframe);
      if (childDoc === null) continue;
      collectDocText(childDoc, pieces);
    }
  }
}

/** 只折叠行内空白与多余空行；块级换行是结构信息，保留。 */
function normalize(raw: string): string {
  return raw
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^\| ?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractPageText(doc: Document = document): PageText {
  const pieces: string[] = [];
  collectDocText(doc, pieces);
  // 相邻行内文本在源码里靠标签分隔，拼接前补空格避免前后字粘连成假词。
  const text = normalize(pieces.join(' '));
  if (text.length <= MAX_PAGE_TEXT_LENGTH) return { text, truncated: false };
  const clipped = text.slice(0, MAX_PAGE_TEXT_LENGTH);
  const lastBreak = clipped.lastIndexOf(LINE_BREAK);
  // 按行边界收尾，末行不被切成半句；行边界过于靠前则宁可硬切，保证至少半个预算的正文。
  const cut = lastBreak > MAX_PAGE_TEXT_LENGTH / 2 ? clipped.slice(0, lastBreak) : clipped;
  return { text: cut.trimEnd(), truncated: true };
}
