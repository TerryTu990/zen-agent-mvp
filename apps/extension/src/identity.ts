export interface IdentityProvider {
  /** 返回宿主/SSO 签发的短期 JWT（C2 claims 闭集），网关侧验签、插件不解析内容；未配置则抛错。 */
  getToken(): Promise<string>;
}

export function createIdentityProvider(): IdentityProvider {
  return {
    async getToken() {
      const items = await chrome.storage.local.get('za.token');
      const token = items['za.token'];
      if (typeof token !== 'string' || token === '') {
        throw new Error('未配置访问令牌（chrome.storage.local "za.token"）');
      }
      return token;
    },
  };
}
