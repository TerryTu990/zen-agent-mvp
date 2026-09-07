/**
 * 配置中心（options 页）三页：站点包 / 个人定制 / 全局设置。
 * L1 只读投影取自 GET /v1/packs；L2 编辑面读写 /v1/user-config（?expectedRevision= 乐观并发，
 * 409 即重载后由用户复核重提）。治理语义在 UI 层机械成立：低于 pack 基线的档位不可选（只收紧）、
 * 条目逐条标来源与作用域、未开放能力置灰且不做假跳转。
 * 身份为只读展示（匿名自动登录，adr-022）：令牌值不入 DOM（ZA-C-SEC-04）。
 * 服务端契约类型在此手抄镜像——插件不依赖 @zen-agent/*（U5）。
 */

import {
  MAX_QUICK_ACTIONS_PER_SCOPE,
  QUICK_ACTION_LABEL_MAX,
  QUICK_ACTION_PLACEHOLDERS,
  QUICK_ACTION_TEMPLATE_MAX,
  type QuickActionContext,
} from './quick-actions.js';
import { isSiteDenyEntry, MAX_SITE_DENYLIST_ENTRIES, siteDeniesUrl } from './site-denylist.js';
import { isGrantedOriginEntry, MAX_GRANTED_ORIGINS } from './injection.js';

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

/** L1 声明的快捷提问在配置中心的投影：只用于「显示/停用」开关，故不取模板（不持第二份副本）。 */
export interface PackQuickActionView {
  id: string;
  label: string;
  context: QuickActionContext;
}

