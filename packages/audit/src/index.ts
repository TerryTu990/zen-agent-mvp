import type { AuditPort } from '@zen-agent/contracts';

export interface AuditOptions {
  /** 事件落点（MVP：`.za/events.jsonl`）；schema 独立于 sink（U6），换落点不换事件结构。 */
  sinkPath: string;
}

export function createAuditPort(options: AuditOptions): AuditPort {
  void options;
  // record 旁路契约禁抛异常（C6），静默 no-op 会伪装成已实现，故骨架在工厂处如实失败。
  throw new Error(
    'NOT_IMPLEMENTED: M4 审计+评测门——record-only 旁路 sink（脱敏落盘 jsonl，故障不进控制流）',
  );
}
