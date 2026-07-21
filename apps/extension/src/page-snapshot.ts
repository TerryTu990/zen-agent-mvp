/**
 * 页面快照采集器（adr-011 观察半程）：扫描可交互元素、分配 za-N ref，
 * ref→元素映射仅当次快照有效（下次 collect 整体重建），供 dom 批次解释器解引用。
 * 可见性按声明式属性排除（hidden/aria-hidden/type=hidden）——不依赖布局测量，
 * 保证 jsdom 可测且不因宿主 CSS 花活漏采。
 */
import type { SnapshotElement } from './frames.js';
import { MAX_ELEMENTS, MAX_LABEL_LENGTH, MAX_NOTICES, MAX_NOTICE_LENGTH } from './tuning.js';

const INTERACTIVE_SELECTOR = [
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
  // 业务表格中的状态、编号和结果通常是静态单元格而非控件；纳入有界快照后才可用 read 步骤
  // 建立“页面证据 → 动作”链。仍受 MAX_ELEMENTS / MAX_LABEL_LENGTH 限制，不无差别采集正文 div。
  'table th',
  'table td',
  '[role="columnheader"]',
  '[role="rowheader"]',
  '[role="cell"]',
  '[role="gridcell"]',
].join(', ');

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

const MESSAGE_RECEIPT_SELECTOR = [
  '[class*="read-status" i]',
  '[class*="send-status" i]',
  '[class*="message-status" i]',
].join(', ');

/** 模态层根匹配：显式语义（role=dialog / aria-modal）优先；无命中再兜底 class 含 dialog/modal 的容器。 */
const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"]';
const MODAL_FALLBACK_SELECTOR = '[class*="dialog" i], [class*="modal" i]';
/** 展开中的下拉浮层常挂 body 末尾，文档序采集易被配额截断，须与模态层同享优先配额。 */
const FLOATING_LIST_SELECTOR = '[role="listbox"]';

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** 页面当前可见的告警/校验/状态提示文本（已去重截断）：agent 据此识别表单校验等拦截。 */
  notices: string[];
}

export interface Snapshotter {
  /** 重建 ref 映射并返回快照；旧 ref 全部作废。 */
  collect(): PageSnapshot;
  /** 解引用最近一次快照的 ref；未知/已作废返回 null。 */
  resolve(ref: string): Element | null;
}

function isDeclaredHidden(el: Element): boolean {
  if (el.closest('[hidden]') !== null) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return el instanceof HTMLInputElement && el.type === 'hidden';
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().toLowerCase() ?? '';
  if (explicit !== '') return explicit;
  const tag = el.tagName.toLowerCase();
  return el instanceof HTMLInputElement ? `${tag}:${el.type}` : tag;
}

// 占位标签：让 agent 能区分"未命名图标钮"与正常控件，不再按位置瞎猜语义。
const UNLABELED_PLACEHOLDER = '[无文字标签]';

function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') return aria.trim().slice(0, MAX_LABEL_LENGTH);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') {
    return placeholder.trim().slice(0, MAX_LABEL_LENGTH);
  }
  const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
  if (text !== '') return text.slice(0, MAX_LABEL_LENGTH);
  const title = el.getAttribute('title');
  if (title !== null && title.trim() !== '') return title.trim().slice(0, MAX_LABEL_LENGTH);
  const name = el.getAttribute('name');
  if (name !== null && name.trim() !== '') return name;
  return UNLABELED_PLACEHOLDER;
}

/** 内联 display/visibility 显隐（含祖先）——宿主的模态层与校验提示常以内联样式切换。 */
function isInlineHidden(el: Element): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.style.display === 'none' || node.style.visibility === 'hidden') return true;
  }
  return false;
}

function findVisible(doc: Document, selector: string): Element[] {
  return [...doc.querySelectorAll(selector)].filter(
    (el) => !isDeclaredHidden(el) && !isInlineHidden(el),
  );
}

/** class 兜底命中只取最外层容器，嵌套命中（modal 壳内的 modal-body）不重复算根。 */
function findModalRoots(doc: Document): Element[] {
  const explicit = findVisible(doc, MODAL_SELECTOR);
  if (explicit.length > 0) return explicit;
  const fallback = findVisible(doc, MODAL_FALLBACK_SELECTOR);
  return fallback.filter((el) => !fallback.some((outer) => outer !== el && outer.contains(el)));
}

/** 优先配额根：展开中的下拉浮层最优先（正在交互的目标），其次模态层，最后全文档。 */
function findPriorityRoots(doc: Document): Element[] {
  return [...findVisible(doc, FLOATING_LIST_SELECTOR), ...findModalRoots(doc)];
}

