// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotter, whenDomSettled } from '../src/page-snapshot.js';
import { DOM_SETTLE_QUIET_MS, DOM_SETTLE_TIMEOUT_MS, MAX_ELEMENTS } from '../src/tuning.js';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.title = '令牌管理';
});

describe('createSnapshotter：可交互元素采集与 ref 映射', () => {
  it('采集按钮/输入框/链接，ref 顺序编号且 resolve 命中原元素', () => {
    document.body.innerHTML = `
      <a href="/console/token">令牌</a>
      <button>创建令牌</button>
      <input type="text" placeholder="令牌名称" />
    `;
    const snapshotter = createSnapshotter();
    const { title, elements } = snapshotter.collect();

    expect(title).toBe('令牌管理');
    expect(elements.map((e) => e.ref)).toEqual(['za-1', 'za-2', 'za-3']);
    expect(elements[1]).toMatchObject({ role: 'button', label: '创建令牌' });
    expect(elements[2]).toMatchObject({ role: 'input:text', label: '令牌名称' });
    expect(snapshotter.resolve('za-2')).toBe(document.querySelector('button'));
  });

  it('只采集无凭证的 http(s) 链接绝对地址', () => {
    document.body.innerHTML = `
      <a href="/item?id=item-a">商品</a>
      <a href="https://user:pass@example.test/private">带凭证</a>
      <a href="javascript:alert(1)">脚本</a>
    `;
    const links = createSnapshotter().collect().elements;
    expect(links[0]?.href).toBe(new URL('/item?id=item-a', document.location.href).href);
    expect(links[1]?.href).toBeUndefined();
    expect(links[2]?.href).toBeUndefined();
  });

  it('采集详情页 description 静态字段但不读取控件值', () => {
    document.body.innerHTML = `
      <span class="ant-descriptions-item-content">订单编号：order-a</span>
      <dl><dt>状态</dt><dd>待发货</dd></dl>
    `;
    expect(createSnapshotter().collect().elements.map((element) => element.label)).toEqual([
      '订单编号：order-a', '状态', '待发货',
    ]);
  });

  it('声明式隐藏元素不采集：hidden 祖先 / aria-hidden / input[type=hidden]', () => {
    document.body.innerHTML = `
      <div hidden><button>藏起来的</button></div>
      <button aria-hidden="true">读屏排除</button>
      <input type="hidden" name="csrf" value="tok" />
      <button>可见按钮</button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ label: '可见按钮' });
  });

  it('任何输入值均不进快照；fill 成功但后续 click 失败也不会把正文送入模型', () => {
    document.body.innerHTML = `
      <input type="password" value="s3cret" aria-label="密码" />
      <input type="text" value="my-key" aria-label="名称" />
      <button disabled>不可点</button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements[0]).not.toHaveProperty('value');
    expect(elements[1]).not.toHaveProperty('value');
    expect(elements[2]).toMatchObject({ disabled: true });
  });

  it('消失元素的旧 ref 不改绑到新元素：resolve 返回 null，新元素取新号', () => {
    document.body.innerHTML = '<button>甲</button>';
    const snapshotter = createSnapshotter();
    snapshotter.collect();
    expect(snapshotter.resolve('za-1')).not.toBeNull();

    const detached = document.querySelector('button')!;
    document.body.innerHTML = '<button>乙</button><button>丙</button>';
    expect(detached.isConnected).toBe(false);
    expect(snapshotter.resolve('za-1')).toBeNull();

    const { elements } = snapshotter.collect();
    // seq 跨 collect 单调递增：新元素拿新号，za-1 永不指向别的控件。
    expect(elements.map((e) => e.ref)).toEqual(['za-2', 'za-3']);
    expect(snapshotter.resolve('za-1')).toBeNull();
    expect(snapshotter.resolve('za-2')).toBe(document.querySelectorAll('button')[0]);
    expect(snapshotter.resolve('za-3')).toBe(document.querySelectorAll('button')[1]);
  });

  it('自定义下拉纳入采集：combobox / option / listbox 后代 li；裸 li 不收', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="分组">请选择分组</div>
      <ul role="listbox">
        <li>分组A</li>
        <li role="option">分组B</li>
      </ul>
      <ul><li>普通列表项不收</li></ul>
    `;
    const { elements } = createSnapshotter().collect();
    // 展开中的 listbox 属优先根，其选项 ref 前置；combobox 的 label 按既有优先级取 aria-label。
    expect(elements.map((e) => e.label)).toEqual(['分组A', '分组B', '分组']);
  });

  it('role 属性优先于 tagName：div[role=option] 报 option，无 role 元素仍按 tag', () => {
    document.body.innerHTML = `
      <div role="option">分组B</div>
      <button>普通按钮</button>
      <input type="text" aria-label="名称" />
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements[0]).toMatchObject({ role: 'option', label: '分组B' });
    expect(elements[1]).toMatchObject({ role: 'button' });
    expect(elements[2]).toMatchObject({ role: 'input:text' });
  });

  it('业务表格静态表头与单元格进入快照，供订单状态和编号建立页面证据', () => {
    document.body.innerHTML = `
      <table>
        <thead><tr><th>订单编号</th><th>平台状态</th></tr></thead>
        <tbody><tr><td>ORDER-MASKED</td><td>待发货</td></tr></tbody>
      </table>
      <div role="gridcell">暂无数据</div>
      <p>普通正文不采集</p>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements.map((e) => [e.role, e.label])).toEqual([
      ['th', '订单编号'],
      ['th', '平台状态'],
      ['td', 'ORDER-MASKED'],
      ['td', '待发货'],
      ['gridcell', '暂无数据'],
    ]);
  });

  it('label 兜底链补 title；仍无可读标签的元素给可辨识占位', () => {
    document.body.innerHTML = `
      <button title="关闭"><svg></svg></button>
      <button><svg></svg></button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements[0]).toMatchObject({ label: '关闭' });
    expect(elements[1]).toMatchObject({ label: '[无文字标签]' });
  });
});

