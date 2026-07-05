/**
 * 会话生命周期：状态全部 JSON 可序列化，SessionStore 接口即外置边界——
 * 换持久化实现（如 Redis）不动网关；订阅者/回合调度等进程内对象留在网关层。
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IdentityClaims, LlmMessage } from '@zen-agent/contracts';

export interface SessionState {
  sessionId: string;
  /** 会话绑定的 claims.sub：非属主访问按不存在处理。 */
  ownerSub: string;
  /** 最近一次请求的验签 claims：代执行门禁的身份取值源（U7），每次请求刷新。 */
  claims: IdentityClaims;
  /** 最近一次 context-report 上报的完整 URL；未上报为 null（featureId 判定 fail-safe 落空）。 */
  currentUrl: string | null;
  /** 用户/助手文本轮 + 工具轮（assistant toolCalls 回声 + role:tool 观测）；system 注入每轮整段重建，不进历史。 */
  history: LlmMessage[];
}

export interface SessionStore {
  create(claims: IdentityClaims): SessionState;
  get(sessionId: string): SessionState | undefined;
  setContext(sessionId: string, url: string): void;
  appendHistory(sessionId: string, message: LlmMessage): void;
  /** 整段替换会话历史（P0 瘦身在回合落盘边界产出的新历史经此写回）。 */
  setHistory(sessionId: string, history: LlmMessage[]): void;
  /** 用最近一次验签结果刷新会话身份，使代执行门禁始终以当前有效身份判定。 */
  refreshClaims(sessionId: string, claims: IdentityClaims): void;
  /** 逐出会话（TTL 清理用）；不存在即无操作。 */
  delete(sessionId: string): void;
  /** 载入既有会话状态（持久化重放恢复用）；覆盖同 id 内存项。 */
  restore(state: SessionState): void;
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();
  const mustGet = (sessionId: string): SessionState => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`未知会话：${sessionId}`);
    return session;
  };
  return {
    create(claims) {
      const session: SessionState = {
        sessionId: randomUUID(),
        ownerSub: claims.sub,
        claims,
        currentUrl: null,
        history: [],
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    get(sessionId) {
      return sessions.get(sessionId);
    },
    setContext(sessionId, url) {
      mustGet(sessionId).currentUrl = url;
    },
    appendHistory(sessionId, message) {
      mustGet(sessionId).history.push(message);
    },
    setHistory(sessionId, history) {
      mustGet(sessionId).history = history;
    },
    refreshClaims(sessionId, claims) {
      mustGet(sessionId).claims = claims;
    },
    delete(sessionId) {
      sessions.delete(sessionId);
    },
    restore(state) {
      sessions.set(state.sessionId, state);
    },
  };
}

/** 落盘事件行（append-only jsonl；history/claims 取 set 语义，重放折叠时后者胜）。 */
type SessionEvent =
  | { t: 'create'; sessionId: string; ownerSub: string; claims: IdentityClaims }
  | { t: 'context'; url: string }
  | { t: 'history'; history: LlmMessage[] }
  | { t: 'claims'; claims: IdentityClaims }
  | { t: 'summary'; summary: string };

export interface PersistentSessionStore extends SessionStore {
  /** 逐出闲置超时的会话（内存项 + 落盘文件）；由内部定时器驱动，测试可直接调用。 */
  sweep(): void;
  /** 停定时器（server 关闭/测试清理）。 */
  stop(): void;
}

export interface PersistentSessionStoreOptions {
  dir: string;
  /** 闲置 TTL 毫秒；默认 1 小时。 */
  ttlMs?: number;
  /** 清理定时器间隔毫秒；默认 60 秒。 */
  sweepIntervalMs?: number;
  /** 时钟注入（测试确定性）；默认 Date.now。 */
  now?: () => number;
}

/**
 * 持久化装饰器（ADR-013 P2，最轻量形态）：包住内存 store，写路径 append
 * `.za/sessions/<id>.jsonl`，读 miss 时按文件重放恢复；闲置 TTL 到期清理内存项与文件。
 * 与审计流严格分离（本存储是运行态，非 record-only 旁路）；落盘只含对话与已解析 claims，
 * 不含 JWT 原文/secret（IdentityClaims 是解析后声明，非令牌本身，SEC-01/04）。
 * fail-open：任何 fs 异常只告警一次、不进控制流（沿审计旁路语义）——存储故障不拖死会话。
 */
export function createPersistentSessionStore(
  inner: SessionStore,
  options: PersistentSessionStoreOptions,
): PersistentSessionStore {
  const dir = options.dir;
  const ttlMs = options.ttlMs ?? 3_600_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const now = options.now ?? Date.now;
  const lastActive = new Map<string, number>();
  let warned = false;

  const failOpen = (cause: unknown): void => {
    if (warned) return;
    warned = true;
    console.warn(
      '会话持久化异常，转 fail-open（内存态继续，落盘停用）：',
      cause instanceof Error ? cause.message : String(cause),
    );
  };

  const fileOf = (sessionId: string): string => join(dir, `${sessionId}.jsonl`);

  const append = (sessionId: string, event: SessionEvent): void => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(fileOf(sessionId), `${JSON.stringify(event)}\n`, 'utf8');
    } catch (cause) {
      failOpen(cause);
    }
  };

  const touch = (sessionId: string): void => {
    lastActive.set(sessionId, now());
  };

  /** 折叠落盘事件重建会话状态；文件缺失/损坏 → undefined（fail-open）。 */
  const replay = (sessionId: string): SessionState | undefined => {
    let raw: string;
    try {
      raw = readFileSync(fileOf(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    let state: SessionState | undefined;
    try {
      for (const line of raw.split('\n')) {
        if (line === '') continue;
        const event = JSON.parse(line) as SessionEvent;
        if (event.t === 'create') {
          state = {
            sessionId: event.sessionId,
            ownerSub: event.ownerSub,
            claims: event.claims,
            currentUrl: null,
            history: [],
          };
        } else if (state === undefined) {
          continue;
        } else if (event.t === 'context') {
          state.currentUrl = event.url;
        } else if (event.t === 'history') {
          state.history = event.history;
        } else if (event.t === 'claims') {
          state.claims = event.claims;
        }
      }
    } catch (cause) {
      failOpen(cause);
      return undefined;
    }
    return state;
  };

  // 重启后已有文件先入 TTL 视野：以文件 mtime 作闲置基线，供清理定时器逐出遗留会话。
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      try {
        lastActive.set(sessionId, statSync(join(dir, entry)).mtimeMs);
      } catch {
        // 单文件 stat 失败忽略（fail-open）
      }
    }
  } catch {
    // 目录尚不存在等：无遗留可载入
  }

  const sweep = (): void => {
    const deadline = now() - ttlMs;
    for (const [sessionId, seen] of [...lastActive]) {
      if (seen > deadline) continue;
      inner.delete(sessionId);
      lastActive.delete(sessionId);
      try {
        rmSync(fileOf(sessionId), { force: true });
      } catch (cause) {
        failOpen(cause);
      }
    }
  };

  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref();

  return {
    create(claims) {
      const session = inner.create(claims);
      touch(session.sessionId);
      append(session.sessionId, {
        t: 'create',
        sessionId: session.sessionId,
        ownerSub: session.ownerSub,
        claims,
      });
      return session;
    },
    get(sessionId) {
      const hit = inner.get(sessionId);
      if (hit) {
        touch(sessionId);
        return hit;
      }
      const restored = replay(sessionId);
      if (restored === undefined) return undefined;
      inner.restore(restored);
      touch(sessionId);
      return restored;
    },
    setContext(sessionId, url) {
      inner.setContext(sessionId, url);
      touch(sessionId);
      append(sessionId, { t: 'context', url });
    },
    appendHistory(sessionId, message) {
      inner.appendHistory(sessionId, message);
      touch(sessionId);
      const state = inner.get(sessionId);
      if (state) append(sessionId, { t: 'history', history: state.history });
    },
    setHistory(sessionId, history) {
      inner.setHistory(sessionId, history);
      touch(sessionId);
      append(sessionId, { t: 'history', history });
    },
    refreshClaims(sessionId, claims) {
      const before = inner.get(sessionId)?.claims;
      inner.refreshClaims(sessionId, claims);
      touch(sessionId);
      // refreshClaims 每请求触发；claims 未变即不落盘，避免 jsonl 无谓膨胀。
      if (before === undefined || JSON.stringify(before) !== JSON.stringify(claims)) {
        append(sessionId, { t: 'claims', claims });
      }
    },
    delete(sessionId) {
      inner.delete(sessionId);
      lastActive.delete(sessionId);
      try {
        rmSync(fileOf(sessionId), { force: true });
      } catch (cause) {
        failOpen(cause);
      }
    },
    restore(state) {
      inner.restore(state);
      touch(state.sessionId);
    },
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}
