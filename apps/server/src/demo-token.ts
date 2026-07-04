/**
 * P0-b demo-token 签发（env 门控，demo 级信任）：让扩展在宿主页自取 token、免手动粘贴。
 * 用与 verifier 同一套 HS256 secret/iss 签发，签出的 token 能被本 server 验签通过。
 *
 * 信任模型（务必理解再改）：此端点不要求鉴权是有意的——它本身就是发 token 的。
 * demo 级信任的安全性不靠 token 身份：代执行时真实鉴权走用户自己的浏览器 cookie（credentials:'include'），
 * 伪造 hostUserId 只会让下游宿主 API 的 New-Api-User 头与用户 cookie 不匹配而被宿主拒绝，平台零特权、不放大权限。
 */
import { SignJWT } from 'jose';

export interface DemoTokenSigner {
  jwtSecret: string;
  /** 签发用 iss，须在 verifier 的 issAllowlist 内，否则自签 token 反被本 server 拒绝。 */
  iss: string;
}

/** 签发 24h 有效的 HS256 token；claims 闭集与 C2 IdentityClaims 同构（sub/tenant/roles/hostUserId/iss/exp）。 */
export function signDemoToken(signer: DemoTokenSigner, hostUserId: string): Promise<string> {
  const key = new TextEncoder().encode(signer.jwtSecret);
  return new SignJWT({ tenant: 'codeflow', roles: ['user'], hostUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('codeflow-user')
    .setIssuer(signer.iss)
    .setExpirationTime('24h')
    .sign(key);
}
