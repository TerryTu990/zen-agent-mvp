import { describe, expect, it } from 'vitest';
import { createLarkBaseCardInventoryPort, type LarkCliRunner } from '../src/index.js';

const FIELDS = ['card_id', 'product_key', 'card_secret', 'status', 'order_id'];

function listPayload(
  records: Array<{ id: string; values: [string, string, string, string[], string | null] }>,
) {
  return {
    ok: true,
    data: {
      data: records.map((record) => record.values),
      fields: FIELDS,
      record_id_list: records.map((record) => record.id),
    },
  };
}

function queuedRunner(responses: unknown[]): LarkCliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function port(runner: LarkCliRunner) {
  return createLarkBaseCardInventoryPort({
    baseToken: 'base-fixture',
    tableId: 'table-fixture',
    runner,
  });
}

describe('飞书卡密库存端口', () => {
  it('同订单已有 reserved 时复用同一卡，不再写入或领取新卡', async () => {
    const runner = queuedRunner([
      listPayload([
        {
          id: 'rec-1',
          values: ['card-1', 'product-a', 'fixture-value-not-real', ['reserved'], 'order-1'],
        },
      ]),
    ]);
    await expect(port(runner).reserve({ productKey: 'product-a', orderId: 'order-1' })).resolves.toEqual({
      ok: true,
      cardId: 'card-1',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved',
      reused: true,
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('新订单先查重，再选择 available，whoami 通过后写 reserved', async () => {
    const runner = queuedRunner([
      listPayload([]),
      listPayload([
        {
          id: 'rec-2',
          values: ['card-2', 'product-a', 'fixture-value-not-real', ['available'], null],
        },
      ]),
      { available: true, identity: 'user' },
      { ok: true },
    ]);
    await expect(port(runner).reserve({ productKey: 'product-a', orderId: 'order-2' })).resolves.toEqual({
      ok: true,
      cardId: 'card-2',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved',
      reused: false,
    });
    expect(runner.calls.map((args) => args[1])).toEqual([
      '+record-list',
      '+record-list',
      undefined,
      '+record-batch-update',
    ]);
    const writeArgs = runner.calls[3]!.join(' ');
    expect(writeArgs).toContain('reserved');
    expect(writeArgs).toContain('order-2');
    expect(writeArgs).not.toContain('fixture-value-not-real');
  });

  it('缺货、重复订单记录、身份失败和写失败均 fail-closed', async () => {
    await expect(
      port(queuedRunner([listPayload([]), listPayload([])])).reserve({
        productKey: 'product-a',
        orderId: 'order-empty',
      }),
    ).resolves.toEqual({ ok: false, error: 'inventory-empty' });

    const duplicate = listPayload([
      { id: 'r1', values: ['c1', 'product-a', 'fixture-a', ['reserved'], 'order-dup'] },
      { id: 'r2', values: ['c2', 'product-a', 'fixture-b', ['reserved'], 'order-dup'] },
    ]);
    await expect(
      port(queuedRunner([duplicate])).reserve({ productKey: 'product-a', orderId: 'order-dup' }),
    ).resolves.toEqual({ ok: false, error: 'inventory-ambiguous' });

    const candidate = listPayload([
      { id: 'r3', values: ['c3', 'product-a', 'fixture-c', ['available'], null] },
    ]);
    await expect(
      port(queuedRunner([listPayload([]), candidate, { available: false, identity: 'bot' }])).reserve({
        productKey: 'product-a',
        orderId: 'order-auth-fail',
      }),
    ).resolves.toEqual({ ok: false, error: 'inventory-write-failed' });
  });

  it('sent/manual 回填校验 card_id 与 order_id；同终态重复调用幂等', async () => {
    const runner = queuedRunner([
      listPayload([
        { id: 'r4', values: ['c4', 'product-a', 'fixture-d', ['reserved'], 'order-4'] },
      ]),
      { available: true, identity: 'user' },
      { ok: true },
    ]);
    await expect(
      port(runner).settle({ cardId: 'c4', orderId: 'order-4', status: 'manual', note: 'timeout' }),
    ).resolves.toEqual({ ok: true });
    expect(runner.calls[2]!.join(' ')).toContain('manual');

    await expect(
      port(
        queuedRunner([
          listPayload([
            { id: 'r5', values: ['c5', 'product-a', 'fixture-e', ['sent'], 'order-5'] },
          ]),
        ]),
      ).settle({ cardId: 'c5', orderId: 'order-5', status: 'sent' }),
    ).resolves.toEqual({ ok: true });

    await expect(
      port(
        queuedRunner([
          listPayload([
            { id: 'r6', values: ['c6', 'product-a', 'fixture-f', ['manual'], 'order-6'] },
          ]),
        ]),
      ).settle({ cardId: 'c6', orderId: 'order-6', status: 'sent' }),
    ).resolves.toEqual({ ok: false, error: 'inventory-invalid-record' });
  });

  it('CLI/响应异常只返回闭集错误，不回显底层内容', async () => {
    const result = await port(queuedRunner([new Error('fixture-value-not-real')])).reserve({
      productKey: 'product-a',
      orderId: 'order-error',
    });
    expect(result).toEqual({ ok: false, error: 'inventory-unavailable' });
    expect(JSON.stringify(result)).not.toContain('fixture-value-not-real');
  });
});
