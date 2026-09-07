/**
 * 用户级站点黑名单的插件侧投影（adr-014 的 L2 `"*"` 作用域 siteDenylist）。
 * background 据此让命中页对服务端完全惰性：不激活、不发出任何上行帧、不执行任何下行指令、
 * 不被登记为活跃执行页；面板据此改给客户端自述；配置中心据此做就地文法自检。
 *
 * 治理终判恒在服务端 compose（U7）：客户端这层是用户隐私意愿的执行，只收紧、不构成治理生效。
 * 故本模块每条不确定路径（拉取失败 / 结构不符 / 条目残缺 / URL 不可解析）一律判为「不命中」：
 * 宁可多上报由服务端拒，也不假装治理已生效——不确定不拦保护的是治理判定不被客户端冒充。
 *
 * 文法与匹配语义是服务端契约（C7 siteDenyEntry）与装配引擎的手抄镜像——插件不依赖 @zen-agent/*（U5）。
 */

/** 契约 maxItems：配置中心据此在添加时给出可定位提示（服务端仍是权威）。 */
export const MAX_SITE_DENYLIST_ENTRIES = 200;

/** storage.local 键：与 /v1/user-config 的那次拉取同源写入，不另发请求。 */
export const SITE_DENYLIST_KEY = 'za.siteDenylist';

/**
 * 「本机确实跳过了这一页的激活」的事实登记键（storage.session，按 tabId）。
 * 面板的客户端自述只认这条事实，不据「当前 URL 命中名单」推断——两者在
 * 「拉黑前已激活、地址早已上报」这条最常见流程上给出的答案相反。
 */
export function siteDeniedSkipKey(tabId: number): string {
  return `za.siteDeniedSkip.${tabId}`;
}

/** 登记键 → tabId；非本族键返回 null。用于按事实是否仍成立逐条复核已有登记。 */
export function siteDeniedSkipTabId(key: string): number | null {
  const match = /^za\.siteDeniedSkip\.(0|[1-9][0-9]*)$/.exec(key);
  return match === null ? null : Number(match[1]);
}

const SITE_DENY_ENTRY_MAX_LENGTH = 255;
const SITE_DENY_ENTRY_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?|[A-Za-z][A-Za-z0-9+.-]*:\/\/\*\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)$/;

/**
 * 条目文法两形态：`scheme://host[:port]` 精确 origin，或 `scheme://*.host` 该域及子域。
 * 无全通配形态——`*` 等价于关停整个产品，文法层即拒。
 */
export function isSiteDenyEntry(value: string): boolean {
  return value.length <= SITE_DENY_ENTRY_MAX_LENGTH && SITE_DENY_ENTRY_PATTERN.test(value);
}

/** 任意来源（storage.local 缓存 / 服务端响应）的值 → 合法条目清单；残缺项逐条丢弃而非整表作废。 */
export function parseSiteDenylist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && isSiteDenyEntry(entry));
}

/** GET /v1/user-config 响应 → 黑名单条目；黑名单只居 "*" 全局作用域（跨站点，不锚定任何 pack）。 */
export function siteDenylistFromUserConfig(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const overlay = (body as Record<string, unknown>)['overlay'];
  if (typeof overlay !== 'object' || overlay === null) return [];
  const packs = (overlay as Record<string, unknown>)['packs'];
  if (typeof packs !== 'object' || packs === null) return [];
  const globalScope = (packs as Record<string, unknown>)['*'];
  if (typeof globalScope !== 'object' || globalScope === null) return [];
  return parseSiteDenylist((globalScope as Record<string, unknown>)['siteDenylist']);
}

/** origin 归一：仅 www 与裸域互认（站点常以两种形态对外服务）；scheme/port 仍须精确。 */
function canonicalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.hostname = url.hostname.replace(/^www\./, '');
    return url.origin;
  } catch {
    return origin;
  }
}

function entryMatchesOrigin(entry: string, origin: string): boolean {
  const wildcard = entry.match(/^([a-z][a-z0-9+.-]*):\/\/\*\.(.+)$/i);
  if (wildcard !== null) {
    const [, scheme = '', suffix = ''] = wildcard;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== `${scheme.toLowerCase()}:`) return false;
    const host = parsed.hostname.toLowerCase();
    const domain = suffix.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return canonicalizeOrigin(entry) === canonicalizeOrigin(origin);
}

/**
 * tab 的判定地址：导航发起到提交之间 `url` 为空、目标只在 `pendingUrl`
 * （navigate 代执行刚开出的页即处于此形态）；两处黑名单判定共用本口径，避免口径漂移留出缺口。
 */
export function tabUrlOf(tab: { url?: string | undefined; pendingUrl?: string | undefined }): string | undefined {
  return tab.url !== undefined && tab.url !== '' ? tab.url : tab.pendingUrl;
}

/** 该页是否落在用户黑名单内；URL 缺失/不可解析（静默页）一律不命中。 */
export function siteDeniesUrl(denylist: readonly string[], url: string | undefined): boolean {
  if (denylist.length === 0 || url === undefined || url === '') return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return denylist.some((entry) => entryMatchesOrigin(entry, origin));
}
