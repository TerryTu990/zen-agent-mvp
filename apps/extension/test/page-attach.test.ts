/**
 * 「这一页为什么没被接入」的本地判定。判据分三组：不可注入地址的闭集、
 * 四类原因的优先级（不可改变的在前、能自行消除的在后）、以及哪些原因给重试入口。
 */
import { describe, expect, it } from 'vitest';
import {
  decideAttachReason,
  isAttachRetryable,
  isRestrictedPage,
  PAGE_ATTACH_REASON_TEXT,
  permissionPatternFor,
  type PageAttachReason,
} from '../src/page-attach.js';

const attached = { siteDenied: false, originGranted: true, loading: false };

describe('isRestrictedPage：浏览器一律不允许注入的地址', () => {
  it.each([
    'chrome://newtab/',
    'chrome://extensions/',
    'chrome-extension://abcdefghijklmnop/sidepanel.html',
    'about:blank',
    'view-source:https://shop.example/',
    'file:///Users/me/report.html',
    'https://chromewebstore.google.com/detail/xyz',
    'https://chrome.google.com/webstore/detail/xyz',
    'https://docs.example/manual.PDF',
    '不是一个地址',
  ])('%s 判为不可注入', (url) => {
    expect(isRestrictedPage(url)).toBe(true);
  });

  it.each([
    'https://shop.example/orders',
    'http://127.0.0.1:4173/landing.html',
    'https://chrome.google.com/search?q=pdf',
    'https://shop.example/pdf-guide',
  ])('%s 判为可注入', (url) => {
    expect(isRestrictedPage(url)).toBe(false);
  });
});

describe('permissionPatternFor：站点权限的匹配模式', () => {
  it('去掉端口：chrome 的匹配模式主机段不带端口，带端口的实参会被判非法', () => {
    expect(permissionPatternFor('http://localhost:4232/article.html')).toBe('http://localhost/*');
    expect(permissionPatternFor('https://shop.example/orders?q=1#x')).toBe('https://shop.example/*');
  });

  it('地址不可解析即拿不出可询问的范围', () => {
    expect(permissionPatternFor('不是一个地址')).toBeNull();
  });
});

describe('decideAttachReason：四类原因与优先级', () => {
  it('浏览器内部页：即便权限齐备也只报硬限制', () => {
    expect(decideAttachReason({ url: 'chrome://newtab/', ...attached })).toBe('restricted');
  });

  it('不辅助名单命中优先于缺权限：那是用户的设置，不是待修复的故障', () => {
    expect(
      decideAttachReason({
        url: 'https://bank.example/accounts',
        siteDenied: true,
        originGranted: false,
        loading: true,
      }),
    ).toBe('site-denied');
  });

  it('缺站点访问权限优先于加载中：加载完也仍然注入不进去', () => {
    expect(
      decideAttachReason({ url: 'https://shop.example/', siteDenied: false, originGranted: false, loading: true }),
    ).toBe('permission');
  });

  it('权限齐备但仍在加载：瞬时态', () => {
    expect(decideAttachReason({ url: 'https://shop.example/', ...attached, loading: true })).toBe('loading');
  });

  it('四条都不成立时不猜原因', () => {
    expect(decideAttachReason({ url: 'https://shop.example/', ...attached })).toBe('unknown');
  });
});

describe('原因的可重试性与措辞', () => {
  it('浏览器硬限制与用户名单不给重试入口：前者必失败，后者违背用户设置', () => {
    expect(isAttachRetryable('restricted')).toBe(false);
    expect(isAttachRetryable('site-denied')).toBe(false);
  });

  it('缺权限 / 加载中 / 原因不明可重试', () => {
    expect(isAttachRetryable('permission')).toBe(true);
    expect(isAttachRetryable('loading')).toBe(true);
    expect(isAttachRetryable('unknown')).toBe(true);
  });

  it('每类原因都有可定位的措辞，且不回显任何本机细节', () => {
    const reasons: PageAttachReason[] = ['restricted', 'site-denied', 'permission', 'loading', 'unknown'];
    for (const reason of reasons) {
      const text = PAGE_ATTACH_REASON_TEXT[reason];
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/chrome-extension:|Bearer|token/i);
    }
  });
});
