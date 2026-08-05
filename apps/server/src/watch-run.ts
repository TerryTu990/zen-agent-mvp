/**
 * 用户自建 watch 自动回合（adr-021）的纯判定与投影：实例解析、工作页归属、快照要素比对与报告素材。
 * 不持会话状态、不发帧、不调端口——编排在 gateway，本模块只做可独立验证的确定性计算。
 */
import { findAutomationTemplate } from '@zen-agent/contracts';
import type {
  PlatformAutomationTemplate,
  SnapshotElement,
  UserOverlay,
  UserOverlayWatch,
} from '@zen-agent/contracts';

/**
 * automationId 的 watch 归属判定：
 *  - none：不是 watch——pack 声明的自动化按普通回合处理，未知 id 由调用方 fail-closed 拒绝；
 *  - blocked：是 watch 但当前不可运行（未启用 / 模板不在平台闭集 / 非只读模板），fail-closed 拒绝——
 *    绝不回落普通回合，否则 watch id 会拿到完整工具面，只读强制被绕过；
 *  - ready：可运行的只读实例。
 */
export type WatchResolution =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'ready'; watch: UserOverlayWatch; template: PlatformAutomationTemplate };

export function resolveWatchRun(overlay: UserOverlay | null, automationId: string): WatchResolution {
  const watch = overlay?.watches?.find((entry) => entry.id === automationId);
  if (watch === undefined) return { kind: 'none' };
  if (!watch.enabled) return { kind: 'blocked', reason: '实例未启用' };
  const template = findAutomationTemplate(watch.templateId);
  if (template === undefined) return { kind: 'blocked', reason: '模板不在平台内建闭集内' };
  if (template.readOnly !== true) return { kind: 'blocked', reason: '模板非只读，当前不支持无人值守运行' };
  return { kind: 'ready', watch, template };
}

/**
 * 工作页归属：上报页与被监测页的归一标识须相等。客户端上报的快照 URL 不在实例范围内时，
 * 本轮看的就不是被监测的页面——fail-closed 判否（不采信客户端上报，U7）。
 */
export function isWatchWorkPage(watchUrl: string, reportedUrl: string): boolean {
  const target = watchPageKey(watchUrl);
  const reported = watchPageKey(reportedUrl);
  // watch 指定的是一个页面而非路由族：前缀语义会让同 origin 的其他页面被当作被监测页，产生虚假变化。
  return target !== null && target === reported;
}

/**
 * 纯跟踪参数：只标注来路、不改变页面内容，故不参与「是哪一个页面」的判定。
 * 闭集只收公认的广告点击与位置埋点标识（`spm` 为阿里系逐次导航轮换的位置串，不承载内容）；
 * 站点自有参数（page/q/status/ref…）一律保留——
 * 把它们一并丢弃会让搜索页、分页、筛选视图被当成同一页，产出虚假的「新增/消失」。
 */
const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'msclkid', 'yclid', 'spm']);

/**
 * 被监测页的归一标识：origin + 去尾斜杠路径 + 排序去跟踪参数后的查询串 + hash。
 * 工作页判定与比对基线共用它，两者口径必须一致——
 *  - 判定比归并粗（如判定忽略查询串而归并不忽略），同一页的变体各自建基线，每轮都落「首轮建基线」而永不报告；
 *  - 判定比归并细，则不同页共用一条基线，每轮互相 diff 出整页虚假变化。
 * 参数名/值重新编码后拼接：直接拼解码值会让 `?b=%26c%3Dd`（单参）与 `?b=&c=d`（两参）产出同一标识。
 * URL 不可解析时返回 null（fail-closed：不可解析的两端不相等）。
 */
export function watchPageKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  const normalizedPath = path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path;
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return !lower.startsWith('utm_') && !TRACKING_PARAMS.has(lower);
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  return parsed.origin + normalizedPath + (query === '' ? '' : `?${query}`) + parsed.hash;
}

/** 比对基线：只留可稳定复现的要素投影（ref 每次快照重新编号，不入基线）。 */
export interface WatchSnapshot {
  url: string;
  title: string;
  items: string[];
}

export interface WatchChange {
  added: string[];
  removed: string[];
  titleChanged: boolean;
}

/** 单轮基线保留的要素条数上限：页面异常膨胀时截断，防长驻基线无界增长。 */
const MAX_ITEMS = 200;
/** 单条要素投影长度上限（字符）。 */
const MAX_ITEM_LENGTH = 160;
/** 摘要与提示词中逐条列举的样本条数上限；超出部分只报计数。 */
const SAMPLE_LIMIT = 5;

