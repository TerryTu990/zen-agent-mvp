/**
 * 轻量 markdown 解析 + vanilla DOM 渲染（assistant 气泡 / 未来卡片共用）。
 * 解析为 block/inline 结构后经 document.createElement + textContent 落成节点，
 * 全程不产 HTML 字符串、不触 innerHTML，天然免 XSS。
 * 支持：# 标题、- / * 无序列表、1. 有序列表、**粗体**、`行内码`、``` 围栏代码块、
 * GFM 管道表格（表头行 + |---| 分隔行确认）；其余按段落。
 */

export type MdInline = { kind: 'text' | 'strong' | 'code'; text: string };

export type MdBlock =
  | { kind: 'heading'; level: number; inlines: MdInline[] }
  | { kind: 'para'; inlines: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: MdInline[][]; rows: MdInline[][][] };

/** 行内解析：**粗体** 与 `行内码`，单遍正则切分 */
export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    const strong = m[1];
    const code = m[2];
    if (strong !== undefined) out.push({ kind: 'strong', text: strong });
    else if (code !== undefined) out.push({ kind: 'code', text: code });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

/** 管道表格行 → 单元格 inline 组（去首尾 |，按 | 切分；不处理转义管道） */
function splitCells(line: string): MdInline[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => parseInline(c.trim()));
}

/** 块级解析：逐行状态机（围栏码块 > 表格 > 标题 > 列表 > 空行分段 > 段落） */
export function parseMarkdownLite(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: MdInline[][] } | null = null;
  let code: string[] | null = null;
  let table: { header: MdInline[][]; rows: MdInline[][][] } | null = null;
  // 表头候选：`|…|` 行先挂起，下一行是 |---| 分隔行才确认成表；否则回落段落
  let tableHeader: string | null = null;

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: 'para', inlines: parseInline(para.join(' ')) });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flushTable = (): void => {
    if (table !== null) {
      blocks.push({ kind: 'table', header: table.header, rows: table.rows });
      table = null;
    }
  };

  for (const line of md.split(/\r?\n/)) {
    if (code !== null) {
      if (FENCE_RE.test(line)) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (table !== null) {
      if (TABLE_ROW_RE.test(line)) {
        table.rows.push(splitCells(line));
        continue;
      }
      flushTable(); // 非表格行结束当前表，当前行按普通行继续判定
    }
    if (tableHeader !== null) {
      const headerLine = tableHeader;
      tableHeader = null;
      if (TABLE_SEP_RE.test(line)) {
        flushPara();
        flushList();
        table = { header: splitCells(headerLine), rows: [] };
        continue;
      }
      para.push(headerLine.trim()); // 未被分隔行确认，表头候选回落为段落行
    }
    if (TABLE_ROW_RE.test(line)) {
      tableHeader = line;
      continue;
    }
    if (FENCE_RE.test(line)) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      flushPara();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = ul === null ? OL_RE.exec(line) : null;
    const itemText = ul?.[1] ?? ol?.[1];
    if (itemText !== undefined) {
      flushPara();
      const ordered = ol !== null;
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline(itemText));
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  // 未闭合围栏按代码块收尾（fail-visible，不丢内容）；挂起表头候选回落段落
  if (code !== null) blocks.push({ kind: 'code', text: code.join('\n') });
  if (tableHeader !== null) para.push(tableHeader.trim());
  flushTable();
  flushPara();
  flushList();
  return blocks;
}

function renderInlines(inlines: MdInline[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const inline of inlines) {
    if (inline.kind === 'strong') {
      const b = document.createElement('b');
      b.textContent = inline.text;
      frag.append(b);
    } else if (inline.kind === 'code') {
      const c = document.createElement('code');
      c.textContent = inline.text;
      frag.append(c);
    } else {
      frag.append(document.createTextNode(inline.text));
    }
  }
  return frag;
}

function renderBlock(block: MdBlock): HTMLElement {
  switch (block.kind) {
    case 'heading': {
      // 卡片内文档标题降到 h4-h6，不抢面板层级
      const level = Math.min(block.level + 3, 6);
      const el = document.createElement(`h${level}`);
      el.append(renderInlines(block.inlines));
      return el;
    }
    case 'para': {
      const p = document.createElement('p');
      p.append(renderInlines(block.inlines));
      return p;
    }
    case 'list': {
      const listEl = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = document.createElement('li');
        li.append(renderInlines(item));
        listEl.append(li);
      }
      return listEl;
    }
    case 'code': {
      const pre = document.createElement('pre');
      pre.textContent = block.text;
      return pre;
    }
    case 'table': {
      const tableEl = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of block.header) {
        const th = document.createElement('th');
        th.append(renderInlines(cell));
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          td.append(renderInlines(cell));
          tr.append(td);
        }
        tbody.append(tr);
      }
      tableEl.append(thead, tbody);
      return tableEl;
    }
  }
}

/** 解析 markdown 并渲染为块级节点集合；调用方置入 .mdlite 容器。 */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const block of parseMarkdownLite(text)) frag.append(renderBlock(block));
  return frag;
}
