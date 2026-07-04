// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HitlRequestFrame, ToolCardFrame } from '../src/frames.js';
import { createConversationUi } from '../src/conversation-hitl.js';

function messagesEl(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

function toolCard(status: ToolCardFrame['status'], overrides: Partial<ToolCardFrame> = {}): ToolCardFrame {
  return {
    type: 'tool-card',
    sessionId: 's1',
    toolCallId: 'tc1',
    toolId: 'order-list.cancel-order',
    status,
    summary: '正在取消订单',
    ...overrides,
  };
}

function hitlRequest(overrides: Partial<HitlRequestFrame> = {}): HitlRequestFrame {
  return {
    type: 'hitl-request',
    sessionId: 's1',
    hitlId: 'h1',
    toolCallId: 'tc1',
    toolId: 'order-list.cancel-order',
    params: { orderId: 'ORD-1001' },
    reason: '高风险操作需确认',
    ...overrides,
  };
}

describe('renderToolCard 工具卡片三状态', () => {
  it('running：渲染 [data-za-toolcard][data-status=running] 且含摘要', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('running'));

    const card = messages.querySelector('[data-za-toolcard]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-status')).toBe('running');
    expect(card?.textContent).toContain('正在取消订单');
  });

  it('succeeded / failed：各自 data-status 反映状态', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('succeeded', { toolCallId: 'a' }));
    ui.renderToolCard(toolCard('failed', { toolCallId: 'b' }));

    const cards = messages.querySelectorAll('[data-za-toolcard]');
    expect(cards.length).toBe(2);
    expect(cards[0]?.getAttribute('data-status')).toBe('succeeded');
    expect(cards[1]?.getAttribute('data-status')).toBe('failed');
  });

  it('同一 toolCallId 状态迁移：就地更新同一张卡片而非新增', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('running'));
    ui.renderToolCard(toolCard('succeeded'));

    const cards = messages.querySelectorAll('[data-za-toolcard]');
    expect(cards.length).toBe(1);
    expect(cards[0]?.getAttribute('data-status')).toBe('succeeded');
  });

  it('卡片摘要不含 params/body（仅呈现 summary 文案）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('running', { summary: '正在处理' }));

    const card = messages.querySelector('[data-za-toolcard]');
    expect(card?.textContent).not.toContain('ORD-');
  });
});

describe('renderToolCard 按 mode 分组', () => {
  it('不同 mode 进不同 section；缺省 mode 归入 client 组', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('running', { toolCallId: 'a', mode: 'server' }));
    ui.renderToolCard(toolCard('running', { toolCallId: 'b', mode: 'mcp' }));
    ui.renderToolCard(toolCard('running', { toolCallId: 'c' }));

    expect(messages.querySelector('[data-mode="server"] [data-za-toolcard]')).not.toBeNull();
    expect(messages.querySelector('[data-mode="mcp"] [data-za-toolcard]')).not.toBeNull();
    expect(messages.querySelector('[data-mode="client"] [data-za-toolcard]')).not.toBeNull();
    expect(messages.querySelectorAll('.za-toolgroup').length).toBe(3);
  });

  it('同 mode 多卡进同一组，且状态迁移就地更新', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.renderToolCard(toolCard('running', { toolCallId: 'a', mode: 'server' }));
    ui.renderToolCard(toolCard('running', { toolCallId: 'b', mode: 'server' }));
    ui.renderToolCard(toolCard('succeeded', { toolCallId: 'a', mode: 'server' }));

    const groups = messages.querySelectorAll('.za-toolgroup');
    expect(groups.length).toBe(1);
    expect(messages.querySelectorAll('[data-za-toolcard]').length).toBe(2);
    expect(messages.querySelector('[data-za-toolcard]')?.getAttribute('data-status')).toBe('succeeded');
  });
});

describe('appendTextDelta assistant 气泡 markdown 渲染', () => {
  it('累积增量后全量重渲染，粗体成 b 节点、用户气泡为纯文本', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.appendTextDelta({ type: 'text-delta', sessionId: 's1', delta: '**重' });
    ui.appendTextDelta({ type: 'text-delta', sessionId: 's1', delta: '点**' });

    const bubble = messages.querySelector('.za-msg[data-role="assistant"] .mdlite');
    expect(bubble?.querySelector('b')?.textContent).toBe('重点');
    // 全量重渲染而非累加，只应有一个气泡
    expect(messages.querySelectorAll('.za-msg[data-role="assistant"]').length).toBe(1);
  });

  it('用户再次发言关闭当前回合，下一 delta 开新气泡', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.appendTextDelta({ type: 'text-delta', sessionId: 's1', delta: 'a' });
    ui.appendUserMessage('问题');
    ui.appendTextDelta({ type: 'text-delta', sessionId: 's1', delta: 'b' });

    expect(messages.querySelectorAll('.za-msg[data-role="assistant"]').length).toBe(2);
  });
});

describe('promptHitl HITL 卡片裁决', () => {
  it('approve：点确认按钮 → Promise 解析为 approve', async () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    const decision = ui.promptHitl(hitlRequest());
    const approve = messages.querySelector<HTMLButtonElement>('[data-za-hitl-approve]');
    expect(approve).not.toBeNull();
    approve?.click();

    await expect(decision).resolves.toBe('approve');
  });

  it('reject：点拒绝按钮 → Promise 解析为 reject', async () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    const decision = ui.promptHitl(hitlRequest());
    messages.querySelector<HTMLButtonElement>('[data-za-hitl-reject]')?.click();

    await expect(decision).resolves.toBe('reject');
  });

  it('卡片含 toolId 与 params 摘要（用户须看到真实将发生什么）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(hitlRequest());

    const card = messages.querySelector('[data-za-hitl]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('order-list.cancel-order');
    expect(card?.textContent).toContain('ORD-1001');
  });

  it('裁决后卡片移除（按钮不可再次触发）', async () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    const decision = ui.promptHitl(hitlRequest());
    messages.querySelector<HTMLButtonElement>('[data-za-hitl-approve]')?.click();
    await decision;

    expect(messages.querySelector('[data-za-hitl]')).toBeNull();
  });
});
