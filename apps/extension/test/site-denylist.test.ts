/**
 * 用户级站点黑名单的插件侧投影（adr-014 L2 globalScope.siteDenylist）：
 * background 据此在命中站点跳过激活（隐私侧不上报），治理终判仍在服务端 compose（U7）。
 * 本模块的每条不确定路径都必须判为「不命中」——客户端宁可多上报，也不能假装治理已生效。
 */
import { describe, expect, it } from 'vitest';
import {
  isSiteDenyEntry,
  parseSiteDenylist,
  siteDeniedSkipKey,
  siteDeniedSkipTabId,
  siteDeniesUrl,
  siteDenylistFromUserConfig,
  tabUrlOf,
} from '../src/site-denylist.js';

function userConfigBody(entries: unknown): unknown {
  return {
    revision: 'rev-1',
    overlay: { schemaVersion: 1, subject: { tenant: 'anon', hostUserId: 'u1' }, packs: { '*': { siteDenylist: entries } } },
  };
}

describe('siteDenylistFromUserConfig：从既有 /v1/user-config 响应派生（不新增请求）', () => {
  it('全局作用域的 siteDenylist 逐条取出（正常）', () => {
    expect(siteDenylistFromUserConfig(userConfigBody(['https://bank.example', 'https://*.corp.example']))).toEqual([
      'https://bank.example',
      'https://*.corp.example',
    ]);
  });

  it('拉取失败/结构不符一律视为无黑名单（异常：不确定就照常激活，由服务端拒）', () => {
    expect(siteDenylistFromUserConfig(null)).toEqual([]);
    expect(siteDenylistFromUserConfig(undefined)).toEqual([]);
    expect(siteDenylistFromUserConfig('<html>502</html>')).toEqual([]);
    expect(siteDenylistFromUserConfig({})).toEqual([]);
    expect(siteDenylistFromUserConfig({ overlay: null })).toEqual([]);
    expect(siteDenylistFromUserConfig({ overlay: { packs: {} } })).toEqual([]);
    expect(siteDenylistFromUserConfig(userConfigBody('https://bank.example'))).toEqual([]);
  });

  it('残缺条目逐条丢弃而非整表作废（边界）', () => {
    expect(siteDenylistFromUserConfig(userConfigBody(['https://bank.example', 42, 'not-an-origin', '*']))).toEqual([
      'https://bank.example',
    ]);
  });

  it('黑名单只居 "*" 全局作用域：pack 级同名键不参与（边界）', () => {
    const body = {
      overlay: { packs: { shop: { siteDenylist: ['https://bank.example'] } } },
    };
    expect(siteDenylistFromUserConfig(body)).toEqual([]);
  });
});

describe('isSiteDenyEntry：条目文法（与 C7 siteDenyEntry 同源）', () => {
  it('精确 origin 与 scheme://*.host 两形态合法（正常）', () => {
    expect(isSiteDenyEntry('https://bank.example')).toBe(true);
    expect(isSiteDenyEntry('http://127.0.0.1:4173')).toBe(true);
    expect(isSiteDenyEntry('http://localhost:4173')).toBe(true);
    expect(isSiteDenyEntry('https://*.corp.example')).toBe(true);
  });

  it('全通配与残缺形态一律非法（异常：黑名单里的 "*" 等于关停整个产品）', () => {
    expect(isSiteDenyEntry('*')).toBe(false);
    expect(isSiteDenyEntry('https://*')).toBe(false);
    expect(isSiteDenyEntry('bank.example')).toBe(false);
    expect(isSiteDenyEntry('https://bank.example/orders')).toBe(false);
    expect(isSiteDenyEntry('')).toBe(false);
  });
});

