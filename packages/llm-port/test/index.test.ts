import { describe, expect, it } from 'vitest';
import { createLlmPort } from '../src/index.js';

describe('createLlmPort', () => {
  it('可构造端口实例，占位方法如实抛 NOT_IMPLEMENTED', () => {
    const port = createLlmPort({ allowedProviders: [] });
    expect(() => port.chat({ messages: [] })).toThrow(/^NOT_IMPLEMENTED/);
  });
});
