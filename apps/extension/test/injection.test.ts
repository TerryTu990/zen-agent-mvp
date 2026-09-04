/**
 * 按需注入面派生的纯逻辑：授权条目文法、L2 投影读取、交集口径与注册项对称 diff。
 * 交集是方向性约束——本机多出的授权不构成治理放行，L2 多出的 origin 也拿不到浏览器授权。
 */
import { describe, expect, it } from 'vitest';
import {
  contentScriptIdForOrigin,
  decideRegisteredOrigins,
  grantedOriginsFromUserConfig,
  isGrantedOriginEntry,
  originMatchPattern,
  grantedPatternCoversOrigin,
  parseGrantedOrigins,
  planRegistrations,
  REGISTRATION_ID_PREFIX,
} from '../src/injection.js';

const never = (): boolean => false;

describe('授权条目文法', () => {
  it('只收精确 origin（http/https），拒通配与路径', () => {
    expect(isGrantedOriginEntry('https://shop.example')).toBe(true);
    expect(isGrantedOriginEntry('http://127.0.0.1:8787')).toBe(true);
    expect(isGrantedOriginEntry('https://*.shop.example')).toBe(false);
    expect(isGrantedOriginEntry('<all_urls>')).toBe(false);
    expect(isGrantedOriginEntry('https://shop.example/orders')).toBe(false);
    expect(isGrantedOriginEntry('file:///etc')).toBe(false);
  });

  it('残缺项逐条丢弃而非整表作废', () => {
    expect(parseGrantedOrigins(['https://a.example', 42, '<all_urls>', 'https://b.example'])).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseGrantedOrigins(null)).toEqual([]);
  });

  it('origin → 匹配模式（chrome.permissions 与 registerContentScripts 同一形态）', () => {
    expect(originMatchPattern('https://shop.example')).toBe('https://shop.example/*');
  });
});

describe('L2 投影读取', () => {
  it('只认 "*" 全局作用域的 grantedOrigins；结构不符即空', () => {
    expect(
      grantedOriginsFromUserConfig({
        overlay: { packs: { '*': { grantedOrigins: ['https://shop.example'] } } },
      }),
    ).toEqual(['https://shop.example']);
    expect(grantedOriginsFromUserConfig({ overlay: { packs: { shop: { grantedOrigins: ['https://x.example'] } } } })).toEqual(
      [],
    );
    expect(grantedOriginsFromUserConfig(null)).toEqual([]);
  });
});

describe('浏览器已授予的模式覆盖判定', () => {
  it('全站通配覆盖任意 origin（用户在 chrome://extensions 改成「在所有网站上」的形态）', () => {
    for (const pattern of ['<all_urls>', 'https://*/*', '*://*/*']) {
      expect(grantedPatternCoversOrigin(pattern, 'https://a.example')).toBe(true);
    }
    expect(grantedPatternCoversOrigin('http://*/*', 'https://a.example')).toBe(false);
  });

  it('子域通配覆盖该域及子域；精确模式连端口一并比对', () => {
    expect(grantedPatternCoversOrigin('https://*.example.com/*', 'https://a.example.com')).toBe(true);
    expect(grantedPatternCoversOrigin('https://*.example.com/*', 'https://example.com')).toBe(true);
    expect(grantedPatternCoversOrigin('https://*.example.com/*', 'https://notexample.com')).toBe(false);
    expect(grantedPatternCoversOrigin('https://a.example/*', 'https://a.example')).toBe(true);
    expect(grantedPatternCoversOrigin('https://a.example/*', 'https://a.example:8443')).toBe(false);
  });

  it('非匹配模式形态一律不覆盖', () => {
    expect(grantedPatternCoversOrigin('https://a.example', 'https://a.example')).toBe(false);
    expect(grantedPatternCoversOrigin('file:///*', 'https://a.example')).toBe(false);
  });
});

describe('注册面 = L2 ∩ 本机授权 − 黑名单', () => {
  it('两侧都有才注册', () => {
    expect(
      decideRegisteredOrigins({
        l2Origins: ['https://a.example', 'https://b.example'],
        grantedPatterns: ['https://b.example/*', 'https://c.example/*'],
        deniedBy: never,
      }),
    ).toEqual(['https://b.example']);
  });

  it('本机全站通配授权时逐条 L2 声明照常注册（授权被吸收不等于没授权）', () => {
    expect(
      decideRegisteredOrigins({
        l2Origins: ['https://a.example'],
        grantedPatterns: ['<all_urls>'],
        deniedBy: never,
      }),
    ).toEqual(['https://a.example']);
  });

  it('黑名单优先于授权', () => {
    expect(
      decideRegisteredOrigins({
        l2Origins: ['https://a.example'],
        grantedPatterns: ['https://a.example/*'],
        deniedBy: (origin) => origin === 'https://a.example',
      }),
    ).toEqual([]);
  });
});

describe('注册项对称 diff', () => {
  it('缺的补、多的撤、已在的不重复注册', () => {
    const keep = contentScriptIdForOrigin('https://a.example');
    const stale = contentScriptIdForOrigin('https://old.example');
    const plan = planRegistrations(['https://a.example', 'https://b.example'], [keep, stale]);
    expect(plan.unregister).toEqual([stale]);
    expect(plan.register.map((item) => item.id)).toEqual([contentScriptIdForOrigin('https://b.example')]);
  });

  it('非本族 id 一律不碰（那不属本机制的注入面）', () => {
    expect(planRegistrations([], ['other-extension-script']).unregister).toEqual([]);
  });

  it('id 由 origin 确定性派生且带本族前缀', () => {
    expect(contentScriptIdForOrigin('https://a.example')).toBe(contentScriptIdForOrigin('https://a.example'));
    expect(contentScriptIdForOrigin('https://a.example').startsWith(REGISTRATION_ID_PREFIX)).toBe(true);
    expect(contentScriptIdForOrigin('https://a-b.example')).not.toBe(contentScriptIdForOrigin('https://a.b.example'));
  });
});
