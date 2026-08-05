import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { UserOverlay } from '@zen-agent/contracts';
import { createFsUserConfigStore, UserConfigStoreError } from '../src/user-config-store.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function storeIn(): { dir: string; store: ReturnType<typeof createFsUserConfigStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'za-ucs-'));
  tmpDirs.push(dir);
  return { dir, store: createFsUserConfigStore({ dir }) };
}

const subject = { tenant: 'default', hostUserId: 'host-1001' };

function overlayOf(text: string): UserOverlay {
  return {
    schemaVersion: 1,
    subject,
    packs: {
      shop: {
        rules: [{ id: 'r-1', text, origin: 'manual', createdAt: '2026-08-05T00:00:00.000Z' }],
      },
    },
  };
}

describe('fs UserConfigStore（adr-014 §6 存储与故障语义）', () => {
  it('空态（文件不存在）revision 稳定：两次 read 同值且 overlay=null', async () => {
    const { store } = storeIn();
    const first = await store.read(subject);
    const second = await store.read(subject);
    expect(first.overlay).toBeNull();
    expect(first.revision).toBe(second.revision);
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('write 后 read 返回同 revision 与同 overlay（正常读写闭环）', async () => {
    const { store } = storeIn();
    const written = await store.write(subject, overlayOf('报价引用运费模板。'));
    const read = await store.read(subject);
    expect(read.revision).toBe(written.revision);
    expect(read.overlay).toEqual(overlayOf('报价引用运费模板。'));
    expect(read.stale).toBeUndefined();
  });

  it('文件损坏（坏 JSON）且有 lastGood → 返回缓存值 + stale 标注', async () => {
    const { dir, store } = storeIn();
    const written = await store.write(subject, overlayOf('缓存里的规则。'));
    const tenantDir = join(dir, readdirSync(dir)[0]!);
    const file = join(tenantDir, readdirSync(tenantDir)[0]!);
    writeFileSync(file, '{not-json', 'utf8');
    const read = await store.read(subject);
    expect(read.stale).toBe(true);
    expect(read.revision).toBe(written.revision);
    expect(read.overlay).toEqual(overlayOf('缓存里的规则。'));
  });

  it('文件损坏且无 lastGood → 抛类型化 read-failed（consumer 走拆分降级）', async () => {
    const { dir, store } = storeIn();
    await store.write(subject, overlayOf('x'));
    const tenantDir = join(dir, readdirSync(dir)[0]!);
    const file = join(tenantDir, readdirSync(tenantDir)[0]!);
    writeFileSync(file, '{not-json', 'utf8');
    const fresh = createFsUserConfigStore({ dir });
    await expect(fresh.read(subject)).rejects.toSatisfy(
      (error) => error instanceof UserConfigStoreError && error.code === 'read-failed',
    );
  });

  it('overlay 不过契约校验（schema 破坏）同走降级语义', async () => {
    const { dir, store } = storeIn();
    await store.write(subject, overlayOf('好的。'));
    const tenantDir = join(dir, readdirSync(dir)[0]!);
    const file = join(tenantDir, readdirSync(tenantDir)[0]!);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, subject, packs: { shop: { enabled: true } } }));
    const read = await store.read(subject);
    expect(read.stale).toBe(true);
  });

  it('subject 段确定性编码：含分隔符/点段/宽字符的 subject 可定位且不越出根目录', async () => {
    const { dir, store } = storeIn();
    const hostile = { tenant: '../escape', hostUserId: 'user@例子.com' };
    const written = await store.write(hostile, { schemaVersion: 1, subject: hostile, packs: {} });
    const read = await store.read(hostile);
    expect(read.revision).toBe(written.revision);
    const topLevel = readdirSync(dir);
    expect(topLevel.some((name) => name.includes('%2F') || name.includes('%2E'))).toBe(true);
    expect(topLevel.every((name) => !name.includes('/'))).toBe(true);
  });

  it('空 subject 段拒绝（invalid-subject，与存储故障解耦）', async () => {
    const { store } = storeIn();
    await expect(store.read({ tenant: '', hostUserId: 'x' })).rejects.toSatisfy(
      (error) => error instanceof UserConfigStoreError && error.code === 'invalid-subject',
    );
  });

  it('双 subject 隔离：A 的写入不影响 B 的空态', async () => {
    const { store } = storeIn();
    await store.write(subject, overlayOf('A 的规则。'));
    const other = await store.read({ tenant: 'default', hostUserId: 'host-2002' });
    expect(other.overlay).toBeNull();
  });

  it('大小写仅异的两 hostUserId 映射不同文件（消歧后缀），大小写不敏感文件系统上互不覆盖', async () => {
    const { dir, store } = storeIn();
    const upper = { tenant: 'default', hostUserId: 'Alice' };
    const lower = { tenant: 'default', hostUserId: 'alice' };
    await store.write(upper, { schemaVersion: 1, subject: upper, packs: {} });
    await store.write(lower, {
      schemaVersion: 1,
      subject: lower,
      packs: { shop: { rules: [{ id: 'r-lc', text: '小写用户的规则。', origin: 'manual', createdAt: '2026-08-05T00:00:00.000Z' }] } },
    });

    // 隔离语义：大写 subject 读回自身内容，不被小写 subject 的写入覆盖（新 store 实例绕过进程内缓存，直读文件）
    const fresh = createFsUserConfigStore({ dir });
    const upperRead = await fresh.read(upper);
    const lowerRead = await fresh.read(lower);
    expect(upperRead.overlay).toEqual({ schemaVersion: 1, subject: upper, packs: {} });
    expect(lowerRead.overlay?.subject).toEqual(lower);

    // 消歧后缀语义：编码段追加 '-' + sha256(原值) 前 8 hex——两文件名忽略大小写后仍互异
    const tenantDir = join(dir, readdirSync(dir)[0]!);
    const files = readdirSync(tenantDir);
    expect(files).toHaveLength(2);
    for (const name of files) {
      expect(name).toMatch(/-[0-9a-f]{8}\.json$/);
    }
    expect(new Set(files.map((name) => name.toLowerCase())).size).toBe(2);
  });
});
