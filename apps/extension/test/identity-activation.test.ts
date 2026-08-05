/**
 * 插件匿名身份（装上就能用，用户零输入）：首次运行生成安装 id 落 chrome.storage.local['za.installId']，
 * 以它向 POST /v1/activation 换取匿名令牌并缓存到 ['za.anonToken']；过期或 401 才重新激活。
 * 客户端零治理判定：令牌是否可用一律由服务端验签决定，本层只管取、缓、刷。
 * 失败须单飞 + 退避（不重试风暴），且安装 id/令牌值不进错误消息（SEC-04）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentityProvider, type IdentityProvider } from '../src/identity.js';

const BASE_URL = 'http://127.0.0.1:8787';
const INSTALL_ID_KEY = 'za.installId';
const ANON_TOKEN_KEY = 'za.anonToken';
/** 明显的假值：只用于断言"值不外泄"，不是任何真实凭证。 */
const TOKEN_CANARY = 'fake-anon-token-canary';

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

interface StubResponse {
  status: number;
  body: unknown;
}

interface Harness {
  identity: IdentityProvider;
  /** 新建一个 provider（模拟 service worker 回收后重启），共用同一 storage。 */
  restart(): IdentityProvider;
  storage: Record<string, unknown>;
  /** chrome.storage.local.get 请求过的全部键（回归断言：不再出现 za.token）。 */
  readKeys: string[];
  calls: FetchCall[];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ok(body: unknown): StubResponse {
  return { status: 200, body };
}

function activationBody(installId: string, options: { token?: string; expiresAt?: number } = {}): unknown {
  return {
    token: options.token ?? TOKEN_CANARY,
    expiresAt: options.expiresAt ?? nowSeconds() + 24 * 3600,
    hostUserId: `anon-hash-of-${installId.slice(0, 4)}`,
  };
}

function jsonResponse(stub: StubResponse): Response {
  return {
    status: stub.status,
    ok: stub.status >= 200 && stub.status < 300,
    json: async () => stub.body,
    text: async () => JSON.stringify(stub.body),
  } as unknown as Response;
}

/** respond 返回 StubResponse 即为一次 HTTP 应答；抛错即模拟网络不可达。 */
function createHarness(options: {
  storage?: Record<string, unknown>;
  respond?: (call: FetchCall, index: number) => StubResponse | Promise<StubResponse>;
} = {}): Harness {
  const storage: Record<string, unknown> = { ...options.storage };
  const readKeys: string[] = [];
  const calls: FetchCall[] = [];

  const area = {
    async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      const wanted = keys === null ? Object.keys(storage) : typeof keys === 'string' ? [keys] : keys;
      readKeys.push(...wanted);
      const picked: Record<string, unknown> = {};
      for (const key of wanted) if (key in storage) picked[key] = storage[key];
      return picked;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(storage, items);
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete storage[key];
    },
  };

  vi.stubGlobal('chrome', {
    storage: { local: area, session: area, onChanged: { addListener: (): void => {} } },
  });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}): Promise<Response> => {
    const call: FetchCall = {
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(call);
    const respond = options.respond ?? ((c: FetchCall) => ok(activationBody(String(c.body['installId']))));
    return jsonResponse(await respond(call, calls.length - 1));
  });

  return {
    identity: createIdentityProvider(),
    restart: () => createIdentityProvider(),
    storage,
    readKeys,
    calls,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('安装 id（za.installId）', () => {
  it('首次运行生成并落库；激活请求体闭集只有 installId', async () => {
    const h = createHarness();

    await h.identity.getToken(BASE_URL);

    const installId = h.storage[INSTALL_ID_KEY];
    expect(typeof installId).toBe('string');
    // 122+ 位随机不可枚举（UUIDv4 即可）：至少 32 字符且不是可猜的短值。
    expect(String(installId).length).toBeGreaterThanOrEqual(32);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`${BASE_URL}/v1/activation`);
    expect(h.calls[0]!.method).toBe('POST');
    expect(h.calls[0]!.body).toEqual({ installId });
  });

  it('已有安装 id 一律复用，不重新生成（换身份 = 换 installId）', async () => {
    const preset = 'a0e1b2c3-4d5e-4f60-8a71-9b2c3d4e5f60';
    const h = createHarness({ storage: { [INSTALL_ID_KEY]: preset } });

    await h.identity.getToken(BASE_URL);
    // SW 重启后新建 provider 仍复用同一安装 id（身份跨重启稳定 → L2 用户配置不丢）。
    await h.restart().refreshToken(BASE_URL);

    expect(h.storage[INSTALL_ID_KEY]).toBe(preset);
    expect(h.calls.map((call) => call.body['installId'])).toEqual([preset, preset]);
  });
});

