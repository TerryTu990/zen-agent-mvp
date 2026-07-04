/**
 * 模块化单体的唯一组装点（U2）：全仓只有本包同时 import 全部模块包；
 * 模块间彼此零依赖，只经 @zen-agent/contracts 端口类型在此接线。
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type {
  AssemblyPort,
  AuditPort,
  ConfigSnapshotManifest,
  LlmPort,
  ToolDefinition,
  ToolGatePort,
} from '@zen-agent/contracts';
import { createAssemblyPort } from '@zen-agent/assembly';
import { createToolGatePort } from '@zen-agent/toolgate';
import { createLlmPort } from '@zen-agent/llm-port';
import { createAuditPort } from '@zen-agent/audit';
import { createTokenVerifier } from './auth.js';
import { createMemorySessionStore } from './sessions.js';
import { createGateway } from './gateway.js';

export interface ServerOptions {
  /** 0 = 随机可用端口（测试用）；固定监听 127.0.0.1。 */
  port: number;
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
}

export interface ServerPorts {
  assembly: AssemblyPort;
  toolgate: ToolGatePort;
  llm: LlmPort;
  audit: AuditPort;
}

/**
 * 汇总快照内全部功能的工具并集，作为 toolgate 分级判定的工具闭集（fail-closed 依据，U7）。
 * 组装层逻辑（唯一组装点在此，不违 U2）：读 manifest 取功能清单，逐功能 compose 收其工具、按 id 去重。
 * 前提：assembly 快照已成功载入（否则 compose 抛快照拒载错误，在此之前触发）。
 */
async function collectHostTools(
  assembly: AssemblyPort,
  snapshotRoot: string,
): Promise<ToolDefinition[]> {
  const manifest = JSON.parse(
    readFileSync(join(snapshotRoot, 'manifest.json'), 'utf8'),
  ) as ConfigSnapshotManifest;
  const featureIds = manifest.features ?? manifest.featureIdRules.map((rule) => rule.featureId);
  const byId = new Map<string, ToolDefinition>();
  for (const featureId of featureIds) {
    const composed = await assembly.compose({ sessionId: '__bootstrap__', featureId });
    for (const tool of composed.tools) byId.set(tool.id, tool);
  }
  return [...byId.values()];
}

export async function assemblePorts(options: ServerOptions): Promise<ServerPorts> {
  const assembly = createAssemblyPort({
    snapshotRoot: options.snapshotRoot,
    systemPromptPath: options.systemPromptPath,
  });
  // 触发快照惰性载入：坏快照 fail-fast（快照拒载错误），先于按 manifest 读工具并集。
  await assembly.resolveFeature({ url: '' });
  const tools = await collectHostTools(assembly, options.snapshotRoot);
  return {
    assembly,
    toolgate: createToolGatePort({
      tools,
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
  const gateway = createGateway({
    assembly: ports.assembly,
    llm: ports.llm,
    toolgate: ports.toolgate,
    audit: ports.audit,
    verifier: createTokenVerifier({
      jwtSecret: options.jwtSecret,
      issAllowlist: options.issAllowlist,
    }),
    store: createMemorySessionStore(),
    heartbeatMs: options.heartbeatMs ?? 15_000,
    ...(options.demoToken?.enabled
      ? { demoToken: { jwtSecret: options.jwtSecret, iss: options.demoToken.iss } }
      : {}),
  });
  const server = createServer(gateway.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
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
        server.close((cause) => (cause ? reject(cause) : resolve()));
        server.closeAllConnections();
      }),
  };
}
