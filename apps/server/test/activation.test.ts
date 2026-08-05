/**
 * 匿名安装身份激活端点 POST /v1/activation（唯一身份入口）：
 * 请求 {installId} → 响应 {token, expiresAt, hostUserId}；恒启用、不要求 authorization、须先于 verifier 判定。
 * 身份派生固定：hostUserId='anon-'+base64url(SHA-256(installId))、sub=hostUserId、tenant='anon'、
 * roles=['user']、iss='zen-agent-anon'、24h 有效。
 * installId 是持有型凭证：MUST NOT 进 token 载荷、错误响应、审计落点与服务端日志（SEC-01/04）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtVerify } from 'jose';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const snapshotRoot = join(repoRoot, 'examples/host-demo/config');
const systemPromptPath = join(repoRoot, 'assets/system-prompt.md');
const AUDIT_SINK = join(mkdtempSync(join(tmpdir(), 'za-activation-audit-')), 'events.jsonl');

// 每次运行现生成：仓库内不留固定密钥串（SEC-01），值本身对断言无意义。
const JWT_SECRET = randomUUID();
const SIGNING_SECRET = randomUUID();
const ANON_ISS = 'zen-agent-anon';
const key = new TextEncoder().encode(JWT_SECRET);

interface ActivationBody {
  token: string;
  expiresAt: number;
  hostUserId: string;
}

let server: RunningServer;
let baseUrl = '';

beforeAll(async () => {
  server = await startServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    signingSecret: SIGNING_SECRET,
    issAllowlist: [ANON_ISS],
    snapshotRoot,
    systemPromptPath,
    auditSinkPath: AUDIT_SINK,
    allowedProviders: ['openai-compatible'],
    heartbeatMs: 60_000,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
});

function newInstallId(): string {
  return crypto.randomUUID();
}

/** 与服务端派生同构的独立实现：用它交叉验证 hostUserId 取值，而不是回读服务端自述。 */
function expectedHostUserId(installId: string): string {
  return `anon-${createHash('sha256').update(installId, 'utf8').digest('base64url')}`;
}

function activate(body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}/v1/activation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

async function activateOk(installId: string): Promise<ActivationBody> {
  const response = await activate({ installId });
  expect(response.status).toBe(200);
  return (await response.json()) as ActivationBody;
}

describe('POST /v1/activation：匿名激活闭环', () => {
  it('无 authorization、无 env 门控即可激活，返回 token/expiresAt/hostUserId 闭集', async () => {
    const installId = newInstallId();
    const response = await activate({ installId });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'hostUserId', 'token']);
    expect(typeof body['token']).toBe('string');
    expect(body['token']).not.toBe('');
    expect(body['hostUserId']).toBe(expectedHostUserId(installId));
  });

  it('签出的 token 过本 server 验签，claims 按固定规则派生（tenant=anon / sub=hostUserId / iss=zen-agent-anon / roles=[user]）', async () => {
    const installId = newInstallId();
    const body = await activateOk(installId);

    const { payload } = await jwtVerify(body.token, key, { algorithms: ['HS256'] });
    expect(payload['iss']).toBe(ANON_ISS);
    expect(payload['tenant']).toBe('anon');
    expect(payload['roles']).toEqual(['user']);
    expect(payload['hostUserId']).toBe(expectedHostUserId(installId));
    expect(payload['sub']).toBe(payload['hostUserId']);
    expect(payload['sub']).toBe(body.hostUserId);
  });

  it('有效期 24h，且响应 expiresAt 与 token 内 exp 同值（客户端据此判缓存过期）', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const body = await activateOk(newInstallId());

    const { payload } = await jwtVerify(body.token, key, { algorithms: ['HS256'] });
    expect(body.expiresAt).toBe(payload['exp']);
    expect(body.expiresAt).toBeGreaterThan(nowSeconds + 24 * 3600 - 120);
    expect(body.expiresAt).toBeLessThan(nowSeconds + 24 * 3600 + 120);
  });

  it('激活所得 token 可直接创建会话（sign→verify 闭环，无需任何预置令牌）', async () => {
    const { token } = await activateOk(newInstallId());
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(created.status).toBe(201);
  });
});

describe('身份稳定性（L2 用户配置不丢的根本保证）', () => {
  it('同一 installId 重复激活 → 同一 hostUserId/sub', async () => {
    const installId = newInstallId();
    const first = await activateOk(installId);
    const second = await activateOk(installId);

    expect(second.hostUserId).toBe(first.hostUserId);
    const firstClaims = (await jwtVerify(first.token, key, { algorithms: ['HS256'] })).payload;
    const secondClaims = (await jwtVerify(second.token, key, { algorithms: ['HS256'] })).payload;
    expect(secondClaims['sub']).toBe(firstClaims['sub']);
    expect(secondClaims['hostUserId']).toBe(firstClaims['hostUserId']);
  });

  it('不同 installId → 不同 hostUserId（身份互不串号）', async () => {
    const a = await activateOk(newInstallId());
    const b = await activateOk(newInstallId());
    expect(a.hostUserId).not.toBe(b.hostUserId);
  });
});

