/**
 * 匿名激活契约类型——权威在 schemas/activation.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */

/** POST /v1/activation 请求体。 */
export interface ActivationRequest {
  /** 客户端本地生成并持久化的安装 id（122+ 位随机）；持有型凭证，服务端只取其哈希。 */
  installId: string;
}

/** POST /v1/activation 响应体。 */
export interface ActivationResponse {
  /** 签发的 JWT，客户端原样回传 Authorization、不解析内容。 */
  token: string;
  /** 过期时刻（epoch 秒，与 C2 claims 的 exp 同值同单位）。 */
  expiresAt: number;
  /** 'anon-' + base64url(SHA-256(installId))，即 C2 claims 的 hostUserId/sub。 */
  hostUserId: string;
}
