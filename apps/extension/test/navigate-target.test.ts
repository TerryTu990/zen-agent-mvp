import { describe, expect, it } from 'vitest';
import { decideBackgroundNavigate, decideNavigateTarget } from '../src/navigate-target.js';
import type { DownstreamFrame, ExecInstructionFrame } from '../src/frames.js';

describe('decideNavigateTarget：navigate 目标页复用决策', () => {
  it('组内已有完全相同 URL 的页：仅激活，不新开也不重载', () => {
    expect(
      decideNavigateTarget('https://example.com/a?x=1', [
        { id: 1, url: 'https://other.com/' },
        { id: 2, url: 'https://example.com/a?x=1' },
      ]),
    ).toEqual({ kind: 'activate', tabId: 2 });
    // 同源异 URL 与完全相同 URL 并存时，完全相同者优先。
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 3, url: 'https://example.com/b' },
        { id: 4, url: 'https://example.com/a' },
      ]),
    ).toEqual({ kind: 'activate', tabId: 4 });
  });

  it('组内已有同源不同 URL 的页：原地换 URL（首个同源成员）', () => {
    expect(
      decideNavigateTarget('https://example.com/detail/9', [
        { id: 1, url: 'https://other.com/detail/9' },
        { id: 2, url: 'https://example.com/list' },
        { id: 3, url: 'https://example.com/home' },
      ]),
    ).toEqual({ kind: 'update', tabId: 2 });
  });

  it('发起页不作换 URL 候选：跳过发起页选其他同源页，仅剩发起页则新建', () => {
    expect(
      decideNavigateTarget(
        'https://example.com/detail/9',
        [
          { id: 2, url: 'https://example.com/list' },
          { id: 3, url: 'https://example.com/home' },
        ],
        2,
      ),
    ).toEqual({ kind: 'update', tabId: 3 });
    expect(
      decideNavigateTarget(
        'https://example.com/detail/9',
        [
          { id: 1, url: 'https://other.com/' },
          { id: 2, url: 'https://example.com/list' },
        ],
        2,
      ),
    ).toEqual({ kind: 'create' });
    // 发起页已在目标 URL：激活不重载文档，不受排除影响。
    expect(
      decideNavigateTarget('https://example.com/a', [{ id: 2, url: 'https://example.com/a' }], 2),
    ).toEqual({ kind: 'activate', tabId: 2 });
  });

  it('组内无同源页：新建', () => {
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 1, url: 'https://other.com/a' },
        { id: 2 },
        { id: undefined, url: 'https://example.com/a' },
      ]),
    ).toEqual({ kind: 'create' });
    expect(decideNavigateTarget('https://example.com/a', [])).toEqual({ kind: 'create' });
  });

  it('目标 url 非法：判 create，沿用调用方既有失败语义', () => {
    expect(decideNavigateTarget('not-a-url', [{ id: 1, url: 'https://example.com/' }])).toEqual({
      kind: 'create',
    });
    // 组内成员 url 非法只跳过该成员，不影响其余匹配。
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 1, url: '::bad::' },
        { id: 2, url: 'https://example.com/a' },
      ]),
    ).toEqual({ kind: 'activate', tabId: 2 });
  });
});

function execFrame(request: ExecInstructionFrame['request']): ExecInstructionFrame {
  return {
    type: 'exec-instruction',
    sessionId: 's-1',
    nonce: 'n-1',
    issuedAt: 0,
    expiresAt: 60_000,
    ttl: 60_000,
    signature: 'sig',
    toolCallId: 'call-1',
    request,
  };
}

describe('decideBackgroundNavigate：无 content 成员时的 background 直执行判定', () => {
  const singleNavigate = execFrame({
    kind: 'dom',
    steps: [{ action: 'navigate', url: 'https://example.com/a' }],
  });

  it('组内无成员且为单步 navigate 的 dom 批次：放行并带 url', () => {
    expect(decideBackgroundNavigate(singleNavigate, 0)).toEqual({
      execute: true,
      frame: singleNavigate,
      url: 'https://example.com/a',
    });
  });

  it('有活跃成员时不走此路', () => {
    expect(decideBackgroundNavigate(singleNavigate, 1)).toEqual({ execute: false });
  });

  it('多步批次拒绝', () => {
    const frame = execFrame({
      kind: 'dom',
      steps: [
        { action: 'navigate', url: 'https://example.com/a' },
        { action: 'click', ref: 'e1' },
      ],
    });
    expect(decideBackgroundNavigate(frame, 0)).toEqual({ execute: false });
  });

  it('非 navigate 动作拒绝', () => {
    const frame = execFrame({ kind: 'dom', steps: [{ action: 'click', ref: 'e1' }] });
    expect(decideBackgroundNavigate(frame, 0)).toEqual({ execute: false });
  });

  it('navigate 缺 url 或 url 为空拒绝', () => {
    expect(
      decideBackgroundNavigate(execFrame({ kind: 'dom', steps: [{ action: 'navigate' }] }), 0),
    ).toEqual({ execute: false });
    expect(
      decideBackgroundNavigate(
        execFrame({ kind: 'dom', steps: [{ action: 'navigate', url: '' }] }),
        0,
      ),
    ).toEqual({ execute: false });
  });

  it('带页面上下文校验字段的批次拒绝（无页可核对）', () => {
    expect(
      decideBackgroundNavigate(
        execFrame({
          kind: 'dom',
          steps: [{ action: 'navigate', url: 'https://example.com/a' }],
          expectedPageUrl: 'https://example.com/list',
        }),
        0,
      ),
    ).toEqual({ execute: false });
    expect(
      decideBackgroundNavigate(
        execFrame({
          kind: 'dom',
          steps: [{ action: 'navigate', url: 'https://example.com/a' }],
          expectedPageInstanceId: 'p-1',
        }),
        0,
      ),
    ).toEqual({ execute: false });
  });

  it('http 形态指令与非 exec-instruction 帧拒绝', () => {
    expect(
      decideBackgroundNavigate(
        execFrame({ method: 'GET', url: 'https://example.com/api' }),
        0,
      ),
    ).toEqual({ execute: false });
    const guide: DownstreamFrame = {
      type: 'guide-action',
      sessionId: 's-1',
      action: 'highlight',
      selector: '#a',
    };
    expect(decideBackgroundNavigate(guide, 0)).toEqual({ execute: false });
  });
});
