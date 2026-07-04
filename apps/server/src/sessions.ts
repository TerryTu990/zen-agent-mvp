/**
 * 会话生命周期：状态全部 JSON 可序列化，SessionStore 接口即外置边界——
 * 换持久化实现（如 Redis）不动网关；订阅者/回合调度等进程内对象留在网关层。
 */
import { randomUUID } from 'node:crypto';
import type { IdentityClaims, LlmMessage } from '@zen-agent/contracts';

export interface SessionState {
  sessionId: string;
  /** 会话绑定的 claims.sub：非属主访问按不存在处理。 */
  ownerSub: string;
  /** 最近一次请求的验签 claims：代执行门禁的身份取值源（U7），每次请求刷新。 */
  claims: IdentityClaims;
  /** 最近一次 context-report 上报的完整 URL；未上报为 null（featureId 判定 fail-safe 落空）。 */
  currentUrl: string | null;
  /** 仅 user/assistant 文本轮；system 注入每轮整段重建，不进历史。 */
  history: LlmMessage[];
}

export interface SessionStore {
  create(claims: IdentityClaims): SessionState;
  get(sessionId: string): SessionState | undefined;
  setContext(sessionId: string, url: string): void;
  appendHistory(sessionId: string, message: LlmMessage): void;
  /** 用最近一次验签结果刷新会话身份，使代执行门禁始终以当前有效身份判定。 */
  refreshClaims(sessionId: string, claims: IdentityClaims): void;
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
    refreshClaims(sessionId, claims) {
      mustGet(sessionId).claims = claims;
    },
  };
}
