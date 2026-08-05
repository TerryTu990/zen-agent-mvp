// @vitest-environment jsdom
/**
 * G3（P2.5-c）会话面板 config-draft 卡：复用 hitl 卡片视觉惯例但独立组件——
 * .za-config-card / .za-config-approve / .za-config-reject / [data-za-config-draft]。
 * 客户端零写入判定（U8）：卡片只上行 config-decision 帧，决定后置终态不可重复触发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConfigDecisionFrame, ConfigDraftFrame } from '../src/frames.js';
import { renderConfigDraftCard } from '../src/config-draft-card.js';

function messagesEl(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

function draftFrame(overrides: Partial<ConfigDraftFrame> = {}): ConfigDraftFrame {
  return {
    type: 'config-draft',
    sessionId: 's1',
    draftId: 'd-1',
    scope: { packId: 'host-demo', featureId: 'order-list' },
    change: {
      rules: [
        {
          id: 'r-abc12345',
          text: '回复买家时引用运费模板。',
          origin: 'teach',
          createdAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    },
    summary: '新增个人规则：回复买家时引用运费模板。',
    ...overrides,
  };
}

type SendFn = (frame: ConfigDecisionFrame) => void;

describe('config-draft 卡渲染（summary/scope/change 预览，R3 用户须看到真实将写入什么）', () => {
  it('渲染 .za-config-card：draftId 标记、summary 可见、规则条目文本逐条可见', () => {
    const messages = messagesEl();
    renderConfigDraftCard(messages, draftFrame(), vi.fn<SendFn>());

    const card = messages.querySelector('.za-config-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-za-config-draft')).toBe('d-1');
    expect(card?.textContent).toContain('新增个人规则：回复买家时引用运费模板。');
    expect(card?.textContent).toContain('回复买家时引用运费模板。');
  });

  it('scope.title 提供时显示人读作用域标签', () => {
    const messages = messagesEl();
    renderConfigDraftCard(
      messages,
      draftFrame({ scope: { packId: 'host-demo', featureId: 'order-list', title: '订单演示 · 订单列表' } }),
      vi.fn<SendFn>(),
    );

    expect(messages.querySelector('.za-config-card')?.textContent).toContain('订单演示 · 订单列表');
  });

  it('scope.title 缺省时回退展示 packId 与 featureId', () => {
    const messages = messagesEl();
    renderConfigDraftCard(messages, draftFrame(), vi.fn<SendFn>());

    const text = messages.querySelector('.za-config-card')?.textContent ?? '';
    expect(text).toContain('host-demo');
    expect(text).toContain('order-list');
  });

  it('riskTierRaise 类 change 预览含目标 toolId（收紧内容可见）', () => {
    const messages = messagesEl();
    renderConfigDraftCard(
      messages,
      draftFrame({
        change: { restrictions: { riskTierRaise: { 'order-list.refresh-orders': 'hitl' } } },
        summary: '收紧：刷新订单改为需确认。',
      }),
      vi.fn<SendFn>(),
    );

    const text = messages.querySelector('.za-config-card')?.textContent ?? '';
    expect(text).toContain('order-list.refresh-orders');
  });
});

describe('config-decision 上行与终态（U8：客户端只回传 draftId+decision，零写入判定）', () => {
  it('点 .za-config-approve → 发出 config-decision accept 帧（仅 draftId+decision，不含 change）', () => {
    const messages = messagesEl();
    const send = vi.fn<SendFn>();
    renderConfigDraftCard(messages, draftFrame(), send);

    messages.querySelector<HTMLButtonElement>('.za-config-approve')?.click();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'config-decision',
      sessionId: 's1',
      draftId: 'd-1',
      decision: 'accept',
    });
  });

  it('点 .za-config-reject → 发出 config-decision reject 帧', () => {
    const messages = messagesEl();
    const send = vi.fn<SendFn>();
    renderConfigDraftCard(messages, draftFrame(), send);

    messages.querySelector<HTMLButtonElement>('.za-config-reject')?.click();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'config-decision',
      sessionId: 's1',
      draftId: 'd-1',
      decision: 'reject',
    });
  });

  it('决定后卡片置终态（data-decided），按钮禁用且再点不重复上行', () => {
    const messages = messagesEl();
    const send = vi.fn<SendFn>();
    renderConfigDraftCard(messages, draftFrame(), send);

    const approve = messages.querySelector<HTMLButtonElement>('.za-config-approve');
    approve?.click();

    const card = messages.querySelector('.za-config-card');
    expect(card?.getAttribute('data-decided')).toBe('accept');
    expect(approve?.disabled).toBe(true);
    expect(messages.querySelector<HTMLButtonElement>('.za-config-reject')?.disabled).toBe(true);

    approve?.click();
    messages.querySelector<HTMLButtonElement>('.za-config-reject')?.click();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reject 终态：data-decided=reject 且不可再触发 accept', () => {
    const messages = messagesEl();
    const send = vi.fn<SendFn>();
    renderConfigDraftCard(messages, draftFrame(), send);

    messages.querySelector<HTMLButtonElement>('.za-config-reject')?.click();
    messages.querySelector<HTMLButtonElement>('.za-config-approve')?.click();

    expect(messages.querySelector('.za-config-card')?.getAttribute('data-decided')).toBe('reject');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].decision).toBe('reject');
  });

  it('全局作用域 "*" 显示为「所有站点」（人读回退，R4）', () => {
    const messages = messagesEl();
    renderConfigDraftCard(
      messages,
      draftFrame({ scope: { packId: '*' } }),
      vi.fn<SendFn>(),
    );
    expect(messages.querySelector('.za-config-card')?.textContent).toContain('所有站点');
  });

  it('终态如实反馈（R6）：accept 显示已保存与配置中心指引，reject 显示未保存', () => {
    const acceptMessages = messagesEl();
    renderConfigDraftCard(acceptMessages, draftFrame(), vi.fn<SendFn>());
    acceptMessages.querySelector<HTMLButtonElement>('.za-config-approve')?.click();
    const acceptText = acceptMessages.querySelector('.za-config-card')?.textContent ?? '';
    expect(acceptText).toContain('已保存');
    expect(acceptText).toContain('配置中心');

    const rejectMessages = messagesEl();
    renderConfigDraftCard(rejectMessages, draftFrame(), vi.fn<SendFn>());
    rejectMessages.querySelector<HTMLButtonElement>('.za-config-reject')?.click();
    expect(rejectMessages.querySelector('.za-config-card')?.textContent).toContain('未保存');
  });
});
