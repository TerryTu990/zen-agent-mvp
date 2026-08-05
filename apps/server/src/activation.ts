/**
 * 匿名安装身份激活：installId → 短时效 HS256 token，与 verifier 同一 secret/iss 白名单，故签出即可验签通过。
 *
 * installId 是持有型凭证：服务端只取其 SHA-256 派生 hostUserId，原值 MUST NOT 落盘、进日志、
 * 进 token 载荷或错误响应（SEC-01/04）。派生是纯函数，无需映射表，故本模块无任何存储态。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { ActivationRequest, ActivationResponse } from '@zen-agent/contracts';

/** 匿名激活签发的 iss；须在 verifier 的 issAllowlist 内，否则自签 token 反被本 server 拒绝。 */
export const ANON_ISS = 'zen-agent-anon';

const ANON_TENANT = 'anon';
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const ACTIVATION_SCHEMA_ID = 'https://zen-agent.dev/schema/activation/v1.json';

const require = createRequire(import.meta.url);

/**
 * 取契约里的 request 子模式而非整份文件——整份根是 oneOf(request, response)，
 * 直接 compile 会把响应体也当合法请求受理。
 */
export function createActivationRequestValidator(): ValidateFunction<ActivationRequest> {
  const ajv = new Ajv2020({ strict: true });
  const schemaPath = require.resolve('@zen-agent/contracts/schemas/activation.schema.json');
  ajv.addSchema(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
  const validate = ajv.getSchema<ActivationRequest>(`${ACTIVATION_SCHEMA_ID}#/$defs/request`);
  if (validate === undefined) throw new Error('激活请求校验器缺失');
  return validate;
}

export function deriveHostUserId(installId: string): string {
  return `anon-${createHash('sha256').update(installId, 'utf8').digest('base64url')}`;
}

/** claims 闭集与 C2 IdentityClaims 同构；expiresAt 与载荷 exp 同值同单位（epoch 秒）。 */
export async function issueActivationToken(
  jwtSecret: string,
  installId: string,
): Promise<ActivationResponse> {
  const hostUserId = deriveHostUserId(installId);
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ tenant: ANON_TENANT, roles: ['user'], hostUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(hostUserId)
    .setIssuer(ANON_ISS)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(jwtSecret));
  return { token, expiresAt, hostUserId };
}
