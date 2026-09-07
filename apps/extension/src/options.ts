/**
 * 选项页宿主：把 chrome.storage.local 的本机设置（服务端地址 / 执行偏好）接到配置中心三页上，
 * 并以匿名身份（adr-022）取得本页读写 L2 所需的令牌；令牌值不入 DOM（ZA-C-SEC-04）。
 * 站点黑名单双写：L2 + 本机 `za.siteDenylist`（background 激活判定的数据源），保存成功即同步。
 */
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
    async saveSettings(patch) {
      const entries: Record<string, unknown> = {};
      if (patch.serverBaseUrl !== undefined && patch.serverBaseUrl !== '') {
        entries[BASEURL_KEY] = patch.serverBaseUrl;
      }
      if (patch.executionPreference !== undefined) entries[EXECUTION_PREFERENCE_KEY] = patch.executionPreference;
      if (patch.serverBaseUrl === '') await chrome.storage.local.remove(BASEURL_KEY);
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
