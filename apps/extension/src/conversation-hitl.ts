import type {
  HitlDecisionValue,
  HitlEffect,
  HitlPackDisplay,
  HitlRequestFrame,
  JsonObject,
  PackSource,
  TextDeltaFrame,
  ToolCardFrame,
} from './frames.js';
import { renderMarkdown } from './markdown.js';

type ToolMode = NonNullable<ToolCardFrame['mode']>;
type ToolStatus = ToolCardFrame['status'];

/** 一批工具调用的折叠区：收起态只留 toggle 上的机械摘要，展开才列出 body 内每条调用。 */
interface ToolGroup {
  toggle: HTMLButtonElement;
  summary: HTMLElement;
  body: HTMLElement;
}

const MODE_LABEL: Record<ToolMode, string> = {
  client: '客户端发起',
  server: '服务端发起',
};

/** 本地即时回显的气泡句柄：服务端回声到达即以权威文本落定，投递失败则撤下。 */
export interface UserMessageHandle {
  settle(text: string): void;
  remove(): void;
}

export interface ConversationUi {
  appendUserMessage(text: string): UserMessageHandle;
  /**
   * 回合首个 delta 开新 assistant 气泡并增量追加（气泡内累积重渲染，markdown 结构不被切碎）。
   * 气泡在遇到回合边界前一直开着：流中途停顿多久都续写同一个。
   */
  appendTextDelta(frame: TextDeltaFrame): void;
  /**
   * 封口当前回合气泡（turn-complete 帧驱动），此后的 delta 另起一个回合气泡。
   * 工具卡、确认卡、状态行与用户发言同样封口——它们各自也是回合边界。
   */
  completeTurn(): void;
  /** 呈现可定位、不含 token/密钥值的错误或状态说明（SEC-04）。 */
  showStatus(message: string): void;
  showThinking(): void;
  hideThinking(): void;
  /** 同批工具调用折叠成一行（默认收起，摘要含未成功计数）；展开后逐条列出状态与可选原因。 */
  renderToolCard(frame: ToolCardFrame): void;
  /** 弹 HITL 卡片等用户裁决；客户端只呈现与回传、零治理判定。 */
  promptHitl(frame: HitlRequestFrame): Promise<HitlDecisionValue | null>;
  /** 停止当前回合时撤下未决授权卡；null 表示不向服务端回传新的裁决。 */
  cancelHitl(): void;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: '执行中',
  succeeded: '已完成',
  failed: '未成功',
};

/** 折叠摘要里各状态的出现次序：进行中在前（当下正发生什么），未成功殿后但恒不省略。 */
const SUMMARY_ORDER: ToolStatus[] = ['running', 'succeeded', 'failed'];

/** delta 静默多久撤下闪烁光标。纯观感阈值，不参与回合边界判定。 */
const STREAM_CURSOR_IDLE_MS = 700;

/**
 * 工具卡上的失败原因：服务端已脱敏的展示字段，仅 failed 状态下发。
 * 非空字符串才呈现，缺席或类型不符一律只留状态与工具名，客户端不本地推断成因（U8）。
 */
function failureReasonOf(frame: ToolCardFrame): string | undefined {
  const reason: unknown = frame.failureReason;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

/** 面向用户的实参摘要；仅供 HITL 卡片呈现用户须知悉的将发生内容，不进 tool-card。 */
function summarizeParams(params: JsonObject): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '（无参数）';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('，');
}

/**
 * 任务授权卡上的 agent 自述部分：task/summary/plan 全部由模型撰写，是次要信息——
 * 用户据以裁决的「将发生什么」只看服务端反解的 frame.effects / frame.targetUrl。
 */
function summarizeTask(params: JsonObject): { title: string; claim: string; plan: string[] } {
  const summary = typeof params['summary'] === 'string' ? params['summary'] : '';
  const plan = Array.isArray(params['plan'])
    ? params['plan'].filter((item): item is string => typeof item === 'string')
    : [];
  return { title: String(params['task']), claim: summary, plan };
}