/** 用户自建的快捷提问：模板是用户自己的内容，面板持其草稿并整条回写。 */
export interface OverlayQuickActionView {
  id: string;
  label: string;
  template: string;
  context: QuickActionContext;
  featureIds?: string[];
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
  configSchema?: Record<string, unknown>;
  /** pack 预置的快捷提问；未声明时省略。 */
  quickActions?: PackQuickActionView[];
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

/**
 * 站点作用域与 "*" 全局作用域的合并投影：全局作用域结构上不出现 enabled/restrictions/packConfig，
 * siteDenylist 则只出现在全局作用域（黑名单跨站点，不锚定任何 pack）。
 */
export interface OverlayScopeView {
  enabled?: false;
  siteDenylist?: string[];
  /** 站点注入授权集（adr-027 轨二）：本机 chrome.permissions 与本集合的交集才常驻注入。 */
  grantedOrigins?: string[];
  /** 本作用域自建的快捷提问（R-5）。 */
  quickActions?: OverlayQuickActionView[];
  /** 本作用域停用的快捷提问 id（只收紧：只能让某条不出现，不能改写它）。 */
  disabledQuickActions?: string[];
  rules?: OverlayEntryView[];
  facts?: OverlayEntryView[];
  restrictions?: {
    riskTierRaise?: Record<string, RiskTierRaise>;
    disabledTools?: string[];
  };
  packConfig?: Record<string, unknown>;
  preferences?: {
    verbosity?: Verbosity;
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
  /** 宿主取得的匿名令牌；空串 = 尚未激活成功，本页读写将得到 401 并如实呈现。 */
  authToken: string;
  /** 全局设置页回显的用户自配服务端地址；空串 = 用构建缺省。 */
  serverBaseUrl: string;
  saveSettings(patch: { serverBaseUrl?: string }): Promise<void>;
  /**
   * 服务端地址信任归一（宿主注入 normalizeTrustedServerBaseUrl）：返回 null 即不受信。
   * 缺省 = 不切换本页请求基址（仅落盘，下次开页由宿主归一）——令牌绝不发往未归一地址。
   */
  normalizeBaseUrl?(value: string): string | null;
  /**
   * 把保存后的站点黑名单全量镜像回本机存储（background 激活判定的数据源）；缺省 = 只写 L2，
   * 本机侧要等下次冷启动重拉才收紧。
   */
  saveSiteDenylist?(entries: string[]): Promise<void>;
  /**
   * 把保存后的站点授权集全量镜像回本机存储（background 常驻注册面的数据源之一）。
   * 缺省 = 只写 L2，本机注册面要等下次冷启动重拉才对齐。
   */
  saveGrantedOrigins?(entries: string[]): Promise<void>;
  /**
   * 向浏览器申请该 origin 的访问权限（chrome.permissions.request）；返回是否授予。
   * MUST 在用户手势内同步调用——授权气泡只在手势里弹得出来。缺省 = 视同已授予（无浏览器宿主的测试环境）。
   */
  requestOriginAccess?(origin: string): Promise<boolean>;
  /** 撤销该 origin 的浏览器访问权限（chrome.permissions.remove）。 */
  revokeOriginAccess?(origin: string): Promise<boolean>;
  /**
   * 该 origin 当下是否真的持有浏览器访问权限（chrome.permissions.contains）。
   * 缺省 = 视同已授予（无浏览器宿主的降级环境不凭空报未授权）。
   */
  hasOriginAccess?(origin: string): Promise<boolean>;
}

export interface ConfigCenterHandle {
  /** 首屏 L1+L2 读取与渲染完成。 */
  ready: Promise<void>;
  /** 提交待保存态：本地设置 + PUT overlay；失败如实反映在状态行，不冒充成功。 */
  save(): Promise<void>;
}

const QUICK_ACTION_CONTEXT_LABEL: Record<QuickActionContext, string> = {
  selection: '用在选中内容上（右键菜单）',
  page: '针对当前页面（面板按钮）',
  none: '与页面无关（面板按钮）',
};
const QUICK_ACTION_CONTEXTS: QuickActionContext[] = ['page', 'none', 'selection'];

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
/** 状态行呈现的服务端 issues 条数上限（超出以计数收尾）。 */
const ISSUE_DISPLAY_LIMIT = 5;
const GLOBAL_SCOPE = '*';
const TABS: { id: string; label: string }[] = [
  { id: 'packs', label: '站点包' },
  { id: 'overlay', label: '个人定制' },
  { id: 'global', label: '全局设置' },
];

/** 地址未过信任归一：保存被拒（令牌绝不发往未归一地址）。 */
class UntrustedBaseUrlError extends Error {}

/** R1 只收紧：候选档位不严于 pack 基线即不可选。 */
export function isTierSelectable(baseTier: RiskTier, candidate: RiskTier): boolean {
  return TIER_ORDER[candidate] >= TIER_ORDER[baseTier];
}

/** 读取失败的人读化：与保存路径分开——读路径没有提交动作，不得复用保存/重提文案。 */
export function describeLoadFailure(status: number, body: unknown): string {
  const detail = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown };
  const error = typeof detail.error === 'string' ? detail.error : '';
  if (status === 401) {
    return '尚未取得身份或身份已失效（身份由插件自动获取，无需填写）：请在「全局设置」确认服务端地址、检查网络后重新打开本页。';
  }
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
  // 身份是开页时按当时的服务端地址取得的：本页内改地址后旧身份必被新服务端拒，重开本页即按新地址重新取得。
  if (status === 401) {
    return '个人配置未提交：身份已失效或与当前服务端地址不匹配（身份由插件按服务端地址自动获取，无需填写）——请重新打开本页后重新提交。';
  }
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

/** 行式设置项：左侧标签与说明，右侧单个控件。 */
function settingRow(label: HTMLElement, hint: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'za-cc-setting');
  const copy = el('div', 'za-cc-setting-copy');
  copy.append(label, el('p', 'za-cc-hint', hint));
  const slot = el('div', 'za-cc-setting-control');
  slot.append(control);
  row.append(copy, slot);
  return row;
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
  /** 空串 = 未设置，跟随站点包默认。 */
  verbosity: Verbosity | '';
  /** "*" 作用域的站点黑名单待保存态；空数组 = 无名单（写回时省略该键）。 */
  siteDenylist: string[];
  /** "*" 作用域的站点授权集待保存态；空数组 = 未授权任何站点（写回时省略该键）。 */
  grantedOrigins: string[];
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

    if (Object.keys(raise).length > 0 || disabledTools.length > 0) {
      const scope = ensureScope(packs, pack.packId);
      scope.restrictions = {
        ...scope.restrictions,
        ...(Object.keys(raise).length > 0 ? { riskTierRaise: raise } : {}),
        ...(disabledTools.length > 0 ? { disabledTools } : {}),
      };
      if (Object.keys(raise).length === 0) delete scope.restrictions.riskTierRaise;
      if (disabledTools.length === 0) delete scope.restrictions.disabledTools;
    }
    const scope = packs[pack.packId];
    if (scope !== undefined && Object.keys(raise).length === 0 && scope.restrictions !== undefined) {
      delete scope.restrictions.riskTierRaise;
      if (Object.keys(scope.restrictions).length === 0) delete scope.restrictions;
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

  // 删空时省略该键：契约 minItems=1，空数组会被写入期拒收。
  if (state.siteDenylist.length === 0) delete packs[GLOBAL_SCOPE]?.siteDenylist;
  else ensureScope(packs, GLOBAL_SCOPE).siteDenylist = [...state.siteDenylist];

  if (state.grantedOrigins.length === 0) delete packs[GLOBAL_SCOPE]?.grantedOrigins;
  else ensureScope(packs, GLOBAL_SCOPE).grantedOrigins = [...state.grantedOrigins];

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
    verbosity: '',
    siteDenylist: [],
    grantedOrigins: [],
    loadError: null,
  };
  const authToken = deps.authToken;
  // 基址在保存后就地更新：换地址后本页后续请求即用新值，无需重开。
  let apiBaseUrl = deps.baseUrl;
  let serverBaseUrl = deps.serverBaseUrl;

