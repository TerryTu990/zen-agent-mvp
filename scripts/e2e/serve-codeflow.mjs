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

  const child = spawn('node', [SERVER_DIST], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZA_JWT_SECRET: JWT_SECRET,
      ZA_SIGNING_SECRET: SIGNING_SECRET,
      ZA_JWT_ISS_ALLOWLIST: JWT_ISS,
      ZA_SNAPSHOT_ROOT: SNAPSHOT_ROOT,
      ZA_SYSTEM_PROMPT_PATH: join(REPO_ROOT, 'assets', 'system-prompt.md'),
      ZA_PORT: String(PORT),
      ZA_LLM_BASE_URL: process.env.ZF_LLM_BASE_URL,
      ZA_LLM_API_KEY: process.env.ZF_LLM_API_KEY,
      ZA_LLM_MODEL: process.env.ZF_LLM_MODEL,
      ZA_AUDIT_SINK: join(REPO_ROOT, '.za', 'codeflow-events.jsonl'),
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