describe('siteDeniesUrl：激活前的站点判定', () => {
  it('命中即不激活；www 与裸域互认（正常）', () => {
    expect(siteDeniesUrl(['https://bank.example'], 'https://bank.example/accounts')).toBe(true);
    expect(siteDeniesUrl(['https://bank.example'], 'https://www.bank.example/accounts')).toBe(true);
    expect(siteDeniesUrl(['https://www.bank.example'], 'https://bank.example/')).toBe(true);
  });

  it('scheme 与端口精确比对，不互认（边界）', () => {
    expect(siteDeniesUrl(['https://bank.example'], 'http://bank.example/')).toBe(false);
    expect(siteDeniesUrl(['http://localhost:4173'], 'http://localhost/')).toBe(false);
    expect(siteDeniesUrl(['http://localhost:4173'], 'http://localhost:4173/orders')).toBe(true);
  });

  it('scheme://*.host 命中该域及其子域，不外溢到同前缀域（边界）', () => {
    expect(siteDeniesUrl(['https://*.corp.example'], 'https://corp.example/')).toBe(true);
    expect(siteDeniesUrl(['https://*.corp.example'], 'https://mail.corp.example/x')).toBe(true);
    expect(siteDeniesUrl(['https://*.corp.example'], 'https://corp.example.evil/')).toBe(false);
  });

  it('空名单（含拉取失败回空）→ 照常激活（异常：不确定不拦）', () => {
    expect(siteDeniesUrl([], 'https://bank.example/')).toBe(false);
    expect(siteDeniesUrl(siteDenylistFromUserConfig(null), 'https://bank.example/')).toBe(false);
  });

  it('URL 缺失或不可解析（静默页）→ 不命中，交服务端终判（边界）', () => {
    expect(siteDeniesUrl(['https://bank.example'], undefined)).toBe(false);
    expect(siteDeniesUrl(['https://bank.example'], '')).toBe(false);
    expect(siteDeniesUrl(['https://*.corp.example'], 'about:blank')).toBe(false);
  });
});

describe('parseSiteDenylist：本机缓存读回（storage.local 值不可信）', () => {
  it('非数组/残缺值一律回空数组（异常）', () => {
    expect(parseSiteDenylist(undefined)).toEqual([]);
    expect(parseSiteDenylist('https://bank.example')).toEqual([]);
    expect(parseSiteDenylist([1, null, 'https://bank.example'])).toEqual(['https://bank.example']);
  });
});

describe('tabUrlOf：判定取哪个地址（激活闸门与页面清单共用一份口径）', () => {
  it('已提交导航取 url（正常）', () => {
    expect(tabUrlOf({ url: 'https://bank.example/accounts' })).toBe('https://bank.example/accounts');
  });

  it('导航尚未提交：url 为空串或缺省时回落 pendingUrl（边界：navigate 代执行新开页的真实形态）', () => {
    expect(tabUrlOf({ url: '', pendingUrl: 'https://bank.example/accounts' })).toBe('https://bank.example/accounts');
    expect(tabUrlOf({ pendingUrl: 'https://bank.example/accounts' })).toBe('https://bank.example/accounts');
  });

  it('两者皆无 → undefined，交 siteDeniesUrl 判为不命中（异常）', () => {
    expect(tabUrlOf({})).toBeUndefined();
    expect(siteDeniesUrl(['https://bank.example'], tabUrlOf({}))).toBe(false);
  });
});

describe('siteDeniedSkipTabId：登记键反解（复核既有登记是否仍成立）', () => {
  it('本族键取回 tabId，与 siteDeniedSkipKey 互逆（正常）', () => {
    expect(siteDeniedSkipTabId(siteDeniedSkipKey(11))).toBe(11);
    expect(siteDeniedSkipTabId(siteDeniedSkipKey(0))).toBe(0);
  });

  it('非本族键与畸形序号一律 null（异常：复核不得误伤同区其他键）', () => {
    expect(siteDeniedSkipTabId('za.zenGroup.7')).toBeNull();
    expect(siteDeniedSkipTabId('za.siteDeniedSkip.')).toBeNull();
    expect(siteDeniedSkipTabId('za.siteDeniedSkip.01')).toBeNull();
    expect(siteDeniedSkipTabId('za.siteDeniedSkip.-3')).toBeNull();
    expect(siteDeniedSkipTabId('za.siteDeniedSkip.11.extra')).toBeNull();
  });
});
