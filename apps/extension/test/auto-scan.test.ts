import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_SCAN_MINUTES,
  decideAutoScanRecovery,
  decideAutoScanDelivery,
  autoScanDispatch,
  autoScanUpstreamFrame,
  autoScanAlarmFor,
  automationIdOfAlarm,
  isAutoScanWorkPage,
  isAutoScanCompletion,
  normalizeAutoScanMinutes,
  parseAutoScanRun,
  parseAutomationDescriptors,
  shouldPauseAutoScan,
  type AutomationDescriptor,
  type AutoScanRun,
} from '../src/auto-scan.js';

const descriptor: AutomationDescriptor = {
  packId: 'xianyu-seller',
  origin: 'https://seller.goofish.com',
  automation: {
    id: 'xianyu-auto-scan',
    prompt: '执行闲鱼自动履约扫描。',
    workRoutes: ['#/seller-trade/order-manage', '#/im'],
    executionPreference: 'dom-only',
    defaultPeriodMinutes: 5,
  },
};

describe('声明驱动周期扫描纯决策', () => {
  it('只接受声明工作页，不把其它路由、伪域名或坏 URL 当工作页', () => {
    expect(isAutoScanWorkPage(descriptor, 'https://seller.goofish.com/?site=COMMONPRO#/seller-trade/order-manage')).toBe(true);
    expect(isAutoScanWorkPage(descriptor, 'https://seller.goofish.com/?site=COMMONPRO#/im?itemId=i&orderId=o')).toBe(true);
    expect(isAutoScanWorkPage(descriptor, 'https://seller.goofish.com/?site=COMMONPRO#/seller-data/data')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://seller.goofish.com/#/im-evil')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://login.goofish.com/')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://seller.goofish.com.evil.test/#/im')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'not-a-url')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, undefined)).toBe(false);
  });

  it('路径型 workRoute 按路径段前缀匹配', () => {
    const pathDescriptor: AutomationDescriptor = {
      ...descriptor,
      automation: { ...descriptor.automation, workRoutes: ['/orders'] },
    };
    expect(isAutoScanWorkPage(pathDescriptor, 'https://seller.goofish.com/orders')).toBe(true);
    expect(isAutoScanWorkPage(pathDescriptor, 'https://seller.goofish.com/orders/42')).toBe(true);
    expect(isAutoScanWorkPage(pathDescriptor, 'https://seller.goofish.com/orders-evil')).toBe(false);
  });

  it('周期限制在 1..60 分钟，非法值回到默认（可按声明覆盖）', () => {
    expect(normalizeAutoScanMinutes(1)).toBe(1);
    expect(normalizeAutoScanMinutes(60)).toBe(60);
    for (const value of [0, 61, 1.5, '5', null]) {
      expect(normalizeAutoScanMinutes(value)).toBe(DEFAULT_AUTO_SCAN_MINUTES);
    }
    expect(normalizeAutoScanMinutes(null, 10)).toBe(10);
  });

  it('有持久轮次锁时失败/HITL 触发暂停，明确完成帧只负责释放', () => {
    const run: AutoScanRun = { runId: 'scan_run_001', automationId: 'xianyu-auto-scan' };
    expect(shouldPauseAutoScan(run, { type: 'tool-card', status: 'failed' })).toBe(true);
    expect(shouldPauseAutoScan(null, { type: 'tool-card', status: 'failed' })).toBe(false);
    expect(shouldPauseAutoScan(run, { type: 'tool-card', status: 'succeeded' })).toBe(false);
    expect(shouldPauseAutoScan(run, { type: 'hitl-request' })).toBe(true);
    expect(shouldPauseAutoScan(run, { type: 'text-delta' })).toBe(false);
    const completion = {
      type: 'tool-card',
      toolId: 'xianyu-auto-scan',
      toolCallId: run.runId,
      status: 'failed',
    };
    expect(isAutoScanCompletion(run, completion)).toBe(true);
    expect(shouldPauseAutoScan(run, completion)).toBe(false);
    expect(isAutoScanCompletion({ ...run, runId: 'different_run' }, completion)).toBe(false);
    expect(isAutoScanCompletion({ ...run, automationId: 'other-automation' }, completion)).toBe(false);
  });

  it('service worker 重启后按服务端权威状态恢复单飞锁', () => {
    expect(decideAutoScanRecovery('running')).toBe('keep-busy');
    expect(decideAutoScanRecovery('unavailable')).toBe('keep-busy');
    expect(decideAutoScanRecovery('succeeded')).toBe('release');
    expect(decideAutoScanRecovery('failed')).toBe('release-and-pause');
    expect(decideAutoScanRecovery('missing')).toBe('release-and-pause');
  });

  it('调度机械保证先同步候选页上下文，再发送带 automationId 的自动轮次', () => {
    expect(autoScanDispatch(descriptor, 'https://seller.goofish.com/#/im?orderId=new', '新订单', 'scan_run_001')).toEqual([
      { kind: 'context-report', url: 'https://seller.goofish.com/#/im?orderId=new', title: '新订单' },
      {
        kind: 'auto-scan',
        text: '执行闲鱼自动履约扫描。',
        executionPreference: 'dom-only',
        automationRunId: 'scan_run_001',
        automationId: 'xianyu-auto-scan',
      },
    ]);
  });

  it('自动回合上行帧携带 automationId：缺失则服务端无法定位只读模板，R7 只读强制不可达', () => {
    const [, dispatch] = autoScanDispatch(descriptor, 'https://seller.goofish.com/#/im', '订单', 'scan_run_002');
    expect(autoScanUpstreamFrame(dispatch, 'sess_1')).toEqual({
      type: 'user-message',
      sessionId: 'sess_1',
      text: '执行闲鱼自动履约扫描。',
      messageId: 'scan_run_002',
      executionPreference: 'dom-only',
      automationRunId: 'scan_run_002',
      automationId: 'xianyu-auto-scan',
    });
  });

  it('上行被拒的处置：只有 403 停用触发器，其余留到下周期重试', () => {
    expect(decideAutoScanDelivery(403)).toBe('pause');
    // 网络不可达没有状态码；401/404/409/503 都能自愈——把它们当停用理由，一次断网就永久关掉用户的监测。
    for (const status of [undefined, 401, 404, 409, 500, 503]) {
      expect(decideAutoScanDelivery(status)).toBe('retry-next-cycle');
    }
  });

  it('alarm 名与 automation id 互相派生', () => {
    expect(autoScanAlarmFor('a-b')).toBe('zen-agent.auto-scan.a-b');
    expect(automationIdOfAlarm('zen-agent.auto-scan.a-b')).toBe('a-b');
    expect(automationIdOfAlarm('other-alarm')).toBe(null);
  });

  it('存储解析 fail-closed：残缺轮次与残缺描述符一律丢弃', () => {
    expect(parseAutoScanRun({ runId: 'r', automationId: 'a' })).toEqual({ runId: 'r', automationId: 'a' });
    expect(parseAutoScanRun('legacy-string-run')).toBe(null);
    expect(parseAutoScanRun({ runId: 'r' })).toBe(null);
    expect(parseAutomationDescriptors([descriptor])).toEqual([descriptor]);
    expect(parseAutomationDescriptors([{ packId: 'x' }, 'junk', null])).toEqual([]);
    expect(parseAutomationDescriptors('junk')).toEqual([]);
  });
});
