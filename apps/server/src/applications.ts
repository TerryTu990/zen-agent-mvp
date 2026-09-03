/**
 * 投递记录（求职 agent 业务日志）：按 subject + 天写 `<dir>/<tenant 段>/<hostUserId 段>/<YYYY-MM-DD>.jsonl`，
 * 供事后回溯"今天投了哪些公司、JD 摘要、模型为何判可投"。与审计取证流（.za/events.jsonl）分立——
 * 审计 record-only 不收工具 params，业务记录需保留 company/reason 等字段，故独立落点
 * （U6：事件 schema 与落点解耦，业务日志亦不进审计控制流）。
 *
 * 治理边界：按 subject 分账，一个用户的记录读写不可达他人落点（跨用户串号面为零）；
 * 写入 record-only 旁路——落盘失败仅本地记错、不抛、不阻断打招呼主流程（fail-open）。
 * 路径由固定目录 + 确定性编码的 subject 段 + 单段日期文件名拼接，无用户可控原文片段（防穿越）。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfigSubject } from '@zen-agent/contracts';

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

/**
 * subject 段 → 文件系统段：与 L2 overlay 存储（user-config-store）同一 percent-encode + sha256 消歧口径，
 * 使同一 subject 在两处落点定位一致（applications.test 对拍守卫）；分隔符/点段/任意字符集均被编码，
 * 结构上无穿越面。尾缀 sha256 前 8 hex 做大小写消歧：大小写不敏感文件系统上仅大小写有异的两 subject 不落同一路径。
 */
function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value)
    .replace(/\*/g, '%2A')
    .replace(/^\.+$/, (dots) => dots.replace(/\./g, '%2E'));
  return `${encoded}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** subject 的记录目录：分账落点，读写共用同一函数（两处口径不得各自实现）。 */
function subjectDir(dir: string, subject: UserConfigSubject): string {
  return join(dir, encodeSegment(subject.tenant), encodeSegment(subject.hostUserId));
}

/** 服务端当天日期 `YYYY-MM-DD`（UTC 切片，稳定可比较）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 追加一条投递记录到该 subject 当天的文件。record-only 旁路：任何 IO 失败只返回 ok:false 供调用方回喂，绝不抛。
 * @returns 落盘结果与当天日期；失败时 ok=false 且带简短原因（不含敏感值）。
 */
export function recordApplication(
  dir: string,
  subject: UserConfigSubject,
  record: ApplicationRecord,
): { ok: boolean; date: string; error?: string } {
  const date = today();
  const target = subjectDir(dir, subject);
  try {
    mkdirSync(target, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    appendFileSync(join(target, `${date}.jsonl`), line);
    return { ok: true, date };
  } catch (err) {
    // fail-open：业务日志故障不进控制流，不影响打招呼；仅本地记错。
    console.error('[applications] 记录写入失败（不影响主流程）：', (err as Error).message);
    return { ok: false, date, error: '记录写入失败' };
  }
}

/**
 * 读取并汇总该 subject 某天的投递记录。date 缺省=今天；给定值必须匹配 `YYYY-MM-DD`，否则拒（防路径穿越）。
 * 文件不存在按"当天无记录"处理（items 空），不视为错误——他人落点对本 subject 恒为"无记录"。
 */
export function listApplications(
  dir: string,
  subject: UserConfigSubject,
  date?: string,
): { ok: boolean; date: string; count: number; items: ApplicationRecord[]; error?: string } {
  const day = date ?? today();
  if (!DATE_RE.test(day)) {
    return { ok: false, date: day, count: 0, items: [], error: '日期格式非法（须 YYYY-MM-DD）' };
  }
  let raw: string;
  try {
    raw = readFileSync(join(subjectDir(dir, subject), `${day}.jsonl`), 'utf8');
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
