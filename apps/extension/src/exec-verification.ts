import type { ExecInstructionFrame, JsonValue } from './frames.js';

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`).join(',')}}`;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

export type ExecVerificationResult =
  | { ok: true }
  | { ok: false; error: 'instruction-invalid' | 'instruction-expired' | 'instruction-replayed' };

/**
 * 插件副作用前的机械防线：公钥来自同一条已鉴权 HTTPS/SSE 响应头；验签、绝对过期与 nonce
 * 去重全部通过后才把 nonce 原子加入 seen。这里不理解工具/策略，不承担服务端治理判定。
 */
export async function verifyExecInstruction(
  frame: ExecInstructionFrame,
  publicKey: string,
  seen: Set<string>,
  now = Date.now(),
): Promise<ExecVerificationResult> {
  if (seen.has(frame.nonce)) return { ok: false, error: 'instruction-replayed' };
  if (
    !Number.isInteger(frame.issuedAt) ||
    !Number.isInteger(frame.expiresAt) ||
    frame.expiresAt !== frame.issuedAt + frame.ttl ||
    now > frame.expiresAt
  ) {
    return { ok: false, error: 'instruction-expired' };
  }
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      decodeBase64Url(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const payload = stableStringify({
      sessionId: frame.sessionId,
      nonce: frame.nonce,
      issuedAt: frame.issuedAt,
      expiresAt: frame.expiresAt,
      ttl: frame.ttl,
      toolCallId: frame.toolCallId,
      request: frame.request,
    } as unknown as JsonValue);
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      decodeBase64Url(frame.signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) return { ok: false, error: 'instruction-invalid' };
    seen.add(frame.nonce);
    return { ok: true };
  } catch {
    return { ok: false, error: 'instruction-invalid' };
  }
}
