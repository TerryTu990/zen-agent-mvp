/** pack 声明的周期自动化描述符（服务端 GET /v1/automation-descriptors 下发，纯调度/提示词数据）。 */
export interface AutomationDescriptor {
  packId: string;
  origin: string;
  automation: {
    id: string;
    prompt: string;
    workRoutes: string[];
    executionPreference: 'auto' | 'dom-only' | 'prefer-client-api' | 'prefer-server-api';
    defaultPeriodMinutes?: number;
  };
}

export const AUTOMATION_DESCRIPTORS_KEY = 'za.automationDescriptors';
export const AUTO_SCAN_ALARM_PREFIX = 'zen-agent.auto-scan.';
export const DEFAULT_AUTO_SCAN_MINUTES = 5;

export const autoScanAlarmFor = (automationId: string): string =>
  AUTO_SCAN_ALARM_PREFIX + automationId;

export const automationIdOfAlarm = (alarmName: string): string | null =>
  alarmName.startsWith(AUTO_SCAN_ALARM_PREFIX)
    ? alarmName.slice(AUTO_SCAN_ALARM_PREFIX.length)
    : null;

export const autoScanEnabledKeyFor = (automationId: string): string =>
  `za.autoScan.${automationId}.enabled`;

export const autoScanMinutesKeyFor = (automationId: string): string =>
  `za.autoScan.${automationId}.minutes`;

export type AutoScanRecoveryStatus = 'running' | 'succeeded' | 'failed' | 'missing' | 'unavailable';
export type AutoScanRecoveryDecision = 'keep-busy' | 'release' | 'release-and-pause';

/** 正在执行的自动回合：runId 单飞锁 + automationId 完成帧关联，storage.session 跨 SW 重启持有。 */
export interface AutoScanRun {
  runId: string;
  automationId: string;
}

export function parseAutoScanRun(stored: unknown): AutoScanRun | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const candidate = stored as Record<string, unknown>;
  return typeof candidate['runId'] === 'string' &&
    candidate['runId'] !== '' &&
    typeof candidate['automationId'] === 'string' &&
    candidate['automationId'] !== ''
    ? { runId: candidate['runId'], automationId: candidate['automationId'] }
    : null;
}

export function parseAutomationDescriptors(stored: unknown): AutomationDescriptor[] {
  if (!Array.isArray(stored)) return [];
  const descriptors: AutomationDescriptor[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const automation = candidate['automation'] as Record<string, unknown> | undefined;
    if (
      typeof candidate['packId'] !== 'string' ||
      typeof candidate['origin'] !== 'string' ||
      typeof automation !== 'object' ||
      automation === null ||
      typeof automation['id'] !== 'string' ||
      typeof automation['prompt'] !== 'string' ||
      !Array.isArray(automation['workRoutes']) ||
      !automation['workRoutes'].every((route) => typeof route === 'string') ||
      typeof automation['executionPreference'] !== 'string'
    ) {
      continue;
    }
    descriptors.push(entry as unknown as AutomationDescriptor);
  }
  return descriptors;
}

export function autoScanDispatch(
  descriptor: AutomationDescriptor,
  tabUrl: string,
  tabTitle: string,
  runId: string,
): readonly [
  { kind: 'context-report'; url: string; title: string },
  {
    kind: 'auto-scan';
    text: string;
    executionPreference: AutomationDescriptor['automation']['executionPreference'];
    automationRunId: string;
    automationId: string;
  },
] {
  return [
    { kind: 'context-report', url: tabUrl, title: tabTitle },
    {
      kind: 'auto-scan',
      text: descriptor.automation.prompt,
      executionPreference: descriptor.automation.executionPreference,
      automationRunId: runId,
      automationId: descriptor.automation.id,
    },
  ];
}

/** SW 重启恢复时只按服务端权威状态处置本地锁；网络不明时保持锁，优先防重复。 */
export function decideAutoScanRecovery(status: AutoScanRecoveryStatus): AutoScanRecoveryDecision {
  if (status === 'running' || status === 'unavailable') return 'keep-busy';
  if (status === 'succeeded') return 'release';
  return 'release-and-pause';
}

/** 唤醒周期上界（分钟）：调度端与配置面板共用同一值域，避免面板显示与实际排程分叉。 */
export const MAX_AUTO_SCAN_MINUTES = 60;

export function normalizeAutoScanMinutes(value: unknown, fallback = DEFAULT_AUTO_SCAN_MINUTES): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_AUTO_SCAN_MINUTES
    ? value
    : fallback;
}

/**
 * 只复用用户已打开的声明工作页；origin 须精确等于 pack 围栏。
 * workRoute 以 '#' 开头按 hash 路由（? 前段）精确匹配，否则按路径段前缀匹配。
 */
export function isAutoScanWorkPage(descriptor: AutomationDescriptor, url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== descriptor.origin) return false;
    const hashRoute = parsed.hash.split('?')[0];
    return descriptor.automation.workRoutes.some((route) =>
      route.startsWith('#')
        ? hashRoute === route
        : parsed.pathname === route || parsed.pathname.startsWith(route.endsWith('/') ? route : `${route}/`),
    );
  } catch {
    return false;
  }
}

export function shouldPauseAutoScan(
  run: AutoScanRun | null,
  frame: { type: string; status?: string; toolId?: string; toolCallId?: string },
): boolean {
  return run !== null && (
    frame.type === 'hitl-request' ||
    (frame.type === 'tool-card' &&
      frame.status === 'failed' &&
      !(frame.toolId === run.automationId && frame.toolCallId === run.runId))
  );
}

export function isAutoScanCompletion(
  run: AutoScanRun | null,
  frame: { type: string; status?: string; toolId?: string; toolCallId?: string },
): boolean {
  return run !== null &&
    frame.type === 'tool-card' &&
    frame.toolId === run.automationId &&
    frame.toolCallId === run.runId &&
    (frame.status === 'succeeded' || frame.status === 'failed');
}
