import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.js';

describe('SSE 解析器', () => {
  it('单 chunk 完整帧 → 产出 data 载荷', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"text-delta","sessionId":"s1","delta":"你好"}\n\n')).toEqual([
      '{"type":"text-delta","sessionId":"s1","delta":"你好"}',
    ]);
  });

  it('帧被分片到多个 chunk → 拼齐后才产出', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"text-')).toEqual([]);
    expect(parser.push('delta","sessionId":"s1","del')).toEqual([]);
    expect(parser.push('ta":"a"}\n\n')).toEqual(['{"type":"text-delta","sessionId":"s1","delta":"a"}']);
  });

  it('分隔符 \\n\\n 自身跨 chunk 也能切帧', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual(['{"a":1}']);
  });

  it('心跳注释行 ": ping" 被忽略且不产出载荷', () => {
    const parser = createSseParser();
    expect(parser.push(': ping\n\n')).toEqual([]);
    expect(parser.push(': ping\n\ndata: {"a":1}\n\n: ping\n\n')).toEqual(['{"a":1}']);
  });

  it('多帧粘包在同一 chunk → 按序全部产出', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it('未闭合的尾部残帧留在缓冲区不提前产出', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\n\ndata: {"b":')).toEqual(['{"a":1}']);
    expect(parser.push('2}\n\n')).toEqual(['{"b":2}']);
  });
});
