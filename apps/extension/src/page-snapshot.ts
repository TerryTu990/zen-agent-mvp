/**
 * 页面快照采集器（adr-011 观察半程）：扫描可交互元素、分配 za-N ref，供 dom 批次解释器解引用。
 * ref 对元素黏附并跨 collect 单调递增：仍连接且 role/label 未变的元素复用旧 ref，消失元素的旧 ref
 * 一律缺席（resolve → null），永不改绑到别的控件；snapshotEpoch 随帧上报，服务端原样落入 dom 判定上下文，标定当前 ref 闭集的代次。
 * 可见性有布局时按计算样式与实际盒子判定、无布局（jsdom）退回声明式属性与内联样式，
 * 两种世界都不把隐藏弹层里的同名控件当成可点目标。
 * 配额（MAX_ELEMENTS）按「浮层/模态 → 视口内控件 → 其余控件 → 静态单元格」分级分配，
 * 超配额后继续计数不采集，并以 elementsTruncated/elementsOmitted 如实标注。
 */
import type { SnapshotElement, SnapshotEvidence, SnapshotEvidenceRule } from './frames.js';
import {
  extractPageText,
  hasLayout,
  isHiddenElement,
  isZeroSizedFrame,
  sameOriginDoc,
  scopesOf,
} from './page-text.js';
import {
  DOM_SETTLE_QUIET_MS,
  DOM_SETTLE_TIMEOUT_MS,
  MAX_ELEMENTS,
  MAX_LABEL_LENGTH,
  MAX_NOTICES,
  MAX_NOTICE_LENGTH,
  VIEWPORT_MARGIN_PX,
} from './tuning.js';

const CONTROL_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="option"]',
  // 无 role 自定义下拉的有界形态：listbox 后代 li 与直接子项（ARIA 契约下即选项行，
  // 部分组件库如 Semi Design 不给子项标 role）；禁无差别收录裸 li/div（快照会爆炸）。
  '[role="listbox"] li',
  '[role="listbox"] > *',
  '[contenteditable="true"]',
].join(', ');

/**
 * 业务表格中的状态、编号和结果通常是静态单元格而非控件；纳入有界快照后才可用 read 步骤
 * 建立“页面证据 → 动作”链。详情页的 definition-list / descriptions 组件同类。
 * 它们排在真控件之后分配配额：一张中等表格的单元格数即可超过 MAX_ELEMENTS，
 * 按文档序采会把页面上真正可点的按钮挤出快照。
 */
const STATIC_CELL_SELECTOR = [
  'table th',
  'table td',
  '[role="columnheader"]',
  '[role="rowheader"]',
  '[role="cell"]',
  '[role="gridcell"]',
  'dl dt',
  'dl dd',
  '[class$="descriptions-item-label"]',
  '[class$="descriptions-item-content"]',
].join(', ');

const INTERACTIVE_SELECTOR = `${CONTROL_SELECTOR}, ${STATIC_CELL_SELECTOR}`;

/**
 * 页面提示文本来源：语义化提示区（alert/status/aria-live）+ 宿主常见的校验错误类名启发式。
 * 后者仅收短文本叶节点（长容器/含表单控件的整块区域一律跳过），避免噪声撑爆观测。
 */
const NOTICE_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[class*="error" i]',
  '[class*="invalid" i]',
].join(', ');

/** 模态层根匹配：显式语义（role=dialog / aria-modal）优先；无命中再兜底 class 含 dialog/modal 的容器。 */
const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"]';
const MODAL_FALLBACK_SELECTOR = '[class*="dialog" i], [class*="modal" i]';
/** 展开中的下拉浮层常挂 body 末尾，文档序采集易被配额截断，须与模态层同享优先配额。 */
const FLOATING_LIST_SELECTOR = '[role="listbox"]';

const SUBMIT_INPUT_TYPES = new Set(['submit', 'button', 'reset']);
const DISABLEABLE_TAGS = new Set(['button', 'input']);

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** 本次采集的世代号，自 1 起单调递增：ref 黏附元素，服务端原样落入 dom 判定上下文，标定当前 ref 闭集的代次。 */
  snapshotEpoch: number;
  /** true = elements 只是配额内的子集；缺席即完整。 */
  elementsTruncated?: boolean;
  /** 命中配额后被丢弃的可交互元素个数；elementsTruncated 缺席时本字段亦缺席。 */
  elementsOmitted?: number;
  /** 页面当前可见的告警/校验/状态提示文本（已去重截断）：agent 据此识别表单校验等拦截。 */
  notices: string[];
  /** pack 配方产出的结构化证据；只含容器数量与状态枚举，不含正文。 */
  evidence: Record<string, SnapshotEvidence>;
  /** 正文纯文本；仅 includeText 请求且页面确有正文时出现（空正文一律缺席）。 */
  text?: string;
  /** true = text 只是正文前缀；缺席即完整。text 缺席时本字段亦缺席。 */
  textTruncated?: boolean;
}

