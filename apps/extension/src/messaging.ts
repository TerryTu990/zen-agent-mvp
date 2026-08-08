/**
 * content ↔ background 的 Port 内部消息（插件私有，不属 C3 契约）。
 * sessionId 由 background 唯一持有：content 只交原料，background 组 C3 上行帧。
 */
import type {
  DownstreamFrame,
  ExecResultFrame,
  ExecutionPreference,
  HitlDecisionValue,
  SnapshotReportFrame,
} from './frames.js';
import type { InjectionDescriptionView } from './injection-view.js';

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
  // navigate-request 的回执：ok 时 url 为新开页目标地址，供 content 组 exec-result。
  | { kind: 'navigate-result'; requestId: string; ok: boolean; url?: string; error?: string };

export type SidePanelToBackgroundMessage =
  | { kind: 'panel-bind'; groupId: number }
  | { kind: 'browsing-context'; groupId: number; url?: string; title?: string; assistable?: boolean }
  | { kind: 'user-message'; messageId: string; text: string; displayText?: string; executionPreference: ExecutionPreference }
  | { kind: 'hitl-decision'; hitlId: string; decision: HitlDecisionValue }
  // L2 草稿裁决（U8）：面板只回传 draftId+decision，change 不经客户端往返。
  | { kind: 'config-decision'; draftId: string; decision: 'accept' | 'reject' }
  // 注入透明视图取数：面板不持有会话与令牌，由 background 转发 GET /v1/sessions/:id/injection。
  | { kind: 'injection-request' }
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
  // 取数成功即带服务端原样描述；失败只带人读原因（不含令牌与栈细节，SEC-04）。
  | { kind: 'injection-result'; ok: true; description: InjectionDescriptionView }
  | { kind: 'injection-result'; ok: false; error: string }
  | { kind: 'stop-result'; messageId?: string; accepted: boolean }
  | { kind: 'operation-state'; running: boolean }
  | {
      kind: 'task-context';
      groupId: number;
      authorized: boolean;
      url?: string;
      title?: string;
      // 缺省视为可辅助：content 上报的 context-report 只来自站点页，无需带此标记。
      assistable?: boolean;
    };

/**
 * 激活握手的一次性 runtime 消息（不走 Port，经 chrome.runtime/tabs.sendMessage 单发）：
 * 显式发起模型下，content 加载不自动连会话，须经此握手由 background 决定是否激活（ADR-013 批次④ §5）。
 */
export type ContentRuntimeMessage =
  // content 加载完成：autoActivate 为该页 origin 是否命中 za.autoActivate 开关（配置级 dev/demo）。
  | { kind: 'request-activate'; autoActivate: boolean };

export type BackgroundRuntimeMessage =
  // background 决定激活：content 据此挂面板并连接会话端口。
  | { kind: 'activate' }
  // 同文档导航（pushState/replaceState 无对应 window 事件）后促使已激活页重报上下文：
  // content 隔离世界拦不到页面 history API，由 background 从 tabs.onUpdated 的 url 变更转发。
  | { kind: 'refresh-context' };