/** 语义化提示区（alert/status/aria-live）；非此即 class 启发式命中，须加短文本约束。 */
function isSemanticNotice(el: Element): boolean {
  const role = el.getAttribute('role');
  if (role === 'alert' || role === 'status') return true;
  const live = el.getAttribute('aria-live');
  return live === 'polite' || live === 'assertive';
}

// 只读 textContent、绝不读控件 value（密码等敏感值不进提示，沿用 SEC-04 快照口径）。
function collectNotices(doc: Document): string[] {
  const notices: string[] = [];
  const seen = new Set<string>();
  const accepted: Element[] = [];
  for (const el of doc.querySelectorAll(NOTICE_SELECTOR)) {
    if (notices.length >= MAX_NOTICES) break;
    if (isDeclaredHidden(el) || isInlineHidden(el)) continue;
    // 嵌套命中（如 alert 区内的 error 子节点）只取外层，避免同段文本重复上报。
    if (accepted.some((outer) => outer.contains(el))) continue;
    const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
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
  return notices;
}

function collectMessageReceiptEvidence(doc: Document): string | null {
  const receipts = findVisible(doc, MESSAGE_RECEIPT_SELECTOR)
    .map((el) => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
    .filter((text) => text !== '' && text.length <= MAX_NOTICE_LENGTH);
  const latest = receipts.at(-1);
  return latest === undefined ? null : `消息回执数：${receipts.length}；最新：${latest}`;
}

function valueOf(el: Element): string | undefined {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    // 密码框值绝不进快照（SEC-04：快照会进 LLM 上下文与审计面）。
    if (el instanceof HTMLInputElement && el.type === 'password') return undefined;
    return el.value === '' ? undefined : el.value.slice(0, MAX_LABEL_LENGTH);
  }
  return undefined;
}

/**
 * 同源 iframe 的子文档（ADR-013 批次④ 方案 A）：contentDocument 可达即同源、返回其 document；
 * 跨源浏览器返回 null 或抛安全错误——一律视为不可下钻、跳过。
 */
function sameOriginDoc(iframe: Element): Document | null {
  try {
    return (iframe as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

export function createSnapshotter(doc: Document = document): Snapshotter {
  let refs = new Map<string, Element>();

  return {
    collect() {
      refs = new Map();
      const elements: SnapshotElement[] = [];
      const taken = new Set<Element>();
      let seq = 0;
      let frameSeq = 0;
      // framePrefix 空串=顶层（ref 维持 za-N，回归零影响）；同源 iframe 内元素带 f<idx>: 前缀。
      const capture = (el: Element, framePrefix: string): void => {
        if (elements.length >= MAX_ELEMENTS || taken.has(el) || isDeclaredHidden(el)) return;
        taken.add(el);
        seq += 1;
        const ref = `${framePrefix}za-${seq}`;
        refs.set(ref, el);
        const value = valueOf(el);
        const disabled = el instanceof HTMLButtonElement || el instanceof HTMLInputElement
          ? el.disabled
          : false;
        elements.push({
          ref,
          role: roleOf(el),
          label: labelOf(el),
          ...(value !== undefined ? { value } : {}),
          ...(disabled ? { disabled } : {}),
        });
      };
      const walk = (into: Document, framePrefix: string): void => {
        if (elements.length >= MAX_ELEMENTS) return;
        // 浮层/模态内可交互元素先分配 ref：防页面主体占满配额导致弹层按钮、下拉选项拿不到 ref。
        for (const root of findPriorityRoots(into)) {
          for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) capture(el, framePrefix);
        }
        for (const el of into.querySelectorAll(INTERACTIVE_SELECTOR)) capture(el, framePrefix);
        // 递归下钻同源 iframe；配额（MAX_ELEMENTS）跨帧全局共享，跨源帧跳过。
        for (const iframe of into.querySelectorAll('iframe')) {
          const childDoc = sameOriginDoc(iframe);
          if (childDoc === null) continue;
          frameSeq += 1;
          walk(childDoc, `f${frameSeq}:`);
        }
      };
      walk(doc, '');
      const notices = collectNotices(doc);
      const receipt = collectMessageReceiptEvidence(doc);
      if (receipt !== null && notices.length < MAX_NOTICES) notices.push(receipt);
      return { url: doc.location?.href ?? '', title: doc.title, elements, notices };
    },
    resolve(ref) {
      const el = refs.get(ref);
      // 已脱离文档的元素视为失效（页面局部重渲染后旧 ref 不可再操作）。
      return el !== undefined && el.isConnected ? el : null;
    },
  };
}