export interface Snapshotter {
  /** 重采并返回快照：存活元素保号，消失元素的 ref 作废。includeText 额外附页面正文。 */
  collect(evidenceRules?: SnapshotEvidenceRule[], includeText?: boolean): PageSnapshot;
  /** 解引用最近一次快照的 ref；未知/已作废返回 null。 */
  resolve(ref: string): Element | null;
}

/**
 * 已下钻的文档及其采集面：scopes = 该文档与其内部所有 open shadow root。
 * notices/evidence 与元素快照共用同一批 scopes，采集面不分叉——影子树里的控件可操作、
 * 校验提示却采不到，会让 agent 把被拦下的提交当成已完成。
 */
interface VisitedDoc {
  doc: Document;
  scopes: ParentNode[];
  layout: boolean;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function isDeclaredHidden(el: Element): boolean {
  if (el.closest('[hidden]') !== null) return true;
  // 读屏排除对整棵子树生效：祖先标了 aria-hidden，其内控件对辅助技术同样不存在。
  if (el.closest('[aria-hidden="true"]') !== null) return true;
  return tagOf(el) === 'input' && (el as Partial<HTMLInputElement>).type === 'hidden';
}

/**
 * 有布局时计算样式与实际盒子已覆盖祖先不可见的绝大多数形态（display:none 祖先无盒子、
 * visibility 继承）；无布局时只有逐层看内联样式才抓得到「祖先内联隐藏、子元素自身无样式」。
 */
function isHidden(el: Element, layout: boolean): boolean {
  if (isDeclaredHidden(el)) return true;
  if (layout) return isHiddenElement(el, true);
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (isHiddenElement(node, false)) return true;
  }
  return false;
}

/** 无布局信息时不区分视口层级（全部视为触手可及），采集回落到文档序。 */
function isInViewport(el: Element, layout: boolean): boolean {
  if (!layout) return true;
  const view = el.ownerDocument?.defaultView ?? null;
  if (view === null || typeof el.getBoundingClientRect !== 'function') return true;
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom >= -VIEWPORT_MARGIN_PX &&
    rect.right >= -VIEWPORT_MARGIN_PX &&
    rect.top <= view.innerHeight + VIEWPORT_MARGIN_PX &&
    rect.left <= view.innerWidth + VIEWPORT_MARGIN_PX
  );
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().toLowerCase() ?? '';
  if (explicit !== '') return explicit;
  if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';
  const tag = tagOf(el);
  const type = (el as Partial<HTMLInputElement>).type;
  return tag === 'input' && typeof type === 'string' ? `${tag}:${type}` : tag;
}

// 占位标签：让 agent 能区分"未命名图标钮"与正常控件，不再按位置瞎猜语义。
const UNLABELED_PLACEHOLDER = '[无文字标签]';
/**
 * 可编辑区承载的是用户正在写的正文（邮件/文档/聊天草稿）。标签只报角色，不报内容——
 * 否则每次快照都把草稿前 80 字送进模型上下文与会话历史（SEC-01，与 notices「绝不读控件值」同口径）。
 */
const EDITABLE_PLACEHOLDER = '[可编辑区域]';

function inlineText(el: Element | null): string {
  return el?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}

function attrText(el: Element, name: string): string {
  return el.getAttribute(name)?.trim() ?? '';
}

function labelledByText(el: Element): string {
  const ids = attrText(el, 'aria-labelledby');
  if (ids === '') return '';
  const root = el.getRootNode() as Partial<Document>;
  const lookup = root.getElementById;
  if (typeof lookup !== 'function') return '';
  return ids
    .split(/\s+/)
    .map((id) => inlineText(lookup.call(root as Document, id)))
    .filter((text) => text !== '')
    .join(' ');
}