describe('createSnapshotter：同源 iframe 下钻（ADR-013 批次④ 方案 A）', () => {
  it('顶层 ref 维持 za-N 不变；同源 iframe 元素带 f<idx>: 前缀且 resolve 命中子文档元素', () => {
    document.body.innerHTML = '<button>顶层写信</button>';
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const childDoc = frame.contentDocument!;
    childDoc.body.innerHTML = '<div contenteditable="true">正文编辑器</div><button>子按钮</button>';

    const snapshotter = createSnapshotter();
    const { elements } = snapshotter.collect();

    // 顶层格式不变（za-N，host-demo 回归零影响）；iframe 内元素带 f1: 前缀，全局配额续编号。
    expect(elements.map((e) => e.ref)).toEqual(['za-1', 'f1:za-2', 'f1:za-3']);
    expect(elements.map((e) => e.label)).toEqual(['顶层写信', '[可编辑区域]', '子按钮']);
    expect(elements[1]?.role).toBe('contenteditable');
    expect(snapshotter.resolve('f1:za-2')).toBe(childDoc.querySelector('[contenteditable]'));
    expect(snapshotter.resolve('za-1')).toBe(document.querySelector('button'));
  });

  it('跨源 iframe（contentDocument 不可达）跳过、不阻断顶层采集', () => {
    document.body.innerHTML = '<button>顶层</button>';
    const crossOrigin = document.createElement('iframe');
    document.body.appendChild(crossOrigin);
    // 模拟跨源：contentDocument 访问抛安全错误 → sameOriginDoc 捕获返回 null → 跳过。
    Object.defineProperty(crossOrigin, 'contentDocument', {
      get() {
        throw new Error('cross-origin frame access denied');
      },
    });

    const { elements } = createSnapshotter().collect();
    expect(elements.map((e) => e.ref)).toEqual(['za-1']);
    expect(elements[0]).toMatchObject({ label: '顶层' });
  });

  it('iframe 下钻共享全局 150 配额：顶层占满后子文档元素不再采集', () => {
    const filler = Array.from({ length: MAX_ELEMENTS }, (_, i) => `<button>主体${i}</button>`).join('');
    document.body.innerHTML = filler;
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<button>子文档按钮</button>';

    const { elements } = createSnapshotter().collect();
    expect(elements).toHaveLength(MAX_ELEMENTS);
    expect(elements.every((e) => !e.ref.startsWith('f'))).toBe(true);
  });
});

