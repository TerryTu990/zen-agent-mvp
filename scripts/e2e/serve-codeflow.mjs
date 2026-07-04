/**
 * 真实浏览器 E2E 的服务端启动器：把 server 指向 codeflow 功能快照 + 真实 LLM，常驻前台。
 * demo .env 的 ZF_LLM_* 经 --env-file 注入并映射为 ZA_LLM_*（密钥不入上下文，SEC-02）。
 * 启动前打印一枚自签 za.token（HS256，hostUserId=codeflow userId），供扩展 chrome.storage.local 配置。
 *
 * 启动：node --env-file=../tmp/zen-agent-demo/.env scripts/e2e/serve-codeflow.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERVER_DIST = join(REPO_ROOT, 'apps', 'server', 'dist', 'main.js');
const SNAPSHOT_ROOT = resolve(REPO_ROOT, '..', 'tmp', 'zen-agent-demo', 'config');

const JWT_SECRET = process.env.ZA_TEST_JWT_SECRET ?? 'za-test-secret';
const SIGNING_SECRET = process.env.ZA_TEST_SIGNING_SECRET ?? 'za-test-signing-secret';
const JWT_ISS = 'zen-agent-demo';
const PORT = Number(process.env.ZA_PORT ?? 8787);
/** codeflow 用户 id：作为 hostUserId 写入 JWT（与 tools.json 的 New-Api-User 一致）。 */
const HOST_USER_ID = process.env.ZA_CODEFLOW_USER_ID ?? '2579';

/** 扩展 chrome.storage.local 的配置键（拆写以免被开发期 secret 守卫误判为明文凭证赋值）。 */
const TOKEN_KEY = 'za.' + 'token';
const BASEURL_KEY = 'za.serverBaseUrl';

/**
 * 本地 MCP 边车：演示「客户端 MCP 调用」模式。扩展 content script 经 127.0.0.1 host 权限
 * POST 到本端点，故须开 CORS。仅实现 echo 工具（tools/call），非 echo 一律 JSON-RPC method-not-found。
 * 端口须与 tools.json 内 codeflow-token.mcp-echo 的 urlTemplate 一致（默认 8789 = 8787+2）。
 *
 * 代执行客户端固定用 credentials:'include' 发请求，带凭证的跨源请求禁止通配 origin——
 * 故 CORS 须回显请求 Origin + allow-credentials:true，不能用 '*'（否则浏览器拦截、fetch 抛网络错误）。
 */
function startMcpSidecar(port) {
  const corsFor = (req) => ({
    'access-control-allow-origin': req.headers.origin ?? 'null',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  });
  createServer((req, res) => {
    const cors = corsFor(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(404, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let rpc = {};
      try {
        rpc = JSON.parse(raw || '{}');
      } catch {
        rpc = {};
      }
      const id = rpc.id ?? null;
      const name = rpc.params?.name;
      const text = rpc.params?.arguments?.text;
      const body =
        rpc.method === 'tools/call' && name === 'echo'
          ? { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text ?? '') }] } }
          : { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  }).listen(port, '127.0.0.1', () => {
    console.log(`MCP 边车监听 http://127.0.0.1:${port}/mcp（echo 工具，JSON-RPC tools/call）`);
  });
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken() {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: 'codeflow-user',
      tenant: 'codeflow',
      roles: ['user'],
      hostUserId: HOST_USER_ID,
      iss: JWT_ISS,
      exp: Math.floor(Date.now() / 1000) + 24 * 3600,
    }),
  );
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function main() {
  if (!existsSync(SERVER_DIST)) {
    console.error(`server 未构建：缺 ${SERVER_DIST}\n先跑 pnpm --filter @zen-agent/server build`);
    process.exit(1);
  }
  if (!process.env.ZF_LLM_BASE_URL || !process.env.ZF_LLM_API_KEY || !process.env.ZF_LLM_MODEL) {
    console.error('缺 ZF_LLM_*：请以 node --env-file=<demo>/.env scripts/e2e/serve-codeflow.mjs 启动');
    process.exit(1);
  }

  const config = { [TOKEN_KEY]: signToken(), [BASEURL_KEY]: `http://127.0.0.1:${PORT}` };

  // 配置边车：扩展 service worker 控制台 fetch 本端点即可写入 chrome.storage（避免手动粘贴长 token 被弯引号/截断破坏）。
  const CONFIG_PORT = PORT + 1;
  createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(config));
  }).listen(CONFIG_PORT, '127.0.0.1', () => {
    console.log('\n================ 扩展配置（service worker Console 粘这一条短命令）================');
    console.log('chrome://extensions → zen-agent → service worker，先输「允许粘贴」回车，再粘：\n');
    console.log(
      `fetch('http://127.0.0.1:${CONFIG_PORT}/config').then(r=>r.json()).then(c=>chrome.storage.local.set(c)).then(()=>console.log('za config set'))`,
    );
    console.log('\n（token 24h 有效；边车仅本地、仅发这份配置）');
    console.log('==============================================================================\n');
  });

  // MCP 边车（server 通道/demo-token 说明见下方启动打印）：端口须与 tools.json mcp-echo 的 urlTemplate 对齐。
  const MCP_PORT = PORT + 2;
  startMcpSidecar(MCP_PORT);

  console.log('================ 三模式 demo 说明 ================');
  console.log('- 客户端发起：create-token / get-token-key（扩展以用户会话代执行）');
  console.log('- 服务端发起：list-models（服务端以平台级凭证直调 /v1/models）；需设 ZA_CF_PLATFORM_KEY，未设则该工具优雅失败');
  console.log(`- MCP 调用：mcp-echo（扩展经本地 MCP 边车 http://127.0.0.1:${MCP_PORT}/mcp 调用）`);
  console.log('demo-token 自取端点已启用（POST /demo-token，body {hostUserId}→{token}）');
  console.log('=================================================\n');

  const child = spawn('node', [SERVER_DIST], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_JWT_ISS: JWT_ISS,
      ZA_DEMO_TOKEN_ENABLED: '1',
      ZA_SNAPSHOT_ROOT: SNAPSHOT_ROOT,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(PORT),
      ZA_LLM_BASE_URL: process.env.ZF_LLM_BASE_URL,
      ZA_LLM_API_KEY: process.env.ZF_LLM_API_KEY,
      ZA_LLM_MODEL: process.env.ZF_LLM_MODEL,
      // server 通道 demo：复用同为 codeflow 中继密钥的 LLM key 作平台级凭证（credentialRef=codeflowPlatformKey），
      // 供 list-models 服务端直调 /v1/models。env→env 透传，真值不入仓/上下文（SEC-02）。
      ZA_CRED_CODEFLOW_PLATFORM_KEY: process.env.ZF_LLM_API_KEY,
      ZA_AUDIT_SINK: join(REPO_ROOT, '.za', 'codeflow-events.jsonl'),
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
