import { describe, expect, it } from 'vitest';
import { createAuditPort } from '../src/index.js';

describe('createAuditPort', () => {
  it('工厂签名存在，骨架期构造即如实抛 NOT_IMPLEMENTED', () => {
    expect(typeof createAuditPort).toBe('function');
    expect(() => createAuditPort({ sinkPath: '.za/events.jsonl' })).toThrow(/^NOT_IMPLEMENTED/);
  });
});
