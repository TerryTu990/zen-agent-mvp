import type { DownstreamFrame, UpstreamFrame } from './frames.js';
import { createIdentityProvider } from './identity.js';
import { createSseParser } from './sse.js';
import {
  SESSION_PORT_NAME,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
} from './messaging.js';

const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8787';

interface Session {
  baseUrl: string;
  token: string;
  sessionId: string;
}

async function readServerBaseUrl(): Promise<string> {
  const items = await chrome.storage.local.get('za.serverBaseUrl');
  const value = items['za.serverBaseUrl'];
  return typeof value === 'string' && value !== '' ? value : DEFAULT_SERVER_BASE_URL;
}

function createSessionBridge(port: chrome.runtime.Port) {
  const identity = createIdentityProvider();
  const abort = new AbortController();
  let disposed = false;
  let sessionPromise: Promise<Session | null> | null = null;

  const post = (message: BackgroundToContentMessage) => {
    if (disposed) return;
    try {
      port.postMessage(message);
    } catch {
      disposed = true;
    }
  };
  const postStatus = (message: string) => post({ kind: 'status', message });

  // 错误消息只含键名/状态码等可定位信息，不回显 token 值（SEC-04）。
  async function openSession(): Promise<Session | null> {
    let token: string;
    try {
      token = await identity.getToken();
    } catch (error) {
      postStatus(error instanceof Error ? error.message : '访问令牌读取失败');
      return null;
    }
    const baseUrl = await readServerBaseUrl();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      postStatus(`无法连接 zen-agent 服务（${baseUrl}）`);
      return null;
    }
    if (response.status === 401) {
      postStatus('身份校验未通过（HTTP 401），请检查 za.token 配置');
      return null;
    }
    if (!response.ok) {
      postStatus(`会话创建失败（HTTP ${response.status}）`);
      return null;
    }
    const { sessionId } = (await response.json()) as { sessionId: string };
    const session = { baseUrl, token, sessionId };
    void pumpEvents(session);
    return session;
  }

  function ensureSession(): Promise<Session | null> {
    sessionPromise ??= openSession().then((session) => {
      if (session === null) sessionPromise = null;
      return session;
    });
    return sessionPromise;
  }

  async function pumpEvents({ baseUrl, token, sessionId }: Session): Promise<void> {
    try {
      const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
      if (!response.ok || response.body === null) {
        postStatus(`事件流建立失败（HTTP ${response.status}）`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            post({ kind: 'frame', frame: JSON.parse(payload) as DownstreamFrame });
          } catch {
            postStatus('收到无法解析的下行帧，已丢弃');
          }
        }
      }
    } catch {
      if (!disposed) postStatus('事件流连接中断');
    }
  }

  function toUpstreamFrame(message: ContentToBackgroundMessage, sessionId: string): UpstreamFrame {
    switch (message.kind) {
      case 'context-report':
        return { type: 'context-report', sessionId, url: message.url, title: message.title };
      case 'user-message':
        return { type: 'user-message', sessionId, text: message.text };
      case 'hitl-decision':
        return { type: 'hitl-decision', sessionId, hitlId: message.hitlId, decision: message.decision };
      case 'exec-result':
        // sessionId 权威归 background：以本会话盖章覆盖 content 侧原料值。
        return { ...message.result, sessionId };
    }
  }

  async function forward(message: ContentToBackgroundMessage): Promise<void> {
    const session = await ensureSession();
    if (session === null) return;
    const frame: UpstreamFrame = toUpstreamFrame(message, session.sessionId);
    try {
      const response = await fetch(`${session.baseUrl}/v1/sessions/${session.sessionId}/frames`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(frame),
      });
      if (response.status === 401) {
        postStatus('身份校验未通过（HTTP 401），请检查 za.token 配置');
      } else if (!response.ok) {
        postStatus(`上行帧被拒绝（HTTP ${response.status}）`);
      }
    } catch {
      postStatus(`无法连接 zen-agent 服务（${session.baseUrl}）`);
    }
  }

  // 串行转发保证 context-report 先于后续 user-message 到达服务端。
  const UPSTREAM_KINDS: ReadonlySet<ContentToBackgroundMessage['kind']> = new Set([
    'context-report',
    'user-message',
    'hitl-decision',
    'exec-result',
  ]);
  let pipeline: Promise<void> = Promise.resolve();
  port.onMessage.addListener((raw) => {
    const message = raw as ContentToBackgroundMessage | null;
    if (message === null || !UPSTREAM_KINDS.has(message.kind)) return;
    pipeline = pipeline.then(() => forward(message));
  });
  port.onDisconnect.addListener(() => {
    disposed = true;
    abort.abort();
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === SESSION_PORT_NAME) createSessionBridge(port);
});
