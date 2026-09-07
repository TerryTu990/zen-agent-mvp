import type { DownstreamFrame, GroupPageEntry, UpstreamFrame } from './frames.js';
import { createIdentityProvider } from './identity.js';
import { createSseParser } from './sse.js';
import {
  createGroupMembers,
  resolveTargetPageMembers,
  routeForFrame,
  targetPageTabId,
  type FrameRoute,
} from './group-routing.js';
import { decideBackgroundNavigate, decideTargetedNavigate } from './navigate-target.js';
import { createNavigateExecutor } from './navigate-execution.js';
import {
  decideActivation,
  decidePanelVisibility,
  sessionKeyForGroup,
  panelGroupKey,
  zenGroupKey,
  panelHistoryKeyForGroup,
  execNonceKeyForGroup,
  pageHandlesKeyForGroup,
  TAB_GROUP_ID_NONE,
} from './activation.js';
import {
  createPageHandleTable,
  createTrailingDebounce,
  deriveGroupPages,
  parsePageHandleTable,
  reconcilePageHandles,
  type MemberPageInfo,
} from './page-handles.js';
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
  type MessageDeliveryFailure,
  type PanelPageEntry,
} from './messaging.js';
import { reducePanelHistory, removeSettledConfigDraft, removeSettledHitl } from './panel-history.js';
import { verifyExecInstruction } from './exec-verification.js';
import { normalizeTrustedServerBaseUrl } from './server-url.js';
import { runToolbarSidePanelAction } from './side-panel-action.js';
import {
  genericPackIdFromPacks,
  mergeQuickActions,
  panelQuickActions,
  parseQuickActions,
  quickActionsFromPacks,
  quickActionsFromUserConfig,
  selectionQuickActions,
  type QuickActionView,
} from './quick-actions.js';
import {
  parseSiteDenylist,
  siteDeniesUrl,
  siteDenylistFromUserConfig,
  siteDeniedSkipKey,
  siteDeniedSkipTabId,
  SITE_DENYLIST_KEY,
  tabUrlOf,
} from './site-denylist.js';
import {
  CONTENT_SCRIPT_FILE,
  decideRegisteredOrigins,
  GRANTED_ORIGINS_KEY,
  grantedOriginsFromUserConfig,
  parseGrantedOrigins,
  planRegistrations,
} from './injection.js';
import { decideAttachReason, isRestrictedPage, permissionPatternFor } from './page-attach.js';

// 服务端地址缺省值：发布构建经 esbuild --define 注入生产地址（release/build-extension.sh），
// 开发构建回退本机；chrome.storage 的 za.serverBaseUrl 仍可覆盖（调试用）。
declare const __ZA_SERVER_BASE_URL__: string | undefined;
const DEFAULT_SERVER_BASE_URL =
  typeof __ZA_SERVER_BASE_URL__ === 'string' && __ZA_SERVER_BASE_URL__ !== ''
    ? __ZA_SERVER_BASE_URL__
    : 'http://127.0.0.1:8787';

// 全局唯一身份提供者：单飞与退避跨会话组共享，避免多组同时激活。
const identity = createIdentityProvider();

/**
 * 定向帧注入后等待目标页会话端口接入的上限。
 * 取值须容得下「注入 → 脚本求值 → 握手 → 端口接入」这一跳；超时按目标不可达丢帧，
 * 不无限等——带副作用的帧压在没有落点的链上会把后续帧一并卡住。
 */
const CONTENT_ATTACH_TIMEOUT_MS = 3000;

interface Session {
  baseUrl: string;
  token: string;
  sessionId: string;
  generation: number;
}

interface EventStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  execPublicKey: string;
  expectedSessionId: string;
  generation: number;
}

interface MessageDeliveryResult {
  accepted: boolean;
  failure?: MessageDeliveryFailure;
  httpStatus?: number;
  messageState?: 'pending' | 'complete';
  idle?: boolean;
}

async function readServerBaseUrl(): Promise<string> {
  const items = await chrome.storage.local.get('za.serverBaseUrl');
  const value = items['za.serverBaseUrl'];
  const configured = typeof value === 'string' && value !== '' ? value : DEFAULT_SERVER_BASE_URL;
  const trusted = normalizeTrustedServerBaseUrl(configured);
  if (trusted === null) throw new Error('生产服务地址必须使用 HTTPS（仅 localhost/127.0.0.1 允许 HTTP）');
  return trusted;
}

/**
 * 默认整体禁用面板：manifest 的 default_path 会让面板对所有标签页可用（全局实例），
 * 而全局实例与按标签页设置的是不同实例，在其上做按页禁用关不掉已打开的面板。
 * 故把默认置为禁用，仅对 zen 组标签页逐个启用——面板因此只存在于任务组里。
 */
void chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

/** 建组当刻登记，使面板在会话建立前的空窗期不被判为组外。 */
async function markZenGroup(groupId: number): Promise<void> {
  await chrome.storage.session.set({ [zenGroupKey(groupId)]: true }).catch(() => {});
}

async function isZenGroup(groupId: number): Promise<boolean> {
  if (groupId === TAB_GROUP_ID_NONE) return false;
  const key = zenGroupKey(groupId);
  const items: Record<string, unknown> = await chrome.storage.session
    .get(key)
    .catch(() => ({}) as Record<string, unknown>);
  return items[key] === true;
}

/**
 * 面板可见性的唯一施加点：按当前标签页所属组开关面板并改绑会话组。
 * manifest 的 default_path 让面板默认对所有标签页可用，故组外标签页必须显式 enabled:false，
 * 否则面板会一直挂着、却绑在看不见的组上（既不消失也不生效）。
 */
async function applyPanelForTab(tab: {
  id?: number | undefined;
  windowId?: number | undefined;
  groupId?: number | undefined;
}): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  const visibility = decidePanelVisibility({
    tabGroupId,
    isZenGroup: await isZenGroup(tabGroupId),
  });
  await chrome.sidePanel
    .setOptions(
      visibility.enabled ? { tabId, path: 'sidepanel.html', enabled: true } : { tabId, enabled: false },
    )
    .catch(() => {});
  if (visibility.groupId !== null && tab.windowId !== undefined) {
    await chrome.storage.session
      .set({ [panelGroupKey(tab.windowId)]: visibility.groupId })
      .catch(() => {});
  }
}

async function applyPanelForTabId(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab !== null) await applyPanelForTab(tab);
}

/** groupId→sessionId 存根是否存在：判定某组是否已建立会话（激活决策与 onUpdated 复用）。 */
async function isGroupMapped(groupId: number): Promise<boolean> {
  const key = sessionKeyForGroup(groupId);
  const stored = (await chrome.storage.session.get(key))[key];
  return typeof stored === 'string' && stored !== '';
}

type UpstreamContentMessage = Exclude<
  ContentToBackgroundMessage,
  | { kind: 'ping' }
  | { kind: 'navigate-request' }
  | { kind: 'page-status' }
  | { kind: 'operation-state' }
>;

type UpstreamPanelMessage = Extract<
  SidePanelToBackgroundMessage,
  { kind: 'user-message' | 'hitl-decision' | 'config-decision' }
>;

// group-pages 由 background 直接组帧（它持有 tabs API 与句柄映射），无 content↔background Port 消息对应。
interface GroupPagesMessage {
  kind: 'group-pages';
  pages: GroupPageEntry[];
}

type BridgeUpstreamMessage = UpstreamContentMessage | UpstreamPanelMessage | GroupPagesMessage;

/**
 * 上行帧所属的页面（不变量 SD 的判据）。
 * `null` = 该帧不归属任何单个页面：面板发起的会话消息、background 自产的回执、
 * 以及逐条已过滤的组级清单——它们不因某一页被拉黑而消失。
 * tabId 与 url 同时给出时任一命中即拦：tab 记录与页面自述各有滞后窗口，取并集只会更严
 * （客户端只收紧、不放宽）。
 */
type UpstreamOrigin = { tabId?: number | undefined; url?: string | undefined } | null;

/** 命中页被拒执行的下行指令回执错误码（回执由 background 自产，不归属任何页面）。 */
const SITE_DENIED_ERROR = 'site-denied';

/**
 * 一个 zen 标签页组的会话桥（ADR-013 批次④：键=tabGroup id，组内共享一个服务端会话、一条 SSE）；
 * 下行帧按 routeForFrame 路由（叙事/HITL → Side Panel；exec/guide/snapshot 缺省 → 活跃执行页；
 * 带 page 句柄时 → 目标成员页单播，adr-023 D2/D3）。
 */