describe('createSnapshotter：模态层优先采集', () => {
  it('页面主体占满配额时弹层内按钮仍拿到 ref：模态元素 ref 前置，总量不超上限', () => {
    const filler = Array.from({ length: MAX_ELEMENTS }, (_, i) => `<button>主体${i}</button>`).join('');
    document.body.innerHTML = `
      ${filler}
      <div role="dialog"><input aria-label="备注" /><button>提交</button><button>取消</button></div>
    `;
    const snapshotter = createSnapshotter();
    const { elements } = snapshotter.collect();
    expect(elements).toHaveLength(MAX_ELEMENTS);
    expect(elements.slice(0, 3).map((e) => e.label)).toEqual(['备注', '提交', '取消']);
    expect(snapshotter.resolve('za-2')).toBe(document.querySelector('[role="dialog"] button'));
  });

  it('模态元素不重复计数；aria-modal 与 class 兜底（含嵌套命中只取外层）均可识别', () => {
    document.body.innerHTML = `
      <button>主体</button>
      <div aria-modal="true"><button>提交</button></div>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['提交', '主体']);

    document.body.innerHTML = `
      <button>主体</button>
      <div class="app-modal"><div class="modal-body"><button>确定</button></div></div>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['确定', '主体']);
  });

  it('隐藏模态层（内联 display:none）内的按钮一律不采集，不与可见同名控件混淆', () => {
    document.body.innerHTML = `
      <button>主体</button>
      <div role="dialog" style="display:none"><button>藏层按钮</button></div>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['主体']);
  });

  it('无 role 子项的 listbox（Semi 类组件）：直接子项拿到 ref，浮层优先于配额', () => {
    const filler = Array.from({ length: MAX_ELEMENTS }, (_, i) => `<button>主体${i}</button>`).join('');
    document.body.innerHTML = `
      ${filler}
      <div role="listbox"><div>ato Claude 转 Codex 分组</div><div>awsq</div></div>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements).toHaveLength(MAX_ELEMENTS);
    expect(elements.slice(0, 2).map((e) => e.label)).toEqual(['ato Claude 转 Codex 分组', 'awsq']);
  });
});