describe('匿名令牌缓存（za.anonToken）', () => {
  it('零预置即自动激活，令牌缓存进 za.anonToken', async () => {
    const h = createHarness();

    const token = await h.identity.getToken(BASE_URL);

    expect(token).toBe(TOKEN_CANARY);
    expect(h.storage[ANON_TOKEN_KEY]).toBeDefined();
    expect(JSON.stringify(h.storage[ANON_TOKEN_KEY])).toContain(TOKEN_CANARY);
  });

  it('缓存未过期时不再请求服务端——包括 SW 重启后的新 provider', async () => {
    const h = createHarness();

    expect(await h.identity.getToken(BASE_URL)).toBe(TOKEN_CANARY);
    expect(await h.identity.getToken(BASE_URL)).toBe(TOKEN_CANARY);
    expect(await h.restart().getToken(BASE_URL)).toBe(TOKEN_CANARY);

    expect(h.calls).toHaveLength(1);
  });

  it('缓存过期 → 用同一 installId 自动重新激活', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = createHarness({
      respond: (call, index) =>
        ok(activationBody(String(call.body['installId']), {
          token: `${TOKEN_CANARY}-${index}`,
          expiresAt: nowSeconds() + 3600,
        })),
    });

    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-0`);
    vi.setSystemTime(Date.now() + 3700_000);
    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.body['installId']).toBe(h.calls[0]!.body['installId']);
  });

  it('服务端 401 → refreshToken 丢弃缓存重新激活一次（不是每次调用都激活）', async () => {
    const h = createHarness({
      respond: (call, index) =>
        ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` })),
    });

    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-0`);
    expect(await h.identity.refreshToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);
    // 刷新后的令牌即新缓存：后续 getToken 复用它、不再打网络。
    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);

    expect(h.calls).toHaveLength(2);
    expect(JSON.stringify(h.storage[ANON_TOKEN_KEY])).toContain(`${TOKEN_CANARY}-1`);
  });
});

describe('缓存按服务端地址归属（换地址即换签发方）', () => {
  const OTHER_URL = 'https://agent.example.test';

  it('换服务端地址不复用旧地址签发的令牌', async () => {
    const h = createHarness({
      respond: (call, index) =>
        ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` })),
    });

    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-0`);
    expect(await h.identity.getToken(OTHER_URL)).toBe(`${TOKEN_CANARY}-1`);

    expect(h.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/activation`,
      `${OTHER_URL}/v1/activation`,
    ]);
  });

  it('SW 重启后落盘缓存同样认地址：新地址不命中旧条目', async () => {
    const h = createHarness({
      respond: (call, index) =>
        ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` })),
    });

    await h.identity.getToken(BASE_URL);
    expect(await h.restart().getToken(OTHER_URL)).toBe(`${TOKEN_CANARY}-1`);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.url).toBe(`${OTHER_URL}/v1/activation`);
  });
});

describe('失败路径：单飞 + 退避，不重试风暴', () => {
  it('并发取令牌只打一次网络（单飞）', async () => {
    const release: Array<() => void> = [];
    const gate = new Promise<void>((resolve) => {
      release.push(() => resolve());
    });
    const h = createHarness({
      respond: async (call) => {
        await gate;
        return ok(activationBody(String(call.body['installId'])));
      },
    });

    const pending = [0, 1, 2, 3, 4].map(() => h.identity.getToken(BASE_URL));
    for (const resume of release) resume();
    const tokens = await Promise.all(pending);

    expect(tokens).toEqual(Array<string>(5).fill(TOKEN_CANARY));
    expect(h.calls).toHaveLength(1);
  });

  it('连续失败按退避收敛：6 次尝试的网络请求次数有上限', async () => {
    const h = createHarness({
      respond: () => {
        throw new Error('network down');
      },
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(h.identity.getToken(BASE_URL)).rejects.toThrow();
    }

    // 首次必须真打网络（否则"次数上限"会被"从不请求"冒充通过）。
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls.length).toBeLessThanOrEqual(2);
  });

  it('退避按服务端地址分账：一台打不通不阻塞另一台（改对地址即刻可用）', async () => {
    const unreachable = 'http://127.0.0.1:9';
    const h = createHarness({
      respond: (call) => {
        if (call.url.startsWith(unreachable)) throw new Error('network down');
        return ok(activationBody(String(call.body['installId'])));
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(h.identity.getToken(unreachable)).rejects.toThrow();
    }
    // 前一地址已进退避窗口；换地址后必须真打网络并拿到令牌，而不是被窗口连坐。
    expect(await h.identity.getToken(BASE_URL)).toBe(TOKEN_CANARY);
    expect(h.calls.some((call) => call.url.startsWith(BASE_URL))).toBe(true);
  });

  it('服务端拒绝激活（5xx）如实失败，不返回空令牌冒充成功', async () => {
    const h = createHarness({ respond: () => ({ status: 503, body: { error: '激活暂不可用' } }) });

    await expect(h.identity.getToken(BASE_URL)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    expect(h.storage[ANON_TOKEN_KEY]).toBeUndefined();
  });
});

describe('换身份 = 换 installId（invalidate）', () => {
  const OLD_INSTALL_ID = 'a0e1b2c3-4d5e-4f60-8a71-9b2c3d4e5f60';
  const NEW_INSTALL_ID = 'b1f2c3d4-5e6f-4071-8b82-0c3d4e5f6071';

  function byIndex(): (call: FetchCall, index: number) => StubResponse {
    return (call, index) =>
      ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` }));
  }

  it('运行中改 installId → invalidate 后下一次 getToken 换新身份', async () => {
    const h = createHarness({ storage: { [INSTALL_ID_KEY]: OLD_INSTALL_ID }, respond: byIndex() });

    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-0`);
    h.storage[INSTALL_ID_KEY] = NEW_INSTALL_ID;
    await h.identity.invalidate();

    expect(h.storage[ANON_TOKEN_KEY]).toBeUndefined();
    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);
    expect(h.calls.map((call) => call.body['installId'])).toEqual([OLD_INSTALL_ID, NEW_INSTALL_ID]);
  });

  it('invalidate 一并清退避窗口：换身份不必等退避走完', async () => {
    let down = true;
    const h = createHarness({
      storage: { [INSTALL_ID_KEY]: OLD_INSTALL_ID },
      respond: (call, index) => {
        if (down) throw new Error('network down');
        return ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` }));
      },
    });

    await expect(h.identity.getToken(BASE_URL)).rejects.toThrow();
    down = false;
    // 未 invalidate 时仍在退避窗口内（证明窗口真实存在，否则下一条断言不成立）。
    await expect(h.identity.getToken(BASE_URL)).rejects.toThrow();

    h.storage[INSTALL_ID_KEY] = NEW_INSTALL_ID;
    await h.identity.invalidate();
    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);
    expect(h.calls[1]!.body['installId']).toBe(NEW_INSTALL_ID);
  });

  it('激活在途时换身份：旧身份令牌不落缓存（不会在下次取用时复活）', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = (): void => resolve();
    });
    const h = createHarness({
      storage: { [INSTALL_ID_KEY]: OLD_INSTALL_ID },
      respond: async (call, index) => {
        if (index === 0) await gate;
        return ok(activationBody(String(call.body['installId']), { token: `${TOKEN_CANARY}-${index}` }));
      },
    });

    const pending = h.identity.getToken(BASE_URL);
    // 必须等激活请求真的发出去，否则测的是「换身份发生在发起之前」——那条路径本就用新 installId。
    for (let tick = 0; tick < 50 && h.calls.length === 0; tick += 1) await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body['installId']).toBe(OLD_INSTALL_ID);

    h.storage[INSTALL_ID_KEY] = NEW_INSTALL_ID;
    await h.identity.invalidate();
    release();

    expect(await pending).toBe(`${TOKEN_CANARY}-0`);
    expect(h.storage[ANON_TOKEN_KEY]).toBeUndefined();
    expect(await h.identity.getToken(BASE_URL)).toBe(`${TOKEN_CANARY}-1`);
    expect(h.calls[1]!.body['installId']).toBe(NEW_INSTALL_ID);
  });

  it('background 把 za.installId 变更接到 identity.invalidate（接线回归）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/background.ts', import.meta.url)), 'utf8');
    expect(source).toContain("changes['za.installId']");
    expect(source).toContain('identity.invalidate()');
  });
});

