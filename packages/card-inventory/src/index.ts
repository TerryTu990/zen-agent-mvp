import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CardInventoryPort,
  CardInventoryStatus,
  CardInventoryStage,
  BeginCardDeliveryInput,
  ConfirmCardShipmentInput,
  ReserveCardInput,
  ReserveCardResult,
  SettleCardInput,
  SettleCardResult,
} from '@zen-agent/contracts';

const execFileAsync = promisify(execFile);

export interface LarkCliRunner {
  /** 返回已解析 JSON；实现不得记录 argv、stdout/stderr（其中查询结果可能含 card_secret）。 */
  run(args: string[]): Promise<unknown>;
}

export interface LarkBaseCardInventoryOptions {
  baseToken: string;
  tableId: string;
  profile?: string;
  cliPath?: string;
  runner?: LarkCliRunner;
}

interface InventoryRecord {
  recordId: string;
  cardId: string;
  productKey: string;
  cardSecret: string;
  status: CardInventoryStatus;
  orderId: string;
  note: string;
}

const RESERVED_NOTE = 'reserved';
const SHIPPING_ATTEMPTED_NOTE = 'shipping-attempted';
const SHIPPED_CONFIRMED_NOTE = 'shipped-confirmed';
const DELIVERY_ATTEMPTED_NOTE = 'delivery-attempted';