describe('createSnapshotter：页面提示文本 notices 采集', () => {
  it('无提示时 notices 为空数组', () => {
    document.body.innerHTML = '<button>提交</button>';
    expect(createSnapshotter().collect().notices).toEqual([]);
  });

  it('采集 role=alert / role=status / aria-live 区域文本并归一空白', () => {
    document.body.innerHTML = `
      <div role="alert">请选择分组</div>
      <div role="status">保存中
        请稍候</div>
      <div aria-live="polite">已加载 3 条</div>
      <div aria-live="off">off 区不收</div>
    `;
    expect(createSnapshotter().collect().notices).toEqual([
      '请选择分组',
      '保存中 请稍候',
      '已加载 3 条',
    ]);
  });

  it('采集 class 含 error/invalid 的短文本节点', () => {
    document.body.innerHTML = `
      <span class="form-error">请选择分组</span>
      <p class="is-Invalid">名称不能为空</p>
    `;
    expect(createSnapshotter().collect().notices).toEqual(['请选择分组', '名称不能为空']);
  });

  it('按 pack 配方以唯一消息容器汇总回执，不采集相邻消息正文', () => {
    document.body.innerHTML = `
      <div class="message-content">
        <div class="message-body">兑换内容不应进入 notices</div>
        <div class="read-status-text--hash">已读</div>
      </div>
      <span class="send-status">已发送</span>
      <span class="message-status">未读</span>
    `;
    const { evidence, notices } = createSnapshotter().collect([
      {
        id: 'message-receipts',
        itemSelector: '.message-content',
        statusSelector: '.read-status-text--hash, .send-status, .message-status',
        statuses: ['未读', '已读', '已发送'],
      },
    ]);
    expect(evidence).toEqual({ 'message-receipts': { count: 1, latest: '已读' } });
    expect(JSON.stringify({ evidence, notices })).not.toContain('兑换内容');
  });

  it('按闲鱼发货配方从 Ant Steps 生成唯一状态证据', () => {
    document.body.innerHTML = `
      <div class="ant-steps-item"><div class="ant-steps-item-title">买家已付款</div></div>
      <div class="ant-steps-item"><div class="ant-steps-item-title">待发货</div></div>
    `;
    const rule = {
      id: 'order-shipment-status', itemSelector: '.ant-steps-item',
      statusSelector: '.ant-steps-item-title', statuses: ['待发货', '已发货'],
    };
    expect(createSnapshotter().collect([rule]).evidence).toEqual({
      'order-shipment-status': { count: 1, latest: '待发货' },
    });
    document.body.innerHTML += '<div class="ant-steps-item"><div class="ant-steps-item-title">已发货</div></div>';
    expect(createSnapshotter().collect([rule]).evidence).toEqual({
      'order-shipment-status': { count: 2, latest: '已发货' },
    });
  });

  it('同一消息容器多个状态叶节点只计一次，取最后允许状态', () => {
    document.body.innerHTML = `
      <div class="message-content">
        兑换内容不应进入 notices
        <span class="read-status">已发送</span>
        <span class="read-status">未读</span>
      </div>
    `;
    const { evidence } = createSnapshotter().collect([
      {
        id: 'message-receipts',
        itemSelector: '.message-content',
        statusSelector: '.read-status',
        statuses: ['未读', '已读'],
      },
    ]);
    expect(evidence).toEqual({ 'message-receipts': { count: 1, latest: '未读' } });
    expect(JSON.stringify(evidence)).not.toContain('兑换内容');
    expect(JSON.stringify(evidence)).not.toContain('已发送');
  });

  it('itemSelector 同时命中消息外层与内层时只计最内层消息根', () => {
    document.body.innerHTML = `
      <div class="message-content-wrapper">
        <div class="message-content">
          <span class="read-status-text">已读</span>
        </div>
      </div>
    `;
    const { evidence } = createSnapshotter().collect([
      {
        id: 'message-receipts',
        itemSelector: '[class*="message-content"]',
        statusSelector: '[class*="read-status-text"]',
        statuses: ['未读', '已读'],
      },
    ]);
    expect(evidence).toEqual({ 'message-receipts': { count: 1, latest: '已读' } });
  });

  it('没有 pack 证据配方时不解释同名 class，避免跨站污染', () => {
    document.body.innerHTML = `
      <div class="message-content"><span class="read-status">已读</span></div>
    `;
    expect(createSnapshotter().collect().evidence).toEqual({});
  });

  it('class 启发式跳过长容器与含表单控件的区块', () => {
    document.body.innerHTML = `
      <div class="error-panel">${'长'.repeat(201)}</div>
      <div class="error"><input type="text" value="abc" /><span>整块表单区</span></div>
      <span class="error">真正的错误提示</span>
    `;
    expect(createSnapshotter().collect().notices).toEqual(['真正的错误提示']);
  });

  it('不可见提示不收：hidden 祖先 / aria-hidden / 内联 display 与 visibility（含祖先）', () => {
    document.body.innerHTML = `
      <div hidden><span role="alert">藏A</span></div>
      <span role="alert" aria-hidden="true">藏B</span>
      <span role="alert" style="display:none">藏C</span>
      <div style="visibility:hidden"><span class="error">藏D</span></div>
      <span role="alert">可见提示</span>
    `;
    expect(createSnapshotter().collect().notices).toEqual(['可见提示']);
  });

  it('去重与嵌套：alert 区内的 error 子节点只取外层，重复文本只留一条', () => {
    document.body.innerHTML = `
      <div role="alert">请选择分组 <span class="error">再试一次</span></div>
      <span class="error">请选择分组 再试一次</span>
    `;
    expect(createSnapshotter().collect().notices).toEqual(['请选择分组 再试一次']);
  });

  it('单条截断 200 字符、总量上限 10 条', () => {
    const long = `<div role="alert">${'甲'.repeat(250)}</div>`;
    const many = Array.from({ length: 12 }, (_, i) => `<div role="alert">提示${i}</div>`).join('');
    document.body.innerHTML = long + many;
    const { notices } = createSnapshotter().collect();
    expect(notices).toHaveLength(10);
    expect(notices[0]).toBe('甲'.repeat(200));
  });

  it('提示只取 textContent，不含控件 value（密码值不进 notices，SEC-04）', () => {
    document.body.innerHTML = `
      <div role="alert">密码格式错误<input type="password" value="s3cret" /></div>
    `;
    const { notices } = createSnapshotter().collect();
    expect(notices).toEqual(['密码格式错误']);
    expect(JSON.stringify(notices)).not.toContain('s3cret');
  });
});

