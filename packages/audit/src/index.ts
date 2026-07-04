import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, AuditPort } from '@zen-agent/contracts';

export interface AuditOptions {
  /** 事件落点（MVP：`.za/events.jsonl`）；schema 独立于 sink（U6），换落点不换事件结构。 */
  sinkPath: string;
}

/**
 * 落盘前兜底脱敏（C5 脱敏前置的 defense-in-depth）：生产方已按 schema 排除 secret，
 * 审计仍对已知 secret 模式做一次替换，杜绝任何路径把凭证值写进 `.za/events.jsonl`（SEC-01）。
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

function redact(line: string): string {
  let scrubbed = line;
  for (const pattern of SECRET_PATTERNS) scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  return scrubbed;
}

/**
 * record-only 旁路 sink：把审计事件按行追加为 JSONL。
 * 旁路铁律（C6/U6）：record 内部吞掉一切异常、只本地告警，任何审计故障 MUST NOT 进控制流。
 */
export function createAuditPort(options: AuditOptions): AuditPort {
  const { sinkPath } = options;
  let dirEnsured = false;
  return {
    record(event: AuditEvent): void {
      try {
        if (!dirEnsured) {
          mkdirSync(dirname(sinkPath), { recursive: true });
          dirEnsured = true;
        }
        appendFileSync(sinkPath, `${redact(JSON.stringify(event))}\n`, 'utf8');
      } catch (cause) {
        // 审计失败绝不拖垮会话：只在本地告警、丢弃该事件（故障不进控制流）。
        console.error(`[audit] 事件落盘失败（已丢弃，不影响会话）：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  };
}
