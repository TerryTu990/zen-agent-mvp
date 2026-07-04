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
  '[contenteditable="true"]',
].join(', ');

const MAX_ELEMENTS = 150;
const MAX_LABEL_LENGTH = 80;

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
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
      return { url: doc.location?.href ?? '', title: doc.title, elements };
    },
    resolve(ref) {
      const el = refs.get(ref);
      // 已脱离文档的元素视为失效（页面局部重渲染后旧 ref 不可再操作）。
      return el !== undefined && el.isConnected ? el : null;
    },
  };
}
