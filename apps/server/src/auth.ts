/**
 * JWT 验签（HS256）→ C2 IdentityClaims 投影，fail-closed：
 * 签名/exp/iss 白名单/claims 契约任一不过均返回 null，不区分失败原因（SEC-04 不泄细节）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { jwtVerify } from 'jose';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { IdentityClaims } from '@zen-agent/contracts';

export interface TokenVerifierOptions {
  jwtSecret: string;
  issAllowlist: string[];
}

export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<IdentityClaims | null>;
}

const require = createRequire(import.meta.url);

function createClaimsValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  const schemaPath = require.resolve('@zen-agent/contracts/schemas/identity-claims.schema.json');
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
}

const CLAIM_KEYS = ['sub', 'tenant', 'roles', 'hostUserId', 'iss', 'exp'] as const;

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const key = new TextEncoder().encode(options.jwtSecret);
  const allowlist = new Set(options.issAllowlist);
  const validate = createClaimsValidator();
  return {
    async verify(authorizationHeader) {
      if (!authorizationHeader?.startsWith('Bearer ')) return null;
      const token = authorizationHeader.slice('Bearer '.length).trim();
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(token, key, { algorithms: ['HS256'] }));
      } catch {
        return null;
      }
      if (typeof payload['iss'] !== 'string' || !allowlist.has(payload['iss'])) return null;
      const candidate: Record<string, unknown> = {};
      for (const claimKey of CLAIM_KEYS) {
        if (payload[claimKey] !== undefined) candidate[claimKey] = payload[claimKey];
      }
      if (!validate(candidate)) return null;
      return candidate as unknown as IdentityClaims;
    },
  };
}
