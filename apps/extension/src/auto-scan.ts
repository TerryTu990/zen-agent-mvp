import type { UserMessageFrame } from './frames.js';

/**
 * 周期自动化描述符（纯调度/提示词数据）：两个来源共用同一形状，调度侧对来源无感知——
 * pack 声明（服务端 GET /v1/automation-descriptors 下发）与用户自建触发器（overlay.watches 派生）。
 */
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

/**
 * 自动回合的上行帧投影。automationRunId 关联完成帧与单飞锁；automationId 是服务端定位
 * 只读模板的唯一依据——缺失则该轮回落普通回合，R7 只读强制整条不可达，故两者必须同时随帧上行。
 */
export function autoScanUpstreamFrame(
  dispatch: ReturnType<typeof autoScanDispatch>[1],
  sessionId: string,
): UserMessageFrame {
  return {
    type: 'user-message',
    sessionId,
    text: dispatch.text,
    messageId: dispatch.automationRunId,
    executionPreference: dispatch.executionPreference,
    automationRunId: dispatch.automationRunId,
    automationId: dispatch.automationId,
  };
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
 *
 * 两种路由语义按来源分叉，且必须与服务端同判定：
 *  - pack 自动化：workRoute 以 '#' 开头按 hash 路由（? 前段）精确匹配，否则按路径段前缀匹配（工作流覆盖一族页面）；
 *  - 用户自建 watch：路径精确相等——watch 指定的是一个页面。若此处仍用前缀语义，
 *    子路径页会被选中并发起回合，而服务端判否后回失败帧，客户端据此把触发器整条暂停。
 */
export function isAutoScanWorkPage(descriptor: AutomationDescriptor, url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== descriptor.origin) return false;
    const exactPath = descriptor.packId === WATCH_DESCRIPTOR_PACK_ID;
    const hashRoute = parsed.hash.split('?')[0];
    return descriptor.automation.workRoutes.some((route) => {
      if (route.startsWith('#')) return hashRoute === route;
      if (exactPath) return trimTrailingSlash(parsed.pathname) === trimTrailingSlash(route);
      return (
        parsed.pathname === route || parsed.pathname.startsWith(route.endsWith('/') ? route : `${route}/`)
      );
    });
  } catch {
    return false;
  }
}

const trimTrailingSlash = (path: string): string =>
  path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path;

/**
 * 平台内建自动化模板闭集镜像（contracts PLATFORM_AUTOMATION_TEMPLATES / adr-021）：
 * 插件不依赖 @zen-agent/*（U5），闭集在此手抄；闭集外的 templateId 一律不派生描述符（fail-closed）。
 */
export const WATCH_TEMPLATE_IDS = ['page-watch'] as const;
export type WatchTemplateId = (typeof WATCH_TEMPLATE_IDS)[number];

/** 平台唤醒周期下限（分钟）：用户自建触发器不得更密，面板与写入期共用同一下限。 */
export const PLATFORM_MIN_WATCH_MINUTES = 5;
/** 单用户自建触发器条数上限（contracts watchList maxItems）。 */
export const MAX_WATCHES = 5;
/** 关注点文本上限（字符）。 */
export const WATCH_FOCUS_MAX_LENGTH = 200;

/** watch 派生描述符的归属占位：watches 居 overlay 顶层、不锚定任何 pack，只借用描述符的调度形状。 */
export const WATCH_DESCRIPTOR_PACK_ID = 'user-watch';

/** 用户自建触发器实例（overlay.watches 一条）：只有「平台模板 id + 参数」，无工具面表达位。 */
export interface WatchInstance {
  id: string;
  templateId: WatchTemplateId;
  url: string;
  minutes: number;
  enabled: boolean;
  focus?: string;
}

function parseWatchInstance(entry: unknown): WatchInstance | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const candidate = entry as Record<string, unknown>;
  const { id, templateId, url, minutes, enabled, focus } = candidate;
  if (
    typeof id !== 'string' || id === '' ||
    typeof templateId !== 'string' ||
    !(WATCH_TEMPLATE_IDS as readonly string[]).includes(templateId) ||
    typeof url !== 'string' ||
    typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 ||
    typeof enabled !== 'boolean' ||
    (focus !== undefined && typeof focus !== 'string')
  ) {
    return null;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  return {
    id,
    templateId: templateId as WatchTemplateId,
    url,
    minutes,
    enabled,
    ...(focus !== undefined ? { focus } : {}),
  };
}

/**
 * GET /v1/user-config 响应 → 可调度的 watch 实例；拉取失败/空态/结构不符一律回空数组
 * （fail-closed 不调度），残缺实例逐条丢弃而非整表作废。
 */
export function watchesFromUserConfig(body: unknown): WatchInstance[] {
  if (typeof body !== 'object' || body === null) return [];
  const overlay = (body as Record<string, unknown>)['overlay'];
  if (typeof overlay !== 'object' || overlay === null) return [];
  const watches = (overlay as Record<string, unknown>)['watches'];
  if (!Array.isArray(watches)) return [];
  const instances: WatchInstance[] = [];
  for (const entry of watches) {
    const instance = parseWatchInstance(entry);
    if (instance !== null) instances.push(instance);
  }
  return instances;
}

/**
 * watch 实例 → 周期自动化描述符：工作页围栏取实例 URL 的 origin + 路径前缀（查询串与 hash 不入围栏）。
 * 前提：instance 已过 watchesFromUserConfig 解析（URL 可解析且协议为 http/https）。
 * focus 只进提示词，不改变工具面——只读强制在服务端，客户端不做任何治理判定（U7）。
 */
export function watchAutomationDescriptor(watch: WatchInstance): AutomationDescriptor {
  const target = new URL(watch.url);
  const focus = watch.focus === undefined || watch.focus === '' ? '' : `用户关注点：${watch.focus}。`;
  return {
    packId: WATCH_DESCRIPTOR_PACK_ID,
    origin: target.origin,
    automation: {
      id: watch.id,
      prompt:
        `只读巡检当前页面（${watch.url}）：读取页面内容并与上一轮快照比对。${focus}` +
        '有变化则给出变化摘要与依据要素；无变化则不作汇报。',
      workRoutes: [target.pathname],
      executionPreference: 'dom-only',
      defaultPeriodMinutes: watch.minutes,
    },
  };
}

/**
 * pack 声明描述符 ∪ 已启用 watch 派生描述符：二者共用 C3 automationId 命名空间，
 * 撞名时保留 pack 侧（自动回合归属不可判定即不调度）。未启用实例不进集合。
 */
export function mergeAutomationDescriptors(
  descriptors: readonly AutomationDescriptor[],
  watches: readonly WatchInstance[],
): AutomationDescriptor[] {
  const taken = new Set(descriptors.map((descriptor) => descriptor.automation.id));
  const merged = [...descriptors];
  for (const watch of watches) {
    if (!watch.enabled || taken.has(watch.id)) continue;
    taken.add(watch.id);
    merged.push(watchAutomationDescriptor(watch));
  }
  return merged;
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
