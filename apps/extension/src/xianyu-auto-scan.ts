export const XIANYU_AUTO_SCAN_ALARM = 'zen-agent.xianyu-auto-scan';
export const XIANYU_AUTO_SCAN_ENABLED_KEY = 'za.xianyuAutoScanEnabled';
export const XIANYU_AUTO_SCAN_MINUTES_KEY = 'za.xianyuAutoScanMinutes';
export const DEFAULT_XIANYU_AUTO_SCAN_MINUTES = 5;
export const XIANYU_AUTO_SCAN_COMPLETION_TOOL_ID = 'xianyu-auto-scan';

export function normalizeAutoScanMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60
    ? value
    : DEFAULT_XIANYU_AUTO_SCAN_MINUTES;
}

/** 只复用用户已打开的卖家订单/聊天工作页；登录页、数据页及站外页一律不唤醒。 */
export function isXianyuAutoScanWorkPage(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://seller.goofish.com') return false;
    const route = parsed.hash.split('?')[0];
    return route === '#/seller-trade/order-manage' || route === '#/im';
  } catch {
    return false;
  }
}

export function shouldPauseXianyuAutoScan(
  runId: string | null,
  frame: { type: string; status?: string; toolId?: string; toolCallId?: string },
): boolean {
  return runId !== null && (
    frame.type === 'hitl-request' ||
    (frame.type === 'tool-card' &&
      frame.status === 'failed' &&
      !(frame.toolId === XIANYU_AUTO_SCAN_COMPLETION_TOOL_ID && frame.toolCallId === runId))
  );
}

export function isXianyuAutoScanCompletion(
  runId: string | null,
  frame: { type: string; status?: string; toolId?: string; toolCallId?: string },
): boolean {
  return runId !== null &&
    frame.type === 'tool-card' &&
    frame.toolId === XIANYU_AUTO_SCAN_COMPLETION_TOOL_ID &&
    frame.toolCallId === runId &&
    (frame.status === 'succeeded' || frame.status === 'failed');
}
