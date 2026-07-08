import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listApplications, recordApplication, today } from '../src/applications.js';

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
    const r = recordApplication(dir, {
      company: '某银行科技',
      position: 'AI工程师',
      score: '高',
      replyOdds: '中',
      reason: '金融AI+低代码强命中',
      decision: '自动greet',
    });
    expect(r.ok).toBe(true);
    expect(r.date).toBe(today());

    const list = listApplications(dir);
    expect(list.ok).toBe(true);
    expect(list.count).toBe(1);
    expect(list.items[0]?.company).toBe('某银行科技');
    expect(list.items[0]?.decision).toBe('自动greet');
  });

  it('多次 record 累加到同一天文件', () => {
    const dir = tmp();
    recordApplication(dir, { company: 'A', position: 'p1' });
    recordApplication(dir, { company: 'B', position: 'p2' });
    const list = listApplications(dir);
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.company)).toEqual(['A', 'B']);
  });

  it('list 未知日期（文件不存在）→ 空汇总、非错误', () => {
    const dir = tmp();
    const list = listApplications(dir, '2020-01-01');
    expect(list.ok).toBe(true);
    expect(list.count).toBe(0);
    expect(list.items).toEqual([]);
  });

  it('list 非法日期格式 → 拒绝（防路径穿越）', () => {
    const dir = tmp();
    for (const bad of ['../../etc/passwd', '2020-1-1', 'today', '2020-01-01/../x']) {
      const list = listApplications(dir, bad);
      expect(list.ok).toBe(false);
      expect(list.count).toBe(0);
    }
  });

  it('损坏行被跳过、不影响其余记录解析', () => {
    const dir = tmp();
    recordApplication(dir, { company: 'ok1', position: 'p' });
    writeFileSync(join(dir, `${today()}.jsonl`), '{坏行不是JSON\n', { flag: 'a' });
    recordApplication(dir, { company: 'ok2', position: 'p' });
    const list = listApplications(dir);
    expect(list.count).toBe(2);
    expect(list.items.map((i) => i.company)).toEqual(['ok1', 'ok2']);
  });

  it('record 写入失败 fail-open：返回 ok:false 不抛', () => {
    // 指向一个"已被占用为文件"的父路径，使 mkdir/append 失败但不抛出。
    const dir = tmp();
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const r = recordApplication(join(filePath, 'sub'), { company: 'X', position: 'p' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});
