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
    ui.renderToolCard(toolCard('running', { toolCallId: 'b', mode: 'client' }));
    ui.renderToolCard(toolCard('running', { toolCallId: 'c' }));

    expect(messages.querySelector('[data-mode="server"] [data-za-toolcard]')).not.toBeNull();
    // 显式 client 与缺省 mode 合流进同一 client 组：server + client 共两组。
    expect(messages.querySelectorAll('[data-mode="client"] [data-za-toolcard]').length).toBe(2);
    expect(messages.querySelectorAll('.za-toolgroup').length).toBe(2);
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

describe('thinking indicator', () => {
  it('is idempotent and can be removed when the response starts', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    ui.showThinking();
    ui.showThinking();
    expect(messages.querySelectorAll('.za-thinking').length).toBe(1);
    expect(messages.querySelector('.za-thinking')?.textContent).toContain('思考中');

    ui.hideThinking();
    expect(messages.querySelector('.za-thinking')).toBeNull();
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

  it('停止回合会撤下未决卡片且不产生新的裁决', async () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    const decision = ui.promptHitl(hitlRequest());
    ui.cancelHitl();

    await expect(decision).resolves.toBeNull();
    expect(messages.querySelector('[data-za-hitl]')).toBeNull();
  });
});

describe('promptHitl 目标页标注与目标 URL（adr-023 D3：服务端给什么渲染什么）', () => {
  it('targetUrl 有值：卡正文含「目标地址」行（T0 navigate 卡缺口修复）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(hitlRequest({ targetUrl: 'https://mail.126.com/main' }));

    const line = messages.querySelector('.za-hitl-target-url');
    expect(line?.textContent).toBe('目标地址：https://mail.126.com/main');
  });

  it('targetPage 有值：卡含「目标页」行，title 与 origin 均来自服务端组装字段', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(
      hitlRequest({ targetPage: { title: '工单 #4521', origin: 'https://desk.example' } }),
    );

    const line = messages.querySelector('.za-hitl-target-page');
    expect(line?.textContent).toBe('目标页：工单 #4521（https://desk.example）');
  });

  it('targetPage 缺 title / 缺 origin：按缺省文案与省略括号渲染', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(hitlRequest({ targetPage: { origin: 'https://desk.example' } }));
    expect(messages.querySelector('.za-hitl-target-page')?.textContent).toBe(
      '目标页：（无标题）（https://desk.example）',
    );
    ui.cancelHitl();

    void ui.promptHitl(hitlRequest({ targetPage: { title: '工单 #4521' } }));
    expect(messages.querySelector('.za-hitl-target-page')?.textContent).toBe('目标页：工单 #4521');
  });

  it('缺省帧（无 targetPage/targetUrl）：零渲染变化，不本地拼装治理语义', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(hitlRequest());

    expect(messages.querySelector('.za-hitl-target-url')).toBeNull();
    expect(messages.querySelector('.za-hitl-target-page')).toBeNull();
  });

  it('dom 任务授权卡带 targetPage 时 hint 措辞不变（授权范围是任务不是页）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(
      hitlRequest({
        params: { task: '提交表单', steps: [], summary: '' },
        targetPage: { title: '工单 #4521', origin: 'https://desk.example' },
      }),
    );

    expect(messages.querySelector('.za-hitl-hint')?.textContent).toContain('本任务内的后续操作');
    expect(messages.querySelector('.za-hitl-target-page')?.textContent).toContain('工单 #4521');
  });
});

