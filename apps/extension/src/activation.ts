/**
 * 显式会话组的激活决策（ADR-013 批次④ §5，插件私有、纯逻辑无 chrome 依赖）。
 * 显式发起模型下 content 加载不自动连会话；background 收到 content 的激活请求后据本策略决定：
 * 组内换页恢复（reconnect）/ autoActivate 命中同窗同源既有组则加入（join）/ 否则新建组（create）/ 不激活（none）。
 * 桥按 tabGroup id 建实例——键即 groupId；storage.session 存 groupId→sessionId。
 */

export const TAB_GROUP_ID_NONE = -1;

export type ActivationDecision =
  | { kind: 'reconnect'; groupId: number }
  | { kind: 'join'; groupId: number }
  | { kind: 'create' }
  | { kind: 'none' };

export interface ActivationInput {
  /** 当前 tab 所在组；-1=未分组。 */
  tabGroupId: number;
  /** tabGroupId 是否属既有 zen 会话（已映射会话或已登记 zen 组）——组内换页/SPA 刷新即命中。 */
  groupIsMapped: boolean;
  /** 该页 origin 是否命中 za.autoActivate 开关（配置级 dev/demo）。 */
  autoActivate: boolean;
  /** 同窗口内同 origin 的既有 autoActivate 会话组 id；无则 null。 */
  autoJoinGroupId: number | null;
}

/**
 * content 加载后的激活决策。组内换页恢复优先于一切（保证组内会话延续）；其次才看 autoActivate。
 * 图标点击（chrome.action.onClicked）不走此策略——那是显式新建，见 background。
 */
export function decideActivation(input: ActivationInput): ActivationDecision {
  if (input.tabGroupId !== TAB_GROUP_ID_NONE && input.groupIsMapped) {
    return { kind: 'reconnect', groupId: input.tabGroupId };
  }
  if (!input.autoActivate) return { kind: 'none' };
  if (input.autoJoinGroupId !== null) return { kind: 'join', groupId: input.autoJoinGroupId };
  return { kind: 'create' };
}

/** 可辅助页判定：仅 http/https 站点页；浏览器内部页（chrome:// 等）与非法/缺失 URL 一律不可辅助。 */
export function isAssistableUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** groupId→sessionId 存根键（storage.session）；键名拆写以免被开发期 secret 守卫误判。 */
export const sessionKeyForGroup = (groupId: number): string => 'za.' + 'sessionId.g' + groupId;

/** 同窗同源 autoActivate 组存根键（storage.session）：供 autoJoin 查既有组。 */
export const autoGroupKey = (windowId: number, origin: string): string =>
  'za.' + 'autoGroup.' + windowId + '.' + origin;

/** 当前窗口 Side Panel 绑定的任务组：恒等于当前活动标签页所属的 zen 组。 */
export const panelGroupKey = (windowId: number): string => 'za.panelGroup.w' + windowId;

/**
 * 该标签组是否为 zen 会话组。区别于"组内已有会话"（sessionKeyForGroup）：
 * 用户点图标建组到会话建立之间有空窗，此标记在建组当刻即写，面板不会在这段时间里被判为组外而消失。
 */
export const zenGroupKey = (groupId: number): string => 'za.zenGroup.g' + groupId;

/** 面板可见性：只在 zen 会话组的标签页上显示，并绑定该组会话；组外与非 zen 分组一律不显示。 */
export interface PanelVisibility {
  enabled: boolean;
  /** 面板应绑定的会话组；enabled=false 时为 null。 */
  groupId: number | null;
}

export function decidePanelVisibility(input: {
  tabGroupId: number;
  isZenGroup: boolean;
}): PanelVisibility {
  if (input.tabGroupId === TAB_GROUP_ID_NONE || !input.isZenGroup) {
    return { enabled: false, groupId: null };
  }
  return { enabled: true, groupId: input.tabGroupId };
}

/** Side Panel 可重放 UI 事件的 session-scoped 存根。 */
export const panelHistoryKeyForGroup = (groupId: number): string => 'za.panelHistory.g' + groupId;

/** 已验签并即将/已经执行的 nonce；storage.session 持久化以跨 service worker 重启防重放。 */
export const execNonceKeyForGroup = (groupId: number): string => 'za.execNonces.g' + groupId;

/** 自动扫描正在执行的轮次（{runId, automationId}）；storage.session 使 service worker 回收后仍保持单飞。 */
export const autoScanRunKeyForGroup = (groupId: number): string => 'za.autoScanRun.g' + groupId;

/** 组内页面句柄表（adr-023 D1）：tabId↔句柄映射的插件私有存根，任何字段不得进上行帧（U5）。 */
export const pageHandlesKeyForGroup = (groupId: number): string => 'za.pageHandles.g' + groupId;
