import { describe, expect, it } from 'vitest';
import { normalizeTrustedServerBaseUrl } from '../src/server-url.js';

describe('zen 服务地址传输身份围栏', () => {
  it('生产仅接受 HTTPS，并规范化尾斜杠/查询/片段', () => {
    expect(normalizeTrustedServerBaseUrl('https://agent.example.com/base/?debug=1#x')).toBe(
      'https://agent.example.com/base',
    );
    expect(normalizeTrustedServerBaseUrl('http://agent.example.com')).toBeNull();
    expect(normalizeTrustedServerBaseUrl('ftp://agent.example.com')).toBeNull();
  });

  it('本机开发允许 HTTP，但相似域名、远端 IP 与 URL 凭证均拒绝', () => {
    expect(normalizeTrustedServerBaseUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeTrustedServerBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeTrustedServerBaseUrl('http://[::1]:8787')).toBe('http://[::1]:8787');
    expect(normalizeTrustedServerBaseUrl('http://localhost.example.com:8787')).toBeNull();
    expect(normalizeTrustedServerBaseUrl('http://192.168.1.20:8787')).toBeNull();
    expect(normalizeTrustedServerBaseUrl('https://user:pass@agent.example.com')).toBeNull();
  });
});
