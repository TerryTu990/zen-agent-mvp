/**
 * L2 用户覆盖层存储的文件系统实现（adr-014，UserConfigStore 端口的 MVP 后端）：
 * 布局 `<dir>/<tenant 编码段>/<hostUserId 编码段>.json`（percent-encode 确定性映射，
 * 任意字符集 subject 均可定位、结构上无穿越面）；revision = sha256(文件字节) 的 hex，
 * 空态（文件不存在）恒为 sha256('null')——revision 稳定可互证（R4）。
 * 读失败（IO/解析/契约校验不过）时：有 lastGood → 返回缓存值 + stale 标注；
 * 无 lastGood → 抛类型化错误，由 compose 承担 fail-open-closed 拆分降级（U7）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateUserOverlay } from '@zen-agent/contracts';
import type {
  UserConfigReadResult,
  UserConfigStore,
  UserConfigSubject,
  UserConfigWriteResult,
  UserOverlay,
} from '@zen-agent/contracts';

/**
 * subject 段 → 文件系统段的确定性编码：percent-encode 使分隔符/点段/任意字符集（如 email 形
 * hostUserId）均可安全映射——invalid-subject 与存储故障因此解耦，字符集不与 C2 契约耦合。
 * 空段仍拒绝（无法定位）。尾缀 '-' + sha256(原值) 前 8 hex 做大小写消歧：大小写不敏感文件系统
 * 上仅大小写有异的两 subject 不落同一路径、互不覆盖。
 */
function encodeSegment(value: string): string {
  if (value.length === 0 || value.length > 512) {
    throw new UserConfigStoreError('invalid-subject', 'subject 路径段为空或超长');
  }
  const encoded = encodeURIComponent(value).replace(/\*/g, '%2A').replace(/^\.+$/, (dots) =>
    dots.replace(/\./g, '%2E'),
  );
  return `${encoded}-${sha256Hex(value).slice(0, 8)}`;
}

export type UserConfigStoreErrorCode = 'invalid-subject' | 'read-failed' | 'write-failed';

export class UserConfigStoreError extends Error {
  constructor(
    readonly code: UserConfigStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserConfigStoreError';
  }
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 旧布局（无 -8hex 消歧尾缀）文件检测：当前布局不定位此类文件（读作空态），存量将被静默弃置——
 * 启动时一次性警示留人工处置线索。无发布存量（消歧尾缀早于任何启用 L2 的发布），仅护开发/演示机。
 */
function warnLegacyLayoutOnce(dir: string): void {
  try {
    const legacy: string[] = [];
    for (const tenant of readdirSync(dir, { withFileTypes: true })) {
      if (!tenant.isDirectory()) continue;
      for (const file of readdirSync(join(dir, tenant.name))) {
        if (file.endsWith('.json') && !/-[0-9a-f]{8}\.json$/.test(file)) {
          legacy.push(join(tenant.name, file));
        }
      }
    }
    if (legacy.length > 0) {
      console.warn(
        `[user-config] 检测到 ${legacy.length} 个旧布局 overlay 文件（无消歧尾缀，不会被读取）：${legacy.slice(0, 5).join(', ')}${legacy.length > 5 ? ' …' : ''}`,
      );
    }
  } catch {
    // 目录不存在/不可读：首次启动的正常形态，不警示。
  }
}

const EMPTY_REVISION = sha256Hex('null');

export interface FsUserConfigStoreOptions {
  /** 存储根目录（MVP：`.za/user-config`）。 */
  dir: string;
}

export function createFsUserConfigStore(options: FsUserConfigStoreOptions): UserConfigStore {
  // 每 subject 最近一次成功读取（进程内）：读失败时的 stale 降级来源。
  const lastGood = new Map<string, UserConfigReadResult>();
  warnLegacyLayoutOnce(options.dir);

  const locate = (subject: UserConfigSubject): { key: string; dir: string; path: string } => {
    const tenantSeg = encodeSegment(subject.tenant);
    const userSeg = encodeSegment(subject.hostUserId);
    const dir = join(options.dir, tenantSeg);
    return {
      key: `${subject.tenant}\n${subject.hostUserId}`,
      dir,
      path: join(dir, `${userSeg}.json`),
    };
  };

  const degrade = (key: string, detail: string): UserConfigReadResult => {
    const cached = lastGood.get(key);
    if (cached !== undefined) {
      return { overlay: structuredClone(cached.overlay), revision: cached.revision, stale: true };
    }
    throw new UserConfigStoreError('read-failed', `L2 overlay 读取失败（${detail}，无可用缓存）`);
  };

  const remember = (key: string, overlay: UserOverlay | null, revision: string): void => {
    lastGood.set(key, { overlay: structuredClone(overlay), revision });
  };

  return {
    async read(subject: UserConfigSubject): Promise<UserConfigReadResult> {
      const { key, path } = locate(subject);
      let raw: Buffer;
      try {
        raw = readFileSync(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          remember(key, null, EMPTY_REVISION);
          return { overlay: null, revision: EMPTY_REVISION };
        }
        return degrade(key, 'IO 读取失败');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return degrade(key, 'JSON 解析失败');
      }
      const validated = validateUserOverlay(parsed);
      if (!validated.ok) {
        // 规模上界（条目数/作用域数）是写入期约束：早于该约束写下的存量 overlay 结构仍合法，
        // 读路径放行并告警，避免用户配置因契约收紧变为不可读且无自助恢复路径；结构非法仍降级。
        if (!validated.issues.every((issue) => issue.kind === 'scale')) {
          return degrade(key, 'overlay 不过契约校验');
        }
        console.warn(
          `[user-config] overlay 规模超出当前上界（${validated.issues.length} 项），已按存量放行；下次保存时须先精简`,
        );
        const oversized = parsed as UserOverlay;
        const oversizedRevision = sha256Hex(raw);
        remember(key, oversized, oversizedRevision);
        return { overlay: oversized, revision: oversizedRevision };
      }
      const revision = sha256Hex(raw);
      remember(key, validated.overlay, revision);
      return { overlay: validated.overlay, revision };
    },

    async write(subject: UserConfigSubject, overlay: UserOverlay): Promise<UserConfigWriteResult> {
      const { key, dir, path } = locate(subject);
      const serialized = JSON.stringify(overlay, null, 2);
      // 原子写（临时文件 + 同目录 rename）：并发读永不见半截文件，正常写入不被误判 stale。
      const tmpPath = `${path}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmpPath, serialized, 'utf8');
        renameSync(tmpPath, path);
      } catch {
        rmSync(tmpPath, { force: true });
        throw new UserConfigStoreError('write-failed', 'L2 overlay 写入失败');
      }
      const revision = sha256Hex(serialized);
      remember(key, overlay, revision);
      return { revision };
    },
  };
}
