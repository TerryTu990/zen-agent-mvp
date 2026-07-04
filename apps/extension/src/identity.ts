export interface IdentityProvider {
  /** 返回宿主/SSO 签发的短期 JWT（C2 claims 闭集），网关侧验签、插件不解析内容；未配置则抛错。 */
  getToken(): Promise<string>;
  /**
   * P0-b 自取：无 za.token 时以宿主用户 id 向 demo-token 端点换取令牌并落库。
   * 成功返回 token 并写入 chrome.storage.local['za.token']；失败抛错。token 值不入日志/错误消息（SEC-04）。
   */
  provisionToken(baseUrl: string, hostUserId: string): Promise<string>;
}

const TOKEN_KEY = 'za.token';

export function createIdentityProvider(): IdentityProvider {
  return {
    async getToken() {
      const items = await chrome.storage.local.get(TOKEN_KEY);
      const token = items[TOKEN_KEY];
      if (typeof token !== 'string' || token === '') {
        throw new Error('未配置访问令牌（chrome.storage.local "za.token"）');
      }
      return token;
    },
    async provisionToken(baseUrl, hostUserId) {
      const response = await fetch(`${baseUrl}/demo-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostUserId }),
      });
      if (!response.ok) {
        throw new Error(`demo-token 端点返回 HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { token?: unknown };
      const token = payload.token;
      if (typeof token !== 'string' || token === '') {
        throw new Error('demo-token 响应缺少有效 token 字段');
      }
      await chrome.storage.local.set({ [TOKEN_KEY]: token });
      return token;
    },
  };
}
