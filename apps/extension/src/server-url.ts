/**
 * 执行公钥随已鉴权 SSE 返回，因此生产连接必须由 TLS 认证服务端身份。
 * 仅本机开发允许明文 HTTP；其它协议、带凭证 URL 与非本机 HTTP 均 fail-closed。
 */
export function normalizeTrustedServerBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const isLoopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.username !== '' || url.password !== '') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
