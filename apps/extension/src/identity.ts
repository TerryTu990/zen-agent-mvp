/**
 * 匿名自动登录（adr-022）：首次运行生成安装 id 落 chrome.storage.local，以它换取短期匿名令牌并缓存。
 * 安装 id 是持有型凭证——只存本地、只随激活请求发往受信服务端，MUST NOT 进日志与错误消息（SEC-01/04）。
 * 客户端零治理判定（U7）：令牌是否可用由服务端验签决定，本层只负责取、缓、刷。
 */
export interface IdentityProvider {
  /** 缓存命中且未过期即直接返回，否则以安装 id 激活换新令牌；失败一律抛错，不返回空值冒充成功。 */
  getToken(baseUrl: string): Promise<string>;
  /** 强制丢弃缓存重新激活（服务端 401 后调用）。 */
  refreshToken(baseUrl: string): Promise<string>;
  /** 丢弃全部已缓存令牌与退避状态（安装 id 变更即换身份，旧身份令牌不得再被复用）。 */
  invalidate(): Promise<void>;
}

const INSTALL_ID_KEY = 'za.installId';
const ANON_TOKEN_KEY = 'za.anonToken';
/** 令牌 exp 前的提前量（秒）：请求在途期间过期会被服务端拒，提前换避免可预见的 401。 */
const EXPIRY_SKEW_SECONDS = 60;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

interface ActivationResult {
  token: string;
  /** 服务端签发的到期时刻（epoch 秒，与 JWT exp 同值）。 */
  expiresAt: number;
}

interface CachedToken extends ActivationResult {
  /** 签发它的服务端地址：换地址即换签发方（secret 可能不同），旧令牌一律视为未命中。 */
  baseUrl: string;
}

function parseActivation(value: unknown): ActivationResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const { token, expiresAt } = value as { token?: unknown; expiresAt?: unknown };
  if (typeof token !== 'string' || token === '' || typeof expiresAt !== 'number') return null;
  return { token, expiresAt };
}

function parseCachedToken(value: unknown): CachedToken | null {
  const entry = parseActivation(value);
  if (entry === null) return null;
  const { baseUrl } = value as { baseUrl?: unknown };
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  return { ...entry, baseUrl };
}

function isUsable(entry: CachedToken, baseUrl: string): boolean {
  return entry.baseUrl === baseUrl && entry.expiresAt - EXPIRY_SKEW_SECONDS > Date.now() / 1000;
}

async function ensureInstallId(): Promise<string> {
  const items = await chrome.storage.local.get(INSTALL_ID_KEY);
  const stored = items[INSTALL_ID_KEY];
  if (typeof stored === 'string' && stored !== '') return stored;
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: installId });
  return installId;
}

/** 缓存、单飞与退避一律按服务端地址分账：一台服务端打不通不得连累另一台（改对地址即刻可用）。 */
interface HostState {
  cached: CachedToken | null;
  inflight: Promise<string> | null;
  failures: number;
  nextAttemptAt: number;
}

export function createIdentityProvider(): IdentityProvider {
  const hosts = new Map<string, HostState>();
  /** 每次 invalidate 递增：在途激活据此判断自己是否已属旧身份，旧身份结果一律不落缓存。 */
  let generation = 0;

  function stateOf(baseUrl: string): HostState {
    const existing = hosts.get(baseUrl);
    if (existing !== undefined) return existing;
    const created: HostState = { cached: null, inflight: null, failures: 0, nextAttemptAt: 0 };
    hosts.set(baseUrl, created);
    return created;
  }

  async function runActivation(baseUrl: string, state: HostState): Promise<string> {
    const issuedFor = generation;
    const installId = await ensureInstallId();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/activation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installId }),
      });
    } catch {
      throw new Error('无法连接 zen-agent 服务，身份激活失败');
    }
    if (!response.ok) throw new Error(`身份激活被拒绝（HTTP ${response.status}）`);
    const result = parseActivation(await response.json().catch(() => null));
    if (result === null) throw new Error('身份激活响应缺少有效字段');
    const entry: CachedToken = { ...result, baseUrl };
    // 身份在激活在途期间被换掉：本次结果只交还给发起方，不写缓存，否则旧身份令牌会在下一次取用时复活。
    if (issuedFor !== generation) return entry.token;
    state.cached = entry;
    await chrome.storage.local.set({ [ANON_TOKEN_KEY]: entry });
    return entry.token;
  }

  /** 单飞 + 失败退避：并发取令牌只打一次网络，连续失败按指数退避拒绝，不向服务端重试风暴。 */
  function activate(baseUrl: string, state: HostState): Promise<string> {
    const existing = state.inflight;
    if (existing !== null) return existing;
    if (Date.now() < state.nextAttemptAt) {
      return Promise.reject(new Error('身份激活失败后仍在退避窗口内，请稍后重试'));
    }
    const started = runActivation(baseUrl, state).then(
      (token) => {
        state.failures = 0;
        state.nextAttemptAt = 0;
        return token;
      },
      (cause: unknown) => {
        state.failures += 1;
        state.nextAttemptAt =
          Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS);
        throw cause;
      },
    );
    state.inflight = started;
    const settle = (): void => {
      if (state.inflight === started) state.inflight = null;
    };
    started.then(settle, settle);
    return started;
  }

  return {
    async getToken(baseUrl) {
      const state = stateOf(baseUrl);
      const memo = state.cached;
      if (memo !== null && isUsable(memo, baseUrl)) return memo.token;
      const items = await chrome.storage.local.get(ANON_TOKEN_KEY);
      const stored = parseCachedToken(items[ANON_TOKEN_KEY]);
      if (stored !== null && isUsable(stored, baseUrl)) {
        state.cached = stored;
        return stored.token;
      }
      return activate(baseUrl, state);
    },
    async refreshToken(baseUrl) {
      const state = stateOf(baseUrl);
      state.cached = null;
      return activate(baseUrl, state);
    },
    async invalidate() {
      generation += 1;
      hosts.clear();
      await chrome.storage.local.remove(ANON_TOKEN_KEY);
    },
  };
}
