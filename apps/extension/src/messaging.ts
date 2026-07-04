/**
 * content ↔ background 的 Port 内部消息（插件私有，不属 C3 契约）。
 * sessionId 由 background 唯一持有：content 只交原料，background 组 C3 上行帧。
 */
import type { DownstreamFrame, ExecResultFrame, HitlDecisionValue } from './frames.js';

export const SESSION_PORT_NAME = 'za-session';

export type ContentToBackgroundMessage =
  | { kind: 'context-report'; url: string; title: string }
  | { kind: 'user-message'; text: string }
  | { kind: 'hitl-decision'; hitlId: string; decision: HitlDecisionValue }
  // content 在页面环境代执行后回传整帧；sessionId 权威仍由 background 组帧时盖章。
  | { kind: 'exec-result'; result: ExecResultFrame };

export type BackgroundToContentMessage =
  | { kind: 'frame'; frame: DownstreamFrame }
  | { kind: 'status'; message: string };