  root.classList.add('za-cc');
  root.replaceChildren();

  const nav = el('nav', 'za-cc-nav');
  const brandMark = el('img', 'za-cc-brand-mark');
  brandMark.src = 'icons/icon.svg';
  brandMark.alt = '';
  const brandCopy = el('div');
  brandCopy.append(el('div', 'za-cc-logo', 'Zen Agent'), el('div', 'za-cc-logo-sub', '配置中心'));
  const brand = el('div', 'za-cc-brand');
  brand.append(brandMark, brandCopy);
  const navList = el('div', 'za-cc-nav-list');
  nav.append(brand, navList);
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
    navList.append(item);
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

  function pageHead(title: string, subtitle: string, actions: HTMLElement[] = []): HTMLElement {
    const head = el('div', 'za-cc-page-head');
    const copy = el('div', 'za-cc-page-copy');
    copy.append(el('h1', 'za-cc-page-title', title), el('p', 'za-cc-page-sub', subtitle));
    head.append(copy);
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
      pageHead('站点包', '服务端已安装的能力来源；在这里决定它们在你的账号下是否启用。', [
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
    );

    const meta = el('div', 'za-cc-pack-meta');
    meta.append(
      el(
        'span',
        'za-cc-pack-origin',
        pack.generic === true ? '任意站点（通用兜底）' : (pack.origin ?? '未声明站点围栏'),
      ),
      el('span', 'za-cc-pack-features', `功能 ${pack.features.length} 项`),
      el('span', 'za-cc-pack-tools', `工具 ${pack.tools.length} 项`),
    );
    if (pack.locations !== undefined && pack.locations.length > 0) {
      meta.append(el('span', 'za-cc-pack-locations', `路径 ${pack.locations.join(' ')}`));
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

    const ops = el('div', 'za-cc-pack-ops');
    ops.append(unavailable('导出', 'P3.5 pack 导入导出'), unavailable('卸载', 'P3.5 pack 打包分发'));

    card.append(row, meta, el('p', 'za-cc-pack-desc', pack.summary ?? '站点包未声明简介。'), ops);
    return card;
  }

  // ---- 个人定制页 ----

  function renderOverlayPanel(): void {
    const panel = panelOf('overlay');
    panel.replaceChildren(
      pageHead('个人定制', '按站点收紧权限、留下你的规则与事实、维护自己的快捷提问。'),
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
    node.append(renderQuickActions(scopeKey, pack));
    if (pack !== undefined && pack.tools.length > 0) node.append(renderMatrix(pack));
    return node;
  }

  /** 某条快捷提问当前是否被停用：两个作用域的停用清单任一命中即算（并集，与服务端同口径）。 */
  function isQuickActionDisabled(scopeKey: string, id: string): boolean {
    const global = state.basePacks[GLOBAL_SCOPE]?.disabledQuickActions ?? [];
    const scoped = state.basePacks[scopeKey]?.disabledQuickActions ?? [];
    return global.includes(id) || scoped.includes(id);
  }

  /**
   * 停用写本作用域；重新启用则两个作用域都摘（用户可能在任一处停过，只摘一处会让开关点了没反应）。
   * 清空即删键：契约的停用清单 minItems=1，空数组会被写入期拒收。
   */
  function setQuickActionDisabled(scopeKey: string, id: string, disabled: boolean): void {
    if (disabled) {
      const scope = ensureScope(state.basePacks, scopeKey);
      const list = scope.disabledQuickActions ?? [];
      if (!list.includes(id)) scope.disabledQuickActions = [...list, id];
      return;
    }
    for (const key of new Set([GLOBAL_SCOPE, scopeKey])) {
      const scope = state.basePacks[key];
      if (scope?.disabledQuickActions === undefined) continue;
      const kept = scope.disabledQuickActions.filter((entry) => entry !== id);
      if (kept.length === 0) delete scope.disabledQuickActions;
      else scope.disabledQuickActions = kept;
    }
  }

  /** 就地校验：与契约同口径（长度、占位符闭集、selection 必含 {{selection}}），过不了不入草稿。 */
  function quickActionIssue(
    scopeKey: string,
    label: string,
    template: string,
    context: QuickActionContext,
  ): string | null {
    if (label === '') return '请填写按钮上显示的文字';
    if (label.length > QUICK_ACTION_LABEL_MAX) return `按钮文字最多 ${QUICK_ACTION_LABEL_MAX} 字`;
    if (template === '') return '请填写点击后发给助手的话';
    if (template.length > QUICK_ACTION_TEMPLATE_MAX) return `内容最多 ${QUICK_ACTION_TEMPLATE_MAX} 字`;
    const allowed: readonly string[] = QUICK_ACTION_PLACEHOLDERS;
    const used = [...template.matchAll(/\{\{[^}]*\}\}/g)].map((match) => match[0]);
    const unknown = used.find((placeholder) => !allowed.includes(placeholder));
    if (unknown !== undefined) return `占位符 ${unknown} 不可用；可用的是 ${allowed.join(' / ')}`;
    if (context === 'selection' && !template.includes('{{selection}}')) {
      return '「用在选中内容上」的内容必须包含 {{selection}}，否则选中的文字无处可放';
    }
    const existing = state.basePacks[scopeKey]?.quickActions ?? [];
    if (existing.length >= MAX_QUICK_ACTIONS_PER_SCOPE) {
      return `本组最多 ${MAX_QUICK_ACTIONS_PER_SCOPE} 条快捷提问`;
    }
    return null;
  }

  /**
   * 快捷提问节：站点包预置的只给「显示/停用」开关（只收紧——改不了别人的模板），
   * 自建条目可删；下方是添加表单。id 由本页生成，用户不需要知道它的存在。
   */
  function renderQuickActions(scopeKey: string, pack: PackView | undefined): HTMLElement {
    const wrap = section('快捷提问');
    wrap.append(
      el('p', 'za-cc-hint', '面板输入框上方与右键菜单里的一排按钮：点一下就把下面这段话发给助手。它只是问法，不改变助手的权限。'),
    );
    for (const declared of pack?.quickActions ?? []) {
      const row = el('div', 'za-cc-quick-action');
      row.dataset['zaQuickActionId'] = declared.id;
      const toggle = el('input') as HTMLInputElement;
      toggle.type = 'checkbox';
      toggle.checked = !isQuickActionDisabled(scopeKey, declared.id);
      toggle.setAttribute('aria-label', `显示「${declared.label}」`);
      toggle.addEventListener('change', () => {
        setQuickActionDisabled(scopeKey, declared.id, !toggle.checked);
        renderOverlayPanel();
      });
      row.append(
        toggle,
        el('span', 'za-cc-quick-action-label', declared.label),
        badge('za-cc-badge-origin', '站点包预置', '来源：站点包预置（可停用，不可改写）'),
        el('span', 'za-cc-quick-action-context', QUICK_ACTION_CONTEXT_LABEL[declared.context]),
      );
      wrap.append(row);
    }
    for (const own of state.basePacks[scopeKey]?.quickActions ?? []) {
      const row = el('div', 'za-cc-quick-action');
      row.dataset['zaQuickActionId'] = own.id;
      row.append(
        el('span', 'za-cc-quick-action-label', own.label),
        badge('za-cc-badge-origin', '我添加的', '来源：我添加的'),
        el('span', 'za-cc-quick-action-context', QUICK_ACTION_CONTEXT_LABEL[own.context]),
        el('span', 'za-cc-quick-action-template', own.template),
      );
      const remove = el('button', 'za-cc-quick-action-delete za-cc-btn za-cc-btn-danger', '删除');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const scope = state.basePacks[scopeKey];
        const kept = (scope?.quickActions ?? []).filter((candidate) => candidate.id !== own.id);
        if (scope !== undefined) {
          if (kept.length === 0) delete scope.quickActions;
          else scope.quickActions = kept;
        }
        renderOverlayPanel();
      });
      row.append(remove);
      wrap.append(row);
    }
    wrap.append(renderQuickActionForm(scopeKey));
    return wrap;
  }

