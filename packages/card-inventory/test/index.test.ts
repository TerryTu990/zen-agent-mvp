import { describe, expect, it } from 'vitest';
import { createLarkBaseCardInventoryPort, type LarkCliRunner } from '../src/index.js';

const FIELDS = ['card_id', 'product_key', 'card_secret', 'status', 'order_id', 'note'];

function listPayload(
  records: Array<{
    id: string;
    values:
      | [string, string, string, string[], string | null]
      | [string, string, string, string[], string | null, string | null];
  }>,
) {
  return {
    ok: true,
    data: {
      data: records.map((record) => record.values.length === 5 ? [...record.values, null] : record.values),
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
      listPayload([]),
      listPayload([]),
    ]);
    await expect(port(runner).reserve({ productKey: 'product-a', orderId: 'order-1' })).resolves.toEqual({
      ok: true,
      cardId: 'card-1',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved',
      stage: 'reserved',
      reused: true,
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('新订单先查重，再选择 available，whoami 通过后写 reserved', async () => {
    const runner = queuedRunner([
      listPayload([]),
      listPayload([]),
      listPayload([]),
      listPayload([]),
      listPayload([
        {
          id: 'rec-2',
          values: ['card-2', 'product-a', 'fixture-value-not-real', ['available'], null],
        },
      ]),
      { available: true, identity: 'user' },
      { ok: true },
      listPayload([
        {
          id: 'rec-2',
          values: ['card-2', 'product-a', 'fixture-value-not-real', ['reserved'], 'order-2', 'reserved'],
        },
      ]),
    ]);
    await expect(port(runner).reserve({ productKey: 'product-a', orderId: 'order-2' })).resolves.toEqual({
      ok: true,
      cardId: 'card-2',
      cardSecret: 'fixture-value-not-real',
      status: 'reserved',
      stage: 'reserved',
      reused: false,
    });
    expect(runner.calls.map((args) => args[1])).toEqual([
      '+record-list',
      '+record-list',
      '+record-list',
      '+record-list',
      '+record-list',
      undefined,
      '+record-batch-update',
      '+record-list',
    ]);
    const writeArgs = runner.calls[6]!.join(' ');
    expect(writeArgs).toContain('reserved');
    expect(writeArgs).toContain('order-2');
    expect(writeArgs).not.toContain('fixture-value-not-real');
  });

  it('缺货、重复订单记录、身份失败和写失败均 fail-closed', async () => {
    await expect(
      port(queuedRunner([listPayload([]), listPayload([]), listPayload([]), listPayload([]), listPayload([])])).reserve({
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
      port(queuedRunner([
        listPayload([]),
        listPayload([]),
        listPayload([]),
        listPayload([]),
        candidate,
        { available: false, identity: 'bot' },
      ])).reserve({
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
      listPayload([
        { id: 'r4', values: ['c4', 'product-a', 'fixture-d', ['manual'], 'order-4', 'timeout'] },
      ]),
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

  it('浏览器副作用前写入 delivery-attempted 并回读；重启恢复时拒绝再次发送', async () => {
    const attempted = listPayload([
      {
        id: 'r7',
        values: ['c7', 'product-a', 'fixture-g', ['reserved'], 'order-7', 'delivery-attempted'],
      },
    ]);
    const runner = queuedRunner([
      listPayload([
        { id: 'r7', values: ['c7', 'product-a', 'fixture-g', ['reserved'], 'order-7', 'shipped-confirmed'] },
      ]),
      { available: true, identity: 'user' },
      { ok: true },
      attempted,
    ]);
    await expect(port(runner).beginDelivery({ cardId: 'c7', orderId: 'order-7' })).resolves.toEqual({ ok: true });
    expect(runner.calls[2]!.join(' ')).toContain('delivery-attempted');
    await expect(
      port(queuedRunner([attempted])).reserve({ productKey: 'product-a', orderId: 'order-7' }),
    ).resolves.toEqual({ ok: false, error: 'inventory-paused' });

    const resumable = listPayload([]);
    const otherManual = listPayload([
      { id: 'r11', values: ['c11', 'product-a', 'fixture-k', ['manual'], 'order-11', 'timeout'] },
    ]);
    await expect(port(queuedRunner([resumable, otherManual])).reserve({
      productKey: 'product-a',
      orderId: 'order-10',
    })).resolves.toEqual({ ok: false, error: 'inventory-paused' });

    const otherAttempted = listPayload([
      { id: 'r12', values: ['c12', 'product-a', 'fixture-l', ['reserved'], 'order-12', 'delivery-attempted'] },
    ]);
    await expect(port(queuedRunner([resumable, listPayload([]), listPayload([]), otherAttempted])).reserve({
      productKey: 'product-a',
      orderId: 'order-10',
    })).resolves.toEqual({ ok: false, error: 'inventory-paused' });
  });

  it('发货副作用前写 shipping-attempted，明确状态后写 shipped-confirmed', async () => {
    const reserved = listPayload([
      { id: 'rs1', values: ['cs1', 'product-a', 'fixture-s', ['reserved'], 'order-s', 'reserved'] },
    ]);
    const attempted = listPayload([
      { id: 'rs1', values: ['cs1', 'product-a', 'fixture-s', ['reserved'], 'order-s', 'shipping-attempted'] },
    ]);
    const confirmed = listPayload([
      { id: 'rs1', values: ['cs1', 'product-a', 'fixture-s', ['reserved'], 'order-s', 'shipped-confirmed'] },
    ]);
    const runner = queuedRunner([
      reserved, { available: true, identity: 'user' }, { ok: true }, attempted,
      attempted, { available: true, identity: 'user' }, { ok: true }, confirmed,
    ]);
    const inventory = port(runner);
    await expect(inventory.beginShipment({ cardId: 'cs1', orderId: 'order-s' })).resolves.toEqual({ ok: true });
    await expect(inventory.confirmShipment({ cardId: 'cs1', orderId: 'order-s', confirmed: true }))
      .resolves.toEqual({ ok: true });
    await expect(port(queuedRunner([confirmed])).reserve({ productKey: 'product-a', orderId: 'order-s' }))
      .resolves.toMatchObject({ ok: true, status: 'reserved', stage: 'shipped-confirmed', reused: true });
  });

  it('写命令成功但回读字段不符时 fail-closed；manual 或未决 attempt 会暂停同商品下一单', async () => {
    const candidate = listPayload([
      { id: 'r8', values: ['c8', 'product-a', 'fixture-h', ['available'], null] },
    ]);
    const stale = listPayload([
      { id: 'r8', values: ['c8', 'product-a', 'fixture-h', ['available'], null] },
    ]);
    await expect(port(queuedRunner([
      listPayload([]), listPayload([]), listPayload([]), listPayload([]), candidate,
      { available: true, identity: 'user' }, { ok: true }, stale,
    ])).reserve({ productKey: 'product-a', orderId: 'order-8' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });

    const manual = listPayload([
      { id: 'r9', values: ['c9', 'product-a', 'fixture-i', ['manual'], 'old-order', 'timeout'] },
    ]);
    await expect(port(queuedRunner([listPayload([]), manual])).reserve({
      productKey: 'product-a', orderId: 'order-9',
    })).resolves.toEqual({ ok: false, error: 'inventory-paused' });
  });

  it('beginDelivery 与 settle 的写后回读不一致也必须 fail-closed', async () => {
    const before = listPayload([
      { id: 'r13', values: ['c13', 'product-a', 'fixture-m', ['reserved'], 'order-13', 'shipped-confirmed'] },
    ]);
    await expect(port(queuedRunner([
      before,
      { available: true, identity: 'user' },
      { ok: true },
      before,
    ])).beginDelivery({ cardId: 'c13', orderId: 'order-13' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });

    const attempted = listPayload([
      { id: 'r14', values: ['c14', 'product-a', 'fixture-n', ['reserved'], 'order-14', 'delivery-attempted'] },
    ]);
    await expect(port(queuedRunner([
      attempted,
      { available: true, identity: 'user' },
      { ok: true },
      attempted,
    ])).settle({ cardId: 'c14', orderId: 'order-14', status: 'sent' })).resolves.toEqual({
      ok: false,
      error: 'inventory-write-failed',
    });
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