function stageOf(note: string): CardInventoryStage | null {
  if (note === '' || note === RESERVED_NOTE) return 'reserved';
  if (note === SHIPPING_ATTEMPTED_NOTE || note === SHIPPED_CONFIRMED_NOTE || note === DELIVERY_ATTEMPTED_NOTE) {
    return note;
  }
  return null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createDefaultRunner(cliPath: string, profile: string): LarkCliRunner {
  return {
    async run(args) {
      try {
        const result = await execFileAsync(cliPath, ['--profile', profile, ...args], {
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return JSON.parse(result.stdout) as unknown;
      } catch {
        // 绝不拼接底层错误/stdout/stderr：查询响应可能包含卡密原文。
        throw new Error('card-inventory-cli-failed');
      }
    },
  };
}

function parseStatus(value: unknown): CardInventoryStatus | null {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized === 'available' ||
    normalized === 'reserved' ||
    normalized === 'sent' ||
    normalized === 'manual'
    ? normalized
    : null;
}

function parseRecords(payload: unknown): InventoryRecord[] | null {
  const root = objectOf(payload);
  const outerData = objectOf(root?.['data']);
  const rows = outerData?.['data'];
  const fields = outerData?.['fields'];
  const recordIds = outerData?.['record_id_list'];
  if (!root?.['ok'] || !Array.isArray(rows) || !Array.isArray(fields) || !Array.isArray(recordIds)) {
    return null;
  }
  const names = fields.every((field) => typeof field === 'string') ? (fields as string[]) : null;
  if (names === null || rows.length !== recordIds.length) return null;
  const index = (name: string): number => names.indexOf(name);
  const required = ['card_id', 'product_key', 'card_secret', 'status', 'order_id', 'note'];
  if (required.some((name) => index(name) < 0)) return null;
  const parsed: InventoryRecord[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const recordId = recordIds[rowIndex];
    if (!Array.isArray(row) || typeof recordId !== 'string') return null;
    const cardId = row[index('card_id')];
    const productKey = row[index('product_key')];
    const cardSecret = row[index('card_secret')];
    const status = parseStatus(row[index('status')]);
    const orderIdValue = row[index('order_id')];
    const noteValue = row[index('note')];
    if (
      typeof cardId !== 'string' ||
      typeof productKey !== 'string' ||
      typeof cardSecret !== 'string' ||
      cardSecret === '' ||
      status === null ||
      (orderIdValue !== null && typeof orderIdValue !== 'string') ||
      (noteValue !== null && typeof noteValue !== 'string')
    ) {
      return null;
    }
    parsed.push({
      recordId,
      cardId,
      productKey,
      cardSecret,
      status,
      orderId: typeof orderIdValue === 'string' ? orderIdValue : '',
      note: typeof noteValue === 'string' ? noteValue : '',
    });
  }
  return parsed;
}

export function createLarkBaseCardInventoryPort(
  options: LarkBaseCardInventoryOptions,
): CardInventoryPort {
  if (options.baseToken === '' || options.tableId === '') {
    throw new Error('飞书卡密库存坐标缺失');
  }
  const profile = options.profile ?? 'general';
  const runner = options.runner ?? createDefaultRunner(options.cliPath ?? 'lark-cli', profile);
  const common = [
    '--as',
    'user',
    '--base-token',
    options.baseToken,
    '--table-id',
    options.tableId,
  ];

  async function assertUserIdentity(): Promise<boolean> {
    try {
      const payload = objectOf(await runner.run(['whoami']));
      return payload?.['available'] === true && payload['identity'] === 'user';
    } catch {
      return false;
    }
  }

  async function list(filter: Record<string, unknown>, limit: number): Promise<InventoryRecord[] | null> {
    try {
      const payload = await runner.run([
        'base',
        '+record-list',
        ...common,
        '--field-id',
        'card_id',
        '--field-id',
        'product_key',
        '--field-id',
        'card_secret',
        '--field-id',
        'status',
        '--field-id',
        'order_id',
        '--field-id',
        'note',
        '--filter-json',
        JSON.stringify(filter),
        '--sort-json',
        JSON.stringify([{ field: 'card_id', desc: false }]),
        '--limit',
        String(limit),
        '--format',
        'json',
      ]);
      return parseRecords(payload);
    } catch {
      return null;
    }
  }

  async function patchRecord(recordId: string, patch: Record<string, unknown>): Promise<boolean> {
    if (!(await assertUserIdentity())) return false;
    try {
      const payload = objectOf(
        await runner.run([
          'base',
          '+record-batch-update',
          ...common,
          '--json',
          JSON.stringify({ record_id_list: [recordId], patch }),
          '--format',
          'json',
        ]),
      );
      return payload?.['ok'] === true;
    } catch {
      return false;
    }
  }

  async function byOrder(orderId: string): Promise<InventoryRecord[] | null> {
    return list({ logic: 'and', conditions: [['order_id', '==', orderId]] }, 2);
  }

  async function byCard(cardId: string): Promise<InventoryRecord[] | null> {
    return list({ logic: 'and', conditions: [['card_id', '==', cardId]] }, 2);
  }

  async function patchAndVerify(
    record: InventoryRecord,
    patch: Record<string, unknown>,
    expected: Partial<Pick<InventoryRecord, 'status' | 'orderId' | 'note'>>,
  ): Promise<boolean> {
    if (!(await patchRecord(record.recordId, patch))) return false;
    const records = await byCard(record.cardId);
    if (records === null || records.length !== 1 || records[0]?.recordId !== record.recordId) return false;
    const updated = records[0];
    return (
      (expected.status === undefined || updated.status === expected.status) &&
      (expected.orderId === undefined || updated.orderId === expected.orderId) &&
      (expected.note === undefined || updated.note === expected.note)
    );
  }

  async function productHasUncertainAttempt(productKey: string): Promise<boolean | null> {
    const manual = await list(
      { logic: 'and', conditions: [['product_key', '==', productKey], ['status', 'intersects', ['manual']]] },
      1,
    );
    if (manual === null) return null;
    if (manual.length > 0) return true;
    for (const note of [SHIPPING_ATTEMPTED_NOTE, DELIVERY_ATTEMPTED_NOTE]) {
      const attempted = await list(
        { logic: 'and', conditions: [['product_key', '==', productKey], ['note', '==', note]] },
        1,
      );
      if (attempted === null) return null;
      if (attempted.length > 0) return true;
    }
    return false;
  }

  let operation = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = operation.then(action, action);
    operation = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    reserve(input: ReserveCardInput): Promise<ReserveCardResult> {
      return serialized(async () => {
        const orderId = input.orderId.trim();
        const productKey = input.productKey.trim();
        if (orderId === '' || productKey === '') {
          return { ok: false, error: 'inventory-invalid-record' };
        }
        const existing = await byOrder(orderId);
        if (existing === null) return { ok: false, error: 'inventory-unavailable' };
        if (existing.length > 1) return { ok: false, error: 'inventory-ambiguous' };
        const prior = existing[0];
        if (prior !== undefined) {
          if (prior.productKey !== productKey || prior.status === 'available') {
            return { ok: false, error: 'inventory-invalid-record' };
          }
          if (prior.status !== 'reserved') {
            return { ok: true, cardId: prior.cardId, status: prior.status, reused: true };
          }
          const stage = stageOf(prior.note);
          if (stage === null) return { ok: false, error: 'inventory-invalid-record' };
          if (stage === 'shipping-attempted' || stage === 'delivery-attempted') {
            return { ok: false, error: 'inventory-paused' };
          }
          return {
            ok: true,
            cardId: prior.cardId,
            cardSecret: prior.cardSecret,
            status: prior.status,
            stage,
            reused: true,
          };
        }
        const paused = await productHasUncertainAttempt(productKey);
        if (paused === null) return { ok: false, error: 'inventory-unavailable' };
        if (paused) return { ok: false, error: 'inventory-paused' };
        const available = await list(
        {
          logic: 'and',
          conditions: [
            ['product_key', '==', productKey],
            ['status', 'intersects', ['available']],
          ],
        },
        2,
      );
        if (available === null) return { ok: false, error: 'inventory-unavailable' };
      if (available.length === 0) return { ok: false, error: 'inventory-empty' };
      const selected = available[0];
      if (selected === undefined || selected.orderId !== '' || selected.status !== 'available') {
        return { ok: false, error: 'inventory-invalid-record' };
      }
      if (!(await patchAndVerify(
        selected,
        { status: 'reserved', order_id: orderId, note: RESERVED_NOTE },
        { status: 'reserved', orderId, note: RESERVED_NOTE },
      ))) {
        return { ok: false, error: 'inventory-write-failed' };
      }
      return {
        ok: true,
        cardId: selected.cardId,
        cardSecret: selected.cardSecret,
        status: 'reserved',
        stage: 'reserved',
        reused: false,
      };
      });
    },

    beginShipment(input: BeginCardDeliveryInput): Promise<SettleCardResult> {
      return serialized(async () => {
        const cardId = input.cardId.trim();
        const orderId = input.orderId.trim();
        if (cardId === '' || orderId === '') return { ok: false, error: 'inventory-invalid-record' };
        const records = await byCard(cardId);
        if (records === null) return { ok: false, error: 'inventory-unavailable' };
        if (records.length !== 1) {
          return { ok: false, error: records.length === 0 ? 'inventory-invalid-record' : 'inventory-ambiguous' };
        }
        const record = records[0]!;
        if (record.orderId !== orderId || record.status !== 'reserved') {
          return { ok: false, error: 'inventory-invalid-record' };
        }
        if (record.note === SHIPPING_ATTEMPTED_NOTE) return { ok: true };
        if (stageOf(record.note) !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
        return (await patchAndVerify(
          record,
          { note: SHIPPING_ATTEMPTED_NOTE },
          { status: 'reserved', orderId, note: SHIPPING_ATTEMPTED_NOTE },
        )) ? { ok: true } : { ok: false, error: 'inventory-write-failed' };
      });
    },

    confirmShipment(input: ConfirmCardShipmentInput): Promise<SettleCardResult> {
      return serialized(async () => {
        const cardId = input.cardId.trim();
        const orderId = input.orderId.trim();
        if (cardId === '' || orderId === '') return { ok: false, error: 'inventory-invalid-record' };
        const records = await byCard(cardId);
        if (records === null) return { ok: false, error: 'inventory-unavailable' };
        if (records.length !== 1) return { ok: false, error: records.length === 0 ? 'inventory-invalid-record' : 'inventory-ambiguous' };
        const record = records[0]!;
        if (record.orderId !== orderId || record.status !== 'reserved') {
          return { ok: false, error: 'inventory-invalid-record' };
        }
        if (input.confirmed && record.note === SHIPPED_CONFIRMED_NOTE) return { ok: true };
        if (record.note !== SHIPPING_ATTEMPTED_NOTE) return { ok: false, error: 'inventory-invalid-record' };
        const status = input.confirmed ? 'reserved' : 'manual';
        const note = input.confirmed ? SHIPPED_CONFIRMED_NOTE : (input.note ?? 'shipping-unconfirmed');
        return (await patchAndVerify(record, { status, note }, { status, orderId, note }))
          ? { ok: true }
          : { ok: false, error: 'inventory-write-failed' };
      });
    },

    beginDelivery(input: BeginCardDeliveryInput): Promise<SettleCardResult> {
      return serialized(async () => {
        const cardId = input.cardId.trim();
        const orderId = input.orderId.trim();
        if (cardId === '' || orderId === '') return { ok: false, error: 'inventory-invalid-record' };
        const records = await byCard(cardId);
        if (records === null) return { ok: false, error: 'inventory-unavailable' };
        if (records.length !== 1) return { ok: false, error: records.length === 0 ? 'inventory-invalid-record' : 'inventory-ambiguous' };
        const record = records[0]!;
        if (record.orderId !== orderId || record.status !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
        if (record.note === DELIVERY_ATTEMPTED_NOTE) return { ok: true };
        if (record.note !== SHIPPED_CONFIRMED_NOTE) return { ok: false, error: 'inventory-invalid-record' };
        return (await patchAndVerify(
          record,
          { note: DELIVERY_ATTEMPTED_NOTE },
          { status: 'reserved', orderId, note: DELIVERY_ATTEMPTED_NOTE },
        )) ? { ok: true } : { ok: false, error: 'inventory-write-failed' };
      });
    },

    settle(input: SettleCardInput): Promise<SettleCardResult> {
      return serialized(async () => {
        const cardId = input.cardId.trim();
        const orderId = input.orderId.trim();
        const records = await byCard(cardId);
      if (records === null) return { ok: false, error: 'inventory-unavailable' };
      if (records.length !== 1) {
        return { ok: false, error: records.length === 0 ? 'inventory-invalid-record' : 'inventory-ambiguous' };
      }
      const record = records[0]!;
      if (record.orderId !== orderId || record.status === 'available') {
        return { ok: false, error: 'inventory-invalid-record' };
      }
      if (record.status === input.status) return { ok: true };
      if (record.status !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
      if (input.status === 'sent' && record.note !== DELIVERY_ATTEMPTED_NOTE) {
        return { ok: false, error: 'inventory-invalid-record' };
      }
      const patch: Record<string, unknown> = { status: input.status };
      const note = input.note ?? (input.status === 'sent' ? 'delivery-confirmed' : 'manual-review-required');
      patch['note'] = note;
      return (await patchAndVerify(record, patch, { status: input.status, orderId, note }))
        ? { ok: true }
        : { ok: false, error: 'inventory-write-failed' };
      });
    },
  };
}