/**
 * jsdom 无排版：getClientRects 恒空、盒子恒 0，采集器据此整份退化为声明式 + 内联判定。
 * 本组用桩搭出「有布局」的世界，验证计算样式/尺寸/视口分支的判定逻辑；
 * 真实布局取值（祖先 display:none 的继承、真实 rect）仍须浏览器 E2E 证实。
 */
const LAYOUT_RECT = {
  x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200,
  toJSON: () => ({}),
} as DOMRect;

function rectAtTop(top: number): DOMRect {
  return { ...LAYOUT_RECT, top, y: top, bottom: top + 20 } as DOMRect;
}

function withLayout(run: () => void): void {
  const rects = Element.prototype.getClientRects;
  const box = Element.prototype.getBoundingClientRect;
  Element.prototype.getClientRects = function (this: Element) {
    return [LAYOUT_RECT] as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return LAYOUT_RECT;
  };
  try {
    run();
  } finally {
    Element.prototype.getClientRects = rects;
    Element.prototype.getBoundingClientRect = box;
  }
}

describe('createSnapshotter：可见性判定（A-PAGE-01 / PC-PAGE-01）', () => {
  it('aria-hidden 祖先内的控件同样不采集（读屏排除覆盖整条祖先链）', () => {
    document.body.innerHTML = `
      <div aria-hidden="true"><button>非活跃面板确定</button></div>
      <button>确定</button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements.map((e) => e.label)).toEqual(['确定']);
  });

  it('内联 display:none 祖先内的控件不采集（折叠菜单/关闭后保留 DOM 的弹层）', () => {
    document.body.innerHTML = `
      <div style="display:none"><button>删除</button></div>
      <div style="visibility:hidden"><button>删除</button></div>
      <button>删除</button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements).toHaveLength(1);
  });

  it('有布局时按计算样式判定：class 隐藏（display:none / opacity:0）的控件不采集', () => {
    document.head.innerHTML = '<style>.collapsed{display:none}.faded{opacity:0}</style>';
    document.body.innerHTML = `
      <button class="collapsed">折叠项</button>
      <button class="faded">透明层按钮</button>
      <button>可见按钮</button>
    `;
    withLayout(() => {
      expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['可见按钮']);
    });
  });

  it('有布局时无盒子（getClientRects 为空）的控件不采集', () => {
    document.body.innerHTML = '<button>零尺寸</button><button>可见按钮</button>';
    withLayout(() => {
      const boxless = document.querySelectorAll('button')[0]!;
      boxless.getClientRects = () => [] as unknown as DOMRectList;
      expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['可见按钮']);
    });
  });

  it('无布局环境（jsdom）退化为属性 + 内联判定，不把整页判成不可见', () => {
    document.body.innerHTML = '<button>可见按钮</button>';
    expect(document.body.getClientRects()).toHaveLength(0);
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['可见按钮']);
  });
});