/**
 * 原生可标记控件由 labels 关联；自定义 role 控件落在 <label> 内时才借用其文本，
 * 且仅限自身无文本者——否则会把包裹 label 的整段文字（含控件自己的文本）当成名字。
 */
function labelText(el: Element): string {
  const labels = (el as Partial<HTMLInputElement>).labels;
  if (labels !== undefined && labels !== null) {
    return [...labels]
      .map((label) => inlineText(label))
      .filter((text) => text !== '')
      .join(' ');
  }
  return inlineText(el) === '' ? inlineText(el.closest('label')) : '';
}

/**
 * 图标钮的名字只存在于 img alt 或 svg > title 里。仅对自身无文本的元素取图形替代文本：
 * 带文字的容器（图 + 文的表格单元格）自身文本更贴切，不该被里面某张图的 alt 顶掉。
 */
function graphicText(el: Element): string {
  if (tagOf(el) === 'img') {
    const own = attrText(el, 'alt');
    if (own !== '') return own;
  }
  if (inlineText(el) !== '') return '';
  const img = el.querySelector('img[alt]');
  const alt = img === null ? '' : attrText(img, 'alt');
  return alt !== '' ? alt : inlineText(el.querySelector('svg > title'));
}

/** input[type=submit|button|reset] 的 value 是按钮字面，不是用户输入值。 */
function buttonValueText(el: Element): string {
  if (tagOf(el) !== 'input') return '';
  const input = el as Partial<HTMLInputElement>;
  if (input.type === undefined || !SUBMIT_INPUT_TYPES.has(input.type)) return '';
  return (input.value ?? '').trim();
}

/** select 的 textContent 是全部 option 的拼接；只有当前选中项才是它此刻的名字。 */
function selectedOptionText(el: Element): string {
  const selected = (el as Partial<HTMLSelectElement>).selectedOptions;
  const first = selected?.[0];
  return first === undefined ? '' : first.text.trim().replace(/\s+/g, ' ');
}

/** W3C accname 取名次序；每级都取不到才落占位符。 */
function accessibleNameOf(el: Element): string {
  const editable = el.getAttribute('contenteditable') === 'true';
  const contentName = editable
    ? ''
    : tagOf(el) === 'select'
      ? selectedOptionText(el)
      : inlineText(el);
  const name = [
    labelledByText(el),
    attrText(el, 'aria-label'),
    labelText(el),
    graphicText(el),
    buttonValueText(el),
    attrText(el, 'placeholder'),
    contentName,
    attrText(el, 'title'),
    attrText(el, 'name'),
  ].find((candidate) => candidate !== '');
  if (name !== undefined) return name.slice(0, MAX_LABEL_LENGTH);
  return editable ? EDITABLE_PLACEHOLDER : UNLABELED_PLACEHOLDER;
}

