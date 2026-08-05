/**
 * 选项页宿主：把 chrome.storage.local 的本机设置（令牌 / 服务端地址 / 自动化调度镜像）
 * 接到配置中心四页上。令牌只写不读回 DOM（ZA-C-SEC-04）。
 * 自动化偏好双写：L2（治理可见、服务端合并）+ 本地 `za.autoScan.*`（background alarm 的调度数据源）。
 */
import {
  AUTOMATION_DESCRIPTORS_KEY,
  autoScanEnabledKeyFor,
  autoScanMinutesKeyFor,
  parseAutomationDescriptors,
} from './auto-scan.js';
import { mountConfigCenter } from './config-center.js';
import { normalizeTrustedServerBaseUrl } from './server-url.js';

const TOKEN_KEY = 'za.token';
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

void chrome.storage.local.get(null).then((items) => {
  const token = items[TOKEN_KEY];
  const storedBaseUrl = items[BASEURL_KEY];
  const authToken = typeof token === 'string' ? token : '';
  const serverBaseUrl = typeof storedBaseUrl === 'string' ? storedBaseUrl : '';
  // 非受信地址（非 HTTPS 且非本机）回落构建缺省：令牌只随请求发往受信端点。
  const baseUrl =
    normalizeTrustedServerBaseUrl(serverBaseUrl === '' ? DEFAULT_SERVER_BASE_URL : serverBaseUrl) ??
    DEFAULT_SERVER_BASE_URL;

  mountConfigCenter(root, {
    fetch: globalThis.fetch.bind(globalThis),
    baseUrl,
    authToken,
    tokenConfigured: authToken !== '',
    serverBaseUrl,
    normalizeBaseUrl: normalizeTrustedServerBaseUrl,
    localAutomations: readLocalAutomations(items),
    async saveSettings(patch) {
      const entries: Record<string, unknown> = {};
      if (patch.token !== undefined) entries[TOKEN_KEY] = patch.token;
      if (patch.serverBaseUrl !== undefined && patch.serverBaseUrl !== '') {
        entries[BASEURL_KEY] = patch.serverBaseUrl;
      }
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
  });
});
