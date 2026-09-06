/**
 * content ↔ background 的 Port 内部消息（插件私有，不属 C3 契约）。
 * sessionId 由 background 唯一持有：content 只交原料，background 组 C3 上行帧。
 */
import type { QuickActionView } from './quick-actions.js';
import type {
  DownstreamFrame,
  ExecResultFrame,
  ExecutionPreference,
  HitlDecisionValue,
  SnapshotReportFrame,
} from './frames.js';

export type SidePanelUiEvent =
  | {
      kind: 'frame';
      frame: Extract<DownstreamFrame, { type: 'text-delta' | 'turn-complete' | 'tool-card' | 'hitl-request' | 'config-draft' }>;
    }
  | { kind: 'status'; message: string }
  | { kind: 'user-echo'; text: string; messageId?: string };

export const SESSION_PORT_NAME = 'za-session';
export const SIDE_PANEL_PORT_NAME = 'za-side-panel';

export type MessageDeliveryFailure =
  // 本机站点黑名单闸门拦下：该帧所属页面在用户的「不辅助的站点」名单内，未出本机。
  | 'site-denied'
  | 'configuration'
  | 'unauthorized'
  | 'session-expired'
  | 'session-interrupted'
  | 'protocol-invalid'
  | 'delivery-unknown'
  | 'server-rejected'
  | 'unreachable'
  | 'session-unavailable';

export type ContentToBackgroundMessage =
  | { kind: 'context-report'; url: string; title: string }
  // content 在页面环境代执行后回传整帧；sessionId 权威仍由 background 组帧时盖章。
  | { kind: 'exec-result'; result: ExecResultFrame }
  // 页面快照上报（dom 代操作观察半程）；sessionId 同样由 background 盖章。
  | { kind: 'snapshot-report'; report: SnapshotReportFrame }
  // navigate 代执行（ADR-013 批次④）：dom 批次遇 navigate 步请 background 在本组窗口开目标页并入组；
  // requestId 关联 navigate-result 回执，不进上行转发管线。
  | { kind: 'navigate-request'; requestId: string; url: string }
  | { kind: 'page-status'; message: string }
  | { kind: 'operation-state'; running: boolean }
  // 保活心跳：仅靠端口消息的到达重置 MV3 service worker 空闲计时器，background 不处理内容。
  | { kind: 'ping' };

export type BackgroundToContentMessage =
  | { kind: 'frame'; frame: DownstreamFrame }
  | { kind: 'stop-operation' }
  // 新回合开始：解除页面侧的停止闩。停止是回合级事实，闩在一次停止后保持置位，
  // 只有这条显式信号（用户发新消息 / 自动回合起跑）才复位它。
  | { kind: 'resume-operation' }
  // navigate-request 的回执：ok 时 url 为新开页目标地址，供 content 组 exec-result。
  | { kind: 'navigate-result'; requestId: string; ok: boolean; url?: string; error?: string };

export type SidePanelToBackgroundMessage =
  | { kind: 'panel-bind'; groupId: number }
  | { kind: 'browsing-context'; groupId: number; url?: string; title?: string }
  | {
      kind: 'user-message';
      messageId: string;
      text: string;
      displayText?: string;
      executionPreference: ExecutionPreference;
      /** 本轮由快捷提问发起：模板由服务端查表展开，面板只发 id（不持模板副本）。 */
      quickActionId?: string;
      /** 随快捷提问带上的页面选区正文；仅右键入口会带。 */
      selectionText?: string;
    }
  | { kind: 'hitl-decision'; hitlId: string; decision: HitlDecisionValue }
  // L2 草稿裁决（U8）：面板只回传 draftId+decision，change 不经客户端往返。
  | { kind: 'config-decision'; draftId: string; decision: 'accept' | 'reject' }
  // 快捷提问 chips 取数：面板不持有会话与令牌，由 background 合并 /v1/packs 与 /v1/user-config 后回投影。
  // siteDenied = 本机确实跳过了这一页的激活（面板持有该事实）：background 据此连会话都不建。
  | { kind: 'quick-actions-request'; siteDenied: boolean }
  | { kind: 'stop-operation'; messageId?: string }
  | { kind: 'ping' };

export type BackgroundToSidePanelMessage =
  | SidePanelUiEvent
  | { kind: 'history-replay'; events: SidePanelUiEvent[] }
  | { kind: 'panel-ready' }
  | { kind: 'session-failed'; failure: MessageDeliveryFailure }
  | {
      kind: 'message-result';
      messageId: string;
      accepted: boolean;
      failure?: MessageDeliveryFailure;
      httpStatus?: number;
    }
  | { kind: 'hitl-result'; hitlId: string; accepted: boolean }
  // 右键「用 Zen 讲解选中内容」：选区原文送面板输入框，由用户补充意图后自行发送。
  | { kind: 'compose-quote'; text: string }
  // 本页可呈现的快捷提问清单（合并 L1/L2 后的投影，不含模板）；空数组 = 本页没有可呈现的条目。
  | { kind: 'quick-actions'; actions: QuickActionView[] }
  // 右键选中某条快捷提问：面板按普通用户消息路径发出（本地回声/停止/幂等全部复用）。
  | { kind: 'compose-quick-action'; actionId: string; label: string; selectionText: string }
  | { kind: 'stop-result'; messageId?: string; accepted: boolean }
  | { kind: 'operation-state'; running: boolean }
  | {
      kind: 'task-context';
      groupId: number;
      authorized: boolean;
      url?: string;
      title?: string;
    };

/**
 * 激活握手的一次性 runtime 消息（不走 Port，经 chrome.runtime/tabs.sendMessage 单发）：
 * 显式发起模型下，content 加载不自动连会话，须经此握手由 background 决定是否激活（ADR-013 批次④ §5）。
 */
export type ContentRuntimeMessage =
  // content 加载完成（adr-027：脚本出现在本页即 background 注入或已授权 origin 的动态注册所致）。
  | { kind: 'request-activate' };

export type BackgroundRuntimeMessage =
  // background 决定激活：content 据此挂面板并连接会话端口。
  | { kind: 'activate' }
  // 同文档导航（pushState/replaceState 无对应 window 事件）后促使已激活页重报上下文：
  // content 隔离世界拦不到页面 history API，由 background 从 tabs.onUpdated 的 url 变更转发。
  | { kind: 'refresh-context' };
