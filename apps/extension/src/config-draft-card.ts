/**
 * L2 配置草稿确认卡（adr-014 teach 流）。视觉沿 hitl 卡惯例但独立组件；
 * U8：客户端零写入判定——卡片只呈现服务端构造的 change 并回传 draftId+decision，
 * change 内容不经客户端往返。用户须看到真实将写入什么（R3），故 change 逐条预览。
 */
import type { ConfigDecisionFrame, ConfigDraftFrame, JsonObject, JsonValue } from './frames.js';

const TIER_LABEL: Record<string, string> = {
  hitl: '需确认',
  forbidden: '禁止',
};

interface PreviewSection {
  label: string;
  items: string[];
}

function textEntries(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof entry['text'] === 'string'
        ? entry['text']
        : null,
    )
    .filter((text): text is string => text !== null);
}

function previewSections(change: JsonObject): PreviewSection[] {
  const sections: PreviewSection[] = [];
  const rules = textEntries(change['rules']);
  if (rules.length > 0) sections.push({ label: '个人规则', items: rules });
  const facts = textEntries(change['facts']);
  if (facts.length > 0) sections.push({ label: '个人事实', items: facts });
  const restrictions = change['restrictions'];
  if (typeof restrictions === 'object' && restrictions !== null && !Array.isArray(restrictions)) {
    const raise = restrictions['riskTierRaise'];
    if (typeof raise === 'object' && raise !== null && !Array.isArray(raise)) {
      const items = Object.entries(raise)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([toolId, tier]) => `${toolId} → ${TIER_LABEL[tier] ?? tier}`);
      if (items.length > 0) sections.push({ label: '收紧工具分级', items });
    }
  }
  return sections;
}

function scopeLabel(scope: ConfigDraftFrame['scope']): string {
  if (scope.title !== undefined) return scope.title;
  if (scope.packId === '*') return '所有站点';
  return scope.featureId === undefined ? scope.packId : `${scope.packId} · ${scope.featureId}`;
}

export function renderConfigDraftCard(
  messages: HTMLElement,
  frame: ConfigDraftFrame,
  send: (decision: ConfigDecisionFrame) => void,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'za-config-card';
  card.setAttribute('data-za-config-draft', frame.draftId);

  const title = document.createElement('div');
  title.className = 'za-config-title';
  title.textContent = '需你确认：更新个人配置';

  const scope = document.createElement('div');
  scope.className = 'za-config-scope';
  scope.textContent = `作用域：${scopeLabel(frame.scope)}`;

  const summary = document.createElement('div');
  summary.className = 'za-config-summary';
  summary.textContent = frame.summary;

  card.append(title, scope, summary);

  for (const section of previewSections(frame.change)) {
    const heading = document.createElement('div');
    heading.className = 'za-config-preview-label';
    heading.textContent = section.label;
    const list = document.createElement('ul');
    list.className = 'za-config-preview';
    for (const item of section.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    card.append(heading, list);
  }

  const note = document.createElement('div');
  note.className = 'za-config-note';
  note.textContent = '对话不会直接修改你的配置——只有此处确认后才会保存。草稿有效期内可确认。';
  card.append(note);

  const actions = document.createElement('div');
  actions.className = 'za-config-actions';
  const approve = document.createElement('button');
  approve.className = 'za-config-approve';
  approve.textContent = '确认保存';
  const reject = document.createElement('button');
  reject.className = 'za-config-reject';
  reject.textContent = '不保存';
  actions.append(approve, reject);
  card.append(actions);

  const outcome = document.createElement('div');
  outcome.className = 'za-config-outcome';
  card.append(outcome);

  const settle = (decision: ConfigDecisionFrame['decision']): void => {
    if (card.hasAttribute('data-decided')) return;
    card.setAttribute('data-decided', decision);
    approve.disabled = true;
    reject.disabled = true;
    // 点击时写入的是「已提交」而非「已保存」：写入结果由服务端裁定，失败时下方状态行给出说明
    // （成功回执的下行帧待补，见 docs/reviews G3 §5 锚点）——不先于服务端宣告成功（R6）。
    outcome.textContent =
      decision === 'accept'
        ? '已提交保存，成功后可在配置中心查看与修改。'
        : '未保存到配置。';
    send({ type: 'config-decision', sessionId: frame.sessionId, draftId: frame.draftId, decision });
  };
  approve.addEventListener('click', () => settle('accept'));
  reject.addEventListener('click', () => settle('reject'));

  messages.append(card);
  messages.scrollTop = messages.scrollHeight;
  return card;
}
