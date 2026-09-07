/**
 * 「这一页为什么没被接入」的本地判定（插件私有，纯逻辑无 chrome 依赖）。
 *
 * silent 不是第三种成员身份，而是一句如实报告：这一页在任务组里，但执行器没能放进去。
 * 它必须对用户可见——签发指令前要 fail-closed，把读不了的页说成能读会让 agent 发出必然超时的读取；
 * 用户那侧同样只看见「某页读不了」，不知道原因也不知道下一步能做什么。
 *
 * 判据全是浏览器 API 当刻能答的本机事实（协议闭集 / 站点权限是否持有 / 是否仍在加载 /
 * 是否命中用户的不辅助名单），不含任何治理判定——治理终判恒在服务端（U7），本模块只解释本机现象。
 */

export type PageAttachReason = 'restricted' | 'site-denied' | 'permission' | 'loading' | 'unknown';

/**
 * 浏览器一律不允许注入执行器的地址：http/https 之外的协议（chrome:// / 扩展页 / about: /
 * view-source: / file:）、扩展商店、以及交给 PDF 阅读器渲染的页面。这一类不可消除，
 * 也不该给重试入口——按了也只会再失败一次。
 */
export function isRestrictedPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') return true;
  if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return true;
  return parsed.pathname.toLowerCase().endsWith('.pdf');
}

/**
 * 地址 → chrome 站点权限的匹配模式。Chrome 的匹配模式主机段不带端口，一条 host 模式即覆盖该主机
 * 全部端口；带端口的模式会被 permissions API 判为非法实参（查询直接抛错）。故此处按
 * scheme://host 归一。地址不可解析即回 null（拿不出可询问的范围）。
 */
export function permissionPatternFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export interface PageAttachInput {
  url: string;
  /** 该页命中用户的「不辅助的站点」名单：故意行为，不该被「修复」。 */
  siteDenied: boolean;
  /** 本机 chrome.permissions 是否已覆盖该页 origin。 */
  originGranted: boolean;
  /** 采样当刻该页仍在加载：瞬时态，下一次清单上报即转为已接入。 */
  loading: boolean;
}

/**
 * 优先级自「不可改变」到「可自行消除」：浏览器硬限制 > 用户自己的名单 > 缺站点权限 > 仍在加载。
 * 四条都不成立时不猜原因（如注入被页面 CSP/崩溃打断），按 unknown 给一次重试。
 */
export function decideAttachReason(input: PageAttachInput): PageAttachReason {
  if (isRestrictedPage(input.url)) return 'restricted';
  if (input.siteDenied) return 'site-denied';
  if (!input.originGranted) return 'permission';
  if (input.loading) return 'loading';
  return 'unknown';
}

/** 面板措辞：说清是哪一类、下一步能做什么；只引用地址本身，不带任何本机细节。 */
export const PAGE_ATTACH_REASON_TEXT: Record<PageAttachReason, string> = {
  restricted: '浏览器不允许在这类页面接入（浏览器内部页、扩展商店、PDF 阅读器、源码视图）',
  'site-denied': '本站在你的「不辅助的站点」名单内，按你的设置未接入',
  permission: '尚未取得该站点的访问权限',
  loading: '页面还在加载，接入后会自动转为可读',
  unknown: '这一页暂时没能接入',
};

/** 重试有意义的原因：浏览器硬限制按了也必失败，用户自己的名单按了则是违背他的设置。 */
export function isAttachRetryable(reason: PageAttachReason): boolean {
  return reason === 'permission' || reason === 'loading' || reason === 'unknown';
}
