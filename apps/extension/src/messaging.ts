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

export type SidePanelUiEvent =
  | {
      kind: 'frame';
      frame: Extract<DownstreamFrame, { type: 'text-delta' | 'tool-card' | 'hitl-request' }>;
    }
  | { kind: 'status'; message: string }
  | { kind: 'user-echo'; text: string };

export const SESSION_PORT_NAME = 'za-session';
export const SIDE_PANEL_PORT_NAME = 'za-side-panel';

export type ContentToBackgroundMessage =
  | { kind: 'context-report'; url: string; title: string }
  // content 在页面环境代执行后回传整帧；sessionId 权威仍由 background 组帧时盖章。
  | { kind: 'exec-result'; result: ExecResultFrame }
  // 页面快照上报（dom 代操作观察半程）；sessionId 同样由 background 盖章。
  | { kind: 'snapshot-report'; report: SnapshotReportFrame }
  // 页面同源读取的宿主用户 id（P0-b 自取 token 用），非 C3 上行帧、不进转发管线。
  | { kind: 'host-identity'; hostUserId: string }
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
  | { kind: 'browsing-context'; groupId: number; url?: string; title?: string }
  | { kind: 'user-message'; text: string; executionPreference: ExecutionPreference }
  | { kind: 'hitl-decision'; hitlId: string; decision: HitlDecisionValue }
  | { kind: 'stop-operation' }
  | { kind: 'ping' };

export type BackgroundToSidePanelMessage =
  | SidePanelUiEvent
  | { kind: 'history-replay'; events: SidePanelUiEvent[] }
  | { kind: 'panel-ready' }
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
  // content 加载完成：autoActivate 为该页 origin 是否命中 za.autoActivate 开关（配置级 dev/demo）。
  | { kind: 'request-activate'; autoActivate: boolean };

export type BackgroundRuntimeMessage =
  // background 决定激活：content 据此挂面板并连接会话端口。
  | { kind: 'activate' };
