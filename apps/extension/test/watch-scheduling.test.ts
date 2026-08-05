/**
 * G5（adr-021）用户自建触发器的客户端调度纯决策：watch 实例（GET /v1/user-config 的 overlay.watches）
 * 派生为周期自动化描述符，与 pack 声明描述符合并进同一套 alarm/单飞锁/SW 恢复机制（按实例 id 通用化）。
 * 客户端零治理判定（U7）：本层只决定「何时、在哪个已开页面发起自动回合」，只读强制与拒绝全在服务端。
 */
import { describe, expect, it } from 'vitest';
import {
  autoScanAlarmFor,
  automationIdOfAlarm,
  isAutoScanCompletion,
  isAutoScanWorkPage,
  mergeAutomationDescriptors,
  shouldPauseAutoScan,
  watchAutomationDescriptor,
  watchesFromUserConfig,
  type AutomationDescriptor,
  type AutoScanRun,
  type WatchInstance,
} from '../src/auto-scan.js';

const packDescriptor: AutomationDescriptor = {
  packId: 'xianyu-seller',
  origin: 'https://seller.goofish.com',
  automation: {
    id: 'xianyu-auto-scan',
    prompt: '执行闲鱼自动履约扫描。',
    workRoutes: ['#/seller-trade/order-manage'],
    executionPreference: 'dom-only',
    defaultPeriodMinutes: 5,
  },
};

const watch: WatchInstance = {
  id: 'watch-release-notes',
  templateId: 'page-watch',
  url: 'https://example.test/release-notes',
  minutes: 15,
  enabled: true,
  focus: '关注版本号与发布日期',
};

function userConfigBody(watches: unknown): Record<string, unknown> {
  return {
    overlay: { schemaVersion: 1, subject: { tenant: 'default', hostUserId: 'host-1' }, packs: {}, watches },
    revision: 'rev-1',
    subject: { tenant: 'default', hostUserId: 'host-1' },
  };
}

describe('watch 实例读取（GET /v1/user-config）', () => {
  it('从 overlay.watches 取出实例', () => {
    expect(watchesFromUserConfig(userConfigBody([watch]))).toEqual([watch]);
  });

  it('拉取失败/空态一律回空——不凭空调度（fail-closed）', () => {
    for (const body of [null, undefined, 'junk', {}, { overlay: null, revision: 'r' }]) {
      expect(watchesFromUserConfig(body)).toEqual([]);
    }
  });

  it('残缺实例逐条丢弃，合法实例不受牵连（解析 fail-closed 不整表作废）', () => {
    const parsed = watchesFromUserConfig(
      userConfigBody([{ id: 'broken' }, 'junk', null, { ...watch, minutes: '15' }, watch]),
    );
    expect(parsed).toEqual([watch]);
  });
});

describe('watch 实例派生周期自动化描述符', () => {
  it('origin 与工作路由取自实例 URL；周期取自实例 minutes', () => {
    const descriptor = watchAutomationDescriptor(watch);
    expect(descriptor.origin).toBe('https://example.test');
    expect(descriptor.automation.id).toBe(watch.id);
    expect(descriptor.automation.workRoutes).toEqual(['/release-notes']);
    expect(descriptor.automation.defaultPeriodMinutes).toBe(15);
    expect(descriptor.automation.executionPreference).toBe('dom-only');
  });

  it('提示词非空且带上用户关注点（focus 只进提示词，不改工具面）', () => {
    expect(watchAutomationDescriptor(watch).automation.prompt).toContain('关注版本号与发布日期');
    const { focus, ...withoutFocus } = watch;
    void focus;
    expect(watchAutomationDescriptor(withoutFocus).automation.prompt.length).toBeGreaterThan(0);
  });

  it('URL 的查询串与 hash 不进工作路由（工作页按 origin + 路径前缀判定）', () => {
    const descriptor = watchAutomationDescriptor({ ...watch, url: 'https://example.test/docs/api?v=2#/top' });
    expect(descriptor.automation.workRoutes).toEqual(['/docs/api']);
  });
});

