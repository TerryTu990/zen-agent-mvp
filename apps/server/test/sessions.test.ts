import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityClaims } from '@zen-agent/contracts';
import {
  createMemorySessionStore,
  createPersistentSessionStore,
  type PersistentSessionStore,
} from '../src/sessions.js';

const CLAIMS: IdentityClaims = {
  sub: 'user-1',
  tenant: 'demo-tenant',
  roles: ['ops'],
  hostUserId: 'host-u1',
  iss: 'zen-agent-demo',
  exp: Math.floor(Date.now() / 1000) + 300,
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'za-sessions-'));
}

const opened: PersistentSessionStore[] = [];
function persistent(dir: string, opts: { ttlMs?: number; now?: () => number } = {}) {
  const store = createPersistentSessionStore(createMemorySessionStore(), { dir, ...opts });
  opened.push(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.stop();
  vi.restoreAllMocks();
});

describe('createPersistentSessionStore（P2 会话持久化）', () => {
  it('messageId 原型键仍按普通幂等键处理', () => {
    const store = createMemorySessionStore();
    const { sessionId } = store.create(CLAIMS);
    for (const messageId of ['constructor', '__proto__']) {
      expect(store.reserveMessageTurn(sessionId, messageId)).toBe('reserved');
      expect(store.reserveMessageTurn(sessionId, messageId)).toBe('pending');
    }
  });

  it('重放恢复：新实例（模拟重启）从落盘文件重建会话历史/URL/claims', () => {
    const dir = freshDir();
    const first = persistent(dir);
    const { sessionId } = first.create(CLAIMS);
    first.setContext(sessionId, 'https://codeflow.asia/console/log');
    first.setHistory(sessionId, [
      { role: 'user', content: '建一个 key' },
      { role: 'assistant', content: '好的' },
    ]);

    // 模拟进程重启：新内存 store + 新装饰器指向同一目录，内存 miss → 重放。
    const revived = persistent(dir);
    const restored = revived.get(sessionId);
    expect(restored).toBeDefined();
    expect(restored!.ownerSub).toBe(CLAIMS.sub);
    expect(restored!.currentUrl).toBe('https://codeflow.asia/console/log');
    expect(restored!.history).toEqual([
      { role: 'user', content: '建一个 key' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(restored!.claims.hostUserId).toBe('host-u1');
  });

  it('重放恢复消息幂等状态，服务重启后相同 messageId 不会重复执行', () => {
    const dir = freshDir();
    const first = persistent(dir);
    const { sessionId } = first.create(CLAIMS);
    expect(first.reserveMessageTurn(sessionId, 'message-1')).toBe('reserved');
    first.setMessageTurn(sessionId, 'message-2', 'complete');

    const revived = persistent(dir);
    expect(revived.get(sessionId)?.messageTurns).toEqual({
      'message-1': 'pending',
      'message-2': 'complete',
    });

    revived.setMessageTurn(sessionId, 'message-1', null);
    const restartedAgain = persistent(dir);
    expect(restartedAgain.get(sessionId)?.messageTurns).toEqual({ 'message-2': 'complete' });
  });

  it('落盘不含 JWT 原文/secret（只含已解析 claims 与对话）', () => {
    const dir = freshDir();
    const store = persistent(dir);
    const { sessionId } = store.create(CLAIMS);
    store.setHistory(sessionId, [{ role: 'user', content: 'hi' }]);
    const raw = readFileSync(join(dir, `${sessionId}.jsonl`), 'utf8');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('eyJ'); // JWT 头惯用前缀
    expect(raw).toContain('host-u1');
  });

  it('TTL 过期清理：闲置超时后逐出内存项与落盘文件', () => {
    const dir = freshDir();
    let clock = 1_000_000;
    const store = persistent(dir, { ttlMs: 1000, now: () => clock });
    const { sessionId } = store.create(CLAIMS);
    expect(existsSync(join(dir, `${sessionId}.jsonl`))).toBe(true);

    clock += 1500; // 超过 ttl
    store.sweep();
    // 内存已逐出且文件已删 → get 无可重放，返回 undefined
    expect(store.get(sessionId)).toBeUndefined();
    expect(existsSync(join(dir, `${sessionId}.jsonl`))).toBe(false);
  });

  it('TTL 未到：活跃会话不被清理', () => {
    const dir = freshDir();
    let clock = 1_000_000;
    const store = persistent(dir, { ttlMs: 5000, now: () => clock });
    const { sessionId } = store.create(CLAIMS);
    clock += 1000;
    store.sweep();
    expect(store.get(sessionId)).toBeDefined();
  });

  it('fail-open：落盘目标不可写时会话仍走内存态、不抛、仅告警一次', () => {
    const base = freshDir();
    // 把「目录」路径占为一个文件 → mkdir/append 必失败。
    const asFile = join(base, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = persistent(asFile);
    const { sessionId } = store.create(CLAIMS);
    // 内存态未受影响：仍可读会话、追加历史。
    expect(store.get(sessionId)).toBeDefined();
    expect(() =>
      store.setHistory(sessionId, [{ role: 'user', content: 'still works' }]),
    ).not.toThrow();
    expect(store.get(sessionId)!.history).toEqual([{ role: 'user', content: 'still works' }]);
    expect(store.reserveMessageTurn(sessionId, 'unsafe-message')).toBe('storage-failed');
    expect(store.get(sessionId)!.messageTurns).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('refreshClaims 相同 claims 不重复落盘（避免每请求膨胀）', () => {
    const dir = freshDir();
    const store = persistent(dir);
    const { sessionId } = store.create(CLAIMS);
    const file = join(dir, `${sessionId}.jsonl`);
    const linesBefore = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    store.refreshClaims(sessionId, { ...CLAIMS });
    store.refreshClaims(sessionId, { ...CLAIMS });
    const linesAfter = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    expect(linesAfter).toBe(linesBefore);
  });

  it('ADR-013：per-origin claims 与 lastPackId 重放恢复；相同值不重复落盘', () => {
    const dir = freshDir();
    const first = persistent(dir);
    const { sessionId } = first.create(CLAIMS);
    const file = join(dir, `${sessionId}.jsonl`);
    first.setOriginClaims(sessionId, 'https://codeflow.asia', CLAIMS);
    first.setLastPackId(sessionId, 'codeflow-console');
    const linesAfter1 = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    // 相同 origin claims / 相同 packId 再写入不落盘。
    first.setOriginClaims(sessionId, 'https://codeflow.asia', { ...CLAIMS });
    first.setLastPackId(sessionId, 'codeflow-console');
    const linesAfter2 = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    expect(linesAfter2).toBe(linesAfter1);

    const revived = persistent(dir);
    const restored = revived.get(sessionId);
    expect(restored!.claimsByOrigin['https://codeflow.asia']?.hostUserId).toBe('host-u1');
    expect(restored!.lastPackId).toBe('codeflow-console');
  });

  it('generic 绑定 origin：同 packId+origin 不重复落盘，origin 变化落盘并重放恢复', () => {
    const dir = freshDir();
    const first = persistent(dir);
    const { sessionId } = first.create(CLAIMS);
    const file = join(dir, `${sessionId}.jsonl`);
    first.setLastPackId(sessionId, 'generic-web', 'https://a.example');
    const linesAfter1 = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    first.setLastPackId(sessionId, 'generic-web', 'https://a.example');
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).length).toBe(linesAfter1);
    // packId 不变、origin 变化 → 视为变更落盘（边界标记判据含 origin）。
    first.setLastPackId(sessionId, 'generic-web', 'https://b.example');
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).length).toBe(linesAfter1 + 1);

    const revived = persistent(dir);
    const restored = revived.get(sessionId);
    expect(restored!.lastPackId).toBe('generic-web');
    expect(restored!.lastGenericOrigin).toBe('https://b.example');
  });
});
