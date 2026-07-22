import type { DownstreamFrame, UpstreamFrame } from './frames.js';
import { createIdentityProvider } from './identity.js';
import { createSseParser } from './sse.js';
import { createGroupMembers, routeForFrame, type FrameRoute } from './group-routing.js';
import {
  decideActivation,
  sessionKeyForGroup,
  autoGroupKey,
  panelGroupKey,
  panelHistoryKeyForGroup,
  execNonceKeyForGroup,
  xianyuAutoScanRunKeyForGroup,
  TAB_GROUP_ID_NONE,
} from './activation.js';
import {
  SESSION_PORT_NAME,
  SIDE_PANEL_PORT_NAME,
  type BackgroundToSidePanelMessage,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
  type SidePanelToBackgroundMessage,
  type SidePanelUiEvent,
  type ContentRuntimeMessage,
  type BackgroundRuntimeMessage,
} from './messaging.js';
import { reducePanelHistory, removeSettledHitl } from './panel-history.js';
import { verifyExecInstruction } from './exec-verification.js';
import { normalizeTrustedServerBaseUrl } from './server-url.js';
import {
  isXianyuAutoScanWorkPage,
  isXianyuAutoScanCompletion,
  decideAutoScanRecovery,
  autoScanDispatch,
  type AutoScanRecoveryStatus,
  normalizeAutoScanMinutes,
  shouldPauseXianyuAutoScan,
  XIANYU_AUTO_SCAN_ALARM,
  XIANYU_AUTO_SCAN_ENABLED_KEY,
  XIANYU_AUTO_SCAN_MINUTES_KEY,
} from './xianyu-auto-scan.js';

// 服务端地址缺省值：发布构建经 esbuild --define 注入生产地址（release/build-extension.sh），
// 开发构建回退本机；chrome.storage 的 za.serverBaseUrl 仍可覆盖（调试用）。
declare const __ZA_SERVER_BASE_URL__: string | undefined;
const DEFAULT_SERVER_BASE_URL =
  typeof __ZA_SERVER_BASE_URL__ === 'string' && __ZA_SERVER_BASE_URL__ !== ''
    ? __ZA_SERVER_BASE_URL__
    : 'http://127.0.0.1:8787';

interface Session {
  baseUrl: string;
  token: string;
  sessionId: string;
}

interface EventStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  execPublicKey: string;
  expectedSessionId: string;
}

