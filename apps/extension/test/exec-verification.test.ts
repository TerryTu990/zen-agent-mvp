import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecInstructionFrame, JsonValue } from '../src/frames.js';
import { verifyExecInstruction } from '../src/exec-verification.js';

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`).join(',')}}`;
}

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url');
}

async function signedFrame(
  now = 1_000,
  page?: string,
): Promise<{ frame: ExecInstructionFrame; publicKey: string }> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const frame: ExecInstructionFrame = {
    type: 'exec-instruction',
    sessionId: 's1',
    nonce: 'nonce-1',
    issuedAt: now,
    expiresAt: now + 60_000,
    ttl: 60_000,
    signature: '',
    toolCallId: 'call-1',
    ...(page !== undefined ? { page } : {}),
    request: {
      kind: 'dom',
      expectedPageUrl: 'https://seller.example/chat/order-1',
      expectedPageInstanceId: 'page-1',
      steps: [
        { action: 'fill', ref: 'za-1', value: 'message' },
        { action: 'click', ref: 'za-2' },
      ],
    },
  };
  const payload = stableStringify({
    sessionId: frame.sessionId,
    nonce: frame.nonce,
    issuedAt: frame.issuedAt,
    expiresAt: frame.expiresAt,
    ttl: frame.ttl,
    toolCallId: frame.toolCallId,
    ...(page !== undefined ? { page } : {}),
    request: frame.request,
  } as unknown as JsonValue);
  frame.signature = base64Url(
    await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(payload)),
  );
  return {
    frame,
    publicKey: base64Url(await webcrypto.subtle.exportKey('spki', pair.publicKey)),
  };
}

describe('exec-instruction 副作用前验证', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto));
  it('合法帧只接受一次；同 nonce 重放在执行前拒绝', async () => {
    const { frame, publicKey } = await signedFrame();
    const seen = new Set<string>();
    await expect(verifyExecInstruction(frame, publicKey, seen, 's1', 2_000)).resolves.toEqual({ ok: true });
    await expect(verifyExecInstruction(frame, publicKey, seen, 's1', 2_000)).resolves.toEqual({
      ok: false,
      error: 'instruction-replayed',
    });
  });

  it('request/页面围栏或会话被篡改、绝对过期时拒绝', async () => {
    const { frame, publicKey } = await signedFrame();
    const tampered: ExecInstructionFrame = {
      ...frame,
      request: { kind: 'dom', steps: [{ action: 'click', ref: 'za-other' }] },
    };
    await expect(verifyExecInstruction(tampered, publicKey, new Set(), 's1', 2_000)).resolves.toEqual({
      ok: false,
      error: 'instruction-invalid',
    });
    await expect(
      verifyExecInstruction({ ...frame, sessionId: 'other-session' }, publicKey, new Set(), 's1', 2_000),
    ).resolves.toEqual({ ok: false, error: 'instruction-invalid' });
    await expect(verifyExecInstruction(frame, publicKey, new Set(), 's1', frame.expiresAt + 1)).resolves.toEqual({
      ok: false,
      error: 'instruction-expired',
    });
  });

  it('同公钥为其它会话合法签发的帧也必须在当前 SSE 会话执行前拒绝', async () => {
    const { frame, publicKey } = await signedFrame();
    await expect(
      verifyExecInstruction(frame, publicKey, new Set(), 'current-sse-session', 2_000),
    ).resolves.toEqual({ ok: false, error: 'instruction-invalid' });
  });

  it('带 page 的定向帧：page 入签名 payload 后验签通过（adr-023 D3）', async () => {
    const { frame, publicKey } = await signedFrame(1_000, 'p2');
    await expect(verifyExecInstruction(frame, publicKey, new Set(), 's1', 2_000)).resolves.toEqual({
      ok: true,
    });
  });

  it('篡改或剥除帧上 page（改投落点）：验签失败（负锚）', async () => {
    const { frame, publicKey } = await signedFrame(1_000, 'p2');
    await expect(
      verifyExecInstruction({ ...frame, page: 'p9' }, publicKey, new Set(), 's1', 2_000),
    ).resolves.toEqual({ ok: false, error: 'instruction-invalid' });
    const { page: _stripped, ...rest } = frame;
    await expect(
      verifyExecInstruction(rest as ExecInstructionFrame, publicKey, new Set(), 's1', 2_000),
    ).resolves.toEqual({ ok: false, error: 'instruction-invalid' });
  });

  it('给缺省帧塞 page（伪造定向）：验签失败（负锚）', async () => {
    const { frame, publicKey } = await signedFrame();
    await expect(
      verifyExecInstruction({ ...frame, page: 'p2' }, publicKey, new Set(), 's1', 2_000),
    ).resolves.toEqual({ ok: false, error: 'instruction-invalid' });
  });
});
