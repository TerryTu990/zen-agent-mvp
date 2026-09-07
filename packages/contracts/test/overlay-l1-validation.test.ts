import { describe, expect, it } from 'vitest';
import type { UserOverlay, UserOverlayL1Baseline } from '../src/index.js';
// validateOverlayAgainstL1：写入期只收紧校验（adr-014 §3——L2 低于 L1 的声明写入期即拒）。
// l1Baseline = { tools: {id, riskTier}[] }（JSON 可序列化）。
import { validateOverlayAgainstL1 } from '../src/index.js';

const subject = { tenant: 'default', hostUserId: 'host-1001' };

const l1Baseline: UserOverlayL1Baseline = {
  tools: [
    { id: 'shop.list', riskTier: 'auto' },
    { id: 'shop.cancel', riskTier: 'hitl' },
    { id: 'shop.purge', riskTier: 'forbidden' },
  ],
};

function overlayWith(shopScope: Record<string, unknown>): UserOverlay {
  return {
    schemaVersion: 1,
    subject,
    packs: { shop: shopScope },
  } as UserOverlay;
}

function issuesText(result: ReturnType<typeof validateOverlayAgainstL1>): string {
  return result.ok ? '' : JSON.stringify(result.issues);
}

describe('validateOverlayAgainstL1 — riskTier 只收紧（写入期）', () => {
  it('合法收紧通过：L1 auto → L2 hitl / L1 auto → L2 forbidden（正常）', () => {
    const result = validateOverlayAgainstL1(
      overlayWith({
        restrictions: { riskTierRaise: { 'shop.list': 'hitl' } },
      }),
      l1Baseline,
    );
    expect(result.ok).toBe(true);

    const toForbidden = validateOverlayAgainstL1(
      overlayWith({ restrictions: { riskTierRaise: { 'shop.list': 'forbidden' } } }),
      l1Baseline,
    );
    expect(toForbidden.ok).toBe(true);
  });

  it('L2 声明低于 L1 → 拒（异常）：L1 forbidden 上声明 hitl', () => {
    const result = validateOverlayAgainstL1(
      overlayWith({ restrictions: { riskTierRaise: { 'shop.purge': 'hitl' } } }),
      l1Baseline,
    );
    expect(result.ok).toBe(false);
    expect(issuesText(result)).toContain('shop.purge');
  });

  it('等于 L1 值：等值声明冗余但合法通过（边界）', () => {
    const result = validateOverlayAgainstL1(
      overlayWith({ restrictions: { riskTierRaise: { 'shop.cancel': 'hitl' } } }),
      l1Baseline,
    );
    expect(result.ok).toBe(true);
  });
});