function createGroupBridge(groupId: number, onEmpty: () => void) {
  const abort = new AbortController();
  const contentMembers = createGroupMembers<chrome.runtime.Port>();
  const panels = new Set<chrome.runtime.Port>();
  const pendingPanels = new Set<chrome.runtime.Port>();
  let panelHistory: SidePanelUiEvent[] = [];
  const historyKey = panelHistoryKeyForGroup(groupId);
  const nonceKey = execNonceKeyForGroup(groupId);
  const seenExecNonces = new Set<string>();
  const echoedMessageIds = new Set<string>();
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
    if (Array.isArray(stored)) {
      panelHistory = stored as SidePanelUiEvent[];
      for (const event of panelHistory) {
        if (event.kind === 'user-echo' && event.messageId !== undefined) echoedMessageIds.add(event.messageId);
      }
    }
  });
  let sessionPromise: Promise<Session | null> | null = null;
  let downlinkPromise: Promise<boolean> | null = null;
  let downlinkReady = false;
  let sessionGeneration = 0;
  const activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const activeTurnIds = new Set<string>();
  const inflightTurnIds = new Set<string>();
  const completedTurnIds = new Set<string>();
  let anonymousTurns = 0;
  let deliveryRequests = 0;
  let configurationDirty = false;
  // navigate 新开页的 tabId：其端口接入时标为活跃页，使后续 exec/HITL 路由随导航跟到新站点页。
  let expectedActiveTabId: number | null = null;
  let suppressedTurnId: string | null = null;
  let lastSessionFailure: Omit<MessageDeliveryResult, 'accepted'> = { failure: 'session-unavailable' };
  const pageHandlesKey = pageHandlesKeyForGroup(groupId);
  let pageHandles = createPageHandleTable();
  const pageHandlesReady = chrome.storage.session.get(pageHandlesKey).then((items) => {
    pageHandles = parsePageHandleTable(items[pageHandlesKey]);
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
  /**
   * 不变量 ST 的唯一权威状态：本组当前是否处于停止态。停止手势置位、明确的新回合复位。
   * 一切会产生页面副作用的路径（帧落页、background 自执行的导航、成员页端口接入）在动手前查它，
   * 而不是各通路各自持有一段闩——每加一条通路就要记得再加一道防线，正是「停止没停住」反复复发的形状。
   */
  let operationStopped = false;
  /**
   * 明确的新回合开始：解除停止态，并把它宣告到各成员页（页面侧的闩同样只由新回合复位）。
   * 与停止手势同为同步广播、不等上行往返——等往返则本回合的第一条指令会被上一次停止挡下，
   * 而那条指令已经带着服务端签名到达页面，不执行既不上报即是静默失败。
   */
  const beginTurn = (): void => {
    operationStopped = false;
    for (const member of contentMembers.members()) {
      postContent(member, { kind: 'resume-operation' });
    }
  };
  const updateHistory = (update: (history: SidePanelUiEvent[]) => SidePanelUiEvent[]): void => {
    historyChain = historyChain.then(async () => {
      panelHistory = update(panelHistory);
      await chrome.storage.session.set({ [historyKey]: panelHistory });
    });
  };
  const emitUi = (event: SidePanelUiEvent): void => {
    if (event.kind === 'user-echo' && event.messageId !== undefined) {
      if (echoedMessageIds.has(event.messageId)) return;
      echoedMessageIds.add(event.messageId);
    }
    updateHistory((history) => reducePanelHistory(history, event));
    postToPanels(event);
  };
  /**
   * 下行帧落到具体页面的统一出口，不变量 SD 第二句的唯一闸门：命中页不执行任何下行指令。
   * exec-instruction 另回一条 site-denied 拒绝回执——没有回执，服务端只能把「已下发未回」
   * 当成超时，用户会以为拉黑生效而实际看不出指令被本机拒了。
   * 串行链保证两帧的先后序不被闸门的异步取址打乱（页面副作用对顺序敏感）。
   * 同时是不变量 ST 的落页闸门：停止态查询发生在闸门取址之后、副作用发生之前，
   * 故「已排队尚未落页」的帧与停止之后才到达的帧一并短路，两者无需分别设防。
   */
  let landing: Promise<void> = Promise.resolve();
  const landOnPage = (frame: DownstreamFrame, tabId: number | undefined, execute: () => void): void => {
    landing = landing
      .then(async () => {
        const denied = await isSiteDeniedPage({ tabId });
        if (operationStopped) return;
        if (!denied) {
          execute();
          return;
        }
        if (frame.type !== 'exec-instruction') return;
        pipeline = pipeline.then(async () => {
          await forward({
            kind: 'exec-result',
            result: {
              type: 'exec-result',
              sessionId: frame.sessionId,
              nonce: frame.nonce,
              ok: false,
              error: SITE_DENIED_ERROR,
            },
          }, null);
        });
      })
      .catch(() => {});
  };

  /**
   * 定向帧落到未注入目标页的通路：先注入，端口接入后再投递。
   * 注入失败或端口始终不来即丢帧——与「目标成员不可达」同一处置，禁改投他页。
   * 注入与端口接入之间最长隔着 CONTENT_ATTACH_TIMEOUT_MS，这段窗口里停止手势与站点拉黑都可能发生：
   * 真正的投递因此重新排回 landOnPage，闸门恒在副作用发生的那一刻判，而非取址那一刻判过就一路放行。
   */
  async function injectAndPostToTab(frame: DownstreamFrame, tabId: number): Promise<void> {
    if (!(await injectContentScript(tabId))) return;
    const member = await awaitContentMember(tabId);
    if (member === undefined) return;
    landOnPage(frame, tabId, () => postContent(member, { kind: 'frame', frame }));
  }

  /**
   * 活跃执行页登记的统一出口，不变量 SD 第三句的唯一闸门：命中页不得成为活跃页——
   * 否则下行帧全部路由到一个只会被下行闸门丢掉的页，同组未命中页反而失联。
   * 有页面自报地址时一并判（上行闸门同口径）：tab 记录的地址在导航途中可能还是旧值。
   * 返回 false = 该页被拒，调用方按「本组当下没有可用执行页」处置。
   */
  async function admitActivePage(port: chrome.runtime.Port, reportedUrl?: string): Promise<boolean> {
    const page = { tabId: port.sender?.tab?.id, ...(reportedUrl !== undefined ? { url: reportedUrl } : {}) };
    if (await isSiteDeniedPage(page)) return false;
    contentMembers.markActive(port);
    return true;
  }

  const postFrame = (route: FrameRoute, frame: DownstreamFrame): void => {
    if (suppressedTurnId !== null) {
      const stoppedTurnCompleted = frame.type === 'turn-complete' &&
        (frame.idle || frame.messageId === suppressedTurnId);
      const safetyAlert = frame.type === 'text-delta' && frame.priority === 'safety';
      if (!stoppedTurnCompleted && !safetyAlert) return;
      if (stoppedTurnCompleted) suppressedTurnId = null;
    }
    if (frame.type === 'turn-complete') {
      if (frame.messageId !== undefined) {
        activeTurnIds.delete(frame.messageId);
        completedTurnIds.add(frame.messageId);
      }
      if (frame.idle) {
        activeTurnIds.clear();
        anonymousTurns = 0;
      }
      void applyPendingConfiguration();
    }
    if (route === 'panel') {
      if (
        frame.type === 'text-delta' ||
        frame.type === 'turn-complete' ||
        frame.type === 'tool-card' ||
        frame.type === 'hitl-request' ||
        frame.type === 'config-draft'
      ) {
        emitUi({ kind: 'frame', frame });
      }
      return;
    }
    if (route === 'target-page') {
      // 定向单步 navigate 的落点由签名帧句柄钉死：不论目标成员有无 content 端口，一律由
      // background 对该 tab 直执行——经 content 委托会走 performNavigate 复用判定（排除发起页、
      // 可改投同源他页并夺焦），违反「批准的目标页＝被导航的那一页」。
      const direct = decideTargetedNavigate(frame, pageHandles);
      if (direct.execute) {
        landOnPage(frame, direct.tabId, () => void executeNavigateToTab(direct.frame, direct.url, direct.tabId));
        return;
      }
      const members = resolveTargetPageMembers(
        frame,
        pageHandles,
        contentMembers.members(),
        (candidate) => candidate.sender?.tab?.id,
      );
      if (members.length === 0) {
        // 目标页尚未注入（按需注入模型下这是组内成员的常态）：定向帧到达即注入该页，再投递。
        // 句柄已退役即 null——那才是真正的目标不可达，丢帧、禁改投。
        const targetTabId = targetPageTabId(frame, pageHandles);
        if (targetTabId !== null) {
          landOnPage(frame, targetTabId, () => void injectAndPostToTab(frame, targetTabId));
        }
        return;
      }
      for (const member of members) {
        landOnPage(frame, member.sender?.tab?.id, () => postContent(member, { kind: 'frame', frame }));
      }
      return;
    }
    const targets = contentMembers.targets('active-page');
    const direct = decideBackgroundNavigate(frame, targets.length);
    if (direct.execute) {
      // 组内无 content 成员的冷启动 open_url：没有落地页可判，目标 URL 的治理在服务端签发前（D-2）；
      // 仍经同一闸门落地，副作用由谁执行不改变它受不变量 ST 约束这件事。
      landOnPage(frame, undefined, () => void executeNavigateWithoutPage(direct.frame, direct.url));
      return;
    }
    for (const member of targets) {
      landOnPage(frame, member.sender?.tab?.id, () => postContent(member, { kind: 'frame', frame }));
    }
  };
  const postStatus = (message: string): void => emitUi({ kind: 'status', message });

  async function invalidateSession(): Promise<void> {
    sessionGeneration += 1;
    sessionPromise = null;
    downlinkPromise = null;
    downlinkReady = false;
    for (const reader of activeReaders) void reader.cancel().catch(() => {});
    activeReaders.clear();
    await chrome.storage.session.remove(sessionKeyForGroup(groupId));
  }

  async function applyPendingConfiguration(): Promise<void> {
    if (!configurationDirty || deliveryRequests !== 0 || activeTurnIds.size !== 0 || anonymousTurns !== 0) return;
    configurationDirty = false;
    await invalidateSession();
  }

  function configurationChanged(): void {
    configurationDirty = true;
    void applyPendingConfiguration();
  }

  // 错误消息只含键名/状态码等可定位信息，不回显 token 值（SEC-04）。
  async function openSession(): Promise<Session | null> {
    const generation = sessionGeneration;
    lastSessionFailure = { failure: 'session-unavailable' };
    let baseUrl: string;
    try {
      baseUrl = await readServerBaseUrl();
    } catch (error) {
      lastSessionFailure = { failure: 'configuration' };
      postStatus(error instanceof Error ? error.message : '服务地址配置无效');
      return null;
    }
    let token: string;
    try {
      token = await identity.getToken(baseUrl);
    } catch {
      lastSessionFailure = { failure: 'session-unavailable' };
      postStatus('无法建立与 zen-agent 服务的身份连接，请检查网络后重试');
      return null;
    }
    // 优先复用本组已存 sessionId：SW 被回收重启后，服务端会话及其挂起 HITL/代执行等待器仍在，
    // 复用即恢复 in-flight 流程、避免每次重连新建会话（会话风暴 + nonce↔会话错位 409）。
    const key = sessionKeyForGroup(groupId);
    const storedId = (await chrome.storage.session.get(key))[key];
    if (typeof storedId === 'string' && storedId !== '') {
      const resumed: Session = { baseUrl, token, sessionId: storedId, generation };
      const stream = await openEventStream(resumed, true);
      if (stream !== null && generation === sessionGeneration) {
        await reconcileTurnState(resumed);
        downlinkReady = true;
        void drainEvents(resumed, stream);
        return resumed;
      }
      // 复用失败（会话已失效/服务端重启）：清存根，落到新建。
      await chrome.storage.session.remove(key);
    }
    if (generation !== sessionGeneration) return null;
    // null = 网络不可达（与「服务端明确拒绝」区分开，后者仍有响应可判读）。
    const createSession = async (bearer: string): Promise<Response | null> => {
      try {
        return await fetch(`${baseUrl}/v1/sessions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}` },
        });
      } catch {
        return null;
      }
    };
    let response = await createSession(token);
    if (response !== null && response.status === 401) {
      // 缓存令牌可能已被服务端作废：重新激活匿名身份后重试一次；仍被拒即如实报错（判定权归服务端，U7）。
      const renewed = await identity.refreshToken(baseUrl).then((value) => value, () => null);
      if (renewed !== null) {
        token = renewed;
        response = await createSession(token);
      }
    }
    if (response === null) {
      lastSessionFailure = { failure: 'unreachable' };
      postStatus(`无法连接 zen-agent 服务（${baseUrl}）`);
      return null;
    }
    if (response.status === 401) {
      lastSessionFailure = { failure: 'unauthorized', httpStatus: response.status };
      postStatus('身份校验未通过（HTTP 401），重新获取身份后仍被拒绝，请稍后重试');
      return null;
    }
    if (!response.ok) {
      lastSessionFailure = { failure: 'server-rejected', httpStatus: response.status };
      postStatus(`会话创建失败（HTTP ${response.status}）`);
      return null;
    }
    const { sessionId } = (await response.json()) as { sessionId: string };
    if (generation !== sessionGeneration) return null;
    await chrome.storage.session.set({ [key]: sessionId });
    const session = { baseUrl, token, sessionId, generation };
    // 先建立 SSE 订阅再返回：否则首个 user-message 触发的回合可能早于订阅注册而丢失下行帧（订阅竞态）。
    const stream = await openEventStream(session);
    if (stream === null) return null;
    downlinkReady = true;
    void drainEvents(session, stream);
    return session;
  }

  function ensureSession(): Promise<Session | null> {
    const existing = sessionPromise;
    if (existing !== null) {
      return existing.then(async (session) => {
        if (session === null || session.generation !== sessionGeneration) return ensureSession();
        return (await ensureDownlink(session)) ? session : null;
      });
    }
    const generation = sessionGeneration;
    const created = openSession();
    sessionPromise = created;
    return created.then(async (session) => {
      const stale = generation !== sessionGeneration || (session !== null && session.generation !== sessionGeneration);
      if (sessionPromise === created && (session === null || stale)) sessionPromise = null;
      if (stale || session === null) return stale ? ensureSession() : null;
      return (await ensureDownlink(session)) ? session : null;
    });
  }

  function ensureDownlink(session: Session, quiet = false): Promise<boolean> {
    if (downlinkReady) return Promise.resolve(true);
    const existing = downlinkPromise;
    if (existing !== null) return existing;
    const created = openEventStream(session, quiet).then((stream) => {
      if (stream === null || session.generation !== sessionGeneration) return false;
      downlinkReady = true;
      void drainEvents(session, stream);
      return true;
    });
    downlinkPromise = created;
    return created.finally(() => {
      if (downlinkPromise === created) downlinkPromise = null;
    });
  }

  /**
   * 建立 SSE 事件流并返回 reader；成功即代表服务端已注册订阅（订阅竞态在此收敛）。失败返回 null。
   * quiet=true 用于复用探测：会话已失效属预期，不向用户报状态。
   */
  async function openEventStream(
    session: Session,
    quiet = false,
  ): Promise<EventStream | null> {
    const { baseUrl, token, sessionId } = session;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
    } catch {
      lastSessionFailure = { failure: 'unreachable' };
      if (!abort.signal.aborted && !quiet) postStatus('事件流连接中断');
      return null;
    }
    const algorithm = response.headers.get('x-zen-agent-exec-algorithm');
    const execPublicKey = response.headers.get('x-zen-agent-exec-public-key');
    if (!response.ok) {
      lastSessionFailure = response.status === 401
        ? { failure: 'unauthorized', httpStatus: response.status }
        : response.status === 404
          ? { failure: 'session-expired', httpStatus: response.status }
          : { failure: 'server-rejected', httpStatus: response.status };
      if (!quiet) postStatus(`事件流建立失败（HTTP ${response.status}）`);
      return null;
    }
    if (response.body === null || algorithm !== 'Ed25519' || !execPublicKey) {
      lastSessionFailure = { failure: 'protocol-invalid' };
      if (!quiet) postStatus('事件流安全握手失败');
      return null;
    }
    return {
      reader: response.body!.getReader(),
      execPublicKey: execPublicKey!,
      expectedSessionId: sessionId,
      generation: session.generation,
    };
  }

  async function reconcileTurnState(session: Session): Promise<void> {
    try {
      const response = await fetch(`${session.baseUrl}/v1/sessions/${session.sessionId}/turn-state`, {
        headers: { authorization: `Bearer ${session.token}` },
        signal: abort.signal,
      });
      if (response.ok) {
        const state = await response.json() as { running?: unknown };
        if (state.running === false) {
          postFrame('panel', { type: 'turn-complete', sessionId: session.sessionId, idle: true });
        }
      }
    } catch {
      if (abort.signal.aborted) return;
    }
  }

  const failTrackedTurns = (failure: MessageDeliveryFailure): void => {
    activeTurnIds.clear();
    anonymousTurns = 0;
    postToPanels({ kind: 'session-failed', failure });
    void applyPendingConfiguration();
  };

  async function recoverEventStream(session: Session): Promise<void> {
    for (let attempt = 0; attempt < 5 && !abort.signal.aborted && session.generation === sessionGeneration; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      if (session.generation !== sessionGeneration) return;
      const ready = await ensureDownlink(session, true);
      if (!ready) {
        if (
          lastSessionFailure.failure === 'unauthorized' ||
          lastSessionFailure.failure === 'session-expired' ||
          lastSessionFailure.failure === 'protocol-invalid'
        ) {
          if (lastSessionFailure.failure === 'unauthorized' || lastSessionFailure.failure === 'session-expired') {
            await invalidateSession();
          }
          failTrackedTurns(lastSessionFailure.failure ?? 'session-unavailable');
          postStatus('事件流无法恢复，请检查连接配置后重试');
          return;
        }
        continue;
      }
      await reconcileTurnState(session);
      return;
    }
    if (!abort.signal.aborted && session.generation === sessionGeneration) {
      downlinkReady = false;
      failTrackedTurns('unreachable');
      postStatus('事件流重连失败，请检查网络后重试');
    }
  }

  async function drainEvents(
    session: Session,
    { reader, execPublicKey, expectedSessionId, generation }: EventStream,
  ): Promise<void> {
    if (generation !== sessionGeneration) {
      await reader.cancel().catch(() => {});
      return;
    }
    activeReaders.add(reader);
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
                }, null);
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
                }, null);
                continue;
              }
            }
            const route = routeForFrame(frame);
            // target-page 反查依赖 storage.session 读回的句柄表：SW 重启窗口内表未就绪时
            // 空表会把合法定向帧误判为句柄退役而丢帧（同 exec-instruction 等 nonceHistoryReady）。
            if (route === 'target-page') await pageHandlesReady;
            postFrame(route, frame);
          } catch {
            postStatus('收到无法解析的下行帧，已丢弃');
          }
        }
      }
    } catch {
      if (abort.signal.aborted) return;
    } finally {
      activeReaders.delete(reader);
    }
    if (!abort.signal.aborted && generation === sessionGeneration) {
      downlinkReady = false;
      postStatus('事件流连接中断，正在重连');
      void recoverEventStream(session);
    }
  }

  function toUpstreamFrame(
    message: BridgeUpstreamMessage,
    sessionId: string,
  ): UpstreamFrame {
    switch (message.kind) {
      case 'context-report':
        return { type: 'context-report', sessionId, url: message.url, title: message.title };
      case 'group-pages':
        return { type: 'group-pages', sessionId, pages: message.pages };
      case 'user-message':
        return {
          type: 'user-message',
          sessionId,
          text: message.text,
          ...('messageId' in message ? { messageId: message.messageId } : {}),
          executionPreference: message.executionPreference,
          ...(message.quickActionId !== undefined ? { quickActionId: message.quickActionId } : {}),
          ...(message.selectionText !== undefined ? { selectionText: message.selectionText } : {}),
        };
      case 'hitl-decision':
        return { type: 'hitl-decision', sessionId, hitlId: message.hitlId, decision: message.decision };
      case 'config-decision':
        return { type: 'config-decision', sessionId, draftId: message.draftId, decision: message.decision };
      case 'exec-result':
        // sessionId 权威归 background：以本会话盖章覆盖 content 侧原料值。
        return { ...message.result, sessionId };
      case 'snapshot-report':
        return { ...message.report, sessionId };
    }
  }

  async function forward(message: BridgeUpstreamMessage, origin: UpstreamOrigin): Promise<boolean> {
    return (await deliver(message, origin)).accepted;
  }

  async function stopTurn(messageId: string): Promise<boolean> {
    const session = await ensureSession();
    if (session === null) return false;
    try {
      const response = await fetch(`${session.baseUrl}/v1/sessions/${session.sessionId}/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      if (response.status === 401 || response.status === 404) await invalidateSession();
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 全部上行帧的统一出口，不变量 SD 第一句的唯一闸门：来源页命中用户站点黑名单的帧不出本机。
   * 判定先于 ensureSession——命中页连一次建会话都不该在服务端留下痕迹。
   * 无按形态放行的例外：连拒绝回执也不是从页面来的（background 自产、origin=null），
   * 任何「某种形状可以过」的口子都等于给页面侧留一条夹带通道。
   */
  async function deliver(message: BridgeUpstreamMessage, origin: UpstreamOrigin): Promise<MessageDeliveryResult> {
    if (origin !== null && (await isSiteDeniedPage(origin))) {
      return { accepted: false, failure: 'site-denied' };
    }
    const session = await ensureSession();
    if (session === null) return { accepted: false, ...lastSessionFailure };
    const frame: UpstreamFrame = toUpstreamFrame(message, session.sessionId);
    const turnId = message.kind === 'user-message' ? message.messageId : null;
    if (turnId !== null) inflightTurnIds.add(turnId);
    deliveryRequests += 1;
    try {
      const response = await fetch(`${session.baseUrl}/v1/sessions/${session.sessionId}/frames`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(frame),
      });
      if (response.status === 401) {
        await invalidateSession();
        const renewed = await identity.refreshToken(session.baseUrl).then(() => true, () => false);
        postStatus(
          renewed
            ? '身份已过期，已自动重新获取，请重新发送'
            : '身份校验未通过（HTTP 401），重新获取身份失败，请检查网络后重试',
        );
        return { accepted: false, failure: 'unauthorized', httpStatus: response.status };
      } else if (response.status === 404) {
        await invalidateSession();
        postStatus('服务端会话已失效，请重新发送');
        return { accepted: false, failure: 'session-expired', httpStatus: response.status };
      } else if (response.status === 409) {
        const payload = await response.json().catch(() => ({})) as { messageState?: unknown };
        if (payload.messageState === 'interrupted') {
          postStatus('上一回合因服务重启中断，请核对业务状态后再重新发送');
          return { accepted: false, failure: 'session-interrupted', httpStatus: response.status };
        }
        postStatus('上行帧状态冲突（HTTP 409）');
        return { accepted: false, failure: 'server-rejected', httpStatus: response.status };
      } else if (!response.ok) {
        postStatus(`上行帧被拒绝（HTTP ${response.status}）`);
        return { accepted: false, failure: 'server-rejected', httpStatus: response.status };
      }
      if (session.generation !== sessionGeneration) {
        return { accepted: false, failure: 'delivery-unknown' };
      }
      const payload = await response.json().catch(() => ({})) as { messageState?: unknown; idle?: unknown };
      const messageState = payload.messageState === 'pending' || payload.messageState === 'complete'
        ? payload.messageState
        : undefined;
      if (message.kind === 'user-message') {
        const turnId = message.messageId;
        if (messageState === 'complete') {
          postFrame('panel', {
            type: 'turn-complete',
            sessionId: session.sessionId,
            messageId: turnId,
            idle: payload.idle === true,
          });
        } else {
          if (completedTurnIds.has(turnId)) completedTurnIds.delete(turnId);
          else activeTurnIds.add(turnId);
        }
      }
      return {
        accepted: true,
        ...(messageState !== undefined ? { messageState } : {}),
        ...(typeof payload.idle === 'boolean' ? { idle: payload.idle } : {}),
      };
    } catch {
      postStatus(`无法连接 zen-agent 服务（${session.baseUrl}）`);
      return { accepted: false, failure: 'unreachable' };
    } finally {
      if (turnId !== null) {
        inflightTurnIds.delete(turnId);
        if (!activeTurnIds.has(turnId) && suppressedTurnId === turnId) suppressedTurnId = null;
      }
      deliveryRequests = Math.max(0, deliveryRequests - 1);
      void applyPendingConfiguration();
    }
  }

  const { performNavigate, executeNavigateWithoutPage, executeNavigateToTab } = createNavigateExecutor({
    groupId,
    tabs: chrome.tabs,
    markMemberActive: (tabId) => {
      const member = contentMembers.members().find((candidate) => candidate.sender?.tab?.id === tabId);
      if (member === undefined) return;
      void admitActivePage(member).then((admitted) => {
        if (admitted) scheduleGroupPagesReport();
      });
    },
    noteExpectedActiveTab: (tabId) => {
      expectedActiveTabId = tabId;
    },
    attachPanelToTab: (tabId) => applyPanelForTabId(tabId),
    sendActivate: async (tabId) => {
      await sendActivate(tabId);
    },
    // background 自产的导航回执：只含服务端签发时已定值的 URL，不归属任何页面（origin=null）。
    forwardExecResult: (result) => {
      pipeline = pipeline.then(async () => {
        await forward({ kind: 'exec-result', result }, null);
      });
    },
  });

  async function handleNavigate(
    port: chrome.runtime.Port,
    request: Extract<ContentToBackgroundMessage, { kind: 'navigate-request' }>,
  ): Promise<void> {
    // 停止态下不开页（不变量 ST）：发出请求的那条批次可能是停止之前就已落到页面上的，
    // 页面侧的步间检查点管不到这一步——它的副作用由 background 执行。
    const outcome = operationStopped
      ? ({ ok: false, error: 'user-stopped' } as const)
      : await performNavigate(request.url, port.sender?.tab?.windowId, port.sender?.tab?.id);
    postContent(
      port,
      outcome.ok
        ? { kind: 'navigate-result', requestId: request.requestId, ok: true, url: outcome.url }
        : { kind: 'navigate-result', requestId: request.requestId, ok: false, error: outcome.error },
    );
  }

  // 串行转发保证 context-report 先于后续 user-message 到达服务端（组内共用一条管线）。
  const UPSTREAM_KINDS: ReadonlySet<ContentToBackgroundMessage['kind']> = new Set([
    'context-report',
    'exec-result',
    'snapshot-report',
  ]);
  let pipeline: Promise<void> = Promise.resolve();

  /**
   * 采集本组全量成员页快照（经 tabs API，含无 content 端口的 silent 页）并对齐句柄表。
   * 隔离负数组键（groupIdOf 合成）无法经 tabs.query 枚举 → 不上报；
   * URL 尚不可得的成员先入句柄表（保持句柄稳定）、本帧暂缺行（空 url 帧不合法）。
   * 落在用户站点黑名单内的成员整条剔除——清单的 url/title 会进注入面被 LLM 读到，
   * 「别让 Zen 看见这个站点」的意图在这条路上同样成立；剔除先于句柄对齐，不留指向已剔除页的悬空句柄。
   */
  async function collectGroupPages(): Promise<GroupPageEntry[] | null> {
    if (groupId < 0) return null;
    const queried = await chrome.tabs.query({ groupId }).catch(() => null);
    if (queried === null) return null;
    const denylist = await readSiteDenylist();
    const tabs = queried.filter((tab) => !siteDeniesUrl(denylist, tabUrlOf(tab)));
    await pageHandlesReady;
    const reconciled = reconcilePageHandles(
      pageHandles,
      tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined),
    );
    pageHandles = reconciled.table;
    if (reconciled.changed) {
      await chrome.storage.session.set({ [pageHandlesKey]: pageHandles }).catch(() => {});
    }
    const members: MemberPageInfo[] = [];
    for (const tab of tabs) {
      const url = tabUrlOf(tab);
      if (tab.id === undefined || url === undefined || url === '') continue;
      members.push({
        tabId: tab.id,
        url,
        ...(tab.title !== undefined && tab.title !== '' ? { title: tab.title } : {}),
      });
    }
    const portTabIds = new Set<number>();
    for (const member of contentMembers.members()) {
      const tabId = member.sender?.tab?.id;
      if (tabId !== undefined) portTabIds.add(tabId);
    }
    const activeTabId = contentMembers.targets('active-page')[0]?.sender?.tab?.id ?? null;
    return deriveGroupPages(pageHandles, members, portTabIds, activeTabId);
  }

  async function reportGroupPages(): Promise<void> {
    if (abort.signal.aborted) return;
    const pages = await collectGroupPages();
    if (pages === null || abort.signal.aborted) return;
    // 组级清单不归属任何单页（origin=null）：命中页的条目已在 collectGroupPages 逐条剔除。
    pipeline = pipeline
      .then(async () => {
        await forward({ kind: 'group-pages', pages }, null);
      })
      .catch(() => {});
  }

  /**
   * 面板侧的成员页接入态清单。与上行清单同源于一次 tabs.query，但保留命中站点黑名单的成员：
   * 那条剔除是不让 agent 读到该页，不是不让用户知道 Zen 为什么没接入它。
   * silent 行的原因只由浏览器 API 当刻能答的本机事实推出（协议闭集 / 权限持有 / 加载中 / 名单命中），
   * 不构成治理判定——治理终判恒在服务端（U7）。
   */
  async function collectPanelPages(): Promise<PanelPageEntry[] | null> {
    if (groupId < 0) return null;
    const queried = await chrome.tabs.query({ groupId }).catch(() => null);
    if (queried === null) return null;
    const denylist = await readSiteDenylist();
    const portTabIds = new Set<number>();
    for (const member of contentMembers.members()) {
      const tabId = member.sender?.tab?.id;
      if (tabId !== undefined) portTabIds.add(tabId);
    }
    const activeTabId = contentMembers.targets('active-page')[0]?.sender?.tab?.id ?? null;
    const pages: PanelPageEntry[] = [];
    for (const tab of queried) {
      const url = tabUrlOf(tab);
      if (tab.id === undefined || url === undefined || url === '') continue;
      const title = tab.title === undefined || tab.title === '' ? {} : { title: tab.title };
      if (portTabIds.has(tab.id)) {
        pages.push({
          tabId: tab.id,
          url,
          ...title,
          status: tab.id === activeTabId ? 'active' : 'background',
        });
        continue;
      }
      pages.push({
        tabId: tab.id,
        url,
        ...title,
        status: 'silent',
        reason: decideAttachReason({
          url,
          siteDenied: siteDeniesUrl(denylist, url),
          originGranted: await originGrantedFor(url),
          loading: tab.status === 'loading',
        }),
      });
    }
    return pages;
  }

  async function reportPanelPages(): Promise<void> {
    if (abort.signal.aborted || panels.size === 0) return;
    const pages = await collectPanelPages();
    if (pages === null || abort.signal.aborted) return;
    postToPanels({ kind: 'group-page-status', pages });
  }

  /**
   * 面板发起的手动补接入：落点必须仍在本组——面板持有的清单可能已滞后，
   * 注入面不得越出任务组边界。成败按注入的实际结果如实回报（站点权限仍未取得的页照样失败），
   * 不静默降级；无论成败都重采一次清单，让原因行跟上当刻事实。
   */
  async function attachPageFromPanel(tabId: number): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab === null || (tab.groupId ?? TAB_GROUP_ID_NONE) !== groupId) return false;
    const attached = await sendActivate(tabId);
    scheduleGroupPagesReport();
    return attached;
  }

  // 防抖 300ms 合并突发（开组/批量导航），到期才采集最终全量快照组帧；单页也上报（≥2 页
  // 门槛是服务端注入门槛，审计活跃页标注仍需状态表）。投递走既有串行管线保证与 context-report
  // 的先后序；失败不重试不阻塞——下个触发点自然带来新全量帧。
  // 到期时宿主可能已不在（SW 回收后定时器仍到期，其捕获的 chrome/fetch 已失效）：采集的同步抛出
  // 与拒绝一并止于本帧，既不外溢成未处理拒绝，也不让一次失败毒化整条上行串行链。
  const scheduleGroupPagesReport = createTrailingDebounce(300, () => {
    void reportGroupPages().catch(() => {});
    // 面板清单与上行清单同一触发点、各走各的通道：上行要过会话与闸门，面板只是本机现象的如实呈现，
    // 任一侧失败都不该拖住另一侧。
    void reportPanelPages().catch(() => {});
  });
  // 桥建立（含 SW 重启重建、面板先于 content 接入）即补一帧全量：
  // 服务端状态表不滞留桥空窗期间已关闭/离组的旧页。
  scheduleGroupPagesReport();

  function maybeClose(): void {
    if (contentMembers.size() === 0 && panels.size === 0) close();
  }

  function detachContent(port: chrome.runtime.Port): void {
    contentMembers.remove(port);
    scheduleGroupPagesReport();
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

  /**
   * 定向帧目标页尚未接入时的等待面：轨一注入后其端口接入即兑现。
   * 键为 tabId——同一页可能有多帧同时在等，故值为回调数组。
   */
  const contentWaiters = new Map<number, Array<() => void>>();

  function memberForTab(tabId: number): chrome.runtime.Port | undefined {
    return contentMembers.members().find((member) => member.sender?.tab?.id === tabId);
  }

  /**
   * 等目标页的会话端口接入，上限 CONTENT_ATTACH_TIMEOUT_MS。
   * 超时按「目标不可达」返回 undefined：等下去只会把带副作用的帧压在一条已经没有落点的链上。
   */
  async function awaitContentMember(tabId: number): Promise<chrome.runtime.Port | undefined> {
    const existing = memberForTab(tabId);
    if (existing !== undefined) return existing;
    await new Promise<void>((resolve) => {
      const waiters = contentWaiters.get(tabId) ?? [];
      const done = (): void => {
        clearTimeout(timer);
        const list = contentWaiters.get(tabId);
        if (list !== undefined) {
          const index = list.indexOf(done);
          if (index !== -1) list.splice(index, 1);
          if (list.length === 0) contentWaiters.delete(tabId);
        }
        resolve();
      };
      const timer = setTimeout(done, CONTENT_ATTACH_TIMEOUT_MS);
      waiters.push(done);
      contentWaiters.set(tabId, waiters);
    });
    return memberForTab(tabId);
  }

  function attachContent(port: chrome.runtime.Port): void {
    contentMembers.add(port);
    const attachedTabId = port.sender?.tab?.id;
    if (attachedTabId !== undefined) {
      const waiters = contentWaiters.get(attachedTabId);
      if (waiters !== undefined) {
        contentWaiters.delete(attachedTabId);
        for (const waiter of [...waiters]) waiter();
      }
    }
    // 接入即取当前停止态，而不是指望曾经广播过什么：停止后才接入的页拿不到那次广播，
    // 重连窗口里错过复位广播的页则会永久停摆——两者都是「曾经广播过」这个前提本身不成立。
    postContent(port, { kind: operationStopped ? 'stop-operation' : 'resume-operation' });
    // navigate 新开页接入即标为活跃：后续 exec/HITL 路由跟随导航到新站点页。
    if (expectedActiveTabId !== null && port.sender?.tab?.id === expectedActiveTabId) {
      expectedActiveTabId = null;
      void admitActivePage(port);
    }
    scheduleGroupPagesReport();
    port.onMessage.addListener((raw) => {
      const message = raw as ContentToBackgroundMessage | null;
      if (message === null) return;
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
      // 帧与来源页的对应关系随帧带到统一出口：判定只在 deliver 里做一次，此处不做第二次。
      const senderTabId = port.sender?.tab?.id;
      const origin: UpstreamOrigin =
        message.kind === 'context-report'
          ? { tabId: senderTabId, url: message.url }
          : message.kind === 'snapshot-report'
            ? { tabId: senderTabId, url: message.report.url }
            : { tabId: senderTabId };
      pipeline = pipeline.then(async () => {
        // 上下文上报来自用户视线所在页：登记为组内活跃页（HITL/exec/guide 的路由目标）。
        // 登记与面板抬头恒在闸门之后（命中页既不成为执行落点，也不冒充「任务页面已连接」），
        // 但不等上行往返：那段窗口内到达的 active-page 下行帧会落到用户刚离开的上一页。
        if (message.kind === 'context-report' && (await admitActivePage(port, message.url))) {
          scheduleGroupPagesReport();
          postToPanels({
            kind: 'task-context',
            groupId,
            authorized: true,
            url: message.url,
            ...(message.title !== '' ? { title: message.title } : {}),
          });
        }
        await deliver(message, origin);
      });
    });
    port.onDisconnect.addListener(() => detachContent(port));
  }

  /**
   * 本组当刻的活动页地址。尚无会话时的首屏兜底面要按它判本页能不能激活——
   * 浏览器内部页/扩展页永不产生上下文上报，错发的 chips 在这类页上不会被后续刷新收窄。
   * 组内查不到活动页（隔离负数组键 / 用户在别的窗口）即回 null，按「本页不可激活」处置。
   */
  async function activeGroupPageUrl(): Promise<string | null> {
    if (groupId < 0) return null;
    const [tab] = await chrome.tabs.query({ groupId, active: true }).catch(() => []);
    const url = tab === undefined ? undefined : tabUrlOf(tab);
    return url === undefined || url === '' ? null : url;
  }

  /**
   * 本轮取数的作用域：会话已在的组按注入自省给出的 packId/featureId（不另立一套激活判定）；
   * 尚无会话时按 generic 兜底包呈现首屏——为一排 chips 建会话会在服务端
   * 落一条 session-start，那是用户没做任何事就产生的可观察行为。自省读不出即回 null（弃本轮取数）。
   * 兜底包只在有 http/https 来源的页上激活：本页拿不出这样的来源时本轮 packId 恒为空，
   * 此时呈现的 chip 点下去必然查不到模板——一条都不给，与「宁可少给入口」同向。
   */
  async function quickActionScope(
    packsBody: unknown,
  ): Promise<{ packId: string | null; featureId: string | null } | null> {
    const session = sessionPromise === null ? null : await sessionPromise;
    if (session === null) {
      const url = await activeGroupPageUrl();
      if (url === null || isRestrictedPage(url)) return null;
      return { packId: genericPackIdFromPacks(packsBody), featureId: null };
    }
    const injection = await fetch(`${session.baseUrl}/v1/sessions/${session.sessionId}/injection`, {
      headers: { authorization: `Bearer ${session.token}` },
      signal: abort.signal,
    });
    if (!injection.ok) return null;
    const description = await injection.json() as { packId?: unknown; featureId?: unknown };
    return {
      packId: typeof description.packId === 'string' ? description.packId : null,
      featureId: typeof description.featureId === 'string' ? description.featureId : null,
    };
  }

  /**
   * 本页可呈现的快捷提问（R-5）：只经两个无会话投影端点取数（/v1/packs 的 L1 声明 + /v1/user-config
   * 的 L2 覆盖层，与配置中心同源），合并口径与服务端展开同源。任一环节读不出即回空清单——宁可少给
   * 入口，也不给一条点下去会被服务端按未知 id 回退的 chip。
   * 返回的同一份清单同时派生右键菜单：一份数据两入口。
   */
  async function resolveQuickActions(siteDenied: boolean): Promise<QuickActionView[]> {
    // 命中站点黑名单的页连取数都不发：快捷动作属激活后的能力，黑名单是「本页不激活」。
    // 派生的右键项一并撤掉（兜底入口不属快捷提问，仍留）。
    if (siteDenied) {
      await syncContextMenus([]);
      return [];
    }
    try {
      const baseUrl = await readServerBaseUrl();
      const token = await identity.getToken(baseUrl);
      const auth = { authorization: `Bearer ${token}` };
      const [packsRes, userConfig] = await Promise.all([
        fetch(`${baseUrl}/v1/packs`, { headers: auth, signal: abort.signal }),
        fetchUserConfig(baseUrl, token),
      ]);
      if (!packsRes.ok) return [];
      const packsBody: unknown = await packsRes.json();
      const scope = await quickActionScope(packsBody);
      if (scope === null) return [];
      const merged = mergeQuickActions(
        quickActionsFromPacks(packsBody, scope.packId),
        quickActionsFromUserConfig(userConfig, scope.packId),
        scope.featureId,
      );
      await syncContextMenus(merged);
      return merged;
    } catch {
      return [];
    }
  }

  /** 右键选区：面板可能尚未挂上（本次点击才打开），故先缓存一条、待面板 ready 再投。 */
  let pendingComposerQuote: string | null = null;
  function queueComposerQuote(text: string): void {
    if (panels.size > 0) {
      postToPanels({ kind: 'compose-quote', text });
      return;
    }
    pendingComposerQuote = text;
  }

  /** 右键快捷提问：与选区引用同一条「面板可能还没挂上」的时序，故同样先缓存一条。 */
  let pendingQuickAction: Extract<BackgroundToSidePanelMessage, { kind: 'compose-quick-action' }> | null = null;
  function queueQuickAction(
    message: Extract<BackgroundToSidePanelMessage, { kind: 'compose-quick-action' }>,
  ): void {
    if (panels.size > 0) {
      postToPanels(message);
      return;
    }
    pendingQuickAction = message;
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
        if (pendingComposerQuote !== null) {
          postPanel(port, { kind: 'compose-quote', text: pendingComposerQuote });
          pendingComposerQuote = null;
        }
        if (pendingQuickAction !== null) {
          postPanel(port, pendingQuickAction);
          pendingQuickAction = null;
        }
        void reportPanelPages().catch(() => {});
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
      if (message.kind === 'quick-actions-request') {
        void resolveQuickActions(message.siteDenied).then((actions) =>
          postPanel(port, { kind: 'quick-actions', actions }),
        );
        return;
      }
      if (message.kind === 'attach-page') {
        void attachPageFromPanel(message.tabId).then((ok) =>
          postPanel(port, { kind: 'attach-page-result', tabId: message.tabId, ok }),
        );
        return;
      }
      if (message.kind === 'stop-operation') {
        const messageId = message.messageId;
        // 置位同步先于一切等待：此刻还在落页串行链上的帧不得再送到页面执行。
        operationStopped = true;
        // 广播到全部成员端口，不只活跃页：定向批次按帧上句柄反查 tabId 投递，
        // 落点与谁是活跃页无关，只通知活跃页等于放任其余页把剩余步骤跑完。
        for (const member of contentMembers.members()) {
          postContent(member, { kind: 'stop-operation' });
        }
        if (messageId === undefined) {
          postStatus('已停止当前页面操作。');
          postToPanels({ kind: 'stop-result', accepted: true });
          return;
        }
        if (activeTurnIds.has(messageId) || inflightTurnIds.has(messageId)) suppressedTurnId = messageId;
        void stopTurn(messageId).then((accepted) => {
          if (!accepted && suppressedTurnId === messageId) suppressedTurnId = null;
          if (accepted) {
            updateHistory((history) => history.filter(
              (event) => !(event.kind === 'frame' && event.frame.type === 'hitl-request'),
            ));
          }
          // 被拒时本机页面侧其实已不可逆地停住（停止态只由新回合复位）：文案须把
          // 「服务端没停」与「本机已停」分开说，否则用户按「没停下来」去处置一个已经停住的本机。
          postStatus(
            accepted
              ? '已停止当前任务。'
              : '本机页面操作已停止；服务端未接受停止请求，该任务可能仍在服务端继续，可稍后重试。',
          );
          postToPanels({ kind: 'stop-result', messageId, accepted });
        });
        return;
      }
      if (message.kind === 'user-message') {
        beginTurn();
        pipeline = pipeline.then(async () => {
          const result = await deliver(message, null);
          if (result.accepted) emitUi({ kind: 'user-echo', text: message.displayText ?? message.text, messageId: message.messageId });
          postToPanels({ kind: 'message-result', messageId: message.messageId, ...result });
        });
        return;
      }
      if (message.kind === 'hitl-decision') {
        pipeline = pipeline.then(async () => {
          const accepted = await forward(message, null);
          if (accepted) updateHistory((history) => removeSettledHitl(history, message.hitlId));
          else postPanel(port, { kind: 'history-replay', events: panelHistory });
          postToPanels({ kind: 'hitl-result', hitlId: message.hitlId, accepted });
        });
        return;
      }
      if (message.kind === 'config-decision') {
        pipeline = pipeline.then(async () => {
          const result = await deliver(message, null);
          const terminal = result.accepted || result.httpStatus === 409 || result.httpStatus === 400;
          if (terminal) {
            // 裁决送达或服务端终态拒绝（409 已消费/过期、400 校验不过）：出历史，卡片不再重现可操作态。
            updateHistory((history) => removeSettledConfigDraft(history, message.draftId));
            if (!result.accepted) {
              emitUi({
                kind: 'status',
                message: '配置草稿已失效或未通过校验，未写入；需要时请重新让助手生成草稿。',
              });
            }
          } else {
            // 网络/5xx 可重试失败：重放历史让卡片恢复可操作。
            postPanel(port, { kind: 'history-replay', events: panelHistory });
          }
        });
        return;
      }
      // 面板发起的会话消息不归属任何页面（origin=null）：面板不是被拉黑的那个页。
      pipeline = pipeline.then(async () => { await forward(message, null); });
    });
    port.onDisconnect.addListener(() => detachPanel(port));
  }

  /** 本组 tab 集/URL 可能变化（tabs.onUpdated/onRemoved）→ 防抖后重报全量清单。 */
  const notifyGroupTabsChanged = (): void => scheduleGroupPagesReport();

  return { attachContent, attachPanel, queueComposerQuote, queueQuickAction, configurationChanged, notifyGroupTabsChanged, close };
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

/**
 * 本机站点黑名单缓存读回（来自 refreshUserConfigMirrors 的那次 /v1/user-config）。
 * 缓存缺失/读失败一律回空名单：治理终判在服务端 compose，客户端不确定时不拦（U7）。
 */
async function readSiteDenylist(): Promise<string[]> {
  const items: Record<string, unknown> = await chrome.storage.local
    .get(SITE_DENYLIST_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return parseSiteDenylist(items[SITE_DENYLIST_KEY]);
}

/**
 * 轨一的一次性注入（不变量 IN 的 (a) 半）：把插件自带的 content 产物打进目标页。
 * 载荷恒为 CONTENT_SCRIPT_FILE——pack 与 L2 都无从改写它（R2）。
 * 失败即返回 false（该 origin 未授权且无 activeTab / 页面不可注入），调用方按「本页无 content」处置：
 * 不降级、不改投、不伪装成功。content 侧的重复注入守卫使本调用幂等。
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 本机 chrome.permissions 是否已覆盖该地址所属 origin（面板清单据此说明「缺站点访问权限」）。
 * 地址不可解析或查询失败一律按未覆盖：此判定只用于向用户解释现象，宁可多给一次重试入口。
 */
async function originGrantedFor(url: string): Promise<boolean> {
  const pattern = permissionPatternFor(url);
  if (pattern === null) return false;
  return chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
}

/** 已授权 origin 的本机缓存读回（来自 refreshUserConfigMirrors 的那次 /v1/user-config）。 */
async function readGrantedOrigins(): Promise<string[]> {
  const items: Record<string, unknown> = await chrome.storage.local
    .get(GRANTED_ORIGINS_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return parseGrantedOrigins(items[GRANTED_ORIGINS_KEY]);
}

/**
 * 轨二的常驻注册面对齐（不变量 IN 的 (b) 半）：注册集 = L2 投影 ∩ 本机 chrome.permissions − 站点黑名单。
 * 每次全量对齐而非增量补丁：授权、L2、黑名单三方任一变动都只在这一处收敛，
 * 「注册了什么」因此恒可由三方当刻状态推出，不依赖历史事件是否都被收到。
 * 注册与注销严格对称，且只碰本族 id（其余注入面不属本机制）。
 */
async function syncContentScriptRegistrations(): Promise<void> {
  try {
    const denylist = await readSiteDenylist();
    const granted = await chrome.permissions.getAll().catch(() => ({}) as { origins?: string[] });
    const desired = decideRegisteredOrigins({
      l2Origins: await readGrantedOrigins(),
      grantedPatterns: granted.origins ?? [],
      deniedBy: (origin) => siteDeniesUrl(denylist, origin),
    });
    const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const plan = planRegistrations(desired, existing.map((item) => item.id));
    if (plan.unregister.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: plan.unregister }).catch(() => {});
    }
    if (plan.register.length > 0) await chrome.scripting.registerContentScripts(plan.register).catch(() => {});
  } catch {
    // 注册面对齐失败不影响会话主链路；下一次配置变更或冷启动再对齐。
  }
}

/**
 * 不变量 SD 的唯一判定：该页是否落在用户站点黑名单内。三处闸门（上行出口 / 下行落页 /
 * 活跃页登记）与激活闸门共用它，判定逻辑因此只有一份。
 * tabId 与 url 同时给出时任一命中即拦：tab 记录与页面自述各有滞后窗口，取并集只会更严。
 * 名单为空时不查 tab：绝大多数用户名单为空，省掉每次一趟 tabs.get。
 * 取址口径与组页面清单同源（tabUrlOf）：导航尚未提交的新页地址只在 pendingUrl 上。
 */
async function isSiteDeniedPage(page: { tabId?: number | undefined; url?: string | undefined }): Promise<boolean> {
  const denylist = await readSiteDenylist();
  if (denylist.length === 0) return false;
  if (siteDeniesUrl(denylist, page.url)) return true;
  if (page.tabId === undefined) return false;
  const tab = await chrome.tabs.get(page.tabId).catch(() => null);
  return tab !== null && siteDeniesUrl(denylist, tabUrlOf(tab));
}

/**
 * 「本机确实跳过了这一页的激活」的事实登记/撤销。
 * 面板的客户端自述只认这条事实——按「当前 URL 命中名单」推断会在「拉黑前已激活、
 * 地址早已上报」这条最常见流程上说假话，而那一轮服务端确实见过该页、它的 site-denied
 * 抬头比客户端的猜测权威。
 */
async function noteActivationSkipped(tabId: number, skipped: boolean): Promise<void> {
  const key = siteDeniedSkipKey(tabId);
  await (skipped
    ? chrome.storage.session.set({ [key]: true })
    : chrome.storage.session.remove(key)
  ).catch(() => {});
  // 快捷提问属激活后的能力：本机跳过了这一页的激活，右键项就一条都不该留着。
  // 面板那一侧自然不会有（命中页面板根本不建组、不连端口），右键菜单是全局的，须显式撤。
  if (skipped) await syncContextMenus([]);
}

/**
 * 撤销不再成立的「跳过激活」登记。面板的客户端自述只认这条事实：名单条目被移出、
 * 或该页早已导航离开命中站点之后仍留着它，面板就会对着一个照常辅助的页说「本站不辅助」。
 * 不确定一律撤销（tab 已关闭 / 名单读不到）：多撤一次只是让服务端描述照常呈现，留着才是说假话。
 */
async function revokeStaleActivationSkip(tabId: number): Promise<void> {
  const key = siteDeniedSkipKey(tabId);
  const items = await chrome.storage.session.get(key).catch(() => ({}) as Record<string, unknown>);
  if (items[key] !== true) return;
  if (await isSiteDeniedPage({ tabId })) return;
  await noteActivationSkipped(tabId, false);
}

/** 名单变更后逐条复核全部登记：变更事件不带受影响的 tab 集，只能全表过一遍。 */
async function revokeStaleActivationSkips(): Promise<void> {
  const items = await chrome.storage.session.get(null).catch(() => ({}) as Record<string, unknown>);
  for (const [key, value] of Object.entries(items)) {
    const tabId = siteDeniedSkipTabId(key);
    if (tabId !== null && value === true) await revokeStaleActivationSkip(tabId);
  }
}

/**
 * 把执行器放进该页并通知它挂面板连接（不变量 IN 轨一的唯一出口）。
 * 注入与激活恒同出一口：任何激活入口都必须先保证 content 在场，否则「已激活」只是一句空话。
 * executeScript 失败（该 origin 未授权且无 activeTab / 页面本身不可注入）即就此收手，连激活也不发——
 * 本页保持无 content，不降级、不改投，页面能力随之缺席，服务端按目标不可达处置。
 * 返回值即「执行器是否已进到这一页」：面板的手动补接入据此如实回执，不猜、不降级。
 * content 侧的重复注入守卫使本调用幂等。
 * 本函数内的黑名单判定是**兜底**：它在全部激活入口（握手 / 工具栏图标 / 组内导航补发 /
 * 拖入已映射组 / navigate 代执行开页）的最后一步，保证任何入口都发不出激活。
 * 用户可见副作用（建组、登记 zen 组、绑面板）发生在各入口更早处，故握手与图标两个入口
 * 另有一处早退判定（见 handleRequestActivate / handleIconClick）——那处管副作用，这处管激活，
 * 两处职责不同，不是重复判定（判定逻辑仍只有 isSiteDeniedPage 一份）。
 * 每条路径都就地登记/撤销「本机跳过了这一页的激活」的事实，面板的客户端自述只认它。
 */
async function sendActivate(tabId: number): Promise<boolean> {
  if (await isSiteDeniedPage({ tabId })) {
    await noteActivationSkipped(tabId, true);
    return false;
  }
  await noteActivationSkipped(tabId, false);
  if (!(await injectContentScript(tabId))) return false;
  const message: BackgroundRuntimeMessage = { kind: 'activate' };
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});
  return true;
}

// SPA 同文档导航（pushState/replaceState 无 window 事件）后促已激活页重报上下文，使服务端装配跟随新子路由。
async function sendRefreshContext(tabId: number): Promise<void> {
  const message: BackgroundRuntimeMessage = { kind: 'refresh-context' };
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

/** 新建 zen 标签页组并命名（同 origin 多组各自独立）；返回新组 id。 */
async function createZenGroup(tabId: number): Promise<number> {
  const groupId = await chrome.tabs.group({ tabIds: tabId });
  await chrome.tabGroups.update(groupId, { title: 'Zen', color: 'purple' }).catch(() => {});
  return groupId;
}

/** 只迁移本扩展旧版本使用的精确名称，不覆盖用户自定义的标签组标题。 */
async function migrateLegacyGroupTitle(groupId: number): Promise<void> {
  const group = (await chrome.tabGroups.query({}).catch(() => [])).find((candidate) => candidate.id === groupId);
  if (group?.title === 'commerce') {
    await chrome.tabGroups.update(groupId, { title: 'Zen', color: 'purple' }).catch(() => {});
  }
}

/**
 * content 就位后的激活握手：按 decideActivation 决定组内换页恢复或不激活。
 * 脚本在页内不构成「该页要开会话」的理由——轨二已授权 origin 上的常驻注册同样会送来这条握手，
 * 建组只发生在手势入口。决策后以 chrome.tabs.sendMessage 通知该页挂面板连接（content 侧幂等）。
 */
async function handleRequestActivate(sender: chrome.runtime.MessageSender): Promise<void> {
  const tab = sender.tab;
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  // 早退管副作用：下面的登记 zen 组 / 绑面板会被用户看见，判定必须先于它们发生。
  if (await isSiteDeniedPage({ tabId })) {
    await noteActivationSkipped(tabId, true);
    return;
  }
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  // zen 组登记先于会话建立：会话尚未映射时组内导航的新页也须重连，否则该页 content 永久沉默。
  const groupIsMapped =
    tabGroupId !== TAB_GROUP_ID_NONE &&
    ((await isGroupMapped(tabGroupId)) || (await isZenGroup(tabGroupId)));
  const decision = decideActivation({ tabGroupId, groupIsMapped });
  if (decision.kind === 'none') return;
  const activeGroupId = decision.groupId;
  await migrateLegacyGroupTitle(activeGroupId);
  await markZenGroup(activeGroupId);
  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [panelGroupKey(tab.windowId)]: activeGroupId });
  }
  await applyPanelForTabId(tabId);
  await sendActivate(tabId);
}

/** 图标点击：未分组 tab 新建独立 zen 组（同 origin 多组独立）；已属某组则采用该组当会话组。 */
async function handleIconClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  // 同 handleRequestActivate：早退管副作用（建组/登记/绑面板），激活本身仍由 sendActivate 兜底。
  // 工具栏手势自身的面板 enable/open 不在此判定内——那两步必须在手势内同步发出，中间不得 await。
  if (await isSiteDeniedPage({ tabId: tab.id })) {
    await noteActivationSkipped(tab.id, true);
    return;
  }
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  const groupId = tabGroupId === TAB_GROUP_ID_NONE ? await createZenGroup(tab.id) : tabGroupId;
  await migrateLegacyGroupTitle(groupId);
  await markZenGroup(groupId);
  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [panelGroupKey(tab.windowId)]: groupId });
  }
  await applyPanelForTab({ ...tab, groupId });
  await sendActivate(tab.id);
}

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
  if (message?.kind === 'request-activate') void handleRequestActivate(sender);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void runToolbarSidePanelAction({
    enablePanel: () => chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true }),
    openPanel: () => chrome.sidePanel.open({ tabId }),
    activatePage: () => handleIconClick(tab),
  }).catch(() => {
    console.error('Zen Agent 工具栏激活失败');
  });
});

const SELECTION_MENU_ID = 'za-explain-selection';

/** 派生自快捷提问清单的菜单项 id 前缀；其后缀即 quickActionId。 */
const QUICK_ACTION_MENU_PREFIX = 'za-qa:';

/** 已注册的派生菜单项 id → label：点击回执要带 label 作本地回声，chrome 的 info 不回传标题。 */
const quickActionMenuLabels = new Map<string, string>();

/**
 * 右键菜单 = 兜底入口 + 快捷提问清单派生项（一份数据两入口）。兜底项「用 Zen 讲解选中内容」常驻：
 * 它不带 quickActionId、走既有引用块路径由用户补充意图，与本页有没有 selection 类问法无关。
 * 入参只决定其后追加什么：null = 尚不知道本页有哪些条目（SW 冷启、面板未开），不追加；
 * [] = 已知本页没有可呈现条目（命中站点黑名单或全被停用），不追加；非空 = 逐条按 label 追加。
 * create 对已存在 id 会抛重复，故每次先 removeAll。
 */
async function syncContextMenus(actions: QuickActionView[] | null): Promise<void> {
  await chrome.contextMenus.removeAll().catch(() => {});
  quickActionMenuLabels.clear();
  chrome.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: '用 Zen 讲解选中内容',
    contexts: ['selection'],
  });
  if (actions === null) return;
  for (const action of selectionQuickActions(actions)) {
    const menuId = `${QUICK_ACTION_MENU_PREFIX}${action.id}`;
    quickActionMenuLabels.set(menuId, action.label);
    chrome.contextMenus.create({ id: menuId, title: action.label, contexts: ['selection'] });
  }
}

void syncContextMenus(null);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const menuId = String(info.menuItemId);
  const label = quickActionMenuLabels.get(menuId);
  if (menuId !== SELECTION_MENU_ID && label === undefined) return;
  const text = (info.selectionText ?? '').trim();
  if (text === '' || tab?.id === undefined) return;
  const tabId = tab.id;
  const selectionTab = tab;
  // 菜单点击即用户手势：enable/open 与 action 点击同路径发出，中间不得 await（否则手势失效）。
  void runToolbarSidePanelAction({
    enablePanel: () => chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true }),
    openPanel: () => chrome.sidePanel.open({ tabId }),
    activatePage: () => handleIconClick(selectionTab),
  })
    .then(async () => {
      const groupId = (await chrome.tabs.get(tabId)).groupId ?? TAB_GROUP_ID_NONE;
      if (groupId === TAB_GROUP_ID_NONE) return;
      const bridge = bridgeFor(groupId);
      if (label === undefined) {
        bridge.queueComposerQuote(text);
        return;
      }
      bridge.queueQuickAction({
        kind: 'compose-quick-action',
        actionId: menuId.slice(QUICK_ACTION_MENU_PREFIX.length),
        label,
        selectionText: text,
      });
    })
    .catch(() => {
      console.error('Zen Agent 选区讲解入口失败');
    });
});

/**
 * L2 个人配置的单次拉取：站点黑名单与已授权 origin 同源于这一次响应，不为任一项另发请求。
 * 任一环节失败即回 null，由各派生方按自身的不确定语义处置。
 */
async function fetchUserConfig(baseUrl: string, token: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/v1/user-config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * 本机 L2 镜像键刷新：站点黑名单与已授权 origin 只在本轮确实拿到 L2 配置时覆写；
 * 拉取失败保留上次值——名单是隐私开关，网络抖动不该把它静默清空（宁可多挡一站）。
 * 应答成功但无该键即用户已清空，照实写空。
 */
async function refreshUserConfigMirrors(): Promise<void> {
  try {
    const baseUrl = await readServerBaseUrl();
    const token = await identity.getToken(baseUrl);
    const userConfig = await fetchUserConfig(baseUrl, token);
    if (userConfig !== null) {
      await chrome.storage.local.set({
        [SITE_DENYLIST_KEY]: siteDenylistFromUserConfig(userConfig),
        [GRANTED_ORIGINS_KEY]: grantedOriginsFromUserConfig(userConfig),
      });
    }
    await syncContentScriptRegistrations();
  } catch {
    // 网络/配置异常不影响既有缓存与会话主链路。
  }
}

void refreshUserConfigMirrors();
chrome.runtime.onStartup.addListener(() => void refreshUserConfigMirrors());
chrome.runtime.onInstalled.addListener(() => void refreshUserConfigMirrors());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const installIdChange = changes['za.installId'];
  if (installIdChange !== undefined || changes['za.serverBaseUrl'] !== undefined) {
    void (async () => {
      // 换身份 = 换 installId：先丢弃旧身份令牌，否则后续会话仍以旧 subject 建立。
      // 首次生成（无 oldValue）不是换身份，此时缓存本就为空，不必多跑一次激活。
      if (installIdChange !== undefined && installIdChange.oldValue !== undefined) {
        await identity.invalidate();
      }
      for (const bridge of groups.values()) bridge.configurationChanged();
      await refreshUserConfigMirrors();
    })();
    return;
  }
  // background 的 L2 刷新（refreshUserConfigMirrors）以一次 storage.local.set 同写这两个镜像键，故它们可能同批到达：
  // 两者各自的处置必须都执行，任一分支不得吞掉另一分支（注册面只由两者的当刻交集推出，对齐一次即可）。
  const grantedChanged = changes[GRANTED_ORIGINS_KEY] !== undefined;
  const denylistChanged = changes[SITE_DENYLIST_KEY] !== undefined;
  if (grantedChanged || denylistChanged) {
    void syncContentScriptRegistrations();
    if (denylistChanged) {
      // 名单变更即重报组页面清单：服务端持有的旧清单里，命中页的 url/title 仍在按 active 优先
      // 进模型注入面——不重报则用户拉黑之后那条记录仍旧一直被读到。
      for (const bridge of groups.values()) bridge.notifyGroupTabsChanged();
      void revokeStaleActivationSkips();
    }
    return;
  }
});

// 切标签页即重判面板可见性：面板只在 zen 组的标签页上显示，并绑定该组会话。
chrome.tabs.onActivated.addListener((activeInfo) => {
  void applyPanelForTabId(activeInfo.tabId);
});

/**
 * 由组内页面打开的新页在创建当刻先启用面板。
 * 代执行开页是「创建→入组→设为活跃」的异步序列，入组事件到达之前它就可能成为活跃页；
 * SW 被回收重启后又会重跑一次全局禁用，此后没有逐页设置的新页同样落回禁用态。
 * 两种窗口里 Chrome 都会把侧边栏关掉，且切回启用页也不自动重开——故此处只开不关：
 * 这一刻新页可能尚未入组（groupId 仍为 -1），按当刻状态去关会关掉正在打开的面板。
 */
chrome.tabs.onCreated.addListener((tab) => {
  void enablePanelForOpenedTab(tab);
});

async function enablePanelForOpenedTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
  const opener = tab.openerTabId === undefined ? null : await chrome.tabs.get(tab.openerTabId).catch(() => null);
  const openerGroupId = opener?.groupId ?? TAB_GROUP_ID_NONE;
  const candidate = tabGroupId !== TAB_GROUP_ID_NONE ? tabGroupId : openerGroupId;
  if (candidate === TAB_GROUP_ID_NONE || !(await isZenGroup(candidate))) return;
  await chrome.sidePanel
    .setOptions({ tabId, path: 'sidepanel.html', enabled: true })
    .catch(() => {});
}

/**
 * 站点访问权限到手即补注入：某页因缺该站点权限注入失败后，用户随后在扩展设置里授予权限
 * 不会重放这一页的激活——不补这一刀，那一页要等它重新加载或被重新激活才接得上。
 * 逐个任务组成员重走激活出口（sendActivate 自带黑名单闸门与幂等守卫），组外页一概不碰。
 */
chrome.permissions.onAdded.addListener(() => {
  void reattachZenGroupTabs();
});

async function reattachZenGroupTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
    if (tab.id === undefined || tabGroupId === TAB_GROUP_ID_NONE) continue;
    if (!(await isZenGroup(tabGroupId))) continue;
    await sendActivate(tab.id);
  }
}

// 拖 tab 入某 zen 会话组（groupId 变为已映射组）→ 通知该页激活并接入同一会话。
// 面板可见性：离组必关；入组只在该组确为 zen 组时开，**入组一律不关**——
// 点图标建组时本事件先于"登记 zen 组"到达，此处若据尚未登记的状态去关，
// 会把同一次点击正在打开的面板关掉（表现为要点两次才出面板）。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 组内同 tab 导航：新页加载完成即补发激活，使其自动接入本组会话并上报 context-report。
  if (changeInfo.status === 'complete') {
    const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
    if (tabGroupId !== TAB_GROUP_ID_NONE) {
      void isZenGroup(tabGroupId).then((zen) => {
        if (zen) void sendActivate(tabId);
      });
    }
  }
  // 该页可能已导航离开命中站点：跳过登记随事实撤销，面板不再对着照常辅助的页说「本站不辅助」。
  if (changeInfo.url !== undefined) void revokeStaleActivationSkip(tabId);
  // 同文档导航（url 变而无 status）：整页加载会带 status，故 url-only 专指 SPA 子路由切换；
  // 促已激活页重报上下文让服务端重新装配。hash/back-forward 另有 content 侧 window 监听即时补报，
  // 此路对其为幂等重报（同 url 的 context-report 无副作用），主要覆盖 pushState/replaceState。
  if (changeInfo.status === undefined && changeInfo.url !== undefined) {
    const tabGroupId = tab.groupId ?? TAB_GROUP_ID_NONE;
    if (tabGroupId !== TAB_GROUP_ID_NONE) {
      void isZenGroup(tabGroupId).then((zen) => {
        if (zen) void sendRefreshContext(tabId);
      });
    }
  }
  // group-pages 触发（adr-023 D1）：本组 tab 的 url 变更/加载完成 → 该组重报；
  // 入组/离组（groupId 变化）时事件不带旧组号，广播全部在场桥各自重查（防抖合并，代价可忽略）。
  if (changeInfo.groupId !== undefined) {
    for (const bridge of groups.values()) bridge.notifyGroupTabsChanged();
  } else if (changeInfo.url !== undefined || changeInfo.status === 'complete') {
    groups.get(tab.groupId ?? TAB_GROUP_ID_NONE)?.notifyGroupTabsChanged();
  }
  const groupId = changeInfo.groupId;
  if (groupId === undefined) return;
  if (groupId === TAB_GROUP_ID_NONE) {
    void applyPanelForTabId(tabId);
    return;
  }
  void isZenGroup(groupId).then((zen) => {
    if (zen) void applyPanelForTabId(tabId);
  });
  void isGroupMapped(groupId).then((mapped) => {
    if (mapped) void sendActivate(tabId);
  });
});

// 关闭的 tab 可能是某组成员（事件不带组号）：广播全部在场桥重报清单。
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(siteDeniedSkipKey(tabId)).catch(() => {});
  for (const bridge of groups.values()) bridge.notifyGroupTabsChanged();
});

// 组关闭=关会话：清 groupId→sessionId 存根并关桥（storage.session 存根在此才清，区别于组内换页重连）。
chrome.tabGroups.onRemoved.addListener((group) => {
  void chrome.storage.session.remove(zenGroupKey(group.id)).catch(() => {});
  void chrome.storage.session.remove(sessionKeyForGroup(group.id)).catch(() => {});
  void chrome.storage.session.remove(execNonceKeyForGroup(group.id)).catch(() => {});
  void chrome.storage.session.remove(pageHandlesKeyForGroup(group.id)).catch(() => {});
  const bridge = groups.get(group.id);
  if (bridge !== undefined) {
    bridge.close();
    groups.delete(group.id);
  }
});
