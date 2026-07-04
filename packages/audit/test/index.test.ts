import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createAuditPort } from '../src/index.js';
import type { AuditEvent } from '@zen-agent/contracts';

const schemaPath = new URL('../../contracts/schemas/audit-event.schema.json', import.meta.url).pathname;

function makeValidator() {
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
}

function baseEvent(): AuditEvent {
  return {
    eventId: 'evt-1',
    type: 'session-start',
    ts: '2026-07-04T00:00:00.000Z',
    sessionId: 's1',
    data: { clientKind: 'extension', iss: 'zen-agent-demo' },
  };
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
}

describe('createAuditPort（record-only 旁路 jsonl sink）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'za-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('record 写出合法 JSONL，可逐行 parse 且过 audit-event schema', () => {
    const sink = join(dir, 'events.jsonl');
    const audit = createAuditPort({ sinkPath: sink });
    audit.record(baseEvent());
    audit.record({
      eventId: 'evt-2',
      type: 'tool-execution',
      ts: '2026-07-04T00:00:01.000Z',
      sessionId: 's1',
      data: { toolCallId: 'tc1', toolId: 'order-list.cancel-order', execution: 'client', outcome: 'ok', nonce: 'n1' },
    });
    const validate = makeValidator();
    const lines = readLines(sink);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(validate(parsed)).toBe(true);
    }
  });

  it('多次 record 追加不覆盖', () => {
    const sink = join(dir, 'events.jsonl');
    const audit = createAuditPort({ sinkPath: sink });
    audit.record(baseEvent());
    audit.record(baseEvent());
    audit.record(baseEvent());
    expect(readLines(sink)).toHaveLength(3);
  });

  it('自动创建缺失的父目录', () => {
    const sink = join(dir, 'nested', 'deep', 'events.jsonl');
    const audit = createAuditPort({ sinkPath: sink });
    audit.record(baseEvent());
    expect(readLines(sink)).toHaveLength(1);
  });

  it('落盘前脱敏已知 secret 模式（defense-in-depth，C5 脱敏前置兜底）', () => {
    const sink = join(dir, 'events.jsonl');
    const audit = createAuditPort({ sinkPath: sink });
    // 运行时拼接构造 secret 样值（避免字面量入仓触发 za-secret-guard）；schema 结构上排除 secret，
    // 此处注入 reason 字段仅为验证审计的兜底脱敏。
    const fakeKey = ['sk', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-');
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'cGF5bG9hZA', 'c2ln'].join('.');
    audit.record({
      eventId: 'evt-x',
      type: 'tool-decision',
      ts: '2026-07-04T00:00:02.000Z',
      sessionId: 's1',
      data: {
        toolCallId: 'tc1',
        toolId: 'order-list.cancel-order',
        riskTier: 'hitl',
        verdict: 'deny',
        reason: `leak ${fakeKey} and Bearer ${fakeJwt}`,
      },
    });
    const line = readLines(sink)[0]!;
    expect(line).not.toContain(fakeKey);
    expect(line).not.toContain(fakeJwt);
    expect(line).toContain('[REDACTED]');
  });

  it('旁路铁律：sink 不可写（路径是目录）时 record 不抛、静默丢弃（故障不进控制流）', () => {
    const badSink = join(dir, 'as-dir');
    mkdirSync(badSink);
    const audit = createAuditPort({ sinkPath: badSink });
    expect(() => audit.record(baseEvent())).not.toThrow();
  });
});
