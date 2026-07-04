/**
 * content ↔ background 的 Port 内部消息（插件私有，不属 C3 契约）。
 * sessionId 由 background 唯一持有：content 只交原料，background 组 C3 上行帧。
 */
import type { DownstreamFrame } from './frames.js';

export const SESSION_PORT_NAME = 'za-session';

export type ContentToBackgroundMessage =
  | { kind: 'context-report'; url: string; title: string }
  | { kind: 'user-message'; text: string };

export type BackgroundToContentMessage =
  | { kind: 'frame'; frame: DownstreamFrame }
  | { kind: 'status'; message: string };
