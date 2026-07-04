/**
 * 模块化单体的唯一组装点（U2）：全仓只有本包同时 import 全部模块包；
 * 模块间彼此零依赖，只经 @zen-agent/contracts 端口类型在此接线。
 */
import { createServer } from 'node:http';
import type { AssemblyPort, LlmPort, ToolGatePort } from '@zen-agent/contracts';
import { createAssemblyPort } from '@zen-agent/assembly';
import { createToolGatePort } from '@zen-agent/toolgate';
import { createLlmPort } from '@zen-agent/llm-port';
import { createTokenVerifier } from './auth.js';
import { createMemorySessionStore } from './sessions.js';
import { createGateway } from './gateway.js';

export interface ServerOptions {
  /** 0 = 随机可用端口（测试用）；固定监听 127.0.0.1。 */
  port: number;
  /** 空值拒绝启动（验签 fail-closed 的前提）。 */
  jwtSecret: string;
  issAllowlist: string[];
  snapshotRoot: string;
  systemPromptPath: string;
  /** M1 未消费：audit sink 接线锚点=M4（createAuditPort 工厂当前如实 NOT_IMPLEMENTED）。 */
  auditSinkPath: string;
  allowedProviders: string[];
  /** SSE 心跳间隔毫秒，默认 15000。 */
  heartbeatMs?: number;
}

export interface ServerPorts {
  assembly: AssemblyPort;
  toolgate: ToolGatePort;
  llm: LlmPort;
}

// audit 端口接回组装的锚点=M4（其工厂在 sink 落地前如实拒绝创建，组装即调会阻断启动）。
export function assemblePorts(options: ServerOptions): ServerPorts {
  return {
    assembly: createAssemblyPort({
      snapshotRoot: options.snapshotRoot,
      systemPromptPath: options.systemPromptPath,
    }),
    // M1 工具面不进对话（LLM 不传 tools）；toolgate 接入 agent 回合的锚点=M3。
    toolgate: createToolGatePort({ tools: [] }),
    llm: createLlmPort({ allowedProviders: options.allowedProviders }),
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
  const ports = assemblePorts(options);
  // 启动即触发快照惰性载入：坏快照 fail-fast 拒绝启动，而非首轮对话才暴露
  await ports.assembly.resolveFeature({ url: '' });
  const gateway = createGateway({
    assembly: ports.assembly,
    llm: ports.llm,
    verifier: createTokenVerifier({
      jwtSecret: options.jwtSecret,
      issAllowlist: options.issAllowlist,
    }),
    store: createMemorySessionStore(),
    heartbeatMs: options.heartbeatMs ?? 15_000,
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