async function readServerBaseUrl(): Promise<string> {
  const items = await chrome.storage.local.get('za.serverBaseUrl');
  const value = items['za.serverBaseUrl'];
  const configured = typeof value === 'string' && value !== '' ? value : DEFAULT_SERVER_BASE_URL;
  const trusted = normalizeTrustedServerBaseUrl(configured);
  if (trusted === null) throw new Error('生产服务地址必须使用 HTTPS（仅 localhost/127.0.0.1 允许 HTTP）');
  return trusted;
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
  | { kind: 'host-identity' }
  | { kind: 'ping' }
  | { kind: 'navigate-request' }
  | { kind: 'page-status' }
  | { kind: 'operation-state' }
>;

type UpstreamPanelMessage = Extract<
  SidePanelToBackgroundMessage,
  { kind: 'user-message' | 'hitl-decision' }
>;

interface AutoScanMessage {
  kind: 'auto-scan';
  text: string;
  executionPreference: 'dom-only';
  automationRunId: string;
}

/**
 * 一个 zen 标签页组的会话桥（ADR-013 批次④：键=tabGroup id，组内共享一个服务端会话、一条 SSE）；
 * 下行帧按 routeForFrame 路由（叙事/HITL → Side Panel；exec/guide/snapshot → 活跃执行页）。
 */
function createGroupBridge(groupId: number, onEmpty: () => void) {
  const identity = createIdentityProvider();
  const abort = new AbortController();
  const contentMembers = createGroupMembers<chrome.runtime.Port>();
  const panels = new Set<chrome.runtime.Port>();
  const pendingPanels = new Set<chrome.runtime.Port>();
  let panelHistory: SidePanelUiEvent[] = [];
  const historyKey = panelHistoryKeyForGroup(groupId);
  const nonceKey = execNonceKeyForGroup(groupId);
  const autoScanRunKey = xianyuAutoScanRunKeyForGroup(groupId);
  const seenExecNonces = new Set<string>();
  let nonceHistory: Array<{ nonce: string; expiresAt: number }> = [];
  const nonceHistoryReady = chrome.storage.session.get(nonceKey).then((items) => {
    const stored = items[nonceKey];
    if (!Array.isArray(stored)) return;
    nonceHistory = stored.filter(
      (item): item is { nonce: string; expiresAt: number } =>
        typeof item === 'object' &&
        item !== null &&
        'nonce' in item &&
        typeof item.nonce === 'string' &&
        'expiresAt' in item &&
        typeof item.expiresAt === 'number' &&
        item.expiresAt >= Date.now(),
    );
    for (const entry of nonceHistory) seenExecNonces.add(entry.nonce);
  });
  let historyChain = chrome.storage.session.get(historyKey).then((items) => {
    const stored = items[historyKey];
    if (Array.isArray(stored)) panelHistory = stored as SidePanelUiEvent[];
  });
  let sessionPromise: Promise<Session | null> | null = null;
  // 组内任一页面同源读取的宿主用户 id；无 za.token 时用于向 demo-token 端点自取（P0-b）。
  let hostUserId: string | null = null;
  // navigate 新开页的 tabId：其端口接入时标为活跃页，使后续 exec/HITL 路由随导航跟到新站点页。
  let expectedActiveTabId: number | null = null;
  let autoScanRunId: string | null = null;
  const autoScanRunReady = chrome.storage.session.get(autoScanRunKey).then((items) => {
    const stored = items[autoScanRunKey];
    if (typeof stored === 'string' && stored !== '') autoScanRunId = stored;
  });

  const postContent = (target: chrome.runtime.Port, message: BackgroundToContentMessage): void => {
    try {
      target.postMessage(message);
    } catch {
      detachContent(target);
    }
  };
  const postPanel = (target: chrome.runtime.Port, message: BackgroundToSidePanelMessage): void => {
    try {
      target.postMessage(message);
    } catch {
      detachPanel(target);
    }
  };
  const postToPanels = (message: BackgroundToSidePanelMessage): void => {
    for (const panel of panels) postPanel(panel, message);
  };
  const updateHistory = (update: (history: SidePanelUiEvent[]) => SidePanelUiEvent[]): void => {
    historyChain = historyChain.then(async () => {
      panelHistory = update(panelHistory);
      await chrome.storage.session.set({ [historyKey]: panelHistory });
    });
  };
  const emitUi = (event: SidePanelUiEvent): void => {
    updateHistory((history) => reducePanelHistory(history, event));
    postToPanels(event);
  };
  const postFrame = (route: FrameRoute, frame: DownstreamFrame): void => {
    if (isXianyuAutoScanCompletion(autoScanRunId, frame)) {
      const failed = frame.type === 'tool-card' && frame.status === 'failed';
      autoScanRunId = null;
      void chrome.storage.session.remove(autoScanRunKey);
      if (failed) {
        void chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
        postStatus('闲鱼自动履约回合异常结束，扫描已暂停。');
      }
      return;
    }
    if (shouldPauseXianyuAutoScan(autoScanRunId, frame)) {
      void chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
      postStatus('闲鱼自动履约已因异常暂停；核对页面、库存与策略后可在设置页重新启用。');
      if (frame.type === 'hitl-request') {
        // 自动回合本不应进入人工确认；安全拒绝可让服务端回合收尾并发出明确完成帧，避免单飞锁悬挂。
        pipeline = pipeline.then(async () => {
          await forward({ kind: 'hitl-decision', hitlId: frame.hitlId, decision: 'reject' });
        });
      }
    }
    if (route === 'panel') {
      if (frame.type === 'text-delta' || frame.type === 'tool-card' || frame.type === 'hitl-request') {
        emitUi({ kind: 'frame', frame });
      }
      return;
    }
    for (const member of contentMembers.targets('active-page')) {
      postContent(member, { kind: 'frame', frame });
    }
  };
  const postStatus = (message: string): void => emitUi({ kind: 'status', message });

  // 错误消息只含键名/状态码等可定位信息，不回显 token 值（SEC-04）。
  async function openSession(): Promise<Session | null> {
    let baseUrl: string;
    try {
      baseUrl = await readServerBaseUrl();
    } catch (error) {
      postStatus(error instanceof Error ? error.message : '服务地址配置无效');
      return null;
    }
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
      const stream = await openEventStream(resumed, true);
      if (stream !== null) {
        void drainEvents(stream);
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
    const stream = await openEventStream(session);
    if (stream === null) return null;
    void drainEvents(stream);
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
  ): Promise<EventStream | null> {
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
    const algorithm = response.headers.get('x-zen-agent-exec-algorithm');
    const execPublicKey = response.headers.get('x-zen-agent-exec-public-key');
    if (!response.ok || response.body === null || algorithm !== 'Ed25519' || !execPublicKey) {
      if (!quiet) postStatus(`事件流建立失败（HTTP ${response.status}）`);
      return null;
    }
    return { reader: response.body.getReader(), execPublicKey, expectedSessionId: sessionId };
  }

  async function drainEvents({ reader, execPublicKey, expectedSessionId }: EventStream): Promise<void> {
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            const frame = JSON.parse(payload) as DownstreamFrame;
            if (frame.type === 'exec-instruction') {
              await nonceHistoryReady;
              const verified = await verifyExecInstruction(
                frame,
                execPublicKey,
                seenExecNonces,
                expectedSessionId,
              );
              if (!verified.ok) {
                void forward({
                  kind: 'exec-result',
                  result: {
                    type: 'exec-result',
                    sessionId: frame.sessionId,
                    nonce: frame.nonce,
                    ok: false,
                    error: verified.error,
                  },
                });
                continue;
              }
              nonceHistory = nonceHistory.filter((entry) => entry.expiresAt >= Date.now());
              nonceHistory.push({ nonce: frame.nonce, expiresAt: frame.expiresAt });
              try {
                await chrome.storage.session.set({ [nonceKey]: nonceHistory });
              } catch {
                seenExecNonces.delete(frame.nonce);
                void forward({
                  kind: 'exec-result',
                  result: {
                    type: 'exec-result',
                    sessionId: frame.sessionId,
                    nonce: frame.nonce,
                    ok: false,
                    error: 'instruction-nonce-store-failed',
                  },
                });
                continue;
              }
            }
            postFrame(routeForFrame(frame), frame);
          } catch {
            postStatus('收到无法解析的下行帧，已丢弃');
          }
        }
      }
    } catch {
      if (!abort.signal.aborted) postStatus('事件流连接中断');
    }
  }

  function toUpstreamFrame(
    message: UpstreamContentMessage | UpstreamPanelMessage | AutoScanMessage,
    sessionId: string,
  ): UpstreamFrame {
    switch (message.kind) {
      case 'context-report':
        return { type: 'context-report', sessionId, url: message.url, title: message.title };
      case 'user-message':
        return {
          type: 'user-message',
          sessionId,
          text: message.text,
          executionPreference: message.executionPreference,
        };
      case 'auto-scan':
        return {
          type: 'user-message',
          sessionId,
          text: message.text,
          executionPreference: message.executionPreference,
          automationRunId: message.automationRunId,
        };
      case 'hitl-decision':
        return { type: 'hitl-decision', sessionId, hitlId: message.hitlId, decision: message.decision };
      case 'exec-result':
        // sessionId 权威归 background：以本会话盖章覆盖 content 侧原料值。
        return { ...message.result, sessionId };
      case 'snapshot-report':
        return { ...message.report, sessionId };
    }
  }

  async function forward(message: UpstreamContentMessage | UpstreamPanelMessage | AutoScanMessage): Promise<boolean> {
    const session = await ensureSession();
    if (session === null) return false;
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
      return response.ok;
    } catch {
      postStatus(`无法连接 zen-agent 服务（${session.baseUrl}）`);
      return false;
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
      postContent(port, { kind: 'navigate-result', requestId: request.requestId, ok: true, url: request.url });
    } catch {
      postContent(port, {
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
    'exec-result',
    'snapshot-report',
  ]);
  let pipeline: Promise<void> = Promise.resolve();

  function maybeClose(): void {
    if (contentMembers.size() === 0 && panels.size === 0) close();
  }

  function detachContent(port: chrome.runtime.Port): void {
    contentMembers.remove(port);
    maybeClose();
  }

  function detachPanel(port: chrome.runtime.Port): void {
    panels.delete(port);
    pendingPanels.delete(port);
    maybeClose();
  }

  /** 桥关闭：中止 SSE 并从组表移除；storage.session 存根不清（供组内换页重连恢复，见 openSession）。 */
  function close(): void {
    if (!abort.signal.aborted) abort.abort();
    onEmpty();
  }

  function attachContent(port: chrome.runtime.Port): void {
    contentMembers.add(port);
    // navigate 新开页接入即标为活跃：后续 exec/HITL 路由跟随导航到新站点页。
    if (expectedActiveTabId !== null && port.sender?.tab?.id === expectedActiveTabId) {
      contentMembers.markActive(port);
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
      if (message.kind === 'page-status') {
        postStatus(message.message);
        return;
      }
      if (message.kind === 'operation-state') {
        postToPanels(message);
        return;
      }
      // 保活心跳：其到达已重置 SW 空闲计时器，不转发、不入管线。
      if (message.kind === 'ping') return;
      if (!UPSTREAM_KINDS.has(message.kind)) return;
      // 上下文上报/用户发言都来自用户视线所在页：即组内活跃页（HITL/exec/guide 的路由目标）。
      if (message.kind === 'context-report') {
        contentMembers.markActive(port);
        postToPanels({
          kind: 'task-context',
          groupId,
          authorized: true,
          url: message.url,
          ...(message.title !== '' ? { title: message.title } : {}),
        });
      }
      pipeline = pipeline.then(async () => { await forward(message); });
    });
    port.onDisconnect.addListener(() => detachContent(port));
  }

  function attachPanel(port: chrome.runtime.Port): void {
    pendingPanels.add(port);
    const finishAttach = (): void => {
      const observed = historyChain;
      void observed.then(() => {
        if (!pendingPanels.has(port)) return;
        if (observed !== historyChain) {
          finishAttach();
          return;
        }
        postPanel(port, { kind: 'history-replay', events: panelHistory });
        pendingPanels.delete(port);
        panels.add(port);
        postPanel(port, { kind: 'panel-ready' });
      });
    };
    finishAttach();
    port.onMessage.addListener((raw) => {
      const message = raw as SidePanelToBackgroundMessage | null;
      if (message === null || message.kind === 'panel-bind' || message.kind === 'ping') return;
      if (message.kind === 'browsing-context') {
        postPanel(port, {
          kind: 'task-context',
          groupId,
          authorized: message.groupId === groupId,
          ...(message.url !== undefined ? { url: message.url } : {}),
          ...(message.title !== undefined ? { title: message.title } : {}),
        });
        return;
      }
      if (message.kind === 'stop-operation') {
        void chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
        postStatus('已停止当前操作并关闭闲鱼自动履约扫描。');
        for (const member of contentMembers.targets('active-page')) {
          postContent(member, { kind: 'stop-operation' });
        }
        return;
      }
      if (message.kind === 'user-message') emitUi({ kind: 'user-echo', text: message.text });
      if (message.kind === 'hitl-decision') {
        updateHistory((history) => removeSettledHitl(history, message.hitlId));
      }
      pipeline = pipeline.then(async () => { await forward(message); });
    });
    port.onDisconnect.addListener(() => detachPanel(port));
  }

  async function recoverAutoScanRun(runId: string): Promise<'busy' | 'settled' | 'paused'> {
    const session = await ensureSession();
    let status: AutoScanRecoveryStatus = 'unavailable';
    if (session !== null) {
      try {
        const response = await fetch(
          `${session.baseUrl}/v1/sessions/${session.sessionId}/automation-runs/${encodeURIComponent(runId)}`,
          { headers: { authorization: `Bearer ${session.token}` } },
        );
        if (response.status === 404) status = 'missing';
        else if (response.ok) {
          const body = await response.json() as { status?: unknown };
          if (body.status === 'running' || body.status === 'succeeded' || body.status === 'failed') {
            status = body.status;
          }
        }
      } catch {
        status = 'unavailable';
      }
    }
    const decision = decideAutoScanRecovery(status);
    if (decision === 'keep-busy') return 'busy';
    if (autoScanRunId === runId) {
      autoScanRunId = null;
      await chrome.storage.session.remove(autoScanRunKey);
    }
    if (decision === 'release-and-pause') {
      await chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
      postStatus('闲鱼自动履约上次回合状态异常，扫描已暂停。');
      return 'paused';
    }
    return 'settled';
  }

  async function triggerAutoScan(tabId: number, tabUrl: string, tabTitle: string): Promise<'started' | 'busy' | 'settled' | 'paused' | 'unavailable'> {
    await autoScanRunReady;
    const enabled = await chrome.storage.local.get(XIANYU_AUTO_SCAN_ENABLED_KEY);
    if (enabled[XIANYU_AUTO_SCAN_ENABLED_KEY] !== true) return 'unavailable';
    if (autoScanRunId !== null) return recoverAutoScanRun(autoScanRunId);
    const target = contentMembers.members().find((member) => member.sender?.tab?.id === tabId);
    if (target === undefined) return 'unavailable';
    contentMembers.markActive(target);
    const runId = crypto.randomUUID();
    autoScanRunId = runId;
    await chrome.storage.session.set({ [autoScanRunKey]: runId });
    postStatus('闲鱼自动履约扫描已触发；本轮最多处理一笔。');
    pipeline = pipeline.then(async () => {
      const current = await chrome.storage.local.get(XIANYU_AUTO_SCAN_ENABLED_KEY);
      if (current[XIANYU_AUTO_SCAN_ENABLED_KEY] !== true || autoScanRunId !== runId) {
        if (autoScanRunId === runId) {
          autoScanRunId = null;
          await chrome.storage.session.remove(autoScanRunKey);
        }
        return;
      }
      const [contextMessage, scanMessage] = autoScanDispatch(tabUrl, tabTitle, runId);
      if (!(await forward(contextMessage))) {
        if (autoScanRunId === runId) {
          autoScanRunId = null;
          await chrome.storage.session.remove(autoScanRunKey);
        }
        await chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
        postStatus('闲鱼工作页上下文同步失败，扫描已暂停。');
        return;
      }
      await forward(scanMessage);
    });
    return 'started';
  }

  return { attachContent, attachPanel, triggerAutoScan, close };
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
  await chrome.tabGroups.update(groupId, { title: 'commerce', color: 'purple' }).catch(() => {});
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
  let activeGroupId: number;
  switch (decision.kind) {
    case 'none':
      return;
    case 'reconnect':
      activeGroupId = decision.groupId;
      break;
    case 'join':
      await chrome.tabs.group({ tabIds: tabId, groupId: decision.groupId }).catch(() => {});
      activeGroupId = decision.groupId;
      break;
    case 'create': {
      // tab 已属某标签组（用户既有分组，或宿主自动化的受控组）则采用该组当会话组——
      // 会话键即 tabGroup id（groupIdOf），无需夺 tab 新建；仅未分组 tab 才建 zen 组。
      const groupId = tabGroupId !== TAB_GROUP_ID_NONE ? tabGroupId : await createZenGroup(tabId);
      activeGroupId = groupId;
      if (origin !== null && tab.windowId !== undefined) {
        await chrome.storage.session.set({ [autoGroupKey(tab.windowId, origin)]: groupId });
      }
      break;
    }
  }
  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [panelGroupKey(tab.windowId)]: activeGroupId });
  }
  await sendActivate(tabId);
}

