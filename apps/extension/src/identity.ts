export interface IdentityProvider {
  /** 返回宿主/SSO 签发的短期 JWT（C2 claims 闭集），网关侧验签、插件不解析内容。 */
  getToken(): Promise<string>;
}

export function createIdentityProvider(): IdentityProvider {
  return {
    getToken() {
      throw new Error('NOT_IMPLEMENTED: M1 讲解闭环——身份获取（企业 SSO / 简化 token）');
    },
  };
}
