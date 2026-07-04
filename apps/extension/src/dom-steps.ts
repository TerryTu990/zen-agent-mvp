/**
 * dom 批次解释器（adr-011）：只解释服务端签发的闭集动作，不 eval 任意代码、零治理判定（U7）。
 * 每步先高亮目标并短暂停顿再执行——用户全程可见 agent 在操作什么（可见性即产品需求本体）。
 * 任一步失败立即中止余下步骤、如实回报（HOW-05），错误只含 ref/动作名不含值（SEC-04）。
 */
import type { DomStep, JsonObject } from './frames.js';

export interface DomStepOutcome {
  ok: boolean;
  /** 采集值按 read 步骤的 name 键回传，作为 exec-result.body.reads。 */
  body?: JsonObject;
  error?: string;
}

export interface DomStepRunner {
  run(steps: DomStep[]): Promise<DomStepOutcome>;
}

const STEP_PACE_MS = 350;

const HIGHLIGHT_STYLE = '3px solid #B4552F';

/**
 * React 受控输入兼容：框架以自有 value 描述符跟踪输入，直接赋值不触发其状态更新，
 * 须经原型 native setter 写值再派发 input/change 事件。
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter !== undefined) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function readValueOf(el: Element): string {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return el.value;
  }
  return el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}

export function createDomStepRunner(
  resolve: (ref: string) => Element | null,
  pace: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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
        const fail = (reason: string): DomStepOutcome => ({
          ok: false,
          error: `step-${index + 1}-${step.action}:${reason}`,
        });
        const el = step.ref !== undefined ? resolve(step.ref) : null;
        if (el === null) return fail('ref-not-found');
        await spotlight(el);
        switch (step.action) {
          case 'click':
            (el as HTMLElement).click();
            break;
          case 'fill':
            if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
              return fail('not-fillable');
            }
            setNativeValue(el, step.value ?? '');
            break;
          case 'select':
            if (!(el instanceof HTMLSelectElement)) return fail('not-selectable');
            el.value = step.value ?? '';
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
