/**
 * 页面快照采集器（adr-011 观察半程）：扫描可交互元素、分配 za-N ref，
 * ref→元素映射仅当次快照有效（下次 collect 整体重建），供 dom 批次解释器解引用。
 * 可见性按声明式属性排除（hidden/aria-hidden/type=hidden）——不依赖布局测量，
 * 保证 jsdom 可测且不因宿主 CSS 花活漏采。
 */
import type { SnapshotElement } from './frames.js';

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
  // 无 role 自定义下拉的有界形态：仅收 listbox 后代 li，禁无差别收录裸 li/div（快照会爆炸）。
  '[role="listbox"] li',
  '[contenteditable="true"]',
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

const MAX_ELEMENTS = 150;
const MAX_LABEL_LENGTH = 80;
const MAX_NOTICES = 10;
const MAX_NOTICE_LENGTH = 200;

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
  const tag = el.tagName.toLowerCase();
  return el instanceof HTMLInputElement ? `${tag}:${el.type}` : tag;
}

function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') return aria.trim().slice(0, MAX_LABEL_LENGTH);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') {
    return placeholder.trim().slice(0, MAX_LABEL_LENGTH);
  }
  const text = el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
  if (text !== '') return text.slice(0, MAX_LABEL_LENGTH);
  return el.getAttribute('name') ?? '';
}

/** 提示文本专用可见性：声明式隐藏之外再排除内联 display/visibility 切换——宿主校验提示常以内联样式显隐。 */
function isNoticeHidden(el: Element): boolean {
  if (isDeclaredHidden(el)) return true;
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.style.display === 'none' || node.style.visibility === 'hidden') return true;
  }
  return false;
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
    if (isNoticeHidden(el)) continue;
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

export function createSnapshotter(doc: Document = document): Snapshotter {
  let refs = new Map<string, Element>();

  return {
    collect() {
      refs = new Map();
      const elements: SnapshotElement[] = [];
      let seq = 0;
      for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (isDeclaredHidden(el)) continue;
        seq += 1;
        const ref = `za-${seq}`;
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
      }
      return { url: doc.location?.href ?? '', title: doc.title, elements, notices: collectNotices(doc) };
    },
    resolve(ref) {
      const el = refs.get(ref);
      // 已脱离文档的元素视为失效（页面局部重渲染后旧 ref 不可再操作）。
      return el !== undefined && el.isConnected ? el : null;
    },
  };
}
