/**
 * 配置中心（options 页）四页：站点包 / 个人定制 / 自动化 / 全局设置。
 * L1 只读投影取自 GET /v1/packs；L2 编辑面读写 /v1/user-config（?expectedRevision= 乐观并发，
 * 409 即重载后由用户复核重提）。治理语义在 UI 层机械成立：低于 pack 基线的档位不可选（只收紧）、
 * 条目逐条标来源与作用域、未开放能力置灰且不做假跳转。
 * 令牌只呈现「已配置 / 未配置」状态，值不入 DOM（ZA-C-SEC-04）。
 * 服务端契约类型在此手抄镜像——插件不依赖 @zen-agent/*（U5）。
 */

import { MAX_AUTO_SCAN_MINUTES } from './auto-scan.js';

export type RiskTier = 'auto' | 'hitl' | 'forbidden';
export type PackSource = 'official' | 'community' | 'local';
export type Verbosity = 'concise' | 'standard' | 'detailed';
export type OverlayEntryOrigin = 'manual' | 'teach';
/** L2 只收紧闭集：结构上无 auto（放宽无表达力）。 */
export type RiskTierRaise = 'hitl' | 'forbidden';

export interface PackFeatureView {
  featureId: string;
  title?: string;
}

export interface PackToolView {
  toolId: string;
  baseTier: RiskTier;
  description: string;
}

export interface PackAutomationView {
  id: string;
  defaultPeriodMinutes?: number;
}

export interface PackView {
  packId: string;
  name?: string;
  version: string;
  source: PackSource;
  summary?: string;
  origin?: string;
  locations?: string[];
  generic?: true;
  features: PackFeatureView[];
  tools: PackToolView[];
  automations: PackAutomationView[];
  configSchema?: Record<string, unknown>;
}

export interface UserConfigSubjectView {
  tenant: string;
  hostUserId: string;
}

export interface OverlayEntryView {
  id: string;
  text: string;
  featureId?: string;
  origin: OverlayEntryOrigin;
  sourceSessionId?: string;
  createdAt: string;
}

export interface OverlayAutomationPreferenceView {
  enabled: boolean;
  minutes?: number;
}

/** 站点作用域与 "*" 全局作用域的合并投影：全局作用域结构上不出现 enabled/restrictions/packConfig。 */
export interface OverlayScopeView {
  enabled?: false;
  rules?: OverlayEntryView[];
  facts?: OverlayEntryView[];
  restrictions?: {
    riskTierRaise?: Record<string, RiskTierRaise>;
    disabledTools?: string[];
  };
  packConfig?: Record<string, unknown>;
  preferences?: {
    verbosity?: Verbosity;
    automations?: Record<string, OverlayAutomationPreferenceView>;
  };
}

export interface UserOverlayView {
  schemaVersion: 1;
  subject: UserConfigSubjectView;
  packs: Record<string, OverlayScopeView>;
}

export interface ConfigCenterDeps {
  fetch: typeof globalThis.fetch;
  /** 服务端 API 基址（无尾斜杠）。 */
  baseUrl: string;
  authToken: string;
  tokenConfigured: boolean;
  /** 全局设置页回显的用户自配服务端地址；空串 = 用构建缺省。 */
  serverBaseUrl: string;
  saveSettings(patch: { token?: string; serverBaseUrl?: string }): Promise<void>;
  /**
   * 服务端地址信任归一（宿主注入 normalizeTrustedServerBaseUrl）：返回 null 即不受信。
   * 缺省 = 不切换本页请求基址（仅落盘，下次开页由宿主归一）——令牌绝不发往未归一地址。
   */
  normalizeBaseUrl?(value: string): string | null;
  /** 本地调度存储（background alarm 数据源）现存的自动化偏好：L2 未声明该项时的回显来源。 */
  localAutomations?: Record<string, { enabled?: boolean; minutes?: number }>;
  /** 把面板上的自动化偏好全量镜像回本地调度存储；缺省 = 只写 L2。 */
  saveAutomations?(prefs: Record<string, { enabled: boolean; minutes: number }>): Promise<void>;
}

export interface ConfigCenterHandle {
  /** 首屏 L1+L2 读取与渲染完成。 */
  ready: Promise<void>;
  /** 提交待保存态：本地设置 + PUT overlay；失败如实反映在状态行，不冒充成功。 */
  save(): Promise<void>;
}

const TIER_ORDER: Record<RiskTier, number> = { auto: 0, hitl: 1, forbidden: 2 };
const TIER_LABEL: Record<RiskTier, string> = { auto: '自动执行', hitl: '需确认', forbidden: '已禁用' };
const SOURCE_LABEL: Record<PackSource, string> = { official: '官方', community: '社区', local: '自建' };
const ENTRY_ORIGIN_LABEL: Record<OverlayEntryOrigin, string> = {
  manual: '手动添加',
  teach: '对话沉淀',
};
const VERBOSITY_LABEL: Record<Verbosity, string> = {
  concise: '简洁',
  standard: '标准',
  detailed: '详细',
};
const TIERS: RiskTier[] = ['auto', 'hitl', 'forbidden'];
const PLATFORM_MIN_PERIOD_MINUTES = 1;
/** 状态行呈现的服务端 issues 条数上限（超出以计数收尾）。 */
const ISSUE_DISPLAY_LIMIT = 5;
const GLOBAL_SCOPE = '*';
const TABS: { id: string; label: string }[] = [
  { id: 'packs', label: '站点包' },
  { id: 'overlay', label: '个人定制' },
  { id: 'automation', label: '自动化' },
  { id: 'global', label: '全局设置' },
];