/**
 * 内建导航工具：只有带 task 且计划每项都是去空白后非空的字符串时才按任务授权卡呈现（批准即授权整任务）；
 * 否则是一次性确认卡。判据与服务端的授权登记条件同构，卡面不得与登记结果背离。
 */
const NAVIGATION_TOOL_IDS = new Set(['open_url', 'site_navigate']);

function isTaskGrantCard(frame: HitlRequestFrame): boolean {
  if (typeof frame.params['task'] !== 'string') return false;
  if (!NAVIGATION_TOOL_IDS.has(frame.toolId)) return true;
  const plan = frame.params['plan'];
  return Array.isArray(plan) && plan.length > 0 && plan.every((item) => typeof item === 'string' && item.trim() !== '');
}

/** pack 来源徽章措辞（与配置中心同表）。 */
const PACK_SOURCE_LABEL: Record<PackSource, string> = {
  official: '官方',
  community: '社区',
  local: '自建',
};

/** 来源 pack 与作用站点行（R4）：只拼服务端给的字段，缺什么略什么，不本地补齐治理语义。 */
function packLineOf(pack: HitlPackDisplay): string {
  const parts = [`站点包「${pack.name ?? pack.packId}」`];
  if (pack.source !== undefined) parts.push(PACK_SOURCE_LABEL[pack.source]);
  if (pack.origin !== undefined) parts.push(pack.origin);
  return `来源：${parts.join(' · ')}`;
}

/** 单条机械摘要行：动作与目标恒有值（服务端反解不出时目标写「目标未知」），值摘要缺席即不显示。 */
function effectLineOf(effect: HitlEffect, index: number): string {
  const head = `${index + 1}. ${effect.action}〈${effect.target}〉`;
  return effect.valuePreview === undefined ? head : `${head}，值：「${effect.valuePreview}」`;
}

/**
 * 治理小字（UI 规范 §5 五要素之一）：措辞固定，有效期只在服务端下发 ttlMs 时标注——
 * 不编造一个平台并不保证的时限。
 */
function governanceNoteOf(ttlMs: number | undefined): string {
  const parts = ['一次性签名指令'];
  if (ttlMs !== undefined) parts.push(`${Math.round(ttlMs / 1000)} 秒内有效`);
  parts.push('全程审计留痕');
  return parts.join(' · ');
}

const WHO_LABEL: Record<'user' | 'assistant', string> = {
  user: '你',
  assistant: 'Zen Agent',
};

const SITE_ACCESS_DESCRIPTOR = { origins: ['<all_urls>'] };

const SITE_ACCESS_NOTE = '首次授权时浏览器会询问站点访问权限（仅用于本任务打开的页面），之后不再询问';

/**
 * 批准手势内补齐站点访问权限：chrome.permissions.request 只能在用户手势里调用，故 contains 必须在
 * 点击处理里同步发起、中间不得 await 别的事。只补权限、不注入——注入仍只由 background 按会话动作触发。
 * 用户拒绝或 API 异常都不改变裁决结果：返回的 promise 恒 resolve，调用方据此继续回传 approve。
 */
