import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CardInventoryPort,
  CardInventoryStatus,
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
  const required = ['card_id', 'product_key', 'card_secret', 'status', 'order_id'];
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
    if (
      typeof cardId !== 'string' ||
      typeof productKey !== 'string' ||
      typeof cardSecret !== 'string' ||
      cardSecret === '' ||
      status === null ||
      (orderIdValue !== null && typeof orderIdValue !== 'string')
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

  return {
    async reserve(input: ReserveCardInput): Promise<ReserveCardResult> {
      if (input.orderId.trim() === '' || input.productKey.trim() === '') {
        return { ok: false, error: 'inventory-invalid-record' };
      }
      const existing = await byOrder(input.orderId);
      if (existing === null) return { ok: false, error: 'inventory-unavailable' };
      if (existing.length > 1) return { ok: false, error: 'inventory-ambiguous' };
      const prior = existing[0];
      if (prior !== undefined) {
        if (prior.productKey !== input.productKey || prior.status === 'available') {
          return { ok: false, error: 'inventory-invalid-record' };
        }
        return {
          ok: true,
          cardId: prior.cardId,
          cardSecret: prior.cardSecret,
          status: prior.status,
          reused: true,
        };
      }
      const available = await list(
        {
          logic: 'and',
          conditions: [
            ['product_key', '==', input.productKey],
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
      if (!(await patchRecord(selected.recordId, { status: 'reserved', order_id: input.orderId }))) {
        return { ok: false, error: 'inventory-write-failed' };
      }
      return {
        ok: true,
        cardId: selected.cardId,
        cardSecret: selected.cardSecret,
        status: 'reserved',
        reused: false,
      };
    },

    async settle(input: SettleCardInput): Promise<SettleCardResult> {
      const records = await byCard(input.cardId);
      if (records === null) return { ok: false, error: 'inventory-unavailable' };
      if (records.length !== 1) {
        return { ok: false, error: records.length === 0 ? 'inventory-invalid-record' : 'inventory-ambiguous' };
      }
      const record = records[0]!;
      if (record.orderId !== input.orderId || record.status === 'available') {
        return { ok: false, error: 'inventory-invalid-record' };
      }
      if (record.status === input.status) return { ok: true };
      if (record.status !== 'reserved') return { ok: false, error: 'inventory-invalid-record' };
      const patch: Record<string, unknown> = { status: input.status };
      if (input.note !== undefined) patch['note'] = input.note;
      return (await patchRecord(record.recordId, patch))
        ? { ok: true }
        : { ok: false, error: 'inventory-write-failed' };
    },
  };
}
