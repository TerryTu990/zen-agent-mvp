/**
 * dom 批次解释器（adr-011）：只解释服务端签发的闭集动作，不 eval 任意代码、零治理判定（U7）。
 * 每步先高亮目标并短暂停顿再执行——用户全程可见 agent 在操作什么（可见性即产品需求本体）。
 * 任一步失败立即中止余下步骤、如实回报（HOW-05），错误只含 ref/动作名不含值（SEC-04）。
 */
import type { DomStep, JsonObject } from './frames.js';
import { STEP_PACE_MS } from './tuning.js';

export interface DomStepOutcome {
  ok: boolean;
  /** 采集值按 read 步骤的 name 键回传，作为 exec-result.body.reads。 */
  body?: JsonObject;
  error?: string;
}

export interface DomStepRunner {
  run(steps: DomStep[]): Promise<DomStepOutcome>;
}

/**
 * navigate 步的执行委托（ADR-013 批次④）：dom 批次遇 navigate 时不在页面内跳转，
 * 而是请 background 在本组窗口开目标页并入组；返回值即回喂服务端的结果本体。
 */
export type DomNavigate = (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>;

const HIGHLIGHT_STYLE = '3px solid #B4552F';

/**
 * 取元素所属 realm 的构造器：同源 iframe 内元素属子文档 realm，用顶层 window 的
 * instanceof / prototype 会漏判（ADR-013 批次④ iframe 下钻）。缺 defaultView 时回退顶层。
 */
function realmOf(el: Element): typeof globalThis {
  return (el.ownerDocument.defaultView ?? window) as unknown as typeof globalThis;
}

function isTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const realm = realmOf(el);
  return el instanceof realm.HTMLInputElement || el instanceof realm.HTMLTextAreaElement;
}

/**
 * React 受控输入兼容：框架以自有 value 描述符跟踪输入，直接赋值不触发其状态更新，
 * 须经原型 native setter 写值再派发 input/change 事件。setter 取自元素自身 realm 原型，兼容同源 iframe。
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const realm = realmOf(el);
  const proto = el instanceof realm.HTMLTextAreaElement
    ? realm.HTMLTextAreaElement.prototype
    : realm.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) setter.call(el, value);
  else (el as HTMLInputElement | HTMLTextAreaElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function readValueOf(el: Element): string {
  const realm = realmOf(el);
  if (
    el instanceof realm.HTMLInputElement ||
    el instanceof realm.HTMLSelectElement ||
    el instanceof realm.HTMLTextAreaElement
  ) {
    return (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }
  return el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}

export function createDomStepRunner(
  resolve: (ref: string) => Element | null,
  pace: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  // 用户「停止」检查点（步间生效）：返回 true 即中止余下步骤，错误串固定 user-stopped（服务端据此吊销任务授权）。
  isStopped: () => boolean = () => false,
  // navigate 步委托；未注入时遇 navigate 如实失败（不静默降级）。
  navigate?: DomNavigate,
): DomStepRunner {
  async function spotlight(el: Element): Promise<void> {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const style = (el as HTMLElement).style;
    const prevOutline = style.outline;
    const prevOffset = style.outlineOffset;
    style.outline = HIGHLIGHT_STYLE;
    style.outlineOffset = '2px';
    await pace(STEP_PACE_MS);
    style.outline = prevOutline;
    style.outlineOffset = prevOffset;
  }

  return {
    async run(steps) {
      const reads: JsonObject = {};
      for (const [index, step] of steps.entries()) {
        if (isStopped()) return { ok: false, error: 'user-stopped' };
        const fail = (reason: string): DomStepOutcome => ({
          ok: false,
          error: `step-${index + 1}-${step.action}:${reason}`,
        });
        // navigate 免 ref、服务端已保证单步：不解引用快照，直接委托 background 开页。
        if (step.action === 'navigate') {
          if (navigate === undefined) return fail('navigate-unavailable');
          if (step.url === undefined || step.url === '') return fail('missing-url');
          const outcome = await navigate(step.url);
          if (!outcome.ok) return fail(outcome.error ?? 'navigate-failed');
          return { ok: true, body: { url: outcome.url ?? step.url } };
        }
        const el = step.ref !== undefined ? resolve(step.ref) : null;
        if (el === null) return fail('ref-not-found');
        await spotlight(el);
        switch (step.action) {
          case 'click':
            (el as HTMLElement).click();
            break;
          case 'fill':
            if (!isTextInput(el)) return fail('not-fillable');
            setNativeValue(el, step.value ?? '');
            break;
          case 'select':
            if (!(el instanceof realmOf(el).HTMLSelectElement)) return fail('not-selectable');
            (el as HTMLSelectElement).value = step.value ?? '';
            el.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          case 'read':
            reads[step.name ?? step.ref ?? `step-${index + 1}`] = readValueOf(el);
            break;
          case 'scroll':
          case 'highlight':
            // spotlight 已完成滚动与高亮本体。
            break;
          default:
            // 服务端签发闭集之外的动作（navigate/waitFor 等未实现项）：拒执行、如实失败。
            return fail('action-not-supported');
        }
      }
      return { ok: true, body: { reads, completedSteps: steps.length } };
    },
  };
}
