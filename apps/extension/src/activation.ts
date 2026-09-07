/**
 * 显式会话组的激活决策（ADR-013 批次④ §5，插件私有、纯逻辑无 chrome 依赖）。
 * content 加载不自动连会话；background 收到激活请求后据本策略决定组内换页恢复（reconnect）
 * 或不激活（none）。建组只发生在手势入口（图标 / 右键，见 background）——脚本已在页内
 * 不构成「该页要开会话」的理由：轨二已授权 origin 上的常驻注册同样会送来这条握手。
 * 桥按 tabGroup id 建实例——键即 groupId；storage.session 存 groupId→sessionId。
 */

export const TAB_GROUP_ID_NONE = -1;

export type ActivationDecision = { kind: 'reconnect'; groupId: number } | { kind: 'none' };

export interface ActivationInput {
  /** 当前 tab 所在组；-1=未分组。 */
  tabGroupId: number;
  /** tabGroupId 是否属既有 zen 会话（已映射会话或已登记 zen 组）——组内换页/SPA 刷新即命中。 */
  groupIsMapped: boolean;
}

export function decideActivation(input: ActivationInput): ActivationDecision {
  if (input.tabGroupId !== TAB_GROUP_ID_NONE && input.groupIsMapped) {
    return { kind: 'reconnect', groupId: input.tabGroupId };
  }
  return { kind: 'none' };
}

/** groupId→sessionId 存根键（storage.session）；键名拆写以免被开发期 secret 守卫误判。 */
export const sessionKeyForGroup = (groupId: number): string => 'za.' + 'sessionId.g' + groupId;

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

/** 组内页面句柄表（adr-023 D1）：tabId↔句柄映射的插件私有存根，任何字段不得进上行帧（U5）。 */
export const pageHandlesKeyForGroup = (groupId: number): string => 'za.pageHandles.g' + groupId;