function ensureSiteAccess(): Promise<void> {
  const permissions = (globalThis as { chrome?: { permissions?: typeof chrome.permissions } }).chrome
    ?.permissions;
  if (permissions === undefined) return Promise.resolve();
  try {
    return permissions
      .contains(SITE_ACCESS_DESCRIPTOR)
      .then((held) => (held ? undefined : permissions.request(SITE_ACCESS_DESCRIPTOR).then(() => undefined)))
      .catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function createConversationUi(messages: HTMLElement): ConversationUi {
  // 当前未封口的 assistant 气泡与其 .mdlite 容器；累积原始文本每次 delta 后全量重渲染，
  // 保证 markdown 结构完整（跨 delta 未闭合的 ** 或代码围栏不会被切成两半各渲一截）。
  let assistantBub: HTMLElement | null = null;
  let assistantBody: HTMLElement | null = null;
  let assistantRaw = '';
  // 闪烁光标的撤下时机：无 done 帧，以「最后一个 delta 后短暂静默」判定当下没在出字。
  // 它只管光标，不管封口——模型流中途的停顿不是回合结束。
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  // 本次用户发言以来已开的 assistant 气泡数；≥2 即为同一轮任务内的后续回合，需署名标号与分隔。
  let assistantTurn = 0;
  // 同一 toolCallId 的状态迁移就地更新同一张卡片（连同它所属的组摘要），避免 running→succeeded 产生两张卡。
  const toolCards = new Map<string, { card: HTMLElement; group: ToolGroup }>();
  // 当前这批工具卡按调用模式归组；批次被文本/用户发言/确认卡打断即清空，下一批另起新组。
  const toolGroups = new Map<ToolMode, ToolGroup>();
  let thinking: HTMLElement | null = null;
  let pendingHitl: { card: HTMLElement; resolve: (decision: HitlDecisionValue | null) => void } | null = null;

  const scrollToEnd = (): void => {
    messages.scrollTop = messages.scrollHeight;
  };

  const hideStreamCursor = (): void => {
    if (cursorTimer !== null) {
      clearTimeout(cursorTimer);
      cursorTimer = null;
    }
    assistantBub?.classList.remove('streaming');
  };

  /**
   * 封口当前回合气泡：后续 delta 另起一个，回合边界不被叙述连成一坨。
   * 只由真实的回合边界触发（turn-complete 帧、工具卡、确认卡、状态行、用户发言），
   * 静默时长不构成边界——按静默封口会把一段完整回答切成两半。
   */
  const closeAssistantTurn = (): void => {
    hideStreamCursor();
    assistantBub = null;
    assistantBody = null;
    assistantRaw = '';
  };

  /** 收束当前工具批次：已渲染的卡仍可就地迁移状态，但后续新卡另起一组。 */
  const closeToolBatch = (): void => {
    toolGroups.clear();
  };

  /** 每条消息＝wrapper[data-role] > .za-who 署名 + .za-bub 气泡；turn ≥2 标出回合序号与分隔。 */
  const appendMessage = (role: 'user' | 'assistant', turn = 1): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'za-msg';
    wrap.dataset['role'] = role;
    if (turn > 1) wrap.classList.add('za-msg-turn');
    const who = document.createElement('div');
    who.className = 'za-who';
    who.textContent = turn > 1 ? `${WHO_LABEL[role]} · 回合 ${turn}` : WHO_LABEL[role];
    const bub = document.createElement('div');
    bub.className = 'za-bub';
    wrap.append(who, bub);
    // 思考指示器已在列表末尾时，新消息插到它前面，保证"用户消息 → 思考中"的时序阅读顺序。
    if (thinking !== null) messages.insertBefore(wrap, thinking);
    else messages.append(wrap);
    return bub;
  };

  /**
   * 收起态那一行的机械摘要与聚合状态：只数本组已渲染的卡，不做任何解释性归因。
   * 未成功计数恒不省略——收起是为降噪，不是为藏失败。
   */
  const refreshToolGroup = (group: ToolGroup): void => {
    const counts: Record<ToolStatus, number> = { running: 0, succeeded: 0, failed: 0 };
    for (const card of group.body.querySelectorAll('[data-za-toolcard]')) {
      const status = card.getAttribute('data-status');
      if (status === 'running' || status === 'succeeded' || status === 'failed') counts[status] += 1;
    }
    group.summary.textContent = SUMMARY_ORDER.filter((status) => counts[status] > 0)
      .map((status) => `${counts[status]} 步${STATUS_LABEL[status]}`)
      .join(' · ');
    group.toggle.dataset['status'] =
      counts.running > 0 ? 'running' : counts.failed > 0 ? 'failed' : 'succeeded';
  };

  const ensureToolGroup = (mode: ToolMode): ToolGroup => {
    const existing = toolGroups.get(mode);
    if (existing !== undefined) return existing;

    const section = document.createElement('div');
    section.className = 'za-toolgroup';
    section.dataset['mode'] = mode;
    section.dataset['expanded'] = 'false';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'za-toolgroup-toggle';
    toggle.setAttribute('data-za-toolgroup-toggle', '');
    toggle.setAttribute('aria-expanded', 'false');
    const state = document.createElement('span');
    state.className = 'za-toolcard-state';
    state.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'za-toolgroup-title';
    title.textContent = MODE_LABEL[mode];
    const summary = document.createElement('span');
    summary.className = 'za-toolgroup-summary';
    const caret = document.createElement('span');
    caret.className = 'za-toolgroup-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '›';
    toggle.append(state, title, summary, caret);

    const body = document.createElement('div');
    body.className = 'za-toolgroup-body';
    body.hidden = true;

    section.append(toggle, body);
    messages.append(section);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      section.dataset['expanded'] = String(expanded);
      body.hidden = !expanded;
    });

    const group: ToolGroup = { toggle, summary, body };
    toolGroups.set(mode, group);
    return group;
  };

  return {
    appendUserMessage(text) {
      closeAssistantTurn();
      closeToolBatch();
      assistantTurn = 0;
      const bubble = appendMessage('user');
      bubble.textContent = text;
      scrollToEnd();
      return {
        settle(next) {
          bubble.textContent = next;
        },
        remove() {
          bubble.parentElement?.remove();
        },
      };
    },
    appendTextDelta(frame) {
      if (assistantBody === null) {
        closeToolBatch();
        assistantTurn += 1;
        assistantBub = appendMessage('assistant', assistantTurn);
        assistantBody = document.createElement('div');
        assistantBody.className = 'za-md mdlite';
        assistantBub.append(assistantBody);
        assistantRaw = '';
      }
      assistantBub?.classList.add('streaming');
      assistantRaw += frame.delta;
      assistantBody.textContent = '';
      assistantBody.append(renderMarkdown(assistantRaw));
      scrollToEnd();
      // 去抖：静默一小段即认为当下没在出字，撤下光标；气泡仍开着，续来的 delta 接着写同一个。
      if (cursorTimer !== null) clearTimeout(cursorTimer);
      cursorTimer = setTimeout(hideStreamCursor, STREAM_CURSOR_IDLE_MS);
    },
    completeTurn() {
      closeAssistantTurn();
    },
    showStatus(message) {
      closeAssistantTurn();
      closeToolBatch();
      thinking?.remove();
      thinking = null;
      const status = document.createElement('div');
      status.className = 'za-status';
      status.textContent = message;
      messages.append(status);
      messages.scrollTop = messages.scrollHeight;
    },
    showThinking() {
      if (thinking !== null) return;
      thinking = document.createElement('div');
      thinking.className = 'za-thinking';
      thinking.setAttribute('role', 'status');
      thinking.innerHTML = `
        <span class="za-thinking-mark" aria-hidden="true">Z</span>
        <span>思考中</span>
        <span class="za-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
      messages.append(thinking);
      scrollToEnd();
    },
    hideThinking() {
      thinking?.remove();
      thinking = null;
    },
    renderToolCard(frame) {
      closeAssistantTurn();
      thinking?.remove();
      thinking = null;
      let entry = toolCards.get(frame.toolCallId) ?? null;
      if (entry === null) {
        const card = document.createElement('div');
        card.setAttribute('data-za-toolcard', '');
        card.className = 'za-toolcard';
        const group = ensureToolGroup(frame.mode ?? 'client');
        group.body.append(card);
        entry = { card, group };
        toolCards.set(frame.toolCallId, entry);
      }
      const { card, group } = entry;
      card.setAttribute('data-status', frame.status);
      card.textContent = '';
      const state = document.createElement('span');
      state.className = 'za-toolcard-state';
      state.setAttribute('aria-hidden', 'true');
      const main = document.createElement('div');
      main.className = 'za-toolcard-main';
      const copy = document.createElement('span');
      copy.className = 'za-toolcard-copy';
      copy.textContent = `${STATUS_LABEL[frame.status]}：${frame.summary ?? frame.toolId}`;
      main.append(copy);
      const failureReason = failureReasonOf(frame);
      if (failureReason !== undefined) {
        const detail = document.createElement('span');
        detail.className = 'za-toolcard-detail';
        detail.textContent = failureReason;
        main.append(detail);
      }
      card.append(state, main);
      refreshToolGroup(group);
      scrollToEnd();
    },
    promptHitl(frame) {
      closeAssistantTurn();
      closeToolBatch();
      thinking?.remove();
      thinking = null;
      return new Promise<HitlDecisionValue | null>((resolve) => {
        const card = document.createElement('div');
        card.setAttribute('data-za-hitl', '');
        card.className = 'za-hitl';

        // 任务授权卡（dom 批次带 task；导航带 task + 计划）：功能级呈现 + 说明"批准后本任务自动执行、可停止"。
        const domTask = isTaskGrantCard(frame) ? summarizeTask(frame.params) : null;
        const navigationGrant = domTask !== null && NAVIGATION_TOOL_IDS.has(frame.toolId);

        const title = document.createElement('div');
        title.className = 'za-hitl-title';
        title.textContent =
          domTask === null
            ? `需你确认：${frame.toolId}`
            : navigationGrant
              ? `授权任务：${domTask.title}`
              : `需你授权：${domTask.title}`;

        // 非 dom 调用的实参摘要仍直接列字段；dom 任务的模型自述降为 claim 块（次要信息）。
        const detail = domTask === null ? document.createElement('div') : null;
        if (detail !== null) {
          detail.className = 'za-hitl-detail';
          detail.textContent = summarizeParams(frame.params);
        }

        /**
         * 卡上「将发生什么」的唯一权威来源：服务端按 toolgate 净化终值 + 最近快照反解的 effects。
         * 缺省即不呈现动作清单——客户端不从 params 推断（U7 客户端零判定）。
         */
        const effectsBlock =
          frame.effects === undefined || frame.effects.length === 0
            ? null
            : document.createElement('div');
        if (effectsBlock !== null && frame.effects !== undefined) {
          effectsBlock.className = 'za-hitl-effects';
          const heading = document.createElement('div');
          heading.className = 'za-hitl-detail';
          heading.textContent = '将执行以下操作（服务端已校验的最终指令）：';
          effectsBlock.append(heading);
          frame.effects.forEach((effect, index) => {
            const line = document.createElement('div');
            line.className = 'za-hitl-effect za-hitl-detail';
            line.textContent = effectLineOf(effect, index);
            effectsBlock.append(line);
          });
        }

        // 目标页/目标 URL 只信服务端组装字段，不从 params 做任何展示推断（U7/U8：客户端零判定）。
        // 导航任务授权卡上这是任务的首步落点，措辞区别于一次性导航的目标地址。
        let targetUrlLine: HTMLElement | null = null;
        if (frame.targetUrl !== undefined) {
          targetUrlLine = document.createElement('div');
          targetUrlLine.className = 'za-hitl-target-url';
          targetUrlLine.textContent = `${navigationGrant ? '将先打开' : '目标地址'}：${frame.targetUrl}`;
        }
        let targetPageLine: HTMLElement | null = null;
        if (frame.targetPage !== undefined) {
          targetPageLine = document.createElement('div');
          targetPageLine.className = 'za-hitl-target-page';
          const pageTitle = frame.targetPage.title ?? '（无标题）';
          targetPageLine.textContent =
            frame.targetPage.origin === undefined
              ? `目标页：${pageTitle}`
              : `目标页：${pageTitle}（${frame.targetPage.origin}）`;
        }

        const packLine = frame.pack === undefined ? null : document.createElement('div');
        if (packLine !== null && frame.pack !== undefined) {
          packLine.className = 'za-hitl-pack za-hitl-detail';
          packLine.textContent = packLineOf(frame.pack);
        }

        const riskLine = frame.risk === undefined ? null : document.createElement('div');
        if (riskLine !== null) {
          riskLine.className = 'za-hitl-risk za-hitl-detail';
          riskLine.textContent = `风险：${frame.risk}`;
        }

        // 模型自述（summary/plan）标注来源后作次要信息呈现：它是待核对的说法，不是裁决依据。
        const claimLine = domTask !== null && domTask.claim !== '' ? document.createElement('div') : null;
        if (claimLine !== null && domTask !== null) {
          claimLine.className = 'za-hitl-claim za-hitl-detail';
          claimLine.textContent = `agent 自述：${domTask.claim}`;
        }

        const planList = domTask !== null && domTask.plan.length > 0 ? document.createElement('ol') : null;
        if (planList !== null && domTask !== null) {
          planList.className = 'za-hitl-plan';
          for (const step of domTask.plan) {
            const li = document.createElement('li');
            li.textContent = step;
            planList.append(li);
          }
        }

        const hint = domTask === null ? null : document.createElement('div');
        if (hint !== null) {
          hint.className = 'za-hitl-hint';
          hint.textContent = '授权后本任务内的后续操作（含页面操作与站点跳转）将自动执行；执行中可随时点「停止」。';
        }

        const tightenedLine = frame.tightenedBy === undefined ? null : document.createElement('div');
        if (tightenedLine !== null) {
          tightenedLine.className = 'za-hitl-tightened za-hitl-detail';
          tightenedLine.textContent = '这是你自己设置的确认项（站点包默认为自动执行）。';
        }

        const gov = document.createElement('div');
        gov.className = 'za-hitl-gov za-hitl-detail';
        gov.textContent = governanceNoteOf(frame.ttlMs);

        const siteAccess = document.createElement('div');
        siteAccess.className = 'za-hitl-site-access za-hitl-detail';
        siteAccess.textContent = SITE_ACCESS_NOTE;

        const actions = document.createElement('div');
        actions.className = 'za-hitl-actions';
        const approve = document.createElement('button');
        approve.setAttribute('data-za-hitl-approve', '');
        approve.className = 'za-hitl-approve';
        approve.textContent = domTask === null ? '确认执行' : '授权执行';
        const reject = document.createElement('button');
        reject.setAttribute('data-za-hitl-reject', '');
        reject.className = 'za-hitl-reject';
        reject.textContent = '拒绝';
        actions.append(approve, reject);

        // 阅读顺序＝UI 规范 §5 五要素：动作与参数 → 作用站点与来源 pack → 风险行 → 治理小字 → 两个按钮。
        card.append(title);
        if (detail !== null) card.append(detail);
        if (effectsBlock !== null) card.append(effectsBlock);
        if (targetUrlLine !== null) card.append(targetUrlLine);
        if (targetPageLine !== null) card.append(targetPageLine);
        if (packLine !== null) card.append(packLine);
        if (riskLine !== null) card.append(riskLine);
        if (claimLine !== null) card.append(claimLine);
        if (planList !== null) card.append(planList);
        if (hint !== null) card.append(hint);
        if (tightenedLine !== null) card.append(tightenedLine);
        if (frame.reason !== undefined) {
          const reason = document.createElement('div');
          reason.className = 'za-hitl-reason';
          reason.textContent = frame.reason;
          card.append(reason);
        }
        card.append(gov, siteAccess, actions);
        messages.append(card);
        messages.scrollTop = messages.scrollHeight;
        // 防误触放权（UI 规范 §8）：默认焦点落「拒绝」，回车不构成授权。
        reject.focus();

        const settle = (decision: HitlDecisionValue | null) => {
          card.remove();
          if (pendingHitl?.card === card) pendingHitl = null;
          resolve(decision);
        };
        pendingHitl = { card, resolve: settle };
        // 权限询问期间卡仍在场（用户可能正对着浏览器气泡），按钮锁住防重复申请；拒绝路径不申请。
        approve.addEventListener('click', () => {
          approve.disabled = true;
          reject.disabled = true;
          void ensureSiteAccess().then(() => settle('approve'));
        });
        reject.addEventListener('click', () => settle('reject'));
      });
    },
    cancelHitl() {
      pendingHitl?.resolve(null);
    },
  };
}