/** 图标点击：未分组 tab 新建独立 zen 组（同 origin 多组独立）；已属某组则采用该组当会话组。 */
async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  const groupId = tabGroupId === TAB_GROUP_ID_NONE ? await createZenGroup(tab.id) : tabGroupId;
  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [panelGroupKey(tab.windowId)]: groupId });
  }
  await sendActivate(tab.id);
}

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  console.error('Zen Commerce Agent 侧边栏点击行为配置失败');
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === SESSION_PORT_NAME) {
    bridgeFor(groupIdOf(port)).attachContent(port);
    return;
  }
  if (port.name !== SIDE_PANEL_PORT_NAME) return;
  const bind = (raw: unknown): void => {
    const message = raw as SidePanelToBackgroundMessage | null;
    if (message?.kind !== 'panel-bind' || message.groupId === TAB_GROUP_ID_NONE) return;
    bridgeFor(message.groupId).attachPanel(port);
  };
  port.onMessage.addListener(bind);
});

chrome.runtime.onMessage.addListener((raw, sender) => {
  const message = raw as ContentRuntimeMessage | null;
  if (message?.kind === 'request-activate') void handleRequestActivate(message, sender);
});

chrome.action.onClicked.addListener((tab) => {
  void handleIconClick(tab);
});

async function syncXianyuAutoScanAlarm(): Promise<void> {
  const settings = await chrome.storage.local.get([
    XIANYU_AUTO_SCAN_ENABLED_KEY,
    XIANYU_AUTO_SCAN_MINUTES_KEY,
  ]);
  await chrome.alarms.clear(XIANYU_AUTO_SCAN_ALARM);
  if (settings[XIANYU_AUTO_SCAN_ENABLED_KEY] !== true) return;
  const periodInMinutes = normalizeAutoScanMinutes(settings[XIANYU_AUTO_SCAN_MINUTES_KEY]);
  chrome.alarms.create(XIANYU_AUTO_SCAN_ALARM, { periodInMinutes });
}

