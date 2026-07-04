import { describe, expect, it } from 'vitest';
import { createToolGatePort } from '../src/index.js';

describe('createToolGatePort', () => {
  it('可构造端口实例，占位方法如实抛 NOT_IMPLEMENTED', () => {
    const port = createToolGatePort({ tools: [] });
    expect(() =>
      port.decide({
        sessionId: 's1',
        toolCallId: 'c1',
        toolId: 't1',
        params: {},
        claims: {
          sub: 'u1',
          tenant: 'default',
          roles: [],
          hostUserId: 'h1',
          iss: 'demo',
          exp: 0,
        },
      }),
    ).toThrow(/^NOT_IMPLEMENTED/);
    expect(() =>
      port.issueExecInstruction({ sessionId: 's1', toolCallId: 'c1', toolId: 't1', params: {} }),
    ).toThrow(/^NOT_IMPLEMENTED/);
    expect(() =>
      port.acceptExecResult({
        sessionId: 's1',
        result: { type: 'exec-result', sessionId: 's1', nonce: 'n1', ok: true },
      }),
    ).toThrow(/^NOT_IMPLEMENTED/);
  });
});
