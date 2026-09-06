/**
 * E2E 的插件装载夹具（adr-027 按需注入模型）。
 *
 * 两件事在 Playwright 里做不到，故由本模块以等价前置替代，且只替代这两件：
 *
 * ① **工具栏手势**：浏览器工具栏图标、右键菜单、扩展快捷键都不在页面内，Playwright 点不到。
 *    activateTab 以插件自身的公开 chrome API 复现 handleIconClick 的可观察产物——建/取 zen 组、
 *    登记 zen 组与面板绑定、把 dist/content.js 注入该页；此后的激活握手、面板绑定、会话建立
 *    全部走产品自身路径。za.zenGroup.g<id> / za.panelGroup.w<id> 是插件私有存根键的手抄镜像
 *    （activation.ts zenGroupKey / panelGroupKey）。
 *
 * ② **站点授权气泡**：chrome.permissions.request 的授权气泡是浏览器 UI，自动化点不到，
 *    调用会一直挂起。prepareExtensionDir 复制一份插件目录并把 optional_host_permissions 提为
 *    host_permissions——Chrome 对 --load-extension 的解包扩展自动授予必需权限，等价于
 *    「用户已授权站点访问」这一前置。**被测的仍是注入时机**：产品清单不含任何 content_scripts，
 *    有没有 content 脚本完全由 background 的注入决定，与权限是否已授予无关。
 *    未被本夹具覆盖的残余面：activeTab 手势授权路径本身（无手势即拿不到，自动化内无从触发）。
 *
 *    scoped 形态（hostPermissions 给定）只把指定 origin 写成 host_permissions、保留
 *    optional_host_permissions:["<all_urls>"]：此时 chrome.permissions.contains(<all_urls>) 为 false，
 *    未授权 origin 上 background 的 executeScript 会真实失败——「未接入」分支由此可达。
 *    该形态下批准手势会真的调用 chrome.permissions.request，须配合 stubPermissionRequest 让它立即
 *    返回、而不是挂在无人可点的授权气泡上。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALL_URLS = '<all_urls>';

/**
 * 复制插件目录并改写 host 权限；返回可直接传给 --load-extension 的路径。
 * 缺省把 optional_host_permissions 整体提为 host_permissions（全站已授权）；
 * 传 hostPermissions 即 scoped 形态：只授权给定 origin 模式，<all_urls> 留在 optional 侧。
 * 目录留在系统临时区，进程退出即由调用方清理（cleanups）。
 */
export function prepareExtensionDir(sourceDir, { hostPermissions } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'za-e2e-ext-'));
  cpSync(sourceDir, target, {
    recursive: true,
    filter: (path) => !path.includes('node_modules') && !path.endsWith('/test') && !path.includes('/test/'),
  });
  const manifestPath = join(target, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.content_scripts !== undefined) {
    throw new Error('产品清单不应再声明 content_scripts：按需注入模型已删除静态注入面');
  }
  const optional = manifest.optional_host_permissions ?? [];
  if (hostPermissions === undefined) {
    delete manifest.optional_host_permissions;
    manifest.host_permissions = optional;
  } else {
    if (hostPermissions.includes(ALL_URLS)) {
      throw new Error('scoped 夹具的 hostPermissions 不得含 <all_urls>：那等价于缺省的全站授权形态');
    }
    manifest.host_permissions = [...hostPermissions];
    manifest.optional_host_permissions = optional.includes(ALL_URLS) ? optional : [...optional, ALL_URLS];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

/**
 * 把面板页里的 chrome.permissions.request 换成立即 resolve(false) 的桩，并把每次实参记入
 * window.__zaPermissionRequests；须在 page.goto(sidepanel.html) 之前调用。
 * 只桩 request：contains 仍走真实 API，「持有与否」的判定不被替代。
 */
export async function stubPermissionRequest(page) {
  await page.addInitScript(() => {
    window.__zaPermissionRequests = [];
    const permissions = globalThis.chrome?.permissions;
    if (permissions === undefined) return;
    Object.defineProperty(permissions, 'request', {
      configurable: true,
      writable: true,
      value: (descriptor) => {
        window.__zaPermissionRequests.push(descriptor);
        return Promise.resolve(false);
      },
    });
  });
}

export function readPermissionRequests(page) {
  return page.evaluate(() => window.__zaPermissionRequests ?? []);
}

export function removeExtensionDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 图标点击的自动化等价：把该页拉进 zen 会话组并注入 content。
 * groupId 给定时加入该组（拖 tab 入组的等价），否则取该页现有组或新建一个。
 * 返回该页所属的会话组 id。
 */
export async function activateTab(sw, tabId, groupId) {
  return sw.evaluate(
    async ([id, joinGroupId]) => {
      const tab = await chrome.tabs.get(id);
      let target = joinGroupId ?? (tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : null);
      if (target === null) target = await chrome.tabs.group({ tabIds: [id] });
      else if (tab.groupId !== target) await chrome.tabs.group({ tabIds: [id], groupId: target });
      await chrome.tabGroups.update(target, { title: 'Zen', color: 'purple' }).catch(() => {});
      await chrome.storage.session.set({
        ['za.zenGroup.g' + target]: true,
        ['za.panelGroup.w' + tab.windowId]: target,
      });
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['dist/content.js'] });
      return target;
    },
    [tabId, groupId ?? null],
  );
}

/**
 * 不变量 IN 的 E2E 判据：该页上没有 zen 的注入痕迹。
 * 两条独立证据——扩展侧向该 tab 发消息无接收方（content 的 runtime 监听不存在），
 * 页面侧 document 上没有任何 za- 命名的节点。
 */
export async function assertNoZenInjection(sw, page, tabId) {
  const reachable = await sw.evaluate(async (id) => {
    try {
      await chrome.tabs.sendMessage(id, { kind: 'refresh-context' });
      return true;
    } catch {
      return false;
    }
  }, tabId);
  if (reachable) throw new Error('未打开面板的第三方页上仍有 content 脚本在监听扩展消息');
  const traces = await page.evaluate(
    () => document.querySelectorAll('#za-root, [id^="za-"], [class^="za-"]').length,
  );
  if (traces !== 0) throw new Error(`未打开面板的第三方页 document 上仍有 ${traces} 个 zen 注入痕迹`);
}
