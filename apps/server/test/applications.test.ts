import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listApplications, recordApplication, today } from '../src/applications.js';
import { createFsUserConfigStore } from '../src/user-config-store.js';

const SUBJECT = { tenant: 'demo-tenant', hostUserId: 'host-u1' };
const OTHER_SUBJECT = { tenant: 'demo-tenant', hostUserId: 'host-u2' };

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'za-apps-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('applications 业务日志（record/list 往返 + fail-open + 路径安全）', () => {
  it('record 写当天文件、list 读回同一条', () => {
    const dir = tmp();
    const r = recordApplication(dir, SUBJECT, {
      company: '某银行科技',
      position: 'AI工程师',
      score: '高',
      replyOdds: '中',
      reason: '金融AI+低代码强命中',
      decision: '自动greet',
    });
    expect(r.ok).toBe(true);
    expect(r.date).toBe(today());

    const list = listApplications(dir, SUBJECT);
    expect(list.ok).toBe(true);
    expect(list.count).toBe(1);
    expect(list.items[0]?.company).toBe('某银行科技');
    expect(list.items[0]?.decision).toBe('自动greet');
  });

  it('多次 record 累加到同一天文件', () => {
    const dir = tmp();
    recordApplication(dir, SUBJECT, { company: 'A', position: 'p1' });
    recordApplication(dir, SUBJECT, { company: 'B', position: 'p2' });
    const list = listApplications(dir, SUBJECT);
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.company)).toEqual(['A', 'B']);
  });

  it('list 未知日期（文件不存在）→ 空汇总、非错误', () => {
    const dir = tmp();
    const list = listApplications(dir, SUBJECT, '2020-01-01');
    expect(list.ok).toBe(true);
    expect(list.count).toBe(0);
    expect(list.items).toEqual([]);
  });

  it('list 非法日期格式 → 拒绝（防路径穿越）', () => {
    const dir = tmp();
    for (const bad of ['../../etc/passwd', '2020-1-1', 'today', '2020-01-01/../x']) {
      const list = listApplications(dir, SUBJECT, bad);
      expect(list.ok).toBe(false);
      expect(list.count).toBe(0);
    }
  });

  it('损坏行被跳过、不影响其余记录解析', () => {
    const dir = tmp();
    recordApplication(dir, SUBJECT, { company: 'ok1', position: 'p' });
    writeFileSync(join(dir, jsonlPathOf(dir)), '{坏行不是JSON\n', { flag: 'a' });
    recordApplication(dir, SUBJECT, { company: 'ok2', position: 'p' });
    const list = listApplications(dir, SUBJECT);
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.company)).toEqual(['ok1', 'ok2']);
  });

  it('record 写入失败 fail-open：返回 ok:false 不抛', () => {
    // 指向一个"已被占用为文件"的父路径，使 mkdir/append 失败但不抛出。
    const dir = tmp();
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const r = recordApplication(join(filePath, 'sub'), SUBJECT, { company: 'X', position: 'p' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});


/** 分账落点（`<dir>/<tenant 段>/<user 段>/<date>.jsonl`）的单一 jsonl 相对路径。 */
function jsonlPathOf(dir: string): string {
  const hit = readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.jsonl'));
  expect(hit).toHaveLength(1);
  return hit[0]!;
}

describe('applications 按 subject 分账（A-SEC-01 跨用户串号）', () => {
  it('异 subject 读不到他人当天记录（隔离）', () => {
    const dir = tmp();
    recordApplication(dir, SUBJECT, { company: '甲公司', position: 'p1' });
    expect(listApplications(dir, SUBJECT).count).toBe(1);
    const other = listApplications(dir, OTHER_SUBJECT);
    expect(other.ok).toBe(true);
    expect(other.count).toBe(0);
    expect(other.items).toEqual([]);
    expect(JSON.stringify(other)).not.toContain('甲公司');
  });

  it('同 tenant 异 hostUserId、异 tenant 同 hostUserId 均各自独立落点', () => {
    const dir = tmp();
    recordApplication(dir, SUBJECT, { company: 'A', position: 'p' });
    recordApplication(dir, OTHER_SUBJECT, { company: 'B', position: 'p' });
    recordApplication(dir, { tenant: 'other-tenant', hostUserId: 'host-u1' }, { company: 'C', position: 'p' });
    expect(listApplications(dir, SUBJECT).items.map((i) => i.company)).toEqual(['A']);
    expect(listApplications(dir, OTHER_SUBJECT).items.map((i) => i.company)).toEqual(['B']);
    expect(
      listApplications(dir, { tenant: 'other-tenant', hostUserId: 'host-u1' }).items.map((i) => i.company),
    ).toEqual(['C']);
  });

  it('subject 含路径分隔符/点段/通配 → 编码后不穿越目录，且与相邻取值不同名', () => {
    const dir = tmp();
    const evil = { tenant: '../..', hostUserId: 'a/../../b' };
    expect(recordApplication(dir, evil, { company: '越权', position: 'p' }).ok).toBe(true);
    const files = readdirSync(dir, { recursive: true }).map((entry) => String(entry));
    expect(files.some((entry) => entry.endsWith('.jsonl'))).toBe(true);
    for (const entry of files) {
      // 穿越面判据是"路径段不是 . / ..、落点仍在 dir 之内"，而非"段内不出现两个点"
      // （`../..` 编码为单段 `..%2F..-<hash>`，是合法且不穿越的目录名）。
      expect(entry.split(sep).every((segment) => segment !== '..' && segment !== '.')).toBe(true);
      expect(resolve(dir, entry).startsWith(resolve(dir) + sep)).toBe(true);
    }
    // 穿越取值只落在自己的编码段内，不与任何其它 subject 混读。
    expect(listApplications(dir, SUBJECT).count).toBe(0);
    expect(listApplications(dir, evil).count).toBe(1);
  });

  it('大小写仅差的 subject 不落同一路径（消歧尾缀）', () => {
    const dir = tmp();
    recordApplication(dir, { tenant: 't', hostUserId: 'User' }, { company: 'U', position: 'p' });
    expect(listApplications(dir, { tenant: 't', hostUserId: 'user' }).count).toBe(0);
  });

  it('分账段编码与 L2 overlay 存储（user-config-store）口径对拍一致', async () => {
    const overlayDir = tmp();
    const appsDir = tmp();
    const subject = { tenant: 'tenant/需要编码 *', hostUserId: 'user+name@example.com' };
    await createFsUserConfigStore({ dir: overlayDir }).write(subject, { version: 1, packs: {} });
    const [overlayTenantSeg] = readdirSync(overlayDir);
    const [overlayUserFile] = readdirSync(join(overlayDir, overlayTenantSeg!));

    recordApplication(appsDir, subject, { company: 'X', position: 'p' });
    const [appsTenantSeg] = readdirSync(appsDir);
    const [appsUserSeg] = readdirSync(join(appsDir, appsTenantSeg!));

    expect(appsTenantSeg).toBe(overlayTenantSeg);
    expect(`${appsUserSeg}.json`).toBe(overlayUserFile);
  });
});
