/**
 * 投递记录（求职 agent 业务日志）：按天写 `<dir>/<YYYY-MM-DD>.jsonl`，供事后回溯"今天投了哪些公司、
 * JD 摘要、模型为何判可投"。与审计取证流（.za/events.jsonl）分立——审计 record-only 不收工具 params，
 * 业务记录需保留 company/reason 等字段，故独立落点（U6：事件 schema 与落点解耦，业务日志亦不进审计控制流）。
 *
 * 治理边界：写入 record-only 旁路——落盘失败仅本地记错、不抛、不阻断打招呼主流程（fail-open）。
 * 日期由服务端生成或经严格正则校验，路径以固定目录 + 单段日期文件名拼接，无用户可控路径片段（防穿越）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 一条投递记录的业务字段（record_application 工具入参投影）。 */
export interface ApplicationRecord {
  company: string;
  position: string;
  jdDigest?: string;
  score?: string;
  replyOdds?: string;
  reason?: string;
  decision?: string;
}

/** 服务端当天日期 `YYYY-MM-DD`（UTC 切片，稳定可比较）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 追加一条投递记录到当天文件。record-only 旁路：任何 IO 失败只返回 ok:false 供调用方回喂，绝不抛。
 * @returns 落盘结果与当天日期；失败时 ok=false 且带简短原因（不含敏感值）。
 */
export function recordApplication(
  dir: string,
  record: ApplicationRecord,
): { ok: boolean; date: string; error?: string } {
  const date = today();
  try {
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    appendFileSync(join(dir, `${date}.jsonl`), line);
    return { ok: true, date };
  } catch (err) {
    // fail-open：业务日志故障不进控制流，不影响打招呼；仅本地记错。
    console.error('[applications] 记录写入失败（不影响主流程）：', (err as Error).message);
    return { ok: false, date, error: '记录写入失败' };
  }
}

/**
 * 读取并汇总某天的投递记录。date 缺省=今天；给定值必须匹配 `YYYY-MM-DD`，否则拒（防路径穿越）。
 * 文件不存在按"当天无记录"处理（items 空），不视为错误。
 */
export function listApplications(
  dir: string,
  date?: string,
): { ok: boolean; date: string; count: number; items: ApplicationRecord[]; error?: string } {
  const day = date ?? today();
  if (!DATE_RE.test(day)) {
    return { ok: false, date: day, count: 0, items: [], error: '日期格式非法（须 YYYY-MM-DD）' };
  }
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${day}.jsonl`), 'utf8');
  } catch {
    return { ok: true, date: day, count: 0, items: [] };
  }
  const items: ApplicationRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      items.push(JSON.parse(trimmed) as ApplicationRecord);
    } catch {
      // 跳过损坏行，不因单行坏数据整体失败。
    }
  }
  return { ok: true, date: day, count: items.length, items };
}
