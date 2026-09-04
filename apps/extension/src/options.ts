/**
 * 选项页宿主：把 chrome.storage.local 的本机设置（服务端地址 / 执行偏好 / 自动化调度镜像）接到配置中心四页上，
 * 并以匿名身份（adr-022）取得本页读写 L2 所需的令牌；令牌值不入 DOM（ZA-C-SEC-04）。
 * 自动化偏好双写：L2（治理可见、服务端合并）+ 本地 `za.autoScan.*`（background alarm 的调度数据源）。
 * 站点黑名单同律双写：L2 + 本机 `za.siteDenylist`（background 激活判定的数据源），保存成功即同步。
 */
import {
  AUTOMATION_DESCRIPTORS_KEY,
  autoScanEnabledKeyFor,
  autoScanMinutesKeyFor,
  parseAutomationDescriptors,
} from './auto-scan.js';
import { mountConfigCenter } from './config-center.js';
import { EXECUTION_PREFERENCE_KEY, parseExecutionPreference } from './execution-preference.js';
import { createIdentityProvider } from './identity.js';
import { normalizeTrustedServerBaseUrl } from './server-url.js';
import { SITE_DENYLIST_KEY } from './site-denylist.js';
import { GRANTED_ORIGINS_KEY, originMatchPattern } from './injection.js';

const BASEURL_KEY = 'za.serverBaseUrl';

// 发布构建经 esbuild --define 注入生产地址（release/build-extension.sh），开发构建回退本机。
declare const __ZA_SERVER_BASE_URL__: string | undefined;
const DEFAULT_SERVER_BASE_URL =
  typeof __ZA_SERVER_BASE_URL__ === 'string' && __ZA_SERVER_BASE_URL__ !== ''
    ? __ZA_SERVER_BASE_URL__
    : 'http://127.0.0.1:8787';

const root = document.getElementById('za-config-center') as HTMLElement;

/**
 * 本机调度偏好三态：键不存在 = 从未配置（不产 enabled 字段），存在则如实取值——
 * 「显式停用」与「从未配置」必须可区分，否则新装机器会被判成「本机已暂停」（R6）。
 */
function readLocalAutomations(
  items: Record<string, unknown>,
): Record<string, { enabled?: boolean; minutes?: number }> {
  const prefs: Record<string, { enabled?: boolean; minutes?: number }> = {};
  for (const descriptor of parseAutomationDescriptors(items[AUTOMATION_DESCRIPTORS_KEY])) {
    const automationId = descriptor.automation.id;
    const minutes = items[autoScanMinutesKeyFor(automationId)];
    const enabledKey = autoScanEnabledKeyFor(automationId);
    prefs[automationId] = {
      ...(Object.hasOwn(items, enabledKey) ? { enabled: items[enabledKey] === true } : {}),
      ...(typeof minutes === 'number' ? { minutes } : {}),
    };
  }
  return prefs;
}

void chrome.storage.local.get(null).then(async (items) => {
  const storedBaseUrl = items[BASEURL_KEY];
  const serverBaseUrl = typeof storedBaseUrl === 'string' ? storedBaseUrl : '';
  // 非受信地址（非 HTTPS 且非本机）回落构建缺省：令牌只随请求发往受信端点。
  const baseUrl =
    normalizeTrustedServerBaseUrl(serverBaseUrl === '' ? DEFAULT_SERVER_BASE_URL : serverBaseUrl) ??
    DEFAULT_SERVER_BASE_URL;
  // 激活失败时以空令牌挂载：配置中心会拿到 401 并如实提示，不阻塞本机设置页可用。
  const authToken = await createIdentityProvider().getToken(baseUrl).catch(() => '');

  mountConfigCenter(root, {
    fetch: globalThis.fetch.bind(globalThis),
    baseUrl,
    authToken,
    serverBaseUrl,
    executionPreference: parseExecutionPreference(items[EXECUTION_PREFERENCE_KEY]),
    normalizeBaseUrl: normalizeTrustedServerBaseUrl,
    localAutomations: readLocalAutomations(items),
    async saveSettings(patch) {
      const entries: Record<string, unknown> = {};
      if (patch.serverBaseUrl !== undefined && patch.serverBaseUrl !== '') {
        entries[BASEURL_KEY] = patch.serverBaseUrl;
      }
      if (patch.executionPreference !== undefined) entries[EXECUTION_PREFERENCE_KEY] = patch.executionPreference;
      if (patch.serverBaseUrl === '') await chrome.storage.local.remove(BASEURL_KEY);
      if (Object.keys(entries).length > 0) await chrome.storage.local.set(entries);
    },
    async saveAutomations(prefs) {
      const entries: Record<string, unknown> = {};
      for (const [automationId, pref] of Object.entries(prefs)) {
        entries[autoScanEnabledKeyFor(automationId)] = pref.enabled;
        entries[autoScanMinutesKeyFor(automationId)] = pref.minutes;
      }
      if (Object.keys(entries).length > 0) await chrome.storage.local.set(entries);
    },
    async saveSiteDenylist(entries) {
      await chrome.storage.local.set({ [SITE_DENYLIST_KEY]: entries });
    },
    async saveGrantedOrigins(entries) {
      await chrome.storage.local.set({ [GRANTED_ORIGINS_KEY]: entries });
    },
    // 授权气泡只在用户手势内弹得出来：配置中心的按钮回调里同步发起，中间不得插入 await。
    requestOriginAccess: (origin) => chrome.permissions.request({ origins: [originMatchPattern(origin)] }),
    revokeOriginAccess: (origin) => chrome.permissions.remove({ origins: [originMatchPattern(origin)] }),
    // 本机权限是注册面的合取项之一：浏览器侧的撤销（站点访问改回「点击时」）不通知本页，只能主动对账。
    hasOriginAccess: (origin) => chrome.permissions.contains({ origins: [originMatchPattern(origin)] }),
  });
});