async function triggerXianyuAutoScan(): Promise<void> {
  const settings = await chrome.storage.local.get(XIANYU_AUTO_SCAN_ENABLED_KEY);
  if (settings[XIANYU_AUTO_SCAN_ENABLED_KEY] !== true) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const groupId = tab.groupId;
    if (
      groupId === undefined ||
      groupId === TAB_GROUP_ID_NONE ||
      !isXianyuAutoScanWorkPage(tab.url) ||
      !(await isGroupMapped(groupId))
    ) {
      continue;
    }
    const bridge = groups.get(groupId);
    if (bridge === undefined) continue;
    if (tab.id !== undefined) {
      const triggered = await bridge.triggerAutoScan(tab.id, tab.url!, tab.title ?? '');
      if (triggered !== 'unavailable') return;
    }
  }
  await chrome.storage.local.set({ [XIANYU_AUTO_SCAN_ENABLED_KEY]: false });
}

void syncXianyuAutoScanAlarm();
chrome.runtime.onStartup.addListener(() => void syncXianyuAutoScanAlarm());
chrome.runtime.onInstalled.addListener(() => void syncXianyuAutoScanAlarm());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes[XIANYU_AUTO_SCAN_ENABLED_KEY] !== undefined ||
      changes[XIANYU_AUTO_SCAN_MINUTES_KEY] !== undefined)
  ) {
    void syncXianyuAutoScanAlarm();
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === XIANYU_AUTO_SCAN_ALARM) void triggerXianyuAutoScan();
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
  void chrome.storage.session.remove(execNonceKeyForGroup(group.id)).catch(() => {});
  const bridge = groups.get(group.id);
  if (bridge !== undefined) {
    bridge.close();
    groups.delete(group.id);
  }
});
