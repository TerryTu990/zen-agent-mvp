/**
 * navigate 代执行的 chrome 粘合层（依赖经工厂注入）：组内已有同源页则复用
 * （decideNavigateTarget），否则在本组窗口开目标页并入本组；目标页登记为待激活，
 * 其端口接入/重连时接管为活跃执行页（组内换站会话延续）。
 * 客户端零治理：url 已由服务端签发前校验落在 pack site 围栏内（U7），此处只执行。
 */

import type { ExecInstructionFrame, ExecResultFrame } from './frames.js';
import { decideNavigateTarget, type NavigateCandidateTab } from './navigate-target.js';

export interface NavigateTabs {
  query(queryInfo: { groupId: number }): Promise<NavigateCandidateTab[]>;
  get(tabId: number): Promise<{ groupId?: number | undefined }>;
  update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<unknown>;
  create(createProperties: {
    url: string;
    windowId?: number;
    active?: boolean;
  }): Promise<{ id?: number | undefined }>;
  group(options: { tabIds: number; groupId: number }): Promise<unknown>;
}

export interface NavigateExecutorDeps {
  groupId: number;
  tabs: NavigateTabs;
  /** 同 URL 复用不重载、端口不重连：已连成员就地标活跃（换 URL 重载的走重连接管）。 */
  markMemberActive(tabId: number): void;
  /** 登记待激活 tabId：该页端口接入时被接管为活跃执行页。 */
  noteExpectedActiveTab(tabId: number): void;
  sendActivate(tabId: number): Promise<void>;
  /** exec-result 回喂上行管线（与 content 侧代执行结果同一通道）。 */
  forwardExecResult(result: ExecResultFrame): void;
  now?(): number;
}

export type NavigateOutcome = { ok: true; url: string } | { ok: false; error: string };

export interface NavigateExecutor {
  performNavigate(url: string, windowId?: number, initiatorTabId?: number): Promise<NavigateOutcome>;
  executeNavigateWithoutPage(frame: ExecInstructionFrame, url: string): Promise<void>;
  executeNavigateToTab(frame: ExecInstructionFrame, url: string, tabId: number): Promise<void>;
}

export function createNavigateExecutor(deps: NavigateExecutorDeps): NavigateExecutor {
  const now = deps.now ?? Date.now;

  async function performNavigate(
    url: string,
    windowId?: number,
    initiatorTabId?: number,
  ): Promise<NavigateOutcome> {
    try {
      const groupTabs = await deps.tabs.query({ groupId: deps.groupId }).catch(() => []);
      const target = decideNavigateTarget(url, groupTabs, initiatorTabId);
      if (target.kind !== 'create') {
        await deps.tabs.update(
          target.tabId,
          target.kind === 'update' ? { url, active: true } : { active: true },
        );
        if (target.kind === 'activate') deps.markMemberActive(target.tabId);
        deps.noteExpectedActiveTab(target.tabId);
        void deps.sendActivate(target.tabId);
        return { ok: true, url };
      }
      // 先入组再激活：active:true 的瞬间新页尚未入组，onActivated/面板会按组外把面板关掉（竞态）。
      const created = await deps.tabs.create({
        url,
        ...(windowId !== undefined ? { windowId } : {}),
        active: false,
      });
      if (created.id !== undefined) {
        await deps.tabs.group({ tabIds: created.id, groupId: deps.groupId });
        await deps.tabs.update(created.id, { active: true });
        deps.noteExpectedActiveTab(created.id);
        // 主动通知新页激活（content 已加载时即接入）；未加载时其自身 request-activate 走 reconnect 兜底。
        void deps.sendActivate(created.id);
      }
      return { ok: true, url };
    } catch {
      return { ok: false, error: 'navigate-open-failed' };
    }
  }

  /**
   * 静默页冷启动的 open_url 通路：组内无 content 成员可代执行时，由 background 直执行单步
   * navigate（decideBackgroundNavigate 已限定唯一放行形态）。结果按 content 侧同一 exec-result
   * 契约回喂上行管线：成功 body={url}、失败错误串比照 dom-steps 口径、过期比照 delegated-execution。
   */
  async function executeNavigateWithoutPage(frame: ExecInstructionFrame, url: string): Promise<void> {
    const base = { type: 'exec-result' as const, sessionId: frame.sessionId, nonce: frame.nonce };
    let result: ExecResultFrame;
    if (now() > frame.expiresAt) {
      result = { ...base, ok: false, error: 'instruction-expired' };
    } else {
      const outcome = await performNavigate(url);
      result = outcome.ok
        ? { ...base, ok: true, body: { url: outcome.url } }
        : { ...base, ok: false, error: `step-1-navigate:${outcome.error}` };
    }
    deps.forwardExecResult(result);
  }

  /**
   * silent 页定向 navigate 的直执行通路（adr-023 D3）：落点已由签名帧上的句柄钉死——
   * 只对该 tab 换 URL，不跑复用判定、不激活不夺焦（用户切过去后该页才转 active，流程 C）。
   * 执行前复核目标当前 groupId：句柄表滞后窗口内目标可能已离组，组外一律不导航——
   * 副作用不得越出任务组边界；不在组按目标已失效如实回失败，禁改投他页。
   * exec-result 回传与 executeNavigateWithoutPage 同构。
   */
  async function executeNavigateToTab(
    frame: ExecInstructionFrame,
    url: string,
    tabId: number,
  ): Promise<void> {
    const base = { type: 'exec-result' as const, sessionId: frame.sessionId, nonce: frame.nonce };
    let result: ExecResultFrame;
    if (now() > frame.expiresAt) {
      result = { ...base, ok: false, error: 'instruction-expired' };
    } else {
      const inGroup = await deps.tabs
        .get(tabId)
        .then((tab) => tab.groupId === deps.groupId)
        .catch(() => false);
      if (!inGroup) {
        result = { ...base, ok: false, error: 'step-1-navigate:navigate-target-gone' };
      } else {
        try {
          await deps.tabs.update(tabId, { url });
          result = { ...base, ok: true, body: { url } };
        } catch {
          result = { ...base, ok: false, error: 'step-1-navigate:navigate-target-gone' };
        }
      }
    }
    deps.forwardExecResult(result);
  }

  return { performNavigate, executeNavigateWithoutPage, executeNavigateToTab };
}