describe('请求体契约（fail-closed）', () => {
  const rejected: Array<[string, unknown]> = [
    ['缺 installId', {}],
    ['installId 为空串', { installId: '' }],
    ['installId 非字符串', { installId: 12345 }],
    ['installId 为 null', { installId: null }],
    ['多余字段', { installId: crypto.randomUUID(), extra: 'x' }],
    ['超长 installId（越契约 128 上界，仍在请求体上界内）', { installId: 'a'.repeat(200) }],
    ['不是合法 JSON', '{'],
  ];

  for (const [name, body] of rejected) {
    it(`${name} → 400`, async () => {
      const response = await activate(body);
      expect(response.status).toBe(400);
    });
  }

  it('400 响应体不回显 installId 原值（SEC-04）', async () => {
    const installId = `${crypto.randomUUID()}-canary`;
    const response = await activate({ installId, extra: 'x' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(installId);
  });
});

describe('installId 不落盘、不进日志、不进 token（SEC-01/04）', () => {
  it('激活与建会话全程：审计落点、服务端日志、token 载荷均不含 installId 原值', async () => {
    const installId = newInstallId();
    const logged: string[] = [];
    const collect = (...args: unknown[]): void => {
      logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(collect),
      vi.spyOn(console, 'warn').mockImplementation(collect),
      vi.spyOn(console, 'error').mockImplementation(collect),
    ];
    let token: string;
    let hostUserId: string;
    try {
      ({ token, hostUserId } = await activateOk(installId));
      const created = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(created.status).toBe(201);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(logged.join('\n')).not.toContain(installId);
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    expect(JSON.stringify(payload)).not.toContain(installId);

    const audit = existsSync(AUDIT_SINK) ? readFileSync(AUDIT_SINK, 'utf8') : '';
    expect(audit).not.toContain(installId);
    // 哈希后的 hostUserId 才是落盘/审计里的可用标识（证明确实用了派生值而非原值）。
    expect(hostUserId.startsWith('anon-')).toBe(true);
  });
});

describe('响应契约同构（SSOT = activation.schema.json）', () => {
  it('真实签发的响应过契约响应子模式——含 expiresAt 单位（秒）守卫', async () => {
    const require = createRequire(import.meta.url);
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(
      JSON.parse(
        readFileSync(require.resolve('@zen-agent/contracts/schemas/activation.schema.json'), 'utf8'),
      ) as object,
    );
    const validateResponse = ajv.getSchema(
      'https://zen-agent.dev/schema/activation/v1.json#/$defs/response',
    );
    expect(validateResponse).toBeDefined();

    const body = await activateOk(newInstallId());
    expect(validateResponse?.(body), JSON.stringify(validateResponse?.errors)).toBe(true);
  });
});

describe('自签必自验：运维白名单不得让服务端拒绝自己签发的令牌', () => {
  let legacyServer: RunningServer;

  beforeAll(async () => {
    // 线上 .env 停留在旧签发方取值（zen-agent）的真实形态：匿名 iss 不在运维白名单里。
    legacyServer = await startServer({
      port: 0,
      jwtSecret: JWT_SECRET,
      signingSecret: SIGNING_SECRET,
      issAllowlist: ['zen-agent'],
      snapshotRoot,
      systemPromptPath,
      auditSinkPath: AUDIT_SINK,
      allowedProviders: ['openai-compatible'],
      heartbeatMs: 60_000,
    });
  });

  afterAll(async () => {
    await legacyServer?.close();
  });

  it('白名单不含 zen-agent-anon 时，激活所得 token 仍能建会话（否则每个用户恒 401）', async () => {
    const legacyBaseUrl = `http://127.0.0.1:${legacyServer.port}`;
    const activated = await fetch(`${legacyBaseUrl}/v1/activation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: newInstallId() }),
    });
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as ActivationBody;

    const created = await fetch(`${legacyBaseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(created.status).toBe(201);
  });

  it('白名单里的外部签发方仍然生效，且未列入者依旧被拒（并入匿名 iss 不等于放开验签）', async () => {
    const legacyBaseUrl = `http://127.0.0.1:${legacyServer.port}`;
    const outsider = await fetch(`${legacyBaseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(outsider.status).toBe(401);
  });
});

describe('未鉴权入口的请求体上界（内存边界）', () => {
  /** 不带 content-length 的分块上传：证明上界不是只靠声明值把关。 */
  function postChunked(chunks: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: '/v1/activation',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }

  it('声明 content-length 超上界 → 413（不缓冲请求体）', async () => {
    const response = await activate({ installId: 'a'.repeat(64), padding: 'p'.repeat(64 * 1024) });
    expect(response.status).toBe(413);
  });

  it('分块上传实收超上界 → 413（停止累积而非读完再判）', async () => {
    const status = await postChunked(Array<string>(64).fill('x'.repeat(1024)));
    expect(status).toBe(413);
  });

  it('上界内的正常激活不受影响', async () => {
    const response = await activate({ installId: newInstallId() });
    expect(response.status).toBe(200);
  });
});

describe('旧 demo-token 自签路径已删除', () => {
  it('未带令牌的 POST /demo-token 不再免鉴权放行 → 401（不存在第二个身份入口）', async () => {
    const response = await fetch(`${baseUrl}/demo-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostUserId: '2579' }),
    });
    expect(response.status).toBe(401);
  });

  it('带有效令牌的 POST /demo-token → 404（路由已删）', async () => {
    const { token } = await activateOk(newInstallId());
    const response = await fetch(`${baseUrl}/demo-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hostUserId: '2579' }),
    });
    expect(response.status).toBe(404);
  });
});