/** 地址未过信任归一：保存被拒（令牌绝不发往未归一地址）。 */
class UntrustedBaseUrlError extends Error {}

/** R1 只收紧：候选档位不严于 pack 基线即不可选。 */
export function isTierSelectable(baseTier: RiskTier, candidate: RiskTier): boolean {
  return TIER_ORDER[candidate] >= TIER_ORDER[baseTier];
}

/** 周期下限 = max(pack 预设, 平台下限)；频率只收紧。 */
export function minPeriodMinutes(defaultPeriodMinutes?: number): number {
  return Math.max(defaultPeriodMinutes ?? PLATFORM_MIN_PERIOD_MINUTES, PLATFORM_MIN_PERIOD_MINUTES);
}

/** 读取失败的人读化：与保存路径分开——读路径没有提交动作，不得复用保存/重提文案。 */
export function describeLoadFailure(status: number, body: unknown): string {
  const detail = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown };
  const error = typeof detail.error === 'string' ? detail.error : '';
  if (status === 401) return '尚未配置有效访问令牌，请在「全局设置」填写后重新打开本页。';
  return error === '' ? `读取失败（HTTP ${status}）` : error;
}

/** 保存失败的人读化：400 逐条呈现服务端 issues，其余保留服务端 error 原文，不吞错。 */
export function describeSaveFailure(status: number, body: unknown): string {
  const detail = (typeof body === 'object' && body !== null ? body : {}) as {
    error?: unknown;
    issues?: unknown;
  };
  const error = typeof detail.error === 'string' ? detail.error : '';
  if (status === 409) return '配置已在别处更新，已重新加载最新配置；请复核后重新提交。';
  if (status === 400) {
    const issues = Array.isArray(detail.issues) ? detail.issues : [];
    const lines = issues
      .map((issue) => issue as { path?: unknown; message?: unknown })
      .filter((issue) => typeof issue.message === 'string')
      .map((issue) =>
        typeof issue.path === 'string' ? `${issue.path} → ${String(issue.message)}` : String(issue.message),
      );
    // allErrors 下 issues 可达数百条：只呈现前若干条，其余给出计数（状态行需可读）。
    const shown = lines.slice(0, ISSUE_DISPLAY_LIMIT);
    const rest = lines.length - shown.length;
    return [
      error === '' ? 'overlay 未通过写入期校验' : error,
      ...shown,
      ...(rest > 0 ? [`另有 ${rest} 项未列出`] : []),
    ].join('；');
  }
  return error === '' ? `保存失败（HTTP ${status}）` : error;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(className: string, text: string, ariaLabel?: string): HTMLElement {
  const node = el('span', `za-cc-badge ${className}`, text);
  if (ariaLabel !== undefined) node.setAttribute('aria-label', ariaLabel);
  return node;
}

/** 未开放能力的如实占位：禁用按钮 + 触发锚点，不做假跳转（R6）。 */
function unavailable(label: string, anchor: string): HTMLButtonElement {
  const button = el('button', 'za-cc-btn za-cc-unavailable', label);
  button.type = 'button';
  button.disabled = true;
  button.title = `尚未开放（${anchor}）`;
  return button;
}

function section(title: string): HTMLElement {
  const node = el('section', 'za-cc-section');
  node.append(el('h2', 'za-cc-section-title', title));
  return node;
}

function packLabel(pack: PackView | undefined, packId: string): string {
  return pack?.name ?? packId;
}

function featureLabel(pack: PackView | undefined, featureId: string): string {
  return pack?.features.find((feature) => feature.featureId === featureId)?.title ?? featureId;
}

function tierKey(packId: string, toolId: string): string {
  return `${packId}\u0000${toolId}`;
}

function entryKey(scopeKey: string, kind: 'rules' | 'facts', id: string): string {
  return `${scopeKey}\u0000${kind}\u0000${id}`;
}

function clonePacks(overlay: UserOverlayView | null): Record<string, OverlayScopeView> {
  return overlay === null
    ? {}
    : (JSON.parse(JSON.stringify(overlay.packs)) as Record<string, OverlayScopeView>);
}

interface AutomationDraft {
  packId: string;
  enabled: boolean;
  /** true = L2 记为启用但本机因异常暂停（须用户显式重开）。 */
  pausedLocally?: boolean;
  minutes: number;
  minMinutes: number;
}

interface CenterState {
  packs: PackView[];
  /** 服务端当前 overlay 的 packs 深拷贝：未在面板暴露的字段（facts/packConfig/未安装 pack 作用域）原样保留。 */
  basePacks: Record<string, OverlayScopeView>;
  subject: UserConfigSubjectView | null;
  revision: string;
  disabled: Set<string>;
  removedEntries: Set<string>;
  /** (packId, toolId) → 面板选定的生效档位（等于 baseTier 即无收紧）。 */
  tiers: Map<string, RiskTier>;
  automations: Map<string, AutomationDraft>;
  /** 空串 = 未设置，跟随站点包默认。 */
  verbosity: Verbosity | '';
  loadError: string | null;
}

function scopeEntries(scope: OverlayScopeView, kind: 'rules' | 'facts'): OverlayEntryView[] {
  return scope[kind] ?? [];
}

function ensureScope(
  packs: Record<string, OverlayScopeView>,
  key: string,
): OverlayScopeView {
  const existing = packs[key];
  if (existing !== undefined) return existing;
  const created: OverlayScopeView = {};
  packs[key] = created;
  return created;
}

function buildOverlay(state: CenterState, subject: UserConfigSubjectView): UserOverlayView {
  const packs = JSON.parse(JSON.stringify(state.basePacks)) as Record<string, OverlayScopeView>;

  for (const [scopeKey, scope] of Object.entries(packs)) {
    for (const kind of ['rules', 'facts'] as const) {
      const entries = scope[kind];
      if (entries === undefined) continue;
      const kept = entries.filter((entry) => !state.removedEntries.has(entryKey(scopeKey, kind, entry.id)));
      if (kept.length === 0) delete scope[kind];
      else scope[kind] = kept;
    }
  }

  for (const pack of state.packs) {
    const disabledPack = state.disabled.has(pack.packId);
    const existing = packs[pack.packId];
    if (disabledPack) ensureScope(packs, pack.packId).enabled = false;
    else if (existing !== undefined) delete existing.enabled;

    const raise: Record<string, RiskTierRaise> = { ...(existing?.restrictions?.riskTierRaise ?? {}) };
    // 面板接管的工具一律以 riskTierRaise 表达档位：同 toolId 的 disabledTools 声明同步摘除
    // （两者语义等价于 forbidden，双重声明会被写入期拒收）；不在当前工具面的键原样保留。
    const baseDisabled = existing?.restrictions?.disabledTools ?? [];
    const disabledTools = baseDisabled.filter(
      (toolId) => !pack.tools.some((tool) => tool.toolId === toolId),
    );
    for (const tool of pack.tools) {
      const wasDisabled = baseDisabled.includes(tool.toolId);
      const chosen =
        state.tiers.get(tierKey(pack.packId, tool.toolId)) ??
        (wasDisabled ? 'forbidden' : tool.baseTier);
      if (chosen === 'auto' || (chosen === tool.baseTier && !wasDisabled)) delete raise[tool.toolId];
      else raise[tool.toolId] = chosen;
    }

    const automations: Record<string, OverlayAutomationPreferenceView> = {
      ...(existing?.preferences?.automations ?? {}),
    };
    for (const automation of pack.automations) {
      const draft = state.automations.get(automation.id);
      if (draft === undefined) continue;
      if (draft.enabled || draft.minutes !== draft.minMinutes) {
        automations[automation.id] = { enabled: draft.enabled, minutes: draft.minutes };
      } else {
        delete automations[automation.id];
      }
    }

    if (Object.keys(raise).length > 0 || Object.keys(automations).length > 0 || disabledTools.length > 0) {
      const scope = ensureScope(packs, pack.packId);
      if (Object.keys(raise).length > 0 || disabledTools.length > 0) {
        scope.restrictions = {
          ...scope.restrictions,
          ...(Object.keys(raise).length > 0 ? { riskTierRaise: raise } : {}),
          ...(disabledTools.length > 0 ? { disabledTools } : {}),
        };
        if (Object.keys(raise).length === 0) delete scope.restrictions.riskTierRaise;
        if (disabledTools.length === 0) delete scope.restrictions.disabledTools;
      }
      if (Object.keys(automations).length > 0) {
        scope.preferences = { ...scope.preferences, automations };
      }
    }
    const scope = packs[pack.packId];
    if (scope !== undefined) {
      if (Object.keys(raise).length === 0 && scope.restrictions !== undefined) {
        delete scope.restrictions.riskTierRaise;
        if (Object.keys(scope.restrictions).length === 0) delete scope.restrictions;
      }
      if (Object.keys(automations).length === 0 && scope.preferences !== undefined) {
        delete scope.preferences.automations;
        if (Object.keys(scope.preferences).length === 0) delete scope.preferences;
      }
    }
  }

  if (state.verbosity === '') {
    const globalScope = packs[GLOBAL_SCOPE];
    if (globalScope?.preferences !== undefined) {
      delete globalScope.preferences.verbosity;
      if (Object.keys(globalScope.preferences).length === 0) delete globalScope.preferences;
    }
  } else {
    const globalScope = ensureScope(packs, GLOBAL_SCOPE);
    globalScope.preferences = { ...globalScope.preferences, verbosity: state.verbosity };
  }

  for (const [key, scope] of Object.entries(packs)) {
    if (Object.keys(scope).length === 0) delete packs[key];
  }

  return { schemaVersion: 1, subject, packs };
}

export function mountConfigCenter(root: HTMLElement, deps: ConfigCenterDeps): ConfigCenterHandle {
  const state: CenterState = {
    packs: [],
    basePacks: {},
    subject: null,
    revision: '',
    disabled: new Set(),
    removedEntries: new Set(),
    tiers: new Map(),
    automations: new Map(),
    verbosity: '',
    loadError: null,
  };
  let tokenConfigured = deps.tokenConfigured;
  // 凭证与基址在保存后就地更新：换令牌/换地址后本页后续请求即用新值，无需重开。
  let authToken = deps.authToken;
  let apiBaseUrl = deps.baseUrl;
  let serverBaseUrl = deps.serverBaseUrl;

  root.classList.add('za-cc');
  root.replaceChildren();

  const nav = el('nav', 'za-cc-nav');
  nav.append(el('div', 'za-cc-logo', 'Zen Agent'), el('div', 'za-cc-logo-sub', '配置中心'));
  const main = el('div', 'za-cc-main');
  const panels = new Map<string, HTMLElement>();
  const navItems = new Map<string, HTMLButtonElement>();

  function activate(tab: string): void {
    for (const [id, panel] of panels) panel.hidden = id !== tab;
    for (const [id, item] of navItems) item.classList.toggle('za-cc-nav-item-active', id === tab);
  }

  for (const tab of TABS) {
    const item = el('button', 'za-cc-nav-item', tab.label);
    item.type = 'button';
    item.dataset['zaTab'] = tab.id;
    item.addEventListener('click', () => activate(tab.id));
    nav.append(item);
    navItems.set(tab.id, item);

    const panel = el('section', 'za-cc-panel');
    panel.dataset['zaPanel'] = tab.id;
    panel.hidden = true;
    panels.set(tab.id, panel);
    main.append(panel);
  }

  const status = el('span', 'za-cc-status');
  const revisionLabel = el('span', 'za-cc-revision');
  const saveButton = el('button', 'za-cc-btn za-cc-btn-primary', '保存');
  saveButton.type = 'button';
  const footer = el('div', 'za-cc-footer');
  footer.append(saveButton, status, revisionLabel);
  main.append(footer);
  root.append(nav, main);
  activate(TABS[0]!.id);

  function setStatus(message: string, isError = false): void {
    status.textContent = message;
    status.classList.toggle('za-cc-status-err', isError);
  }

  function panelOf(tab: string): HTMLElement {
    return panels.get(tab)!;
  }

  function pageHead(title: string, actions: HTMLElement[] = []): HTMLElement {
    const head = el('div', 'za-cc-page-head');
    head.append(el('h1', 'za-cc-page-title', title));
    if (actions.length > 0) {
      const group = el('div', 'za-cc-head-actions');
      group.append(...actions);
      head.append(group);
    }
    return head;
  }

  function notice(text: string, tone: 'info' | 'warn' | 'lock' = 'info'): HTMLElement {
    return el('p', `za-cc-notice za-cc-notice-${tone}`, text);
  }

  // ---- 站点包页 ----

  function renderPacksPanel(): void {
    const panel = panelOf('packs');
    panel.replaceChildren(
      pageHead('站点包', [
        unavailable('从文件导入', 'P3.5 pack 打包分发'),
        unavailable('浏览社区包', 'P3.5 社区目录'),
      ]),
      notice('站点包是纯数据（prompt / markdown / JSON），不含可执行代码，可审计。'),
    );
    if (state.loadError !== null) {
      panel.append(notice(state.loadError, 'warn'));
      return;
    }
    if (state.packs.length === 0) {
      panel.append(el('p', 'za-cc-empty', '当前服务端没有已安装的站点包。'));
      return;
    }
    for (const pack of state.packs) {
      panel.append(renderPackCard(pack));
    }
  }

  function renderPackCard(pack: PackView): HTMLElement {
    const card = el('div', 'za-cc-pack');
    card.dataset['zaPackId'] = pack.packId;

    const row = el('div', 'za-cc-pack-row');
    row.append(
      el('span', 'za-cc-pack-name', packLabel(pack, pack.packId)),
      el('span', 'za-cc-pack-version', `v${pack.version}`),
      badge(`za-cc-badge-source za-cc-badge-${pack.source}`, SOURCE_LABEL[pack.source], `来源：${SOURCE_LABEL[pack.source]}`),
      el(
        'span',
        'za-cc-pack-origin',
        pack.generic === true ? '任意站点（通用兜底）' : (pack.origin ?? '未声明站点围栏'),
      ),
      el('span', 'za-cc-pack-features', `功能 ${pack.features.length} 项`),
      el('span', 'za-cc-pack-tools', `工具 ${pack.tools.length} 项`),
    );
    if (pack.locations !== undefined && pack.locations.length > 0) {
      row.append(el('span', 'za-cc-pack-locations', `路径 ${pack.locations.join(' ')}`));
    }

    const toggleLabel = el('label', 'za-cc-switch');
    const toggle = el('input', 'za-cc-pack-toggle');
    toggle.type = 'checkbox';
    toggle.checked = !state.disabled.has(pack.packId);
    toggle.addEventListener('change', () => {
      if (toggle.checked) state.disabled.delete(pack.packId);
      else state.disabled.add(pack.packId);
    });
    toggleLabel.append(toggle, el('span', 'za-cc-switch-text', '启用'));
    row.append(toggleLabel);

    const sub = el('div', 'za-cc-pack-sub');
    sub.append(el('span', 'za-cc-pack-desc', pack.summary ?? '站点包未声明简介。'));
    const ops = el('div', 'za-cc-pack-ops');
    ops.append(unavailable('导出', 'P3.5 pack 导入导出'), unavailable('卸载', 'P3.5 pack 打包分发'));
    sub.append(ops);

    card.append(row, sub);
    return card;
  }

  // ---- 个人定制页 ----

  function renderOverlayPanel(): void {
    const panel = panelOf('overlay');
    panel.replaceChildren(
      pageHead('个人定制'),
      notice('个人设置只能收紧站点包的权限，不能放宽；放宽需更换站点包。', 'warn'),
    );
    if (state.loadError !== null) {
      panel.append(notice(state.loadError, 'warn'));
      return;
    }
    const installed = new Set(state.packs.map((pack) => pack.packId));
    for (const pack of state.packs) {
      panel.append(renderScope(pack.packId, pack));
    }
    for (const scopeKey of Object.keys(state.basePacks)) {
      if (scopeKey === GLOBAL_SCOPE || installed.has(scopeKey)) continue;
      panel.append(renderScope(scopeKey, undefined));
    }
    panel.append(renderScope(GLOBAL_SCOPE, undefined));
  }

  function renderScope(scopeKey: string, pack: PackView | undefined): HTMLElement {
    const isGlobal = scopeKey === GLOBAL_SCOPE;
    const scope = state.basePacks[scopeKey] ?? {};
    const node = el('div', 'za-cc-scope');
    node.dataset['zaScope'] = scopeKey;

    const head = el('div', 'za-cc-scope-head');
    head.append(
      el('h2', 'za-cc-scope-title', isGlobal ? '全部站点' : packLabel(pack, scopeKey)),
    );
    if (isGlobal) {
      head.append(el('span', 'za-cc-scope-note', '跨站点生效的规则与事实；无工具面，故无收紧矩阵。'));
    } else if (pack === undefined) {
      head.append(badge('za-cc-badge-warn', '站点包未安装', '该作用域对应的站点包当前未安装'));
    } else {
      head.append(badge(`za-cc-badge-source za-cc-badge-${pack.source}`, SOURCE_LABEL[pack.source]));
    }
    node.append(head);

    node.append(renderEntries(scopeKey, pack, scope, 'rules', '我的规则'));
    node.append(renderEntries(scopeKey, pack, scope, 'facts', '我的事实'));
    if (pack !== undefined && pack.tools.length > 0) node.append(renderMatrix(pack));
    return node;
  }

  function renderEntries(
    scopeKey: string,
    pack: PackView | undefined,
    scope: OverlayScopeView,
    kind: 'rules' | 'facts',
    title: string,
  ): HTMLElement {
    const wrap = section(title);
    if (kind === 'rules') {
      wrap.append(unavailable('添加规则', 'P3.5 teach 与面板手动录入'));
    }
    const entries = scopeEntries(scope, kind).filter(
      (entry) => !state.removedEntries.has(entryKey(scopeKey, kind, entry.id)),
    );
    if (entries.length === 0) {
      wrap.append(
        el(
          'p',
          'za-cc-empty',
          kind === 'rules' ? '暂无个人规则；对话沉淀经你确认后写入这里。' : '暂无个人事实。',
        ),
      );
      return wrap;
    }
    const itemClass = kind === 'rules' ? 'za-cc-rule' : 'za-cc-fact';
    for (const entry of entries) {
      const row = el('div', itemClass);
      row.dataset[kind === 'rules' ? 'zaRuleId' : 'zaFactId'] = entry.id;
      row.append(
        el('span', `${itemClass}-text`, entry.text),
        badge('za-cc-badge-origin', ENTRY_ORIGIN_LABEL[entry.origin], `来源：${ENTRY_ORIGIN_LABEL[entry.origin]}`),
        el(
          'span',
          `${itemClass}-scope`,
          scopeKey === GLOBAL_SCOPE
            ? '全部站点'
            : entry.featureId === undefined
              ? packLabel(pack, scopeKey)
              : `${packLabel(pack, scopeKey)} · ${featureLabel(pack, entry.featureId)}`,
        ),
        el('span', `${itemClass}-created`, entry.createdAt.slice(0, 10)),
      );
      const remove = el('button', `${itemClass}-delete za-cc-btn za-cc-btn-danger`, '删除');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        state.removedEntries.add(entryKey(scopeKey, kind, entry.id));
        renderOverlayPanel();
      });
      row.append(remove);
      wrap.append(row);
    }
    return wrap;
  }

  function renderMatrix(pack: PackView): HTMLElement {
    const wrap = section('工具权限（只收紧）');
    // disabledTools 与 riskTierRaise 语义等价于 forbidden，但同 toolId 双重声明会被写入期拒收：
    // 面板据此如实呈现「已禁用」，用户改档时同步从 disabledTools 摘除该键（见 buildOverlay）。
    const disabledTools = new Set(state.basePacks[pack.packId]?.restrictions?.disabledTools ?? []);
    const table = el('table', 'za-cc-matrix');
    const header = el('tr');
    for (const label of ['工具', '站点包默认', '生效档位']) {
      header.append(el('th', undefined, label));
    }
    table.append(header);
    for (const tool of pack.tools) {
      const row = el('tr', 'za-cc-tool');
      row.dataset['zaToolId'] = tool.toolId;

      const nameCell = el('td');
      nameCell.append(
        el('span', 'za-cc-tool-name', tool.toolId),
        el('span', 'za-cc-tool-desc', tool.description),
      );
      const baseCell = el('td');
      baseCell.append(
        el('span', 'za-cc-tool-base', `${TIER_LABEL[tool.baseTier]}（${tool.baseTier}）`),
      );

      const chosen =
        state.tiers.get(tierKey(pack.packId, tool.toolId)) ??
        (disabledTools.has(tool.toolId) ? 'forbidden' : tool.baseTier);
      const select = el('select', 'za-cc-tier');
      select.dataset['zaToolId'] = tool.toolId;
      select.setAttribute('aria-label', `${tool.toolId} 的生效风险档`);
      for (const tier of TIERS) {
        const option = el('option', undefined, `${TIER_LABEL[tier]}（${tier}）`);
        option.value = tier;
        option.disabled = !isTierSelectable(tool.baseTier, tier);
        option.selected = tier === chosen;
        select.append(option);
      }
      const tightened = badge('za-cc-badge-tight', '已收紧', `已收紧，站点包默认为 ${TIER_LABEL[tool.baseTier]}`);
      tightened.hidden = chosen === tool.baseTier;
      select.addEventListener('change', () => {
        const value = select.value as RiskTier;
        state.tiers.set(tierKey(pack.packId, tool.toolId), value);
        tightened.hidden = value === tool.baseTier;
      });

      const tierCell = el('td');
      tierCell.append(select, tightened);
      row.append(nameCell, baseCell, tierCell);
      table.append(row);
    }
    wrap.append(table);
    return wrap;
  }

  // ---- 自动化页 ----

  function renderAutomationPanel(): void {
    const panel = panelOf('automation');
    panel.replaceChildren(
      pageHead('自动化', [unavailable('新建触发器', 'G5 通用页面监测模板')]),
      notice('无人值守任务不允许自动执行不可撤销的写操作——平台底线，不可配置。', 'lock'),
      notice('周期自动化只唤醒已打开且已加入会话组的声明工作页；不会自动新建页面，任一不确定状态即暂停。'),
    );
    if (state.loadError !== null) {
      panel.append(notice(state.loadError, 'warn'));
      return;
    }
    const withAutomations = state.packs.filter((pack) => pack.automations.length > 0);
    if (withAutomations.length === 0) {
      panel.append(el('p', 'za-cc-empty', '已安装的站点包都没有声明周期自动化。'));
      return;
    }
    for (const pack of withAutomations) {
      const group = section(`${packLabel(pack, pack.packId)}${pack.origin === undefined ? '' : ` · ${pack.origin}`}`);
      for (const automation of pack.automations) {
        group.append(renderAutomationRow(pack, automation));
      }
      panel.append(group);
    }
  }

  function renderAutomationRow(pack: PackView, automation: PackAutomationView): HTMLElement {
    const draft = state.automations.get(automation.id)!;
    const row = el('div', 'za-cc-automation');
    row.dataset['zaAutomationId'] = automation.id;

    const enabled = el('input', 'za-cc-automation-enabled');
    enabled.type = 'checkbox';
    enabled.dataset['zaAutomationId'] = automation.id;
    enabled.checked = draft.enabled;
    enabled.addEventListener('change', () => {
      draft.enabled = enabled.checked;
    });
    const enabledLabel = el('label', 'za-cc-switch');
    enabledLabel.append(enabled, el('span', 'za-cc-switch-text', '启用'));

    const minutes = el('input', 'za-cc-automation-minutes');
    minutes.type = 'number';
    minutes.dataset['zaAutomationId'] = automation.id;
    minutes.min = String(draft.minMinutes);
    minutes.max = String(MAX_AUTO_SCAN_MINUTES);
    minutes.step = '1';
    minutes.value = String(draft.minutes);
    minutes.addEventListener('change', () => {
      draft.minutes = Number(minutes.value);
    });
    const minutesLabel = el('label', 'za-cc-field-inline');
    minutesLabel.append(el('span', undefined, '周期（分钟）'), minutes);

    row.append(
      el('span', 'za-cc-automation-name', automation.id),
      badge('za-cc-badge-kind', '站点包预置'),
      enabledLabel,
      minutesLabel,
      el(
        'span',
        'za-cc-hint',
        `周期 ${draft.minMinutes}–${MAX_AUTO_SCAN_MINUTES} 分钟（下限=站点包预设，只可调稀不可调密）`,
      ),
    );
    if (draft.pausedLocally === true) {
      row.append(
        badge('za-cc-badge-paused', '本机已暂停', '自动轮次异常后本机暂停，需在此显式重新启用'),
      );
    }
    return row;
  }

  // ---- 全局设置页 ----

  let tokenInput: HTMLInputElement | null = null;
  let baseUrlInput: HTMLInputElement | null = null;
  let tokenState: HTMLElement | null = null;

  function renderGlobalPanel(): void {
    const panel = panelOf('global');
    panel.replaceChildren(pageHead('全局设置'));

    const connection = section('连接');
    const tokenField = el('div', 'za-cc-field');
    const tokenLabelRow = el('div', 'za-cc-field-head');
    const tokenLabel = el('label', 'za-cc-label', '访问令牌');
    tokenLabel.htmlFor = 'za-cc-token';
    tokenState = el(
      'span',
      'za-cc-token-state',
      tokenConfigured ? '已配置（值不回显）' : '未配置',
    );
    tokenLabelRow.append(tokenLabel, tokenState);
    tokenInput = el('input', 'za-cc-input');
    tokenInput.type = 'password';
    tokenInput.id = 'za-cc-token';
    tokenInput.autocomplete = 'off';
    tokenInput.placeholder = tokenConfigured ? '如需更换，粘贴新令牌覆盖' : '粘贴管理员签发的令牌';
    tokenField.append(
      tokenLabelRow,
      tokenInput,
      el('p', 'za-cc-hint', '令牌只存于本浏览器；面板不回显已保存的值，留空即保持不变。'),
    );

    const baseUrlField = el('div', 'za-cc-field');
    const baseUrlLabel = el('label', 'za-cc-label', '服务端地址');
    baseUrlLabel.htmlFor = 'za-cc-base-url';
    baseUrlInput = el('input', 'za-cc-input');
    baseUrlInput.id = 'za-cc-base-url';
    baseUrlInput.value = serverBaseUrl;
    baseUrlInput.placeholder = '留空使用默认';
    baseUrlField.append(baseUrlLabel, baseUrlInput);
    connection.append(tokenField, baseUrlField);

    const preferences = section('偏好');
    const verbosityField = el('div', 'za-cc-field-inline');
    const verbosityLabel = el('label', 'za-cc-label', '回答详略');
    verbosityLabel.htmlFor = 'za-cc-verbosity';
    const verbosity = el('select', 'za-cc-verbosity');
    verbosity.id = 'za-cc-verbosity';
    const options: { value: string; label: string }[] = [
      { value: '', label: '未设置（跟随站点包默认）' },
      ...(['concise', 'standard', 'detailed'] as Verbosity[]).map((value) => ({
        value,
        label: VERBOSITY_LABEL[value],
      })),
    ];
    for (const option of options) {
      const node = el('option', undefined, option.label);
      node.value = option.value;
      node.selected = option.value === state.verbosity;
      verbosity.append(node);
    }
    verbosity.addEventListener('change', () => {
      state.verbosity = verbosity.value as Verbosity | '';
    });
    verbosityField.append(verbosityLabel, verbosity);
    preferences.append(
      verbosityField,
      el('p', 'za-cc-hint', '偏好写入「全部站点」作用域，对所有站点包生效。'),
    );

    const pending = section('尚未开放');
    for (const item of [
      { label: '站点授权管理', anchor: 'P3 商店上架权限模型' },
      { label: '模型与密钥（BYOK）', anchor: 'P4 账号与配额' },
      { label: '数据披露与审计保留期', anchor: 'P4 托管形态' },
      { label: '导出我的配置', anchor: 'P3.5 pack 导入导出' },
    ]) {
      const row = el('div', 'za-cc-pending-row');
      row.append(unavailable(item.label, item.anchor), el('span', 'za-cc-hint', `锚点：${item.anchor}`));
      pending.append(row);
    }

    const locked = section('平台底线');
    locked.classList.add('za-cc-section-locked');
    for (const item of ['服务端安全判定', '代执行一次性签名指令', '全程审计留痕']) {
      const row = el('div', 'za-cc-lock-row');
      row.append(el('span', 'za-cc-lock-name', item), el('span', 'za-cc-lock-tag', '始终开启'));
      locked.append(row);
    }
    locked.append(el('p', 'za-cc-hint', '这些是平台底线能力，任何配置不可关闭。'));

    panel.append(connection, preferences, pending, locked);
  }

  function renderAll(): void {
    renderPacksPanel();
    renderOverlayPanel();
    renderAutomationPanel();
    renderGlobalPanel();
    revisionLabel.textContent = state.revision === '' ? '' : `配置版本 ${state.revision}`;
  }

  // ---- 数据链路 ----

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const response = await deps.fetch(`${apiBaseUrl}${path}`, { headers: authHeaders() });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  function adoptPacks(body: unknown): void {
    const packs = (body as { packs?: unknown } | null)?.packs;
    state.packs = Array.isArray(packs) ? (packs as PackView[]) : [];
  }

  /** 服务端 overlay 落为面板待保存态的初值；未在面板暴露的字段留在 basePacks 里原样回传。 */
  function adoptOverlay(body: unknown): void {
    const payload = (body ?? {}) as {
      overlay?: UserOverlayView | null;
      revision?: unknown;
      subject?: UserConfigSubjectView;
    };
    const overlay = payload.overlay ?? null;
    state.basePacks = clonePacks(overlay);
    state.revision = typeof payload.revision === 'string' ? payload.revision : '';
    state.subject = payload.subject ?? overlay?.subject ?? null;
    state.disabled = new Set(
      Object.entries(state.basePacks)
        .filter(([, scope]) => scope.enabled === false)
        .map(([packId]) => packId),
    );
    state.removedEntries = new Set();
    state.verbosity = state.basePacks[GLOBAL_SCOPE]?.preferences?.verbosity ?? '';

    state.tiers = new Map();
    state.automations = new Map();
    for (const pack of state.packs) {
      const scope = state.basePacks[pack.packId];
      const disabledTools = new Set(scope?.restrictions?.disabledTools ?? []);
      for (const tool of pack.tools) {
        const raised = scope?.restrictions?.riskTierRaise?.[tool.toolId];
        // disabledTools 等价于 forbidden：播种即取该值，否则零编辑保存会把用户的禁用静默撤销（只收紧破坏）。
        state.tiers.set(
          tierKey(pack.packId, tool.toolId),
          raised ?? (disabledTools.has(tool.toolId) ? 'forbidden' : tool.baseTier),
        );
      }
      for (const automation of pack.automations) {
        const min = minPeriodMinutes(automation.defaultPeriodMinutes);
        const local = deps.localAutomations?.[automation.id];
        const stored = scope?.preferences?.automations?.[automation.id] ?? local;
        // local.enabled 只在本机键存在时出现：区分「显式暂停」与「从未配置」，
        // 后者不得被判成暂停（否则会呈现一个从未发生的事实，R6）。
        // 本机停用优先于 L2 启用：background 在自动轮次异常时以本机键暂停（唯一生效的调度开关），
        // 该暂停须由用户显式重开，不被面板回显与保存静默恢复。
        const enabled = local?.enabled === false ? false : stored?.enabled ?? false;
        state.automations.set(automation.id, {
          packId: pack.packId,
          enabled,
          pausedLocally: local?.enabled === false && scope?.preferences?.automations?.[automation.id]?.enabled === true,
          minutes: stored?.minutes ?? min,
          minMinutes: min,
        });
      }
    }
  }

  async function load(): Promise<void> {
    const [packs, config] = await Promise.all([getJson('/v1/packs'), getJson('/v1/user-config')]);
    state.loadError = null;
    if (packs.status === 200) adoptPacks(packs.body);
    else {
      state.packs = [];
      state.loadError = `站点包读取失败：${describeLoadFailure(packs.status, packs.body)}`;
    }
    if (config.status === 200) adoptOverlay(config.body);
    else {
      adoptOverlay(null);
      state.loadError = `个人配置读取失败：${describeLoadFailure(config.status, config.body)}`;
    }
  }

  /** 409 后的重读：只刷新 L2（L1 快照不可变，无需重取）。 */
  async function reloadOverlay(): Promise<void> {
    const config = await getJson('/v1/user-config');
    if (config.status === 200) adoptOverlay(config.body);
    renderAll();
  }

  function invalidAutomation(): { id: string; min: number; max: number } | null {
    for (const [id, draft] of state.automations) {
      if (
        !Number.isInteger(draft.minutes) ||
        draft.minutes < draft.minMinutes ||
        draft.minutes > MAX_AUTO_SCAN_MINUTES
      ) {
        return { id, min: draft.minMinutes, max: MAX_AUTO_SCAN_MINUTES };
      }
    }
    return null;
  }

  /**
   * 本机设置持久化（令牌/服务端地址）：与 L2 提交解耦——首装、令牌过期、服务端不可达时
   * 用户仍须能存下令牌。写入成功后同步刷新本实例持有的凭证与基址，后续请求即用新值。
   */
  async function persistLocalSettings(): Promise<boolean> {
    const patch: { token?: string; serverBaseUrl?: string } = {};
    const token = tokenInput?.value.trim() ?? '';
    if (token !== '') patch.token = token;
    const baseUrl = baseUrlInput?.value.trim() ?? '';
    // 地址信任归一是采用该地址的前置条件：未归一地址一律不落盘、更不切换本页基址——
    // 否则本页会立刻把令牌发往该地址（server-url 的 TLS/loopback 硬门不得被绕过）。
    // 令牌与地址各自独立成败：地址不受信不拖累令牌保存（同一 blocker 的成因）。
    let trustedBaseUrl: string | null = null;
    let untrustedBaseUrl = false;
    if (baseUrl !== serverBaseUrl) {
      trustedBaseUrl = baseUrl === '' ? '' : deps.normalizeBaseUrl?.(baseUrl) ?? null;
      if (trustedBaseUrl === null) untrustedBaseUrl = true;
      else patch.serverBaseUrl = baseUrl;
    }
    if (Object.keys(patch).length === 0) {
      if (untrustedBaseUrl) throw new UntrustedBaseUrlError();
      return false;
    }
    await deps.saveSettings(patch);
    if (patch.token !== undefined) {
      authToken = patch.token;
      tokenConfigured = true;
      if (tokenInput !== null) tokenInput.value = '';
      if (tokenState !== null) tokenState.textContent = '已配置（值不回显）';
    }
    if (patch.serverBaseUrl !== undefined) {
      serverBaseUrl = patch.serverBaseUrl;
      if (trustedBaseUrl !== null && trustedBaseUrl !== '') {
        apiBaseUrl = trustedBaseUrl.replace(/\/+$/, '');
      }
    }
    if (untrustedBaseUrl) throw new UntrustedBaseUrlError();
    return true;
  }

  /** 自动化的本地调度镜像（background alarm 的真实数据源）：仅在 L2 写入成功后落盘，避免「保存失败却已在跑」。 */
  async function persistAutomationMirror(): Promise<void> {
    if (deps.saveAutomations === undefined) return;
    const prefs: Record<string, { enabled: boolean; minutes: number }> = {};
    for (const [id, draft] of state.automations) {
      prefs[id] = { enabled: draft.enabled, minutes: draft.minutes };
    }
    await deps.saveAutomations(prefs);
  }

  async function save(): Promise<void> {
    const invalid = invalidAutomation();
    if (invalid !== null) {
      setStatus(
        `自动化「${invalid.id}」的周期须在 ${invalid.min}–${invalid.max} 分钟之间（下限=站点包预设，上限=调度上界）`,
        true,
      );
      return;
    }
    let localSaved = false;
    try {
      localSaved = await persistLocalSettings();
    } catch (error) {
      setStatus(
        error instanceof UntrustedBaseUrlError
          ? '服务端地址不受信：生产地址必须使用 HTTPS（仅 127.0.0.1/localhost 可用 HTTP），该地址未保存；其余本机设置已保存'
          : '本机设置保存失败',
        true,
      );
      return;
    }
    // 凭证/地址刚变更且此前无可用连接（首装/凭证过期）：以新值重读 L1+L2 并重渲染。
    // 已有连接时不重读——重读会以服务端态覆盖待保存编辑，把丢弃当成功宣告（R6）。
    if (localSaved && state.subject === null) {
      try {
        await load();
      } catch {
        state.loadError = '无法连接服务端，配置中心只显示本机设置。';
      }
      renderAll();
    }
    // 归属键仍未知（未鉴权/服务端不可达）：本机设置已落盘，个人配置如实标注未提交，不静默丢弃用户操作。
    if (state.subject === null) {
      setStatus(
        localSaved
          ? '本机设置已保存；个人配置未提交（仍未连上服务端，请核对访问令牌与服务端地址）'
          : '个人配置未提交：尚未连上服务端，请先在全局设置填写访问令牌与服务端地址',
        true,
      );
      return;
    }
    const overlay = buildOverlay(state, state.subject);

    const url = `${apiBaseUrl}/v1/user-config?expectedRevision=${encodeURIComponent(state.revision)}`;
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'PUT',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(overlay),
      });
    } catch {
      setStatus('无法连接服务端，个人配置未提交', true);
      return;
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 200) {
      const revision = (body as { revision?: unknown } | null)?.revision;
      state.revision = typeof revision === 'string' ? revision : state.revision;
      state.basePacks = JSON.parse(JSON.stringify(overlay.packs)) as Record<string, OverlayScopeView>;
      state.removedEntries = new Set();
      revisionLabel.textContent = `配置版本 ${state.revision}`;
      try {
        await persistAutomationMirror();
      } catch {
        setStatus('个人配置已保存，但本机自动化调度镜像写入失败（重开本页可重试）', true);
        return;
      }
      setStatus('已保存');
      return;
    }
    if (response.status === 409) {
      await reloadOverlay();
      setStatus(describeSaveFailure(409, body), true);
      return;
    }
    setStatus(describeSaveFailure(response.status, body), true);
  }

  saveButton.addEventListener('click', () => {
    void save();
  });

  const ready = load()
    .catch(() => {
      state.loadError = '无法连接服务端，配置中心只显示本机设置。';
      adoptOverlay(null);
    })
    .then(() => {
      renderAll();
      if (state.loadError !== null) setStatus(state.loadError, true);
    });

  return { ready, save };
}
