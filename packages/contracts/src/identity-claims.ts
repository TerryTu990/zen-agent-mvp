/**
 * C2 身份契约类型——权威在 schemas/identity-claims.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */

/**
 * 网关验签 JWT 后投影出的 claims 闭集（原始 token 的 iat/aud/jti 等标准字段投影时丢弃）。
 * 平台零特权：只验签与透传，工具门禁的身份校验以本对象为唯一输入（U7）。
 */
export interface IdentityClaims {
  sub: string;
  /** MVP 单租户固定值；标准版多租户隔离键，字段先行。 */
  tenant: string;
  /** 宿主侧角色闭单，仅供门禁粗粒度校验；细粒度权限由宿主 API 以用户身份判定。 */
  roles: string[];
  /** 宿主系统用户标识：代执行/直调透传身份与审计 userId 的取值源。 */
  hostUserId: string;
  /** 签发方标识，网关按白名单验签，白名单外 fail-closed 拒绝。 */
  iss: string;
  /** 过期时刻（epoch 秒，短时效）。 */
  exp: number;
}
