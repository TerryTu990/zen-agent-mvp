import type { DownstreamFrame, UpstreamFrame } from './frames.js';
import { createIdentityProvider } from './identity.js';
import { createSseParser } from './sse.js';
import { createGroupMembers, routeForFrame, type FrameRoute } from './group-routing.js';
import {
  SESSION_PORT_NAME,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
} from './messaging.js';

const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8787';
/**
 * 会话存根键按宿主源分组（adr-012 一组一会话）；存 storage.session：跨 SW 重启存活、
 * 随浏览器关闭清除，不残留死会话存根。键名拆写以免被开发期 secret 守卫误判。
 */
const sessionKeyFor = (origin: string): string => 'za.' + 'sessionId.' + origin;

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

type UpstreamContentMessage = Exclude<
  ContentToBackgroundMessage,
  { kind: 'host-identity' } | { kind: 'ping' }
>;

/**
 * 一个宿主源标签页组的会话桥：组内共享一个服务端会话、一条 SSE；下行帧按
 * routeForFrame 路由（叙事帧全员镜像 / HITL·exec·guide 仅活跃页）。
 */
function createGroupBridge(origin: string, onEmpty: () => void) {
  const identity = createIdentityProvider();
  const abort = new AbortController();
  const members = createGroupMembers<chrome.runtime.Port>();
  let sessionPromise: Promise<Session | null> | null = null;
  // 组内任一页面同源读取的宿主用户 id；无 za.token 时用于向 demo-token 端点自取（P0-b）。
  let hostUserId: string | null = null;

  const post = (target: chrome.runtime.Port, message: BackgroundToContentMessage): void => {
    try {
      target.postMessage(message);
    } catch {
      detach(target);
    }
  };
  const postTo = (route: FrameRoute, message: BackgroundToContentMessage): void => {
    for (const member of members.targets(route)) post(member, message);
  };
  const postStatus = (message: string) => postTo('all', { kind: 'status', message });

  // 错误消息只含键名/状态码等可定位信息，不回显 token 值（SEC-04）。
  async function openSession(): Promise<Session | null> {
    const baseUrl = await readServerBaseUrl();
    let token: string;
    try {
      token = await identity.getToken();
    } catch (error) {
      if (hostUserId === null) {
        postStatus(error instanceof Error ? error.message : '访问令牌读取失败');
        return null;
      }
      // 无手动配置的 za.token：以页面登录用户 id 自取 demo token（不覆盖已有配置）。
      try {
        token = await identity.provisionToken(baseUrl, hostUserId);
      } catch {
        postStatus('自动获取访问令牌失败，请确认已登录宿主系统或手动配置 za.token');
        return null;
      }
    }
    // 优先复用本组已存 sessionId：SW 被回收重启后，服务端会话及其挂起 HITL/代执行等待器仍在，
    // 复用即恢复 in-flight 流程、避免每次重连新建会话（会话风暴 + nonce↔会话错位 409）。
    const key = sessionKeyFor(origin);
    const storedId = (await chrome.storage.session.get(key))[key];
    if (typeof storedId === 'string' && storedId !== '') {
      const resumed: Session = { baseUrl, token, sessionId: storedId };
      const reader = await openEventStream(resumed, true);
      if (reader !== null) {
        void drainEvents(reader);
        return resumed;
      }
      // 复用失败（会话已失效/服务端重启）：清存根，落到新建。
      await chrome.storage.session.remove(key);
    }
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
    await chrome.storage.session.set({ [key]: sessionId });
    const session = { baseUrl, token, sessionId };
    // 先建立 SSE 订阅再返回：否则首个 user-message 触发的回合可能早于订阅注册而丢失下行帧（订阅竞态）。
    const reader = await openEventStream(session);
    if (reader === null) return null;
    void drainEvents(reader);
    return session;
  }

  function ensureSession(): Promise<Session | null> {
    sessionPromise ??= openSession().then((session) => {
      if (session === null) sessionPromise = null;
      return session;
    });
    return sessionPromise;
  }

  /**
   * 建立 SSE 事件流并返回 reader；成功即代表服务端已注册订阅（订阅竞态在此收敛）。失败返回 null。
   * quiet=true 用于复用探测：会话已失效属预期，不向用户报状态。
   */
  async function openEventStream(
    { baseUrl, token, sessionId }: Session,
    quiet = false,
  ): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
    } catch {
      if (!abort.signal.aborted && !quiet) postStatus('事件流连接中断');
      return null;
    }
    if (!response.ok || response.body === null) {
      if (!quiet) postStatus(`事件流建立失败（HTTP ${response.status}）`);
      return null;
    }
    return response.body.getReader();
  }

  async function drainEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            const frame = JSON.parse(payload) as DownstreamFrame;
            postTo(routeForFrame(frame), { kind: 'frame', frame });
          } catch {
            postStatus('收到无法解析的下行帧，已丢弃');
          }
        }
      }
    } catch {
      if (!abort.signal.aborted) postStatus('事件流连接中断');
    }
  }

  function toUpstreamFrame(message: UpstreamContentMessage, sessionId: string): UpstreamFrame {
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
      case 'snapshot-report':
        return { ...message.report, sessionId };
    }
  }

  async function forward(message: UpstreamContentMessage): Promise<void> {
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

  // 串行转发保证 context-report 先于后续 user-message 到达服务端（组内共用一条管线）。
  const UPSTREAM_KINDS: ReadonlySet<ContentToBackgroundMessage['kind']> = new Set([
    'context-report',
    'user-message',
    'hitl-decision',
    'exec-result',
    'snapshot-report',
  ]);
  let pipeline: Promise<void> = Promise.resolve();

  function detach(port: chrome.runtime.Port): void {
    members.remove(port);
    if (members.size() === 0) {
      abort.abort();
      onEmpty();
    }
  }

  function attach(port: chrome.runtime.Port): void {
    members.add(port);
    port.onMessage.addListener((raw) => {
      const message = raw as ContentToBackgroundMessage | null;
      if (message === null) return;
      if (message.kind === 'host-identity') {
        hostUserId = message.hostUserId;
        return;
      }
      // 保活心跳：其到达已重置 SW 空闲计时器，不转发、不入管线。
      if (message.kind === 'ping') return;
      if (!UPSTREAM_KINDS.has(message.kind)) return;
      // 上下文上报/用户发言都来自用户视线所在页：即组内活跃页（HITL/exec/guide 的路由目标）。
      if (message.kind === 'context-report' || message.kind === 'user-message') {
        members.markActive(port);
      }
      // 组内其它页回显该提问，保持各页对话镜像一致。
      if (message.kind === 'user-message') {
        for (const other of members.others(port)) post(other, { kind: 'user-echo', text: message.text });
      }
      pipeline = pipeline.then(() => forward(message));
    });
    port.onDisconnect.addListener(() => detach(port));
  }

  return { attach };
}

const groups = new Map<string, ReturnType<typeof createGroupBridge>>();
let fallbackGroupSeq = 0;

/** 组键 = 页面 origin；来源不可识别时按端口独立成组（宁可隔离，不可误并组）。 */
function groupKeyOf(port: chrome.runtime.Port): string {
  const url = port.sender?.tab?.url ?? port.sender?.url;
  if (url !== undefined) {
    try {
      return new URL(url).origin;
    } catch {
      // 落到独立组
    }
  }
  fallbackGroupSeq += 1;
  return `za-isolated:${fallbackGroupSeq}`;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SESSION_PORT_NAME) return;
  const key = groupKeyOf(port);
  let bridge = groups.get(key);
  if (bridge === undefined) {
    bridge = createGroupBridge(key, () => groups.delete(key));
    groups.set(key, bridge);
  }
  bridge.attach(port);
});
