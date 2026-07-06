/**
 * 模块化单体的唯一组装点（U2）：全仓只有本包同时 import 全部模块包；
 * 模块间彼此零依赖，只经 @zen-agent/contracts 端口类型在此接线。
 */
import { createServer } from 'node:http';
import type { AssemblyPort, AuditPort, LlmPort, ToolGatePort } from '@zen-agent/contracts';
import { createAssemblyPort } from '@zen-agent/assembly';
import { createToolGatePort } from '@zen-agent/toolgate';
import { createLlmPort } from '@zen-agent/llm-port';
import { createAuditPort } from '@zen-agent/audit';
import { createTokenVerifier } from './auth.js';
import {
  createMemorySessionStore,
  createPersistentSessionStore,
  type PersistentSessionStore,
  type SessionStore,
} from './sessions.js';
import { createGateway } from './gateway.js';

export interface ServerOptions {
  /** 0 = 随机可用端口（测试用）。 */
  port: number;
  /** 监听地址，默认 '127.0.0.1'（本机开发）；容器/对外部署设 '0.0.0.0'。 */
  host?: string;
  /** 空值拒绝启动（验签 fail-closed 的前提）。 */
  jwtSecret: string;
  /** 代执行指令签名密钥；空值拒绝启动（U7 一次性签名的前提），经 env 注入不落仓/日志（SEC-01）。 */
  signingSecret: string;
  issAllowlist: string[];
  snapshotRoot: string;
  systemPromptPath: string;
  /** M1 未消费：audit sink 接线锚点=M4（createAuditPort 工厂当前如实 NOT_IMPLEMENTED）。 */
  auditSinkPath: string;
  allowedProviders: string[];
  /** SSE 心跳间隔毫秒，默认 15000。 */
  heartbeatMs?: number;
  /** agent loop 单回合轮数上限，默认 12；dom 代操作一批页面操作固定耗 2 轮（操作+复核快照）。 */
  maxTurnRounds?: number;
  /** 历史压缩触发的上下文窗口 token 数（ZA_LLM_CONTEXT_WINDOW），默认 200000。 */
  compressContextWindow?: number;
  /** 历史压缩触发阈值比例（ZA_LLM_COMPRESS_THRESHOLD），默认 0.6。 */
  compressThreshold?: number;
  /** Access-Control-Allow-Origin 响应头值，默认 '*'。 */
  corsOrigin?: string;
  /**
   * P0-b demo-token 端点（env 门控）：enabled=false 时 /demo-token 恒 404。
   * 签发复用 jwtSecret（与 verifier 同 secret，故自签 token 能验签通过）；iss 须在 issAllowlist 内。
   */
  demoToken?: { enabled: boolean; iss: string };
  /**
   * server 通道凭证解析：ServerAdapter.credentialRef → 真值。由组装边界运行时注入、真值不入配置/日志/审计（SEC-01/02）。
   * 缺省或解析不到时 executeServer 返回 credential-unresolved。
   */
  resolveCredential?: (ref: string) => string | undefined;
  /**
   * 会话持久化落盘目录（P2）：设置即启用 `.za/sessions/<id>.jsonl` 落盘 + 重启重放 + 闲置清理；
   * 缺省=纯内存态（不落盘）。存储故障 fail-open、不进控制流。
   */
  sessionDir?: string;
  /** 会话闲置 TTL 毫秒，默认 3600000（1 小时）；仅在 sessionDir 启用时生效。 */
  sessionTtlMs?: number;
}

export interface ServerPorts {
  assembly: AssemblyPort;
  toolgate: ToolGatePort;
  llm: LlmPort;
  audit: AuditPort;
}

export async function assemblePorts(options: ServerOptions): Promise<ServerPorts> {
  const assembly = createAssemblyPort({
    snapshotRoot: options.snapshotRoot,
    systemPromptPath: options.systemPromptPath,
  });
  // 触发快照惰性载入：坏快照 fail-fast（快照拒载错误），先于读全 pack 工具并集。
  await assembly.resolveFeature({ url: '' });
  // toolgate 分级判定的工具闭集（fail-closed 依据，U7）：全 pack 工具并集，按 toolId 去重。
  const tools = await assembly.allTools();
  // ADR-013：site 围栏（navigate 校验）+ 逐 pack 工具归属（命名空间纪律，跨 pack 同名 toolId 载入即拒启）。
  const sites = await assembly.listSites();
  const toolOwnership = await assembly.listToolOwnership();
  return {
    assembly,
    toolgate: createToolGatePort({
      tools,
      sites,
      toolOwnership,
      signingSecret: options.signingSecret,
      ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}),
    }),
    llm: createLlmPort({ allowedProviders: options.allowedProviders }),
    audit: createAuditPort({ sinkPath: options.auditSinkPath }),
  };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (!options.jwtSecret) {
    throw new Error('ZA_JWT_SECRET 未设置：JWT 验签无密钥，拒绝启动（fail-closed）');
  }
  if (!options.signingSecret) {
    throw new Error('ZA_SIGNING_SECRET 未设置：代执行指令无签名密钥，拒绝启动（fail-closed，U7）');
  }
  // 组装即触发快照载入 + 工具并集汇总：坏快照/坏工具在启动期 fail-fast，而非首轮对话才暴露。
  const ports = await assemblePorts(options);
  const memoryStore = createMemorySessionStore();
  const persistentStore: PersistentSessionStore | undefined =
    options.sessionDir !== undefined
      ? createPersistentSessionStore(memoryStore, {
          dir: options.sessionDir,
          ...(options.sessionTtlMs !== undefined ? { ttlMs: options.sessionTtlMs } : {}),
        })
      : undefined;
  const store: SessionStore = persistentStore ?? memoryStore;
  const gateway = createGateway({
    assembly: ports.assembly,
    llm: ports.llm,
    toolgate: ports.toolgate,
    audit: ports.audit,
    verifier: createTokenVerifier({
      jwtSecret: options.jwtSecret,
      issAllowlist: options.issAllowlist,
    }),
    store,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    maxTurnRounds: options.maxTurnRounds ?? 12,
    compressContextWindow: options.compressContextWindow ?? 200_000,
    compressThreshold: options.compressThreshold ?? 0.6,
    corsOrigin: options.corsOrigin ?? '*',
    ...(options.demoToken?.enabled
      ? { demoToken: { jwtSecret: options.jwtSecret, iss: options.demoToken.iss } }
      : {}),
  });
  const server = createServer(gateway.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法确定监听端口');
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        gateway.shutdown();
        persistentStore?.stop();
        server.close((cause) => (cause ? reject(cause) : resolve()));
        server.closeAllConnections();
      }),
  };
}
