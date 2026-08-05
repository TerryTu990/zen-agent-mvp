/**
 * 注入透明视图（R4 来源可追溯 / R6 如实呈现）：以 GET /v1/sessions/:id/injection 响应为唯一数据源，
 * 分层呈现当前页面将注入的 L0/L1/L2 段与工具面收紧；服务端未给的字段一律不展示，不由客户端推断补齐。
 *
 * 类型 SSOT = packages/contracts（ports.ts 的 InjectionDescription 族）；本包零 @zen-agent 依赖，
 * 按 U5 契约手抄镜像——改契约须同步改本文件。可选字段显式带 `| undefined`，配合
 * exactOptionalPropertyTypes 允许调用方以显式 undefined 表达「服务端未给」。
 */

export type InjectionOrigin = 'L0' | 'L1' | 'L2';
export type InjectionRiskTier = 'auto' | 'hitl' | 'forbidden';
export type InjectionPackSource = 'official' | 'community' | 'local';

export interface InjectionBlockView {
  kind:
    | 'system-prompt'
    | 'sites-index'
    | 'feature-rules'
    | 'facts'
    | 'user-rules'
    | 'user-facts'
    | 'skill'
    | 'docs-index';
  id?: string | undefined;
  bytes: number;
  origin?: InjectionOrigin | undefined;
}

export interface InjectionToolView {
  toolId: string;
  baseTier: InjectionRiskTier;
  effectiveTier: InjectionRiskTier;
  origin: 'L0' | 'L1';
  /** 收紧来源作用域键（packId），或哨兵值 'storage-failure'（L2 读失败的治理降级）。 */
  tightenedBy?: string | undefined;
}

export interface InjectionDescriptionView {
  snapshotVersion: string;
  packId: string | null;
  featureId: string | null;
  blocks: InjectionBlockView[];
  toolIds: string[];
  tools?: InjectionToolView[] | undefined;
  packVersion?: string | undefined;
  packName?: string | undefined;
  packSource?: InjectionPackSource | undefined;
  featureTitle?: string | undefined;
  userConfigRevision?: string | undefined;
  /** 用户关停 pack 的轮次：packId 已回落 null，据此呈现「已关停」而非「无站点包」。 */
  disabledPackId?: string | undefined;
}

const LAYER_ORDER: InjectionOrigin[] = ['L0', 'L1', 'L2'];

const LAYER_NAMES: Record<InjectionOrigin, string> = {
  L0: '平台基座 · 不可修改',
  L1: '站点包',
  L2: '我的定制',
};

const BLOCK_NAMES: Record<InjectionBlockView['kind'], string> = {
  'system-prompt': '基座提示',
  'sites-index': '站点索引',
  'feature-rules': '功能规则',
  facts: '功能事实',
  'user-rules': '个人规则',
  'user-facts': '个人事实',
  skill: '技能',
  'docs-index': '文档索引',
};

const SOURCE_NAMES: Record<InjectionPackSource, string> = {
  official: '官方',
  community: '社区',
  local: '自建',
};