  function renderQuickActionForm(scopeKey: string): HTMLElement {
    const form = el('div', 'za-cc-quick-action-form');
    form.dataset['zaQuickActionForm'] = scopeKey;
    const label = el('input', 'za-cc-input') as HTMLInputElement;
    label.type = 'text';
    label.placeholder = '按钮文字，如「挑重点讲」';
    label.setAttribute('aria-label', '快捷提问的按钮文字');
    const template = el('textarea', 'za-cc-textarea') as HTMLTextAreaElement;
    template.rows = 2;
    template.placeholder = `点击后发给助手的话，可用 ${QUICK_ACTION_PLACEHOLDERS.join(' / ')}`;
    template.setAttribute('aria-label', '快捷提问的内容');
    const context = el('select', 'za-cc-select') as HTMLSelectElement;
    context.setAttribute('aria-label', '快捷提问的使用场景');
    for (const value of QUICK_ACTION_CONTEXTS) {
      const option = el('option', undefined, QUICK_ACTION_CONTEXT_LABEL[value]);
      option.value = value;
      context.append(option);
    }
    const issue = el('span', 'za-cc-quick-action-issue');
    const add = el('button', 'za-cc-btn', '添加快捷提问');
    add.type = 'button';
    add.dataset['zaQuickActionAdd'] = scopeKey;
    add.addEventListener('click', () => {
      const chosen = context.value as QuickActionContext;
      const problem = quickActionIssue(scopeKey, label.value.trim(), template.value.trim(), chosen);
      issue.textContent = problem ?? '';
      if (problem !== null) return;
      const scope = ensureScope(state.basePacks, scopeKey);
      scope.quickActions = [
        ...(scope.quickActions ?? []),
        {
          id: `qa-${crypto.randomUUID().slice(0, 8)}`,
          label: label.value.trim(),
          template: template.value.trim(),
          context: chosen,
        },
      ];
      renderOverlayPanel();
    });
    const fields = el('div', 'za-cc-qa-fields');
    fields.append(label, context);
    form.append(fields, template, add, issue);
    return form;
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
      const description = el('span', 'za-cc-tool-desc', tool.description);
      description.title = tool.description;
      nameCell.append(el('span', 'za-cc-tool-name', tool.toolId), description);
      const baseCell = el('td');
      const baseTier = el('span', 'za-cc-tool-base', `${TIER_LABEL[tool.baseTier]}（${tool.baseTier}）`);
      baseTier.dataset['zaTier'] = tool.baseTier;
      baseCell.append(baseTier);

      const chosen =
        state.tiers.get(tierKey(pack.packId, tool.toolId)) ??
        (disabledTools.has(tool.toolId) ? 'forbidden' : tool.baseTier);
      const select = el('select', 'za-cc-tier');
      select.dataset['zaToolId'] = tool.toolId;
      select.dataset['zaTier'] = chosen;
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
        select.dataset['zaTier'] = value;
        tightened.hidden = value === tool.baseTier;
      });