describe('createSnapshotter：配额如实标注与优先级（A-PAGE-02 / PC-PAGE-06）', () => {
  it('未超配额时不带截断标注', () => {
    document.body.innerHTML = '<button>甲</button>';
    const snapshot = createSnapshotter().collect();
    expect(snapshot).not.toHaveProperty('elementsTruncated');
    expect(snapshot).not.toHaveProperty('elementsOmitted');
  });

  it('配额恰好命中：不标截断（无元素被丢弃）', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_ELEMENTS },
      (_, i) => `<button>主体${i}</button>`,
    ).join('');
    const snapshot = createSnapshotter().collect();
    expect(snapshot.elements).toHaveLength(MAX_ELEMENTS);
    expect(snapshot).not.toHaveProperty('elementsTruncated');
  });

  it('超配额后继续计数不采集：elementsTruncated + elementsOmitted 如实标注', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_ELEMENTS + 7 },
      (_, i) => `<button>主体${i}</button>`,
    ).join('');
    const snapshot = createSnapshotter().collect();
    expect(snapshot.elements).toHaveLength(MAX_ELEMENTS);
    expect(snapshot.elementsTruncated).toBe(true);
    expect(snapshot.elementsOmitted).toBe(7);
  });

  it('跨帧省略计入同一计数（配额与标注都是全局口径）', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_ELEMENTS },
      (_, i) => `<button>主体${i}</button>`,
    ).join('');
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<button>子甲</button><button>子乙</button>';
    const snapshot = createSnapshotter().collect();
    expect(snapshot.elements).toHaveLength(MAX_ELEMENTS);
    expect(snapshot.elementsOmitted).toBe(2);
  });

  it('隐藏元素不计入省略数：省略数只表示「本可采集却因配额丢弃」', () => {
    const filler = Array.from(
      { length: MAX_ELEMENTS },
      (_, i) => `<button>主体${i}</button>`,
    ).join('');
    document.body.innerHTML = `${filler}<div hidden><button>藏起来的</button></div>`;
    const snapshot = createSnapshotter().collect();
    expect(snapshot.elements).toHaveLength(MAX_ELEMENTS);
    expect(snapshot).not.toHaveProperty('elementsTruncated');
  });

  it('静态单元格排在真控件之后：中等表格不再吃掉真控件的配额', () => {
    document.body.innerHTML = `
      <table><tbody><tr><td>ORDER-1</td><td>待发货</td></tr></tbody></table>
      <button>发货</button>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual([
      '发货', 'ORDER-1', '待发货',
    ]);
  });

  it('有布局时视口内控件先分配配额，视口外控件排在其后', () => {
    document.body.innerHTML = '<button>页尾按钮</button><button>视口内按钮</button>';
    withLayout(() => {
      const [below] = [...document.querySelectorAll('button')];
      below!.getBoundingClientRect = () => rectAtTop(5000);
      expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual([
        '视口内按钮', '页尾按钮',
      ]);
    });
  });
});

describe('createSnapshotter：可达名计算（A-PAGE-03 / PC-PAGE-03）', () => {
  it('aria-labelledby 按 id 顺序拼接，优先于 aria-label', () => {
    document.body.innerHTML = `
      <span id="l1">收货</span><span id="l2">地址</span>
      <input aria-labelledby="l1 l2" aria-label="被覆盖" />
    `;
    expect(createSnapshotter().collect().elements.at(-1)?.label).toBe('收货 地址');
  });

  it('label[for] 与包裹 label 都能给出控件名（图标钮/无文本控件不再无名）', () => {
    document.body.innerHTML = `
      <label for="phone">手机号</label><input id="phone" />
      <label>邮箱<input id="mail" /></label>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['手机号', '邮箱']);
  });

  it('img alt 与 input[type=submit].value 进入可达名', () => {
    document.body.innerHTML = `
      <button><img alt="删除" /></button>
      <input type="submit" value="提交订单" />
      <input type="button" value="取消" />
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual([
      '删除', '提交订单', '取消',
    ]);
  });

  it('图文混排容器取自身文本，不被内嵌图片 alt 顶掉', () => {
    document.body.innerHTML = `
      <table><tbody><tr><td><img alt="缩略图" />蓝牙耳机</td></tr></tbody></table>
    `;
    expect(createSnapshotter().collect().elements[0]?.label).toBe('蓝牙耳机');
  });

  it('select 取当前选中项而非全部 option 文本', () => {
    document.body.innerHTML = `
      <select><option>甲分组</option><option selected>乙分组</option></select>
    `;
    expect(createSnapshotter().collect().elements[0]?.label).toBe('乙分组');
  });

  it('placeholder 让位于关联 label；两者皆无才取 textContent', () => {
    document.body.innerHTML = `
      <label for="k">令牌名称</label><input id="k" placeholder="请输入" />
      <button>纯文本按钮</button>
    `;
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual([
      '令牌名称', '纯文本按钮',
    ]);
  });

  it('contenteditable 不把编辑中的正文当标签（A-SEC-05：草稿不进模型上下文）', () => {
    document.body.innerHTML = `
      <div contenteditable="true">尊敬的王总，附件是本季度的报价单与折扣说明</div>
      <div contenteditable="true" aria-label="邮件正文">同上但有 aria-label</div>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements.map((e) => e.label)).toEqual(['[可编辑区域]', '邮件正文']);
    expect(JSON.stringify(elements)).not.toContain('报价单');
  });
});