function safeHrefOf(el: Element): string | undefined {
  if (tagOf(el) !== 'a') return undefined;
  const href = (el as Partial<HTMLAnchorElement>).href ?? '';
  if (href === '') return undefined;
  try {
    // 基准取元素所在文档：同源帧内的相对链接按帧地址解析，跨 realm 不落回顶层地址。
    const url = new URL(href, el.ownerDocument?.location?.href);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' &&
      url.password === '' && url.href.length <= 2048
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function findVisible(scopes: ParentNode[], selector: string, layout: boolean): Element[] {
  return scopes
    .flatMap((scope) => [...scope.querySelectorAll(selector)])
    .filter((el) => !isHidden(el, layout));
}

/** class 兜底命中只取最外层容器，嵌套命中（modal 壳内的 modal-body）不重复算根。 */
function findModalRoots(scopes: ParentNode[], layout: boolean): Element[] {
  const explicit = findVisible(scopes, MODAL_SELECTOR, layout);
  if (explicit.length > 0) return explicit;
  const fallback = findVisible(scopes, MODAL_FALLBACK_SELECTOR, layout);
  return fallback.filter((el) => !fallback.some((outer) => outer !== el && outer.contains(el)));
}

/** 优先配额根：展开中的下拉浮层最优先（正在交互的目标），其次模态层，最后全文档。 */
function findPriorityRoots(scopes: ParentNode[], layout: boolean): Element[] {
  return [
    ...findVisible(scopes, FLOATING_LIST_SELECTOR, layout),
    ...findModalRoots(scopes, layout),
  ];
}

/** 语义化提示区（alert/status/aria-live）；非此即 class 启发式命中，须加短文本约束。 */
function isSemanticNotice(el: Element): boolean {
  const role = el.getAttribute('role');
  if (role === 'alert' || role === 'status') return true;
  const live = el.getAttribute('aria-live');
  return live === 'polite' || live === 'assertive';
}

// 只读 textContent、绝不读控件 value（密码等敏感值不进提示，沿用 SEC-04 快照口径）。
// 逐帧采集并合并：同源帧内表单的校验提示与顶层提示对 agent 同等重要，上限与去重跨帧全局。
function collectNotices(visited: VisitedDoc[]): string[] {
  const notices: string[] = [];
  const seen = new Set<string>();
  for (const { scopes, layout } of visited) {
    // 嵌套去重用 contains，不跨影子边界；跨 scope 的重复由 seen 文本去重兜底。
    const accepted: Element[] = [];
    for (const el of scopes.flatMap((scope) => [...scope.querySelectorAll(NOTICE_SELECTOR)])) {
      if (notices.length >= MAX_NOTICES) return notices;
      if (isHidden(el, layout)) continue;
      // 嵌套命中（如 alert 区内的 error 子节点）只取外层，避免同段文本重复上报。
      if (accepted.some((outer) => outer.contains(el))) continue;
      const text = inlineText(el);
      if (text === '') continue;
      if (!isSemanticNotice(el)) {
        if (text.length > MAX_NOTICE_LENGTH) continue;
        if (el.querySelector('input, select, textarea, button') !== null) continue;
      }
      const clipped = text.slice(0, MAX_NOTICE_LENGTH);
      if (seen.has(clipped)) continue;
      seen.add(clipped);
      accepted.push(el);
      notices.push(clipped);
    }
  }
  return notices;
}

function collectEvidence(
  visited: VisitedDoc[],
  rules: SnapshotEvidenceRule[],
): Record<string, SnapshotEvidence> {
  const evidence: Record<string, SnapshotEvidence> = {};
  for (const rule of rules.slice(0, MAX_NOTICES)) {
    const allowed = new Set(rule.statuses);
    const itemStatuses: string[] = [];
    for (const { scopes, layout } of visited) {
      let items: Element[];
      try {
        items = findVisible(scopes, rule.itemSelector, layout);
      } catch {
        continue;
      }
      // 宽泛的 pack selector 可能同时命中 wrapper 与内层消息根。只保留最内层命中项，
      // 避免同一个状态叶节点经祖先、后代容器重复计数；一个 wrapper 包含多条消息时也保留各消息根。
      items = items.filter((item) => item.querySelector(rule.itemSelector) === null);
      for (const item of items) {
        let candidates: Element[];
        try {
          candidates = [...item.querySelectorAll(rule.statusSelector)];
        } catch {
          candidates = [];
        }
        const statuses = candidates
          .filter((el) => el.childElementCount === 0 && !isHidden(el, layout))
          .map((el) => inlineText(el))
          .filter((status) => allowed.has(status));
        const latest = statuses.at(-1);
        if (latest !== undefined) itemStatuses.push(latest);
      }
    }
    const latest = itemStatuses.at(-1);
    if (latest !== undefined) evidence[rule.id] = { count: itemStatuses.length, latest };
  }
  return evidence;
}

/**
 * DOM 静默窗：观察 body 的子树与属性变更，任一变更即重置静默计时器；连续静默满
 * DOM_SETTLE_QUIET_MS 视为页面静定。整段等待另受 DOM_SETTLE_TIMEOUT_MS 绝对上限钳制——
 * 到点无论是否静定一律放行，永不把控制流交给页面（页面可以永远在变）。
 * 观察能力缺席（无 body / 无 MutationObserver）即同步放行，采集不因此推迟。
 * 只决定采样时刻，不产出任何治理判定（U7 客户端零判定）。
 */
export function whenDomSettled(
  run: () => void,
  doc: Document | null = typeof document === 'undefined' ? null : document,
): void {
  const target = doc?.body ?? null;
  if (target === null || typeof MutationObserver !== 'function') {
    run();
    return;
  }
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | null = null;
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(quietTimer);
    clearTimeout(capTimer);
    observer?.disconnect();
    run();
  };
  observer = new MutationObserver(() => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(finish, DOM_SETTLE_QUIET_MS);
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true });
  capTimer = setTimeout(finish, DOM_SETTLE_TIMEOUT_MS);
  quietTimer = setTimeout(finish, DOM_SETTLE_QUIET_MS);
}