describe('promptHitl R4 五要素与防误触（UI 规范 §5/§8；服务端给什么渲染什么）', () => {
  const domFrame = (overrides: Partial<HitlRequestFrame> = {}): HitlRequestFrame =>
    hitlRequest({
      toolId: 'browse.page-operate',
      params: {
        task: '发一条消息',
        summary: '整理订单列表',
        plan: ['打开订单列表', '整理数据'],
        steps: [{ action: 'fill', ref: 'za-1', value: 'x' }],
      },
      effects: [
        { action: '填写', target: '收件人（input:text）', valuePreview: 'attacker@evil.example' },
        { action: '点击', target: '发 送（button）' },
      ],
      ...overrides,
    });

  it('卡上呈现服务端反解的真实动作，而非只有模型自述的 summary/plan（A-SEC-02）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(domFrame());

    const effects = messages.querySelector('.za-hitl-effects');
    expect(effects).not.toBeNull();
    expect(effects?.textContent).toContain('填写');
    expect(effects?.textContent).toContain('收件人（input:text）');
    expect(effects?.textContent).toContain('attacker@evil.example');
    expect(effects?.textContent).toContain('发 送（button）');
  });

  it('模型自述降为次要信息并标注来源：不得与服务端反解的动作混为一谈', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(domFrame());

    const claim = messages.querySelector('.za-hitl-claim');
    expect(claim?.textContent).toContain('整理订单列表');
    expect(claim?.textContent).toContain('agent 自述');
    // 自述块与真实动作块是两个不同节点：真实动作不来自 params。
    expect(messages.querySelector('.za-hitl-effects')?.textContent).not.toContain('整理订单列表');
  });

  it('effects 缺省（服务端未下发机械摘要）→ 不本地从 params 推断动作，只留自述块', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    const { effects: _effects, ...withoutEffects } = domFrame();
    void ui.promptHitl(withoutEffects);

    expect(messages.querySelector('.za-hitl-effects')).toBeNull();
    expect(messages.querySelector('.za-hitl-claim')?.textContent).toContain('整理订单列表');
  });

  it('来源 pack 与作用站点、风险行、治理小字按 §5 五要素渲染（服务端字段）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(
      domFrame({
        pack: { packId: 'xianyu-seller', name: '闲鱼卖家', source: 'official', origin: 'https://seller.goofish.com' },
        risk: '将触发页面按钮：一旦触发提交，平台无法为你撤销。',
        ttlMs: 60000,
      }),
    );

    const pack = messages.querySelector('.za-hitl-pack');
    expect(pack?.textContent).toContain('闲鱼卖家');
    expect(pack?.textContent).toContain('官方');
    expect(pack?.textContent).toContain('https://seller.goofish.com');
    expect(messages.querySelector('.za-hitl-risk')?.textContent).toContain('平台无法为你撤销');
    const gov = messages.querySelector('.za-hitl-gov')?.textContent ?? '';
    expect(gov).toContain('一次性签名指令');
    expect(gov).toContain('60 秒内有效');
    expect(gov).toContain('全程审计留痕');
  });

  it('pack 无 name 时回退 packId；ttlMs 缺省时治理小字不编造有效期', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(domFrame({ pack: { packId: 'host-demo' } }));

    expect(messages.querySelector('.za-hitl-pack')?.textContent).toContain('host-demo');
    const gov = messages.querySelector('.za-hitl-gov')?.textContent ?? '';
    expect(gov).toContain('一次性签名指令');
    expect(gov).not.toContain('有效');
  });

  it('tightenedBy=L2：标注这是用户自己设置的确认项（R4 来源可追溯）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(domFrame({ tightenedBy: 'L2' }));
    expect(messages.querySelector('.za-hitl-tightened')?.textContent).toContain('你自己设置的确认项');

    ui.cancelHitl();
    void ui.promptHitl(domFrame());
    expect(messages.querySelector('.za-hitl-tightened')).toBeNull();
  });

  it('卡挂载后默认焦点落「拒绝」（§8 防误触放权）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(domFrame());

    expect(document.activeElement).toBe(messages.querySelector('[data-za-hitl-reject]'));
  });
});

describe('promptHitl 导航任务授权卡（adr-028：带 task+plan 的导航一卡授权整任务）', () => {
  const navFrame = (params: HitlRequestFrame['params'], toolId = 'open_url'): HitlRequestFrame =>
    hitlRequest({
      toolId,
      params,
      targetUrl: 'https://search.example/results?q=zen',
      effects: [{ action: '导航', target: 'https://search.example/results?q=zen' }],
    });

  it('open_url 带 task + 非空 plan：标题「授权任务」、首步「将先打开」、计划清单、自动执行提示、按钮「授权执行」', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(
      navFrame({
        url: 'https://search.example/results?q=zen',
        task: '检索 zen 并打开首条结果',
        plan: ['打开搜索结果页', '点开首条结果', '读取正文并总结'],
      }),
    );

    expect(messages.querySelector('.za-hitl-title')?.textContent).toBe('授权任务：检索 zen 并打开首条结果');
    expect(messages.querySelector('.za-hitl-target-url')?.textContent).toBe(
      '将先打开：https://search.example/results?q=zen',
    );
    const plan = messages.querySelectorAll('.za-hitl-plan li');
    expect([...plan].map((li) => li.textContent)).toEqual(['打开搜索结果页', '点开首条结果', '读取正文并总结']);
    expect(messages.querySelector('.za-hitl-hint')?.textContent).toContain('本任务内的后续操作');
    expect(messages.querySelector('[data-za-hitl-approve]')?.textContent).toBe('授权执行');
    expect(document.activeElement).toBe(messages.querySelector('[data-za-hitl-reject]'));
  });

  it('site_navigate 带 task + plan 同样按任务授权卡呈现', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(
      navFrame({ url: 'https://search.example/results?q=zen', task: '跨站整理', plan: ['去站点乙填表'] }, 'site_navigate'),
    );

    expect(messages.querySelector('.za-hitl-title')?.textContent).toBe('授权任务：跨站整理');
    expect(messages.querySelector('[data-za-hitl-approve]')?.textContent).toBe('授权执行');
  });

  it('导航无 plan（即便带 task）：一次性确认卡——「需你确认」、「目标地址」、无计划与提示、按钮「确认执行」', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(navFrame({ url: 'https://search.example/results?q=zen', task: '检索 zen' }));

    expect(messages.querySelector('.za-hitl-title')?.textContent).toBe('需你确认：open_url');
    expect(messages.querySelector('.za-hitl-target-url')?.textContent).toBe(
      '目标地址：https://search.example/results?q=zen',
    );
    expect(messages.querySelector('.za-hitl-plan')).toBeNull();
    expect(messages.querySelector('.za-hitl-hint')).toBeNull();
    expect(messages.querySelector('[data-za-hitl-approve]')?.textContent).toBe('确认执行');
    expect(document.activeElement).toBe(messages.querySelector('[data-za-hitl-reject]'));
  });

  it('dom 批次带 task 无 plan：仍是任务授权卡（导航之外的口径不变）', () => {
    const messages = messagesEl();
    const ui = createConversationUi(messages);

    void ui.promptHitl(hitlRequest({ toolId: 'browse.page-operate', params: { task: '填表', steps: [], summary: '' } }));

    expect(messages.querySelector('.za-hitl-title')?.textContent).toBe('需你授权：填表');
    expect(messages.querySelector('[data-za-hitl-approve]')?.textContent).toBe('授权执行');
  });
});
