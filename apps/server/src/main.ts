/**
 * CLI 入口：env → ServerOptions → startServer。
 * ZA_LLM_BASE_URL / ZA_LLM_API_KEY / ZA_LLM_MODEL 由 llm-port 在调用时读取，此处只做启动期提示。
 */
import { ANON_ISS } from './activation.js';
import { startServer } from './index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} 未设置，拒绝启动`);
    process.exit(1);
  }
  return value;
}

/**
 * server 通道凭证解析：credentialRef → env `ZA_CRED_<UPPER_SNAKE(ref)>` 的真值（如 codeflowPlatformKey → ZA_CRED_CODEFLOW_PLATFORM_KEY）。
 * 真值只在执行器边界经此惰性读取、注入本次请求，不落配置/日志/审计（SEC-01/02）。
 */
function resolveCredential(ref: string): string | undefined {
  const key = `ZA_CRED_${ref.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value && value !== '' ? value : undefined;
}

const jwtSecret = requireEnv('ZA_JWT_SECRET');
const signingSecret = requireEnv('ZA_SIGNING_SECRET');
const snapshotRoot = requireEnv('ZA_SNAPSHOT_ROOT');
const port = Number(process.env['ZA_PORT'] ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('ZA_PORT 不是合法端口号，拒绝启动');
  process.exit(1);
}
// 监听地址：默认仅本机；容器/对外部署显式设 ZA_HOST=0.0.0.0（对外暴露是有意决策，不做默认）。
const host = process.env['ZA_HOST'] ?? '127.0.0.1';
const maxTurnRounds = Number(process.env['ZA_MAX_TURN_ROUNDS'] ?? 12);
if (!Number.isInteger(maxTurnRounds) || maxTurnRounds < 1) {
  console.error('ZA_MAX_TURN_ROUNDS 不是正整数，拒绝启动');
  process.exit(1);
}
const sessionTtlMs = Number(process.env['ZA_SESSION_TTL_MS'] ?? 3_600_000);
if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 1) {
  console.error('ZA_SESSION_TTL_MS 不是正整数，拒绝启动');
  process.exit(1);
}
const compressContextWindow = Number(process.env['ZA_LLM_CONTEXT_WINDOW'] ?? 200_000);
if (!Number.isInteger(compressContextWindow) || compressContextWindow < 1) {
  console.error('ZA_LLM_CONTEXT_WINDOW 不是正整数，拒绝启动');
  process.exit(1);
}
const compressThreshold = Number(process.env['ZA_LLM_COMPRESS_THRESHOLD'] ?? 0.6);
if (!Number.isFinite(compressThreshold) || compressThreshold <= 0 || compressThreshold > 1) {
  console.error('ZA_LLM_COMPRESS_THRESHOLD 不是 (0,1] 区间小数，拒绝启动');
  process.exit(1);
}
// LLM 分层超时（llm-port）由该端口就地读取；网关侧两项（连续失败预算、人工确认等待上限）在此解析为
// ServerOptions 后经组装点注入，与其余配置共用同一条通路。启动期取值校验把「配置写错」挡在启动时，
// 而不是推迟成运行期的静默不生效。未设置＝该项不启用。
for (const name of [
  'ZA_LLM_TIMEOUT_MS',
  'ZA_LLM_FIRST_CHUNK_MS',
  'ZA_LLM_IDLE_MS',
  'ZA_MAX_CONSECUTIVE_FAILURES',
  'ZA_HITL_TIMEOUT_MS',
] as const) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') continue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} 不是正整数，拒绝启动`);
    process.exit(1);
  }
}

/** 已过启动期校验的正整数 env；未设或空串返回 undefined（＝该项不启用）。 */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return Number(raw);
}

const maxConsecutiveFailures = positiveIntEnv('ZA_MAX_CONSECUTIVE_FAILURES');
const hitlTimeoutMs = positiveIntEnv('ZA_HITL_TIMEOUT_MS');
if (!process.env['ZA_LLM_BASE_URL']) {
  console.warn('ZA_LLM_BASE_URL 未设置：LLM 调用将以"服务暂时不可用"降级');
}

startServer({
  port,
  host,
  jwtSecret,
  signingSecret,
  issAllowlist: (process.env['ZA_JWT_ISS_ALLOWLIST'] ?? ANON_ISS)
    .split(',')
    .map((iss) => iss.trim())
    .filter((iss) => iss !== ''),
  snapshotRoot,
  maxTurnRounds,
  ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}),
  ...(hitlTimeoutMs !== undefined ? { hitlTimeoutMs } : {}),
  compressContextWindow,
  compressThreshold,
  corsOrigin: process.env['ZA_CORS_ORIGIN'] ?? '*',
  systemPromptPath: process.env['ZA_SYSTEM_PROMPT_PATH'] ?? 'assets/system-prompt.md',
  auditSinkPath: process.env['ZA_AUDIT_SINK'] ?? '.za/events.jsonl',
  sessionDir: process.env['ZA_SESSION_DIR'] ?? '.za/sessions',
  applicationsDir: process.env['ZA_APPLICATIONS_DIR'] ?? '.za/applications',
  userConfigDir: process.env['ZA_USER_CONFIG_DIR'] ?? '.za/user-config',
  sessionTtlMs,
  allowedProviders: ['openai-compatible'],
  resolveCredential,
}).then(
  ({ port: boundPort }) => {
    console.log(`zen-agent server listening on http://${host}:${boundPort}`);
  },
  (cause) => {
    console.error(`启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  },
);
