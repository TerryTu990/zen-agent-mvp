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
  originOfMatchPattern,
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

  it('匹配模式与 origin 互转；通配模式不还原为 origin', () => {
    expect(originMatchPattern('https://shop.example')).toBe('https://shop.example/*');
    expect(originOfMatchPattern('https://shop.example/*')).toBe('https://shop.example');
    expect(originOfMatchPattern('<all_urls>')).toBeNull();
    expect(originOfMatchPattern('https://*/*')).toBeNull();
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