/** 要素投影：角色 + 可读标签 + 禁用态；值与链接已在调用点剥离（SEC 投影同快照回喂口径）。 */
function itemOf(element: SnapshotElement): string {
  const base = `${element.role}｜${element.label}${element.disabled === true ? '｜已禁用' : ''}`;
  return base.length > MAX_ITEM_LENGTH ? `${base.slice(0, MAX_ITEM_LENGTH)}…` : base;
}

export function watchSnapshotOf(
  url: string,
  title: string,
  elements: SnapshotElement[],
  notices: string[] = [],
): WatchSnapshot {
  return {
    url,
    title,
    items: [
      ...elements.slice(0, MAX_ITEMS).map(itemOf),
      // 页面提示文本（校验/状态/告警）已由快照采集：纳入基线使「状态位变化」可被检出。
      ...notices.slice(0, MAX_ITEMS).map((notice) => `notice｜${notice}`),
    ],
  };
}

/** 多重集差分：同一要素出现多次时按次数配平，故"两条变一条"也算消失一条。 */
export function diffWatchSnapshots(prev: WatchSnapshot, next: WatchSnapshot): WatchChange {
  const remaining = new Map<string, number>();
  for (const item of prev.items) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of next.items) {
    const left = remaining.get(item) ?? 0;
    if (left > 0) remaining.set(item, left - 1);
    else added.push(item);
  }
  const removed: string[] = [];
  for (const [item, left] of remaining) {
    for (let index = 0; index < left; index += 1) removed.push(item);
  }
  return { added, removed, titleChanged: prev.title !== next.title };
}

export function hasWatchChange(change: WatchChange): boolean {
  return change.added.length > 0 || change.removed.length > 0 || change.titleChanged;
}

function sample(items: string[]): string {
  const shown = items.slice(0, SAMPLE_LIMIT).join('、');
  return items.length > SAMPLE_LIMIT ? `${shown} 等 ${items.length} 项` : shown;
}

/**
 * 变化摘要（R6 如实呈现）：服务端据快照比对机械生成，不经模型——完成帧与面板历史以此为准，
 * 模型只负责在报告正文里解释，不负责断言"有没有变化"。
 */
export function changeSummary(change: WatchChange): string {
  const parts: string[] = [];
  if (change.added.length > 0) parts.push(`新增 ${change.added.length} 项`);
  if (change.removed.length > 0) parts.push(`消失 ${change.removed.length} 项`);
  if (change.titleChanged) parts.push('页面标题变更');
  const details: string[] = [];
  if (change.added.length > 0) details.push(`新增：${sample(change.added)}`);
  if (change.removed.length > 0) details.push(`消失：${sample(change.removed)}`);
  const head = parts.length > 0 ? parts.join('、') : '页面要素有变化';
  return details.length > 0 ? `${head}；${details.join('；')}` : head;
}

/**
 * 报告回合的用户消息：把「用户指令 + 关注点 + 服务端比对结论 + 本轮要素」交给模型渲染人读报告。
 * 结论由服务端给定，模型不得据此外的信息作断言；并显式声明本轮无人值守（无可确认的人）。
 */
export function watchReportPrompt(input: {
  text: string;
  watch: UserOverlayWatch;
  snapshot: WatchSnapshot;
  change: WatchChange;
  summary: string;
}): string {
  const { text, watch, snapshot, change, summary } = input;
  const lines = [
    '【自动化任务】用户自建页面变化监测（平台只读模板，本轮由调度发起，用户不在场）。',
    `【用户指令】${text}`,
    ...(watch.focus !== undefined ? [`【用户关注点】${watch.focus}`] : []),
    `【监测页面】${snapshot.url}${snapshot.title !== '' ? `（标题：${snapshot.title}）` : ''}`,
    `【服务端比对结论】${summary}`,
    ...(change.added.length > 0
      ? ['【新增要素】', ...change.added.slice(0, SAMPLE_LIMIT).map((item) => `- ${item}`)]
      : []),
    ...(change.removed.length > 0
      ? ['【消失要素】', ...change.removed.slice(0, SAMPLE_LIMIT).map((item) => `- ${item}`)]
      : []),
    '【本轮页面要素（截断）】',
    ...snapshot.items.slice(0, 30).map((item) => `- ${item}`),
    '【要求】只依据以上内容如实汇报本轮变化，与关注点相关的优先说明；未出现在要素中的信息一律不得推断或补全。',
    '本轮无人值守：没有人可以确认任何操作，不要请求执行页面操作或任何需要人工确认的动作。',
  ];
  return lines.join('\n');
}
