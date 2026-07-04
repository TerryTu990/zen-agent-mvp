// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotter } from '../src/page-snapshot.js';

beforeEach(() => {
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

  it('密码框值不进快照（SEC-04）；普通输入值与 disabled 如实采集', () => {
    document.body.innerHTML = `
      <input type="password" value="s3cret" aria-label="密码" />
      <input type="text" value="my-key" aria-label="名称" />
      <button disabled>不可点</button>
    `;
    const { elements } = createSnapshotter().collect();
    expect(elements[0]).not.toHaveProperty('value');
    expect(elements[1]).toMatchObject({ value: 'my-key' });
    expect(elements[2]).toMatchObject({ disabled: true });
  });

  it('重新 collect 后旧 ref 作废；脱离文档的元素 resolve 为 null', () => {
    document.body.innerHTML = '<button>甲</button>';
    const snapshotter = createSnapshotter();
    snapshotter.collect();
    expect(snapshotter.resolve('za-1')).not.toBeNull();

    const detached = document.querySelector('button')!;
    document.body.innerHTML = '<button>乙</button><button>丙</button>';
    // 旧映射仍指向 detached 元素：已脱离文档 → null（局部重渲染后不可操作旧 ref）。
    expect(detached.isConnected).toBe(false);
    expect(snapshotter.resolve('za-1')).toBeNull();

    snapshotter.collect();
    expect(snapshotter.resolve('za-2')).toBe(document.querySelectorAll('button')[1]);
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
    // combobox 的 label 按既有优先级取 aria-label。
    expect(elements.map((e) => e.label)).toEqual(['分组', '分组A', '分组B']);
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
