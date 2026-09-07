/**
 * 按需注入面的派生（adr-027 双轨模型，插件私有，纯逻辑无 chrome 依赖）。
 *
 * 不变量 IN：content 脚本只出现在两类页面上——(a) 用户在本会话里对其发起了动作的页
 * （图标 / 右键 / 快捷动作 / 服务端下发的定向帧），(b) 用户显式授权过 origin 的页；
 * 其余任何页面上 document 无 zen 注入痕迹。注入面 = 授权集 − 站点黑名单。
 *
 * (a) 是会话内一次性注入（background 逐次 executeScript，本模块只提供脚本文件名）；
 * (b) 是常驻动态注册，其 origin 集合由本模块派生：**本机 chrome.permissions 与服务端 L2 投影的交集**。
 * 取交集而非并集是方向性约束——本机授权多出来的 origin 不构成治理放行（U7 判定恒在服务端），
 * L2 多出来的 origin 也不能凭空取得浏览器授权。黑名单优先于授权：命中即不注册。
 */

/** 动态注册与一次性注入共用的脚本文件（恒为插件自带产物，pack 与 L2 都无从改写它，R2）。 */
export const CONTENT_SCRIPT_FILE = 'dist/content.js';

/** 动态注册项 id 前缀：据此枚举「本扩展注册了哪些注入面」，非本族 id 一律不碰。 */
export const REGISTRATION_ID_PREFIX = 'za-cs-';

/** 已授权 origin 集合的本机缓存键（与 /v1/user-config 的那次拉取同源写入，不另发请求）。 */
export const GRANTED_ORIGINS_KEY = 'za.grantedOrigins';

const GRANTED_ORIGIN_MAX_LENGTH = 255;
/**
 * 授权条目文法：精确 origin `scheme://host[:port]`，协议闭集 http/https。
 * 无通配形态——授权是「才注入」的正向集合，通配等于把注入面重新放回 `<all_urls>`。
 */
const GRANTED_ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?$/;

export function isGrantedOriginEntry(value: string): boolean {
  return value.length <= GRANTED_ORIGIN_MAX_LENGTH && GRANTED_ORIGIN_PATTERN.test(value);
}

/** 契约 maxItems：配置中心据此在添加时给出可定位提示（服务端仍是权威）。 */
export const MAX_GRANTED_ORIGINS = 50;

/** 任意来源（storage.local 缓存 / 服务端响应）的值 → 合法条目清单；残缺项逐条丢弃而非整表作废。 */
export function parseGrantedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && isGrantedOriginEntry(entry));
}

/** GET /v1/user-config 响应 → 已授权 origin；与黑名单同居 "*" 全局作用域（跨站点，不锚定任何 pack）。 */
export function grantedOriginsFromUserConfig(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const overlay = (body as Record<string, unknown>)['overlay'];
  if (typeof overlay !== 'object' || overlay === null) return [];
  const packs = (overlay as Record<string, unknown>)['packs'];
  if (typeof packs !== 'object' || packs === null) return [];
  const globalScope = (packs as Record<string, unknown>)['*'];
  if (typeof globalScope !== 'object' || globalScope === null) return [];
  return parseGrantedOrigins((globalScope as Record<string, unknown>)['grantedOrigins']);
}

/** origin → chrome 匹配模式（`chrome.permissions.request` 与 registerContentScripts 同一形态）。 */
export function originMatchPattern(origin: string): string {
  return `${origin}/*`;
}

/**
 * 浏览器已授予的某条匹配模式是否覆盖该 origin。
 * 逐 origin 授权得到的是精确模式，但用户在 chrome://extensions 把站点访问改成「在所有网站上」时，
 * 浏览器给回的是 `<all_urls>` 或裸通配主机这类模式，逐条授权会被它吸收——
 * 只按精确模式比对会在「用户明明全授权了」时把注册面判成空，常驻注入随之静默失效。
 */
export function grantedPatternCoversOrigin(pattern: string, origin: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/*]+)\/\*$/.exec(pattern);
  if (match === null) return false;
  const [, scheme = '', host = ''] = match;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (scheme !== '*' && parsed.protocol !== `${scheme}:`) return false;
  if (host === '*') return true;
  const hostname = parsed.hostname.toLowerCase();
  if (host.startsWith('*.')) {
    const domain = host.slice(2).toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  // 精确形态须连端口一并相同：`https://a.example/*` 不覆盖 `https://a.example:8443`。
  return `${parsed.protocol}//${parsed.host}` === `${scheme}://${host}`;
}

/** FNV-1a：只为把 origin 压成 id 里可读的定长尾缀，消歧不同 origin 归一化后的同名冲突。 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * origin → 确定性注册 id：同一 origin 恒得同一 id，注册前按该 id 注销即幂等；
 * 「谁注册了什么」可枚举、可对称撤销。
 */
export function contentScriptIdForOrigin(origin: string): string {
  const readable = origin.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${REGISTRATION_ID_PREFIX}${readable}-${fnv1a(origin)}`;
}

export interface RegisteredOriginsInput {
  /** 服务端 L2 投影（globalScope.grantedOrigins）。 */
  l2Origins: readonly string[];
  /** 本机 chrome.permissions.getAll().origins 的匹配模式清单。 */
  grantedPatterns: readonly string[];
  /** 站点黑名单条目（判定复用 site-denylist 的 siteDeniesUrl）。 */
  deniedBy: (origin: string) => boolean;
}

/**
 * 常驻注册面 = L2 投影 ∩ 本机已授权 − 站点黑名单。
 * 交集口径见文件头；黑名单优先于授权（两轨都不注入）。结果按输入序去重，供确定性 diff。
 */
export function decideRegisteredOrigins(input: RegisteredOriginsInput): string[] {
  const result: string[] = [];
  for (const origin of input.l2Origins) {
    if (!isGrantedOriginEntry(origin)) continue;
    if (!input.grantedPatterns.some((pattern) => grantedPatternCoversOrigin(pattern, origin))) continue;
    if (input.deniedBy(origin)) continue;
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}

export interface ContentScriptRegistration {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  persistAcrossSessions: boolean;
}

export function registrationForOrigin(origin: string): ContentScriptRegistration {
  return {
    id: contentScriptIdForOrigin(origin),
    matches: [originMatchPattern(origin)],
    js: [CONTENT_SCRIPT_FILE],
    // document_idle：与既有静态声明的注入时机同口径，页面五能力对 DOM 就绪的假设不变。
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
}

export interface RegistrationPlan {
  /** 待注销的本族注册 id（授权撤销 / 被拉黑 / L2 移除）。 */
  unregister: string[];
  /** 待新增的注册项（已存在的同 id 项不重复注册）。 */
  register: ContentScriptRegistration[];
}

/**
 * 现存注册面 → 目标注册面的对称 diff。只碰本族 id：其余 id 不属本机制，注销它们会踩到别的注入面。
 */
export function planRegistrations(
  desiredOrigins: readonly string[],
  existingIds: readonly string[],
): RegistrationPlan {
  const desired = desiredOrigins.map(registrationForOrigin);
  const desiredIds = new Set(desired.map((item) => item.id));
  const owned = existingIds.filter((id) => id.startsWith(REGISTRATION_ID_PREFIX));
  return {
    unregister: owned.filter((id) => !desiredIds.has(id)),
    register: desired.filter((item) => !owned.includes(item.id)),
  };
}
