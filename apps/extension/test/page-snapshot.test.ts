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
});
