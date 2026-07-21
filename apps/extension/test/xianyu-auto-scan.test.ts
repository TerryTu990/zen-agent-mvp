import { describe, expect, it } from 'vitest';
import {
  DEFAULT_XIANYU_AUTO_SCAN_MINUTES,
  isXianyuAutoScanWorkPage,
  normalizeAutoScanMinutes,
  shouldPauseXianyuAutoScan,
} from '../src/xianyu-auto-scan.js';

describe('闲鱼周期扫描纯决策', () => {
  it('只接受卖家订单页与聊天页，不把数据页、登录页、伪域名或坏 URL 当工作页', () => {
    expect(isXianyuAutoScanWorkPage('https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage')).toBe(true);
    expect(isXianyuAutoScanWorkPage('https://seller.goofish.com/?site=COMMONPRO#/im?itemId=i&orderId=o')).toBe(true);
    expect(isXianyuAutoScanWorkPage('https://seller.goofish.com/?site=COMMONPRO#/seller-data/data')).toBe(false);
    expect(isXianyuAutoScanWorkPage('https://login.goofish.com/')).toBe(false);
    expect(isXianyuAutoScanWorkPage('https://seller.goofish.com.evil.test/#/im')).toBe(false);
    expect(isXianyuAutoScanWorkPage('not-a-url')).toBe(false);
  });

  it('周期限制在 1..60 分钟，非法值回到保守默认', () => {
    expect(normalizeAutoScanMinutes(1)).toBe(1);
    expect(normalizeAutoScanMinutes(60)).toBe(60);
    for (const value of [0, 61, 1.5, '5', null]) {
      expect(normalizeAutoScanMinutes(value)).toBe(DEFAULT_XIANYU_AUTO_SCAN_MINUTES);
    }
  });

  it('仅在自动扫描活动窗口内由失败 tool-card 触发持久暂停', () => {
    expect(shouldPauseXianyuAutoScan(2_000, 1_000, { type: 'tool-card', status: 'failed' })).toBe(true);
    expect(shouldPauseXianyuAutoScan(999, 1_000, { type: 'tool-card', status: 'failed' })).toBe(false);
    expect(shouldPauseXianyuAutoScan(2_000, 1_000, { type: 'tool-card', status: 'succeeded' })).toBe(false);
    expect(shouldPauseXianyuAutoScan(2_000, 1_000, { type: 'hitl-request' })).toBe(true);
    expect(shouldPauseXianyuAutoScan(2_000, 1_000, { type: 'text-delta' })).toBe(false);
  });
});