const TIER_NAMES: Record<InjectionRiskTier, string> = {
  auto: '自动执行',
  hitl: '需确认',
  forbidden: '禁止',
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tierText(tier: InjectionRiskTier): string {
  return `${TIER_NAMES[tier]}（${tier}）`;
}

function renderBlock(block: InjectionBlockView): HTMLElement {
  const row = el('li', 'za-injection-block');
  row.dataset['zaBlockKind'] = block.kind;
  if (block.id !== undefined) row.dataset['zaBlockId'] = block.id;
  row.append(el('span', 'za-injection-block-kind', BLOCK_NAMES[block.kind]));
  if (block.id !== undefined) row.append(el('span', 'za-injection-block-id', block.id));
  row.append(el('span', 'za-injection-bytes', `${block.bytes} 字节`));
  row.append(el('span', 'za-injection-origin', block.origin ?? '来源未标注'));
  return row;
}

function renderBlockList(blocks: InjectionBlockView[]): HTMLElement {
  const list = el('ul', 'za-injection-blocks');
  for (const block of blocks) list.append(renderBlock(block));
  return list;
}

function renderPackBadge(description: InjectionDescriptionView): HTMLElement {
  const parts = [description.packName ?? description.packId ?? ''];
  if (description.packVersion !== undefined) parts.push(`v${description.packVersion}`);
  if (description.packSource !== undefined) parts.push(SOURCE_NAMES[description.packSource]);
  return el('span', 'za-injection-pack', parts.join(' · '));
}

function renderHeader(description: InjectionDescriptionView): HTMLElement {
  const header = el('header', 'za-injection-head');
  header.append(el('h2', 'za-injection-title', '当前页面会注入什么'));
  if (description.packId !== null) {
    header.append(renderPackBadge(description));
    const featureLabel = description.featureTitle ?? description.featureId;
    if (featureLabel !== null && featureLabel !== undefined) {
      header.append(el('span', 'za-injection-feature', featureLabel));
    }
  }
  if (description.disabledPackId !== undefined) {
    header.append(
      el('span', 'za-injection-disabled-pack', `站点包「${description.disabledPackId}」已关停`),
    );
  }
  if (description.userConfigRevision !== undefined) {
    header.append(
      el('span', 'za-injection-revision', `个人定制版本 ${description.userConfigRevision}`),
    );
  }
  if (isStorageDegraded(description)) {
    header.append(
      el(
        'span',
        'za-injection-degraded',
        '个人定制读取失败：本轮工具面已整体收紧为禁止，讲解与引导仍可用；恢复后自动复原。',
      ),
    );
  }
  return header;
}

/** L2 分区在无 L2 注入段时仍呈现的两种参与形态：定格 revision、或工具面被 L2 收紧。 */
function hasUserLayer(description: InjectionDescriptionView, l2Blocks: InjectionBlockView[]): boolean {
  return (
    l2Blocks.length > 0 ||
    description.userConfigRevision !== undefined ||
    (description.tools ?? []).some((tool) => tool.tightenedBy !== undefined)
  );
}

function renderLayer(
  layer: InjectionOrigin,
  blocks: InjectionBlockView[],
  degraded = false,
): HTMLElement {
  const section = el('section', 'za-injection-layer');
  section.dataset['zaLayer'] = layer;
  const head = el('div', 'za-injection-layer-head');
  head.append(el('span', 'za-injection-layer-tag', layer));
  head.append(el('span', 'za-injection-layer-name', LAYER_NAMES[layer]));
  section.append(head);
  // 降级轮的空态不能说「无」——用户的定制还在，只是本轮读不到；说成「无」会让人以为配置丢了。
  section.append(
    blocks.length > 0
      ? renderBlockList(blocks)
      : el(
          'p',
          'za-injection-layer-empty',
          degraded ? '本轮读取失败，未注入（你的定制未被清空）' : '本轮无该层注入段',
        ),
  );
  return section;
}

function renderTool(toolId: string, tool: InjectionToolView | undefined): HTMLElement {
  const row = el('li', 'za-injection-tool');
  row.dataset['zaToolId'] = toolId;
  row.append(el('span', 'za-injection-tool-id', toolId));
  if (tool === undefined) return row;
  row.append(el('span', 'za-injection-tier-base', tierText(tool.baseTier)));
  if (tool.effectiveTier !== tool.baseTier) {
    row.append(el('span', 'za-injection-tier-arrow', '→'));
    row.append(el('span', 'za-injection-tier-effective', tierText(tool.effectiveTier)));
  }
  // 收紧来源只在档位确实被抬高时才说——基线本就是 forbidden 的工具没有被谁收紧，
  // 标上来源会让用户以为它原本可用、故障恢复后能用。
  if (tool.tightenedBy !== undefined && tool.effectiveTier !== tool.baseTier) {
    row.append(
      el(
        'span',
        'za-injection-tightened-by',
        tool.tightenedBy === 'storage-failure'
          ? '因存储故障降级收紧'
          : `收紧来源：${tool.tightenedBy}`,
      ),
    );
  }
  return row;
}

/**
 * 工具面渲染以「可见面 ∪ 逐项描述」为行集：收紧到禁止的工具已不在 toolIds 内，
 * 若只按可见面渲染，被收紧掉的工具会连同其收紧来源一起从视图消失——用户看到的是
 * 「agent 忽然什么都不做」而无从追溯（违 R4/R6）。故落面工具也成行。
 *
 * 落面原因决定措辞：存储降级是本轮的、会自行恢复；其余（用户自己关停等）是长期的，
 * 说成「本轮」会让用户等一个永远不来的恢复。
 */
function renderTools(description: InjectionDescriptionView): HTMLElement {
  const section = el('section', 'za-injection-tools');
  section.append(el('h3', 'za-injection-section-title', '工具面'));
  const list = el('ul', 'za-injection-tool-list');
  const byId = new Map((description.tools ?? []).map((tool) => [tool.toolId, tool]));
  const visible = new Set(description.toolIds);
  for (const toolId of description.toolIds) list.append(renderTool(toolId, byId.get(toolId)));
  for (const tool of description.tools ?? []) {
    if (visible.has(tool.toolId)) continue;
    const row = renderTool(tool.toolId, tool);
    row.dataset['zaToolUnavailable'] = 'true';
    // 基线本就禁止的工具不会「恢复可用」，说成本轮同样是误导；只有档位确实被降级抬高时才是本轮性的。
    const transient = tool.tightenedBy === 'storage-failure' && tool.effectiveTier !== tool.baseTier;
    row.append(
      el(
        'span',
        'za-injection-tool-unavailable',
        transient ? '本轮不可用' : tool.tightenedBy === 'storage-failure' ? '一直不可用' : '已被你的定制关闭',
      ),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

/** L2 读失败的降级轮：工具面整体禁止而讲解仍可用，须就地说明，否则「做不了」无从解释（R6）。 */
function isStorageDegraded(description: InjectionDescriptionView): boolean {
  return (description.tools ?? []).some((tool) => tool.tightenedBy === 'storage-failure');
}

/**
 * 以 description 全量替换 root 内容（重复渲染为替换而非追加）。
 * 分区只在该层确有内容时出现：未注入的层不渲染，避免制造「有该层参与」的假象。
 */
export function renderInjectionView(root: HTMLElement, description: InjectionDescriptionView): void {
  root.textContent = '';
  root.append(renderHeader(description));

  const byLayer = new Map<InjectionOrigin, InjectionBlockView[]>(
    LAYER_ORDER.map((layer) => [layer, [] as InjectionBlockView[]]),
  );
  const unlabeled: InjectionBlockView[] = [];
  for (const block of description.blocks) {
    if (block.origin === undefined) unlabeled.push(block);
    else byLayer.get(block.origin)?.push(block);
  }

  const degraded = isStorageDegraded(description);
  const layers = el('div', 'za-injection-layers');
  for (const layer of LAYER_ORDER) {
    const blocks = byLayer.get(layer) ?? [];
    const visible = layer === 'L2' ? hasUserLayer(description, blocks) : blocks.length > 0;
    if (visible) layers.append(renderLayer(layer, blocks, layer === 'L2' && degraded));
  }
  root.append(layers);

  if (unlabeled.length > 0) {
    const section = el('section', 'za-injection-unlabeled');
    section.append(el('h3', 'za-injection-section-title', '来源未标注的注入段'));
    section.append(renderBlockList(unlabeled));
    root.append(section);
  }

  if (description.toolIds.length > 0 || (description.tools ?? []).length > 0) {
    root.append(renderTools(description));
  }
  root.append(
    el('p', 'za-injection-note', '装配由服务端决定；对话内容不能改变以上任何治理配置。'),
  );
}