describe('SEC-04：安装 id 与令牌值不进错误消息', () => {
  it('激活失败的错误消息既不含 installId 也不含响应里的令牌值', async () => {
    const preset = 'c0ffee00-1111-4222-8333-444455556666';
    const h = createHarness({
      storage: { [INSTALL_ID_KEY]: preset },
      respond: () => ({ status: 500, body: { error: 'boom', token: TOKEN_CANARY } }),
    });

    const message = await h.identity.getToken(BASE_URL).then(
      () => '（未如期失败）',
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );

    expect(message).not.toBe('（未如期失败）');
    // 失败必须来自真实激活请求，而不是"根本没发起"。
    expect(h.calls).toHaveLength(1);
    expect(message).not.toContain(preset);
    expect(message).not.toContain(TOKEN_CANARY);
  });
});

describe('手填访问令牌路径已删除（回归）', () => {
  it('运行期从不读取 za.token', async () => {
    const h = createHarness();

    await h.identity.getToken(BASE_URL);
    await h.identity.refreshToken(BASE_URL);

    expect(h.readKeys).not.toContain('za.token');
    expect(Object.keys(h.storage)).not.toContain('za.token');
  });

  it('插件源码中不再有手填令牌痕迹（存储键 za.token 与配置中心输入框 za-cc-token 全删）', () => {
    const needles = ['za.token', 'za-cc-token'];
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const files = readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, text: readFileSync(`${srcDir}${name}`, 'utf8') }));
    files.push({
      name: 'options.html',
      text: readFileSync(fileURLToPath(new URL('../options.html', import.meta.url)), 'utf8'),
    });

    const offenders = files
      .filter((file) => needles.some((needle) => file.text.includes(needle)))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