      const tierCell = el('td');
      tierCell.append(select, tightened);
      row.append(nameCell, baseCell, tierCell);
      table.append(row);
    }
    const scroller = el('div', 'za-cc-matrix-scroll');
    scroller.append(table);
    wrap.append(scroller);
    return wrap;
  }

  // ---- 全局设置页 ----

  let baseUrlInput: HTMLInputElement | null = null;
  let siteDenySection: HTMLElement | null = null;
  let grantSection: HTMLElement | null = null;

  /** 身份只读展示：形态 + hostUserId 指纹前 8 位；完整标识经复制按钮取用（排障时报给运维）。 */
  function identityField(): HTMLElement {
    const field = el('div', 'za-cc-field');
    const head = el('div', 'za-cc-field-head');
    head.append(el('span', 'za-cc-label', '身份'), badge('za-cc-badge-kind', '匿名（自动登录）'));
    field.append(head);

    const hostUserId = state.subject?.hostUserId ?? '';
    if (hostUserId === '') {
      field.append(el('p', 'za-cc-hint', '尚未连上服务端，身份标识未知；插件会在联网后自动完成登录。'));
      return field;
    }
    const row = el('div', 'za-cc-field-inline');
    const fingerprint = el('code', 'za-cc-identity', hostUserId.replace(/^anon-/, '').slice(0, 8));
    fingerprint.id = 'za-cc-identity';
    const copy = el('button', 'za-cc-btn', '复制完整标识');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        setStatus('当前环境不支持剪贴板，请手动选择文本复制', true);
        return;
      }
      void navigator.clipboard.writeText(hostUserId).then(
        () => setStatus('身份标识已复制'),
        () => setStatus('复制失败，请手动选择文本复制', true),
      );
    });
    row.append(fingerprint, copy);
    field.append(
      row,
      el('p', 'za-cc-hint', '无需填写任何凭证；个人配置按此标识归属，换浏览器或重装扩展会得到新标识。'),
    );
    return field;
  }

  function renderGlobalPanel(): void {
    const panel = panelOf('global');
    panel.replaceChildren(pageHead('全局设置', '连接、身份，以及跨全部站点生效的偏好与站点名单。'));

    const connection = section('连接');

    const baseUrlField = el('div', 'za-cc-field');
    const baseUrlLabel = el('label', 'za-cc-label', '服务端地址');
    baseUrlLabel.htmlFor = 'za-cc-base-url';
    baseUrlInput = el('input', 'za-cc-input');
    baseUrlInput.id = 'za-cc-base-url';
    baseUrlInput.value = serverBaseUrl;
    baseUrlInput.placeholder = '留空使用默认';
    baseUrlField.append(baseUrlLabel, baseUrlInput);
    connection.append(identityField(), baseUrlField);

    const preferences = section('偏好');
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
    preferences.append(settingRow(verbosityLabel, '偏好写入「全部站点」作用域，对所有站点包生效。', verbosity));

    const pending = section('尚未开放');
    for (const item of [
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

    siteDenySection = buildSiteDenySection();
    grantSection = buildGrantSection();
    panel.append(connection, preferences, grantSection, siteDenySection, pending, locked);
  }

  /** 名单增删只换本节点：全局设置页的地址是未提交的输入值，整页重渲会把它抹掉。 */
  function refreshSiteDenySection(): void {
    const next = buildSiteDenySection();
    siteDenySection?.replaceWith(next);
    siteDenySection = next;
  }

  /** 授权增删同律只换本节点。 */
  function refreshGrantSection(): void {
    const next = buildGrantSection();
    grantSection?.replaceWith(next);
    grantSection = next;
  }

  /**
   * 站点黑名单编辑面：写 "*" 全局作用域的 siteDenylist。
   * 面板只做就地文法自检与增删，不宣称本机拦下了什么——命中站点上不装配任何站点包的判定在服务端。
   */
  function buildSiteDenySection(): HTMLElement {
    const wrap = section('不辅助的站点');
    wrap.classList.add('za-cc-site-deny');
    wrap.append(
      el(
        'p',
        'za-cc-hint',
        '加进名单的站点上，Zen 不装配任何站点包，只留平台基座——判定在服务端，保存后下一轮装配即生效。' +
          '保存成功后插件同步这份名单：名单内的站点不再激活会话、不再上报页面上下文、不进任务组页面清单。' +
          '一处前提：服务端或本机读不到配置的那一轮不做拦截，该轮照常装配站点包、页面信息照常上行——' +
          '配置读取失败时以「照常辅助」兜底，不假装名单已经生效。',
      ),
    );

    for (const entry of state.siteDenylist) {
      const row = el('div', 'za-cc-site-deny-entry');
      row.dataset['zaSiteDeny'] = entry;
      const remove = el('button', 'za-cc-btn za-cc-btn-danger za-cc-site-deny-remove', '移出名单');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        state.siteDenylist = state.siteDenylist.filter((candidate) => candidate !== entry);
        refreshSiteDenySection();
      });
      row.append(
        el('span', 'za-cc-site-deny-text', entry),
        el(
          'span',
          'za-cc-hint',
          entry.includes('://*.') ? '该域及其全部子域' : '该站点（scheme 与端口须完全一致）',
        ),
        remove,
      );
      wrap.append(row);
    }
    if (state.siteDenylist.length === 0) {
      wrap.append(el('p', 'za-cc-empty', '名单为空：Zen 在所有站点上照常按站点包辅助。'));
    }

    const input = el('input', 'za-cc-site-deny-input');
    input.type = 'text';
    input.placeholder = 'https://example.com';
    input.setAttribute('aria-label', '要加入不辅助名单的站点');
    const add = el('button', 'za-cc-btn za-cc-site-deny-add', '加入名单');
    add.type = 'button';
    add.addEventListener('click', () => {
      const value = input.value.trim();
      if (!isSiteDenyEntry(value)) {
        setStatus(
          '站点格式不正确：请填 https://example.com（可带端口）或 https://*.example.com（该域及子域），' +
            '不支持通配整个网络',
          true,
        );
        return;
      }
      if (state.siteDenylist.includes(value)) {
        setStatus(`${value} 已在名单里`, true);
        return;
      }
      if (state.siteDenylist.length >= MAX_SITE_DENYLIST_ENTRIES) {
        setStatus(`名单最多 ${MAX_SITE_DENYLIST_ENTRIES} 条`, true);
        return;
      }
      state.siteDenylist = [...state.siteDenylist, value];
      setStatus(`${value} 已加入待保存的名单，点「保存」后不再进入该站点；已打开的页重载后生效`);
      refreshSiteDenySection();
    });
    const form = el('div', 'za-cc-field-inline');
    form.append(input, add);
    wrap.append(
      form,
      el(
        'p',
        'za-cc-hint',
        '两种写法：https://example.com 只匹配该站点（scheme 与端口精确，www 与裸域互认）；' +
          'https://*.example.com 匹配该域及其全部子域。',
      ),
    );
    return wrap;
  }

  /**
   * 本机浏览器对某 origin 的实际授权态。只登记探测到的结果：未登记项视同已授予——
   * 宿主不提供探测面时，本页不得凭空把一个用得好好的站点报成未授权。
   */
  const localOriginAccess = new Map<string, boolean>();

  /**
   * 授权判定的唯一出口：L2 声明 ∩ 本机浏览器权限。
   * 两者之一缺席，该站点当下就不会被注入——只认 L2 会把「已授权」显示成一个其实注入不进去的状态，
   * 且不给出任何补回授权的线索（浏览器侧的撤销不通知本页）。
   */
  function originAuthorized(origin: string): boolean {
    return state.grantedOrigins.includes(origin) && localOriginAccess.get(origin) !== false;
  }

  /** 已授权集在本机的实际状态重探；有变动才重渲。 */
  async function syncLocalOriginAccess(): Promise<void> {
    const probe = deps.hasOriginAccess;
    if (probe === undefined) return;
    let changed = false;
    for (const origin of state.grantedOrigins) {
      const has = await probe(origin).catch(() => true);
      if (localOriginAccess.get(origin) === has) continue;
      localOriginAccess.set(origin, has);
      changed = true;
    }
    if (!changed) return;
    refreshGrantSection();
  }

  /**
   * 站点授权：先向浏览器申请（MUST 在手势内同步发起，故本函数第一个动作即 request），
   * 授予后才进待保存的 L2 授权集。浏览器拒绝时不写 L2——本机拿不到权限，写进去也只是一条永远不生效的声明。
   */
  async function grantOrigin(origin: string): Promise<boolean> {
    // 上限先判：判定是同步的，仍落在手势内；先弹气泡再说「其实加不进去」等于白要一次权限。
    if (state.grantedOrigins.length >= MAX_GRANTED_ORIGINS && !state.grantedOrigins.includes(origin)) {
      setStatus(`站点授权最多 ${MAX_GRANTED_ORIGINS} 个`, true);
      return false;
    }
    if (!(await (deps.requestOriginAccess?.(origin) ?? Promise.resolve(true)))) {
      setStatus(`浏览器未授予 ${origin} 的访问权限：Zen 不会在该站点常驻`, true);
      return false;
    }
    localOriginAccess.set(origin, true);
    if (!state.grantedOrigins.includes(origin)) state.grantedOrigins = [...state.grantedOrigins, origin];
    setStatus(`${origin} 已授权，点「保存」后 Zen 即可在该站点常驻`);
    return true;
  }

  /** 撤销：浏览器权限与 L2 声明一并撤，二者不对称会留下一个自己也说不清的中间态。 */
  async function revokeOrigin(origin: string): Promise<void> {
    await deps.revokeOriginAccess?.(origin);
    localOriginAccess.delete(origin);
    state.grantedOrigins = state.grantedOrigins.filter((candidate) => candidate !== origin);
    setStatus(`${origin} 的授权已撤销，点「保存」后不再进入该站点；已打开的页重载后生效`);
  }

  /**
   * 站点授权编辑面：写 "*" 全局作用域的 grantedOrigins，并同步向浏览器申请/撤销该 origin 的访问权限。
   * 授权只决定 Zen 在该站点是否出现，不改变任何工具的风险档位与确认要求——那两项恒由站点包与个人定制决定。
   */
  function buildGrantSection(): HTMLElement {
    const wrap = section('已授权常驻的站点');
    wrap.classList.add('za-cc-site-grant');
    wrap.append(
      el(
        'p',
        'za-cc-hint',
        'Zen 默认不进入任何页面：点图标或用右键唤起时才把执行器放进当前页，离开该页即失效。' +
          '授权某个站点后，Zen 才可以在该站点常驻，不必每次先点图标唤起。' +
          '授权只决定 Zen 在这些站点上是否出现，不改变任何操作的风险档位与确认要求。' +
          '被加进「不辅助的站点」名单的站点即使授权过也不会注入。',
      ),
    );

    for (const origin of state.grantedOrigins) {
      const row = el('div', 'za-cc-site-grant-entry');
      row.dataset['zaSiteGrant'] = origin;
      const remove = el('button', 'za-cc-btn za-cc-btn-danger za-cc-site-grant-remove', '撤销授权');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        void revokeOrigin(origin).then(() => {
          refreshGrantSection();
        });
      });
      row.append(el('span', 'za-cc-site-grant-text', origin), remove);
      if (localOriginAccess.get(origin) === false) {
        const regrant = el('button', 'za-cc-btn za-cc-site-grant-regrant', '重新授权');
        regrant.type = 'button';
        regrant.addEventListener('click', () => {
          void grantOrigin(origin).then((granted) => {
            if (!granted) return;
            refreshGrantSection();
          });
        });
        row.append(
          badge(
            'za-cc-badge-warn',
            '浏览器已撤销访问',
            '这条声明仍在，但浏览器当下没有给 Zen 该站点的访问权限：点「重新授权」即可补回',
          ),
          regrant,
        );
      }
      if (siteDeniesUrl(state.siteDenylist, origin)) {
        row.append(
          badge('za-cc-badge-warn', '被名单挡住', '该站点同时在「不辅助的站点」名单内：黑名单优先，不注入'),
        );
      }
      wrap.append(row);
    }
    if (state.grantedOrigins.length === 0) {
      wrap.append(el('p', 'za-cc-empty', '尚未授权任何站点：Zen 只在你点图标/用右键唤起的那一页上工作。'));
    }

    const input = el('input', 'za-cc-site-grant-input');
    input.type = 'text';
    input.placeholder = 'https://example.com';
    input.setAttribute('aria-label', '要授权 Zen 常驻的站点');
    const add = el('button', 'za-cc-btn za-cc-site-grant-add', '授权站点');
    add.type = 'button';
    add.addEventListener('click', () => {
      const value = input.value.trim();
      if (!isGrantedOriginEntry(value)) {
        setStatus('站点格式不正确：请填精确地址 https://example.com（可带端口），不支持通配', true);
        return;
      }
      if (originAuthorized(value)) {
        setStatus(`${value} 已在授权列表里`, true);
        return;
      }
      void grantOrigin(value).then((granted) => {
        if (granted) {
          input.value = '';
          refreshGrantSection();
        }
      });
    });
    const form = el('div', 'za-cc-field-inline');
    form.append(input, add);
    wrap.append(form);
    return wrap;
  }

  function renderAll(): void {
    renderPacksPanel();
    renderOverlayPanel();
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
    state.siteDenylist = [...(state.basePacks[GLOBAL_SCOPE]?.siteDenylist ?? [])];
    state.grantedOrigins = [...(state.basePacks[GLOBAL_SCOPE]?.grantedOrigins ?? [])];

    state.tiers = new Map();
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

  /**
   * 本机设置持久化（服务端地址）：与 L2 提交解耦——服务端不可达时用户仍须能改地址。
   * 写入成功后同步刷新本实例持有的基址，后续请求即用新值。
   */
  async function persistLocalSettings(): Promise<boolean> {
    const patch: { serverBaseUrl?: string } = {};
    const baseUrl = baseUrlInput?.value.trim() ?? '';
    // 地址信任归一是采用该地址的前置条件：未归一地址一律不落盘、更不切换本页基址——
    // 否则本页会立刻把令牌发往该地址（server-url 的 TLS/loopback 硬门不得被绕过）。
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
    if (patch.serverBaseUrl !== undefined) {
      serverBaseUrl = patch.serverBaseUrl;
      if (trustedBaseUrl !== null && trustedBaseUrl !== '') {
        apiBaseUrl = trustedBaseUrl.replace(/\/+$/, '');
      }
    }
    if (untrustedBaseUrl) throw new UntrustedBaseUrlError();
    return true;
  }

  /** 站点黑名单的本机镜像（background 激活判定的数据源）：仅在 L2 写入成功后落盘。 */
  async function persistSiteDenylistMirror(): Promise<void> {
    if (deps.saveSiteDenylist === undefined) return;
    await deps.saveSiteDenylist([...state.siteDenylist]);
  }

  /** 站点授权集的本机镜像（background 常驻注册面的数据源之一）：同律，仅在 L2 写入成功后落盘。 */
  async function persistGrantedOriginsMirror(): Promise<void> {
    if (deps.saveGrantedOrigins === undefined) return;
    await deps.saveGrantedOrigins([...state.grantedOrigins]);
  }

  async function save(): Promise<void> {
    let localSaved = false;
    try {
      localSaved = await persistLocalSettings();
    } catch (error) {
      setStatus(
        error instanceof UntrustedBaseUrlError
          ? '服务端地址不受信：生产地址必须使用 HTTPS（仅 127.0.0.1/localhost 可用 HTTP），该地址未保存'
          : '本机设置保存失败',
        true,
      );
      return;
    }
    // 地址刚变更且此前无可用连接（首装/地址填错）：以新值重读 L1+L2 并重渲染。
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
          ? '本机设置已保存；个人配置未提交：新地址下尚无可用身份——请重新打开本页后重新提交（仍不通则核对服务端地址与网络）'
          : '个人配置未提交：尚未连上服务端，请核对全局设置里的服务端地址与网络',
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
        await persistSiteDenylistMirror();
        await persistGrantedOriginsMirror();
      } catch {
        setStatus('个人配置已保存，但本机镜像写入失败（重开本页可重试）', true);
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
    if (response.status === 401) {
      setStatus(`${localSaved ? '本机设置已保存；' : ''}${describeSaveFailure(401, body)}`, true);
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
    .then(async () => {
      renderAll();
      if (state.loadError !== null) setStatus(state.loadError, true);
      await syncLocalOriginAccess();
    });

  return { ready, save };
}
