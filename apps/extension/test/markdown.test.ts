// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdownLite, renderMarkdown } from '../src/markdown.js';

describe('parseInline 行内解析', () => {
  it('切分 **粗体** 与 `行内码`，其余为 text', () => {
    expect(parseInline('普通 **重点** 与 `code` 尾')).toEqual([
      { kind: 'text', text: '普通 ' },
      { kind: 'strong', text: '重点' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' 尾' },
    ]);
  });

  it('无标记时整段为单个 text', () => {
    expect(parseInline('纯文本')).toEqual([{ kind: 'text', text: '纯文本' }]);
  });
});

describe('parseMarkdownLite 块级解析', () => {
  it('标题降级由 renderMarkdown 处理，解析保留原始 level', () => {
    const blocks = parseMarkdownLite('# 一级\n## 二级');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, inlines: [{ kind: 'text', text: '一级' }] },
      { kind: 'heading', level: 2, inlines: [{ kind: 'text', text: '二级' }] },
    ]);
  });

  it('无序 / 有序列表各自成块', () => {
    const blocks = parseMarkdownLite('- a\n- b\n\n1. x\n2. y');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true });
    expect((blocks[0] as { items: unknown[] }).items.length).toBe(2);
  });

  it('围栏代码块整体成 code 块（内部不再解析）', () => {
    const blocks = parseMarkdownLite('```\nconst x = **not bold**\n```');
    expect(blocks).toEqual([{ kind: 'code', text: 'const x = **not bold**' }]);
  });

  it('GFM 管道表格：表头 + |---| 分隔行确认，否则回落段落', () => {
    const table = parseMarkdownLite('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(table[0]).toMatchObject({ kind: 'table' });
    const noSep = parseMarkdownLite('| A | B |\n普通行');
    expect(noSep.every((b) => b.kind !== 'table')).toBe(true);
  });
});

describe('renderMarkdown vanilla DOM 渲染', () => {
  it('标题降到 h4-h6，粗体/行内码成 b/code 节点', () => {
    const host = document.createElement('div');
    host.append(renderMarkdown('# 标题\n正文 **粗** 与 `c`'));
    expect(host.querySelector('h4')?.textContent).toBe('标题');
    expect(host.querySelector('p b')?.textContent).toBe('粗');
    expect(host.querySelector('p code')?.textContent).toBe('c');
  });

  it('围栏代码块内容经 textContent 落地，不解释为 HTML（免 XSS）', () => {
    const host = document.createElement('div');
    host.append(renderMarkdown('```\n<img src=x onerror=alert(1)>\n```'));
    const pre = host.querySelector('pre');
    expect(pre?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(pre?.querySelector('img')).toBeNull();
  });

  it('行内 HTML 不被当作标签渲染（作为纯文本）', () => {
    const host = document.createElement('div');
    host.append(renderMarkdown('<b>x</b> 文本'));
    expect(host.querySelector('p')?.textContent).toContain('<b>x</b>');
    expect(host.querySelector('p b')).toBeNull();
  });

  it('表格渲染为 thead/tbody 结构', () => {
    const host = document.createElement('div');
    host.append(renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |'));
    expect(host.querySelectorAll('thead th').length).toBe(2);
    expect(host.querySelectorAll('tbody td').length).toBe(2);
  });
});