describe('watch 工作页判定（origin + 路径前缀，复用既有闭集判定）', () => {
  const descriptor = watchAutomationDescriptor({ ...watch, url: 'https://example.test/news/tech' });

  it('同 origin 且路径前缀命中才算工作页', () => {
    expect(isAutoScanWorkPage(descriptor, 'https://example.test/news/tech')).toBe(true);
    expect(isAutoScanWorkPage(descriptor, 'https://example.test/news/tech?page=2')).toBe(true);
    expect(isAutoScanWorkPage(descriptor, 'https://example.test/news/tech/2026')).toBe(true);
  });

  it('前缀相邻、上级路径、异 origin、异协议与坏 URL 一律不算工作页', () => {
    expect(isAutoScanWorkPage(descriptor, 'https://example.test/news/tech-evil')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://example.test/news')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://evil.example.test/news/tech')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'https://example.test.evil/news/tech')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'http://example.test/news/tech')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, 'not-a-url')).toBe(false);
    expect(isAutoScanWorkPage(descriptor, undefined)).toBe(false);
  });

  it('站点根 URL 的实例覆盖该 origin 全站', () => {
    const rootWatch = watchAutomationDescriptor({ ...watch, url: 'https://example.test/' });
    expect(isAutoScanWorkPage(rootWatch, 'https://example.test/any/deep/path')).toBe(true);
    expect(isAutoScanWorkPage(rootWatch, 'https://other.test/any')).toBe(false);
  });
});

describe('与 pack 描述符合并调度', () => {
  it('启用实例并入 pack 描述符集合，二者互不覆盖', () => {
    const merged = mergeAutomationDescriptors([packDescriptor], [watch]);
    expect(merged.map((entry) => entry.automation.id)).toEqual(['xianyu-auto-scan', watch.id]);
    expect(merged[0]).toEqual(packDescriptor);
  });

  it('未启用实例不进调度集合（关停即不调度）', () => {
    const merged = mergeAutomationDescriptors([packDescriptor], [{ ...watch, enabled: false }]);
    expect(merged.map((entry) => entry.automation.id)).toEqual(['xianyu-auto-scan']);
  });

  it('实例 id 与 pack automation id 撞名时丢弃实例（pack 优先，避免归属不可判定）', () => {
    const collided = { ...watch, id: 'xianyu-auto-scan' };
    const merged = mergeAutomationDescriptors([packDescriptor], [collided]);
    expect(merged).toEqual([packDescriptor]);
  });

  it('实例拉取失败（空表）时只剩 pack 描述符——不调度任何 watch', () => {
    expect(mergeAutomationDescriptors([packDescriptor], watchesFromUserConfig(null))).toEqual([
      packDescriptor,
    ]);
    expect(mergeAutomationDescriptors([], watchesFromUserConfig(null))).toEqual([]);
  });
});

describe('单飞锁与 alarm 按实例 id 生效', () => {
  const run: AutoScanRun = { runId: 'watch_run_001', automationId: watch.id };

  it('alarm 名与实例 id 互相派生（与 pack automation 同一命名空间）', () => {
    expect(automationIdOfAlarm(autoScanAlarmFor(watch.id))).toBe(watch.id);
  });

  it('只有本实例本轮次的完成帧释放锁', () => {
    const completion = {
      type: 'tool-card',
      toolId: watch.id,
      toolCallId: run.runId,
      status: 'succeeded',
    };
    expect(isAutoScanCompletion(run, completion)).toBe(true);
    expect(isAutoScanCompletion(run, { ...completion, toolId: 'other-watch' })).toBe(false);
    expect(isAutoScanCompletion(run, { ...completion, toolCallId: 'watch_run_002' })).toBe(false);
  });

  it('无人值守轮次内出现 HITL 或他方失败卡即暂停该实例', () => {
    expect(shouldPauseAutoScan(run, { type: 'hitl-request' })).toBe(true);
    expect(shouldPauseAutoScan(run, { type: 'tool-card', status: 'failed' })).toBe(true);
    expect(
      shouldPauseAutoScan(run, {
        type: 'tool-card',
        status: 'failed',
        toolId: watch.id,
        toolCallId: run.runId,
      }),
    ).toBe(false);
  });
});