describe('createSnapshotter：ref 稳定性与快照世代（A-PAGE-04 / PC-PAGE-02）', () => {
  it('仍连接且 role/label 未变的元素跨 collect 复用 ref', () => {
    document.body.innerHTML = '<button>甲</button><button>乙</button>';
    const snapshotter = createSnapshotter();
    expect(snapshotter.collect().elements.map((e) => e.ref)).toEqual(['za-1', 'za-2']);

    document.body.insertAdjacentHTML('afterbegin', '<button>新来的</button>');
    const second = snapshotter.collect();
    expect(second.elements.map((e) => [e.ref, e.label])).toEqual([
      ['za-3', '新来的'],
      ['za-1', '甲'],
      ['za-2', '乙'],
    ]);
    expect(snapshotter.resolve('za-1')?.textContent).toBe('甲');
  });

  it('label 变化即换号（同一元素改了语义就不再是同一个可指目标）', () => {
    document.body.innerHTML = '<button>展开</button>';
    const snapshotter = createSnapshotter();
    snapshotter.collect();
    document.querySelector('button')!.textContent = '收起';
    expect(snapshotter.collect().elements[0]?.ref).toBe('za-2');
  });

  it('snapshotEpoch 自 1 起随每次 collect 单调递增', () => {
    document.body.innerHTML = '<button>甲</button>';
    const snapshotter = createSnapshotter();
    expect(snapshotter.collect().snapshotEpoch).toBe(1);
    expect(snapshotter.collect().snapshotEpoch).toBe(2);
  });
});

