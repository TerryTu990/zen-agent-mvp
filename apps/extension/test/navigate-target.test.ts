import { describe, expect, it } from 'vitest';
import {
  decideBackgroundNavigate,
  decideNavigateTarget,
  decideTargetedNavigate,
  isBlankPageUrl,
} from '../src/navigate-target.js';
import type { DownstreamFrame, ExecInstructionFrame } from '../src/frames.js';
import type { PageHandleTable } from '../src/page-handles.js';

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

  it('组内无同源页也无空白页：新建', () => {
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 1, url: 'https://other.com/a' },
        { id: undefined, url: 'https://example.com/a' },
      ]),
    ).toEqual({ kind: 'create' });
    expect(decideNavigateTarget('https://example.com/a', [])).toEqual({ kind: 'create' });
  });

  it('组内有空白页：原地换 URL，不再新开页签留下空白页', () => {
    const blanks = ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/', ''];
    for (const blank of blanks) {
      expect(decideNavigateTarget('https://example.com/a', [{ id: 7, url: blank }])).toEqual({
        kind: 'update',
        tabId: 7,
      });
    }
    // url 取不到（尚未提交导航的空文档）同样按空白页复用。
    expect(decideNavigateTarget('https://example.com/a', [{ id: 7 }])).toEqual({
      kind: 'update',
      tabId: 7,
    });
  });

  it('多个空白页：取组内首个', () => {
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 4, url: 'https://other.com/a' },
        { id: 5, url: 'chrome://newtab/' },
        { id: 6, url: 'about:blank' },
      ]),
    ).toEqual({ kind: 'update', tabId: 5 });
  });

  it('同源页优先于空白页', () => {
    expect(
      decideNavigateTarget('https://example.com/detail/9', [
        { id: 5, url: 'about:blank' },
        { id: 6, url: 'https://example.com/list' },
      ]),
    ).toEqual({ kind: 'update', tabId: 6 });
    // 同 URL 页优先于两者。
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 5, url: 'about:blank' },
        { id: 6, url: 'https://example.com/list' },
        { id: 7, url: 'https://example.com/a' },
      ]),
    ).toEqual({ kind: 'activate', tabId: 7 });
  });

  it('发起页是空白页：不复用，走新建（原地重载会销毁发起页文档）', () => {
    expect(
      decideNavigateTarget('https://example.com/a', [{ id: 5, url: 'chrome://newtab/' }], 5),
    ).toEqual({ kind: 'create' });
    expect(
      decideNavigateTarget(
        'https://example.com/a',
        [
          { id: 5, url: 'chrome://newtab/' },
          { id: 6, url: 'about:blank' },
        ],
        5,
      ),
    ).toEqual({ kind: 'update', tabId: 6 });
  });

  it('非空白且非同源的页不被复用', () => {
    expect(
      decideNavigateTarget('https://example.com/a', [
        { id: 5, url: 'https://other.com/list' },
        { id: 6, url: 'chrome://settings/' },
        { id: 7, url: 'chrome://newtab/x' },
      ]),
    ).toEqual({ kind: 'create' });
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

describe('isBlankPageUrl：空白页判定闭集', () => {
  it('闭集成员与缺省/空串判空白', () => {
    for (const url of [
      'about:blank',
      'chrome://newtab/',
      'chrome://new-tab-page/',
      'edge://newtab/',
      '',
      undefined,
    ]) {
      expect(isBlankPageUrl(url)).toBe(true);
    }
  });

  it('闭集外一律不算空白（含闭集成员的变体）', () => {
    for (const url of [
      'https://example.com/',
      'chrome://newtab',
      'chrome://settings/',
      'about:blank#x',
      'edge://newtab/x',
    ]) {
      expect(isBlankPageUrl(url)).toBe(false);
    }
  });
});

function execFrame(request: ExecInstructionFrame['request'], page?: string): ExecInstructionFrame {
  return {
    type: 'exec-instruction',
    sessionId: 's-1',
    nonce: 'n-1',
    issuedAt: 0,
    expiresAt: 60_000,
    ttl: 60_000,
    signature: 'sig',
    toolCallId: 'call-1',
    ...(page !== undefined ? { page } : {}),
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

describe('decideTargetedNavigate：silent 页定向 navigate 的直执行判定（adr-023 D3）', () => {
  const table: PageHandleTable = { nextSeq: 3, byTab: { '101': 'p1', '102': 'p2' } };
  const navigateRequest: ExecInstructionFrame['request'] = {
    kind: 'dom',
    steps: [{ action: 'navigate', url: 'https://example.com/a' }],
  };

  it('获签的单步 navigate 且句柄命中：落点即句柄解析出的那一个 tab', () => {
    const frame = execFrame(navigateRequest, 'p2');
    expect(decideTargetedNavigate(frame, table)).toEqual({
      execute: true,
      frame,
      url: 'https://example.com/a',
      tabId: 102,
    });
  });

  it('无 page 的帧不走定向直执行（缺省路径归 decideBackgroundNavigate）', () => {
    expect(decideTargetedNavigate(execFrame(navigateRequest), table)).toEqual({ execute: false });
  });

  it('句柄未命中（退役/从未存在）：拒绝，丢帧由服务端超时回喂', () => {
    expect(decideTargetedNavigate(execFrame(navigateRequest, 'p9'), table)).toEqual({
      execute: false,
    });
  });

  it('非单步 navigate 形状拒绝：不扩大直执行面', () => {
    expect(
      decideTargetedNavigate(
        execFrame({ kind: 'dom', steps: [{ action: 'click', ref: 'e1' }] }, 'p2'),
        table,
      ),
    ).toEqual({ execute: false });
    expect(
      decideTargetedNavigate(
        execFrame(
          {
            kind: 'dom',
            steps: [{ action: 'navigate', url: 'https://example.com/a' }],
            expectedPageUrl: 'https://example.com/list',
          },
          'p2',
        ),
        table,
      ),
    ).toEqual({ execute: false });
  });

  it('guide-action 定向到无端口成员：拒绝（纯引导静默降级）', () => {
    const guide: DownstreamFrame = {
      type: 'guide-action',
      sessionId: 's-1',
      action: 'highlight',
      selector: '#a',
      page: 'p2',
    };
    expect(decideTargetedNavigate(guide, table)).toEqual({ execute: false });
  });
});