export function createSnapshotter(doc: Document = document): Snapshotter {
  let refs = new Map<string, Element>();
  /**
   * ref 与元素身份绑定并跨 collect 存活：同一控件保号，改了 role/label 即视为另一个可指目标而换号。
   * WeakMap 随元素被回收，不构成跨页残留状态。
   */
  const stickyRefs = new WeakMap<Element, { ref: string; role: string; label: string }>();
  let seq = 0;
  let epoch = 0;

  return {
    collect(evidenceRules = [], includeText = false) {
      epoch += 1;
      refs = new Map();
      const elements: SnapshotElement[] = [];
      const taken = new Set<Element>();
      const visited: VisitedDoc[] = [];
      let omitted = 0;
      let frameSeq = 0;

      const refOf = (el: Element, role: string, label: string, framePrefix: string): string => {
        const prior = stickyRefs.get(el);
        if (prior !== undefined && prior.role === role && prior.label === label) return prior.ref;
        seq += 1;
        const ref = `${framePrefix}za-${seq}`;
        stickyRefs.set(el, { ref, role, label });
        return ref;
      };

      // framePrefix 空串=顶层（ref 维持 za-N，回归零影响）；同源 iframe 内元素带 f<idx>: 前缀。
      const capture = (el: Element, framePrefix: string, layout: boolean): void => {
        if (taken.has(el) || isHidden(el, layout)) return;
        taken.add(el);
        // 配额命中后仍逐个记数：agent 必须能分辨「页面上没有」与「这次没采到」。
        if (elements.length >= MAX_ELEMENTS) {
          omitted += 1;
          return;
        }
        const role = roleOf(el);
        const label = accessibleNameOf(el);
        const ref = refOf(el, role, label, framePrefix);
        refs.set(ref, el);
        const disabled = DISABLEABLE_TAGS.has(tagOf(el)) &&
          (el as Partial<HTMLButtonElement>).disabled === true;
        const href = safeHrefOf(el);
        elements.push({
          ref,
          role,
          label,
          ...(href !== undefined ? { href } : {}),
          ...(disabled ? { disabled } : {}),
        });
      };

      const walk = (into: Document, framePrefix: string): void => {
        const layout = hasLayout(into);
        const scopes = scopesOf(into);
        visited.push({ doc: into, scopes, layout });
        // 浮层/模态内可交互元素先分配 ref：防页面主体占满配额导致弹层按钮、下拉选项拿不到 ref。
        for (const root of findPriorityRoots(scopes, layout)) {
          for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
            capture(el, framePrefix, layout);
          }
        }
        // 真控件先于静态单元格、视口内先于视口外：150 个号先覆盖用户此刻够得着的目标。
        for (const selector of [CONTROL_SELECTOR, STATIC_CELL_SELECTOR]) {
          const tier = scopes.flatMap((scope) => [...scope.querySelectorAll(selector)]);
          for (const el of tier) {
            if (isInViewport(el, layout)) capture(el, framePrefix, layout);
          }
          for (const el of tier) capture(el, framePrefix, layout);
        }
        // 递归下钻同源 iframe；配额与截断计数跨帧全局共享，跨源/隐藏/零尺寸帧跳过。
        for (const scope of scopes) {
          for (const iframe of scope.querySelectorAll('iframe')) {
            if (isHidden(iframe, layout) || isZeroSizedFrame(iframe)) continue;
            const childDoc = sameOriginDoc(iframe);
            if (childDoc === null) continue;
            frameSeq += 1;
            walk(childDoc, `f${frameSeq}:`);
          }
        }
      };

      walk(doc, '');
      const pageText = includeText ? extractPageText(doc) : null;
      return {
        url: doc.location?.href ?? '',
        title: doc.title,
        elements,
        snapshotEpoch: epoch,
        ...(omitted > 0 ? { elementsTruncated: true, elementsOmitted: omitted } : {}),
        notices: collectNotices(visited),
        evidence: collectEvidence(visited, evidenceRules),
        ...(pageText !== null && pageText.text !== ''
          ? {
              text: pageText.text,
              ...(pageText.truncated ? { textTruncated: true } : {}),
            }
          : {}),
      };
    },
    resolve(ref) {
      const el = refs.get(ref);
      // 已脱离文档的元素视为失效（页面局部重渲染后旧 ref 不可再操作）。
      return el !== undefined && el.isConnected ? el : null;
    },
  };
}