describe('createSnapshotter：shadow DOM 与帧资格（A-PAGE-09/12 / PC-PAGE-07）', () => {
  it('open shadow root 内的控件可采集且 resolve 命中', () => {
    document.body.innerHTML = '<button>轻 DOM 按钮</button><div id="host"></div>';
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>影子按钮</button><div id="inner"></div>';
    shadow.querySelector('#inner')!.attachShadow({ mode: 'open' }).innerHTML =
      '<input aria-label="影子输入" />';

    const snapshotter = createSnapshotter();
    const { elements } = snapshotter.collect();
    expect(elements.map((e) => e.label)).toEqual(['轻 DOM 按钮', '影子按钮', '影子输入']);
    expect(snapshotter.resolve(elements[1]!.ref)).toBe(shadow.querySelector('button'));
  });

  it('closed shadow root 不可达时不抛错，轻 DOM 照常采集', () => {
    document.body.innerHTML = '<div id="host"></div><button>轻 DOM 按钮</button>';
    document.querySelector('#host')!.attachShadow({ mode: 'closed' }).innerHTML = '<button>不可达</button>';
    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['轻 DOM 按钮']);
  });

  it('零尺寸帧（埋点帧）与隐藏帧不下钻，与正文抽取同口径', () => {
    document.body.innerHTML = '<button>顶层</button>';
    const beacon = document.createElement('iframe');
    beacon.setAttribute('width', '0');
    document.body.appendChild(beacon);
    beacon.contentDocument!.body.innerHTML = '<button>埋点帧按钮</button>';
    const hidden = document.createElement('iframe');
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
    hidden.contentDocument!.body.innerHTML = '<button>隐藏帧按钮</button>';

    expect(createSnapshotter().collect().elements.map((e) => e.label)).toEqual(['顶层']);
  });

  it('同源帧内元素的 role/href 按所在文档解析（跨 realm 不退化）', () => {
    document.body.innerHTML = '';
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML =
      '<input type="text" aria-label="帧内输入" /><a href="/inner">帧内链接</a>';
    const { elements } = createSnapshotter().collect();
    expect(elements[0]?.role).toBe('input:text');
    expect(elements[1]?.href).toBe(new URL('/inner', document.location.href).href);
  });

  it('notices 按已下钻的同源帧合并采集（帧内校验提示不再漏采）', () => {
    document.body.innerHTML = '<div role="alert">顶层提示</div>';
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<div role="alert">帧内校验失败</div>';
    expect(createSnapshotter().collect().notices).toEqual(['顶层提示', '帧内校验失败']);
  });

  it('evidence 按已下钻的同源帧合并计数', () => {
    document.body.innerHTML = '<div class="msg"><span class="st">已读</span></div>';
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<div class="msg"><span class="st">未读</span></div>';
    const rule = {
      id: 'message-receipts',
      itemSelector: '.msg',
      statusSelector: '.st',
      statuses: ['未读', '已读'],
    };
    expect(createSnapshotter().collect([rule]).evidence).toEqual({
      'message-receipts': { count: 2, latest: '未读' },
    });
  });
});

describe('whenDomSettled：DOM 静默窗（G5-PAGE-01）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('静默达阈值后才放行采集', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    whenDomSettled(() => ran.push('collect'), document);
    await vi.advanceTimersByTimeAsync(DOM_SETTLE_QUIET_MS - 50);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    expect(ran).toEqual(['collect']);
  });

  it('每次 DOM 变更重置静默窗，总等待封顶后无论是否静定一律放行', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    whenDomSettled(() => ran.push('collect'), document);
    const churn = Math.ceil(DOM_SETTLE_TIMEOUT_MS / (DOM_SETTLE_QUIET_MS - 100)) + 2;
    for (let i = 0; i < churn; i += 1) {
      document.body.appendChild(document.createElement('div'));
      await vi.advanceTimersByTimeAsync(DOM_SETTLE_QUIET_MS - 100);
    }
    // 变更从未停过：静默窗永不达标，只可能由总上限收尾，且只放行一次。
    expect(ran).toEqual(['collect']);
  });

  it('无 body / 无 MutationObserver 的环境立即放行（观察能力缺席不推迟采集）', () => {
    const ran: string[] = [];
    whenDomSettled(() => ran.push('collect'), null);
    expect(ran).toEqual(['collect']);
  });
});
