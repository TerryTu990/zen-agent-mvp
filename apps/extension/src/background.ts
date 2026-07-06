import type { DownstreamFrame, UpstreamFrame } from './frames.js';
import { createIdentityProvider } from './identity.js';
import { createSseParser } from './sse.js';
import { createGroupMembers, routeForFrame, type FrameRoute } from './group-routing.js';
import {
  decideActivation,
  sessionKeyForGroup,
  autoGroupKey,
  TAB_GROUP_ID_NONE,
} from './activation.js';
import {
  SESSION_PORT_NAME,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
  type ContentRuntimeMessage,
  type BackgroundRuntimeMessage,
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

/** groupId→sessionId 存根是否存在：判定某组是否已是 zen 会话组（激活决策与 onUpdated 复用）。 */
async function isGroupMapped(groupId: number): Promise<boolean> {
  const key = sessionKeyForGroup(groupId);
  const stored = (await chrome.storage.session.get(key))[key];
  return typeof stored === 'string' && stored !== '';
}

function originOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type UpstreamContentMessage = Exclude<
  ContentToBackgroundMessage,
  { kind: 'host-identity' } | { kind: 'ping' } | { kind: 'navigate-request' }
>;

/**
 * 一个 zen 标签页组的会话桥（ADR-013 批次④：键=tabGroup id，组内共享一个服务端会话、一条 SSE）；
 * 下行帧按 routeForFrame 路由（叙事帧全员镜像 / HITL·exec·guide 仅活跃页）。
 */
function createGroupBridge(groupId: number, onEmpty: () => void) {
  const identity = createIdentityProvider();
  const abort = new AbortController();
  const members = createGroupMembers<chrome.runtime.Port>();
  let sessionPromise: Promise<Session | null> | null = null;
  // 组内任一页面同源读取的宿主用户 id；无 za.token 时用于向 demo-token 端点自取（P0-b）。
  let hostUserId: string | null = null;
  // navigate 新开页的 tabId：其端口接入时标为活跃页，使后续 exec/HITL 路由随导航跟到新站点页。
  let expectedActiveTabId: number | null = null;

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
    const key = sessionKeyForGroup(groupId);
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

  /**
   * navigate 代执行（ADR-013 批次④）：在本组窗口开目标页并入本组，标其为待激活的活跃页。
   * 入组触发 tabs.onUpdated → 新页收 activate 后接入同一会话（组内换站会话延续）。
   * 客户端零治理：url 已由服务端签发前校验落在某已安装 pack site 围栏内（U7），此处只执行。
   */
  async function handleNavigate(
    port: chrome.runtime.Port,
    request: Extract<ContentToBackgroundMessage, { kind: 'navigate-request' }>,
  ): Promise<void> {
    const windowId = port.sender?.tab?.windowId;
    try {
      const created = await chrome.tabs.create({
        url: request.url,
        ...(windowId !== undefined ? { windowId } : {}),
        active: true,
      });
      if (created.id !== undefined) {
        await chrome.tabs.group({ tabIds: created.id, groupId });
        expectedActiveTabId = created.id;
        // 主动通知新页激活（content 已加载时即接入）；未加载时其自身 request-activate 走 reconnect 兜底。
        void sendActivate(created.id);
      }
      post(port, { kind: 'navigate-result', requestId: request.requestId, ok: true, url: request.url });
    } catch {
      post(port, {
        kind: 'navigate-result',
        requestId: request.requestId,
        ok: false,
        error: 'navigate-open-failed',
      });
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
    if (members.size() === 0) close();
  }

  /** 桥关闭：中止 SSE 并从组表移除；storage.session 存根不清（供组内换页重连恢复，见 openSession）。 */
  function close(): void {
    if (!abort.signal.aborted) abort.abort();
    onEmpty();
  }

  function attach(port: chrome.runtime.Port): void {
    members.add(port);
    // navigate 新开页接入即标为活跃：后续 exec/HITL 路由跟随导航到新站点页。
    if (expectedActiveTabId !== null && port.sender?.tab?.id === expectedActiveTabId) {
      members.markActive(port);
      expectedActiveTabId = null;
    }
    port.onMessage.addListener((raw) => {
      const message = raw as ContentToBackgroundMessage | null;
      if (message === null) return;
      if (message.kind === 'host-identity') {
        hostUserId = message.hostUserId;
        return;
      }
      // navigate 代执行请求：本地处理（开页入组），不进上行转发管线。
      if (message.kind === 'navigate-request') {
        void handleNavigate(port, message);
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

  return { attach, close };
}

type GroupBridge = ReturnType<typeof createGroupBridge>;
const groups = new Map<number, GroupBridge>();
let isolatedSeq = TAB_GROUP_ID_NONE;

/**
 * 组键 = 页面所在 tabGroup id（显式发起模型：端口只在被激活入组后连接，故 groupId 有效）。
 * 极端情形（无法识别所属组）按端口独立成负数键，宁可隔离不可误并组。
 */
function groupIdOf(port: chrome.runtime.Port): number {
  const gid = port.sender?.tab?.groupId;
  if (typeof gid === 'number' && gid !== TAB_GROUP_ID_NONE) return gid;
  isolatedSeq -= 1;
  return isolatedSeq;
}

function bridgeFor(groupId: number): GroupBridge {
  let bridge = groups.get(groupId);
  if (bridge === undefined) {
    bridge = createGroupBridge(groupId, () => groups.delete(groupId));
    groups.set(groupId, bridge);
  }
  return bridge;
}

async function sendActivate(tabId: number): Promise<void> {
  const message: BackgroundRuntimeMessage = { kind: 'activate' };
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

/** 新建 zen 标签页组并命名（同 origin 多组各自独立）；返回新组 id。 */
async function createZenGroup(tabId: number): Promise<number> {
  const groupId = await chrome.tabs.group({ tabIds: tabId });
  await chrome.tabGroups.update(groupId, { title: 'zen', color: 'purple' }).catch(() => {});
  return groupId;
}

/** 同窗同源 autoActivate 既有组（须仍映射会话）：供 autoJoin，避免既有多页场景重复建组。 */
async function findAutoJoinGroup(windowId: number, origin: string): Promise<number | null> {
  const key = autoGroupKey(windowId, origin);
  const stored = (await chrome.storage.session.get(key))[key];
  if (typeof stored !== 'number') return null;
  return (await isGroupMapped(stored)) ? stored : null;
}

/**
 * content 加载后的激活握手：按 decideActivation 决定组内换页恢复 / autoActivate 加入既有组 / 新建组 / 不激活。
 * 决策后统一以 chrome.tabs.sendMessage 通知该页挂面板连接（content 侧 activate 幂等）。
 */
async function handleRequestActivate(
  request: ContentRuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  const origin = originOf(tab.url);
  const groupIsMapped = tabGroupId !== TAB_GROUP_ID_NONE && (await isGroupMapped(tabGroupId));
  let autoJoinGroupId: number | null = null;
  if (request.autoActivate && origin !== null && tab.windowId !== undefined) {
    autoJoinGroupId = await findAutoJoinGroup(tab.windowId, origin);
  }
  const decision = decideActivation({
    tabGroupId,
    groupIsMapped,
    autoActivate: request.autoActivate,
    autoJoinGroupId,
  });
  switch (decision.kind) {
    case 'none':
      return;
    case 'reconnect':
      break;
    case 'join':
      await chrome.tabs.group({ tabIds: tabId, groupId: decision.groupId }).catch(() => {});
      break;
    case 'create': {
      // tab 已属某标签组（用户既有分组，或宿主自动化的受控组）则采用该组当会话组——
      // 会话键即 tabGroup id（groupIdOf），无需夺 tab 新建；仅未分组 tab 才建 zen 组。
      const groupId = tabGroupId !== TAB_GROUP_ID_NONE ? tabGroupId : await createZenGroup(tabId);
      if (origin !== null && tab.windowId !== undefined) {
        await chrome.storage.session.set({ [autoGroupKey(tab.windowId, origin)]: groupId });
      }
      break;
    }
  }
  await sendActivate(tabId);
}

/** 图标点击：未分组 tab 新建独立 zen 组（同 origin 多组独立）；已属某组则采用该组当会话组。 */
async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  if (tabGroupId === TAB_GROUP_ID_NONE) {
    await createZenGroup(tab.id);
  }
  await sendActivate(tab.id);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SESSION_PORT_NAME) return;
  bridgeFor(groupIdOf(port)).attach(port);
});

chrome.runtime.onMessage.addListener((raw, sender) => {
  const message = raw as ContentRuntimeMessage | null;
  if (message?.kind === 'request-activate') void handleRequestActivate(message, sender);
});

chrome.action.onClicked.addListener((tab) => {
  void handleIconClick(tab);
});

// 拖 tab 入某 zen 会话组（groupId 变为已映射组）→ 通知该页激活并接入同一会话。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const groupId = changeInfo.groupId;
  if (groupId === undefined || groupId === TAB_GROUP_ID_NONE) return;
  void isGroupMapped(groupId).then((mapped) => {
    if (mapped) void sendActivate(tabId);
  });
});

// 组关闭=关会话：清 groupId→sessionId 存根并关桥（storage.session 存根在此才清，区别于组内换页重连）。
chrome.tabGroups.onRemoved.addListener((group) => {
  void chrome.storage.session.remove(sessionKeyForGroup(group.id)).catch(() => {});
  const bridge = groups.get(group.id);
  if (bridge !== undefined) {
    bridge.close();
    groups.delete(group.id);
  }
});
