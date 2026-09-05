// @vitest-environment jsdom
/**
 * content 脚本的重复注入守卫：轨一逐次 executeScript，同一文档可能被注入多次
 * （手势重复、导航补发与定向帧到达撞在一起）。第二次注入必须整体空转——
 * 否则同一页会挂上两套 runtime 监听与两条会话端口，一条指令被执行两次即副作用重复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentRuntimeMessage, ContentToBackgroundMessage } from '../src/messaging.js';

type ContentMessage = ContentToBackgroundMessage | ContentRuntimeMessage;

interface Probe {
  runtimeListeners: number;
  ports: number;
  sent: ContentMessage[];
  activate(): void;
}

function installChrome(): Probe {
  const runtimeListeners: Array<(raw: unknown) => void> = [];
  const sent: ContentMessage[] = [];
  let ports = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (cb: (raw: unknown) => void): void => void runtimeListeners.push(cb) },
      sendMessage: async (message: unknown): Promise<void> => void sent.push(message as ContentMessage),
      connect: () => {
        ports += 1;
        return {
          onMessage: { addListener: (): void => undefined },
          onDisconnect: { addListener: (): void => undefined },
          postMessage: (message: ContentToBackgroundMessage): void => void sent.push(message),
          disconnect: (): void => undefined,
        };
      },
    },
    storage: { local: { get: async (): Promise<Record<string, unknown>> => ({}) } },
  });
  vi.stubGlobal('setInterval', () => 0);
  return {
    get runtimeListeners() {
      return runtimeListeners.length;
    },
    get ports() {
      return ports;
    },
    sent,
    activate: () => {
      for (const listener of runtimeListeners) listener({ kind: 'activate' });
    },
  };
}

async function inject(): Promise<void> {
  vi.resetModules();
  await import('../src/content.js');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

let probe: Probe;

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>)['__zaInjected'];
  probe = installChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('重复注入幂等', () => {
  it('第二次注入不再挂监听、不再握手', async () => {
    await inject();
    expect(probe.runtimeListeners).toBe(1);
    const handshakes = probe.sent.filter((message) => message.kind === 'request-activate').length;
    expect(handshakes).toBe(1);

    await inject();
    expect(probe.runtimeListeners).toBe(1);
    expect(probe.sent.filter((message) => message.kind === 'request-activate')).toHaveLength(1);
  });

  it('重复注入后收到 activate 仍只建一条会话端口', async () => {
    await inject();
    await inject();
    probe.activate();
    await Promise.resolve();
    expect(probe.ports).toBe(1);
  });
});

describe('激活握手不再携带客户端 origin 名单', () => {
  it('request-activate 只报「content 已就位」这一件事', async () => {
    await inject();
    const handshake = probe.sent.find((message) => message.kind === 'request-activate');
    expect(handshake).toEqual({ kind: 'request-activate' });
  });
});
