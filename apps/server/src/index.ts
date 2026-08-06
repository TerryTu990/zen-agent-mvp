/**
 * 模块化单体的唯一组装点（U2）：全仓只有本包同时 import 全部模块包；
 * 模块间彼此零依赖，只经 @zen-agent/contracts 端口类型在此接线。
 */
import { createServer } from 'node:http';
import type {
  AssemblyPort,
  AuditPort,
  CardInventoryPort,
  FulfillmentCoordinatorPort,
  LlmPort,
  ToolGatePort,
  UserConfigStore,
} from '@zen-agent/contracts';
import { createAssemblyPort } from '@zen-agent/assembly';
import { createToolGatePort, type BoundedFulfillmentPolicy } from '@zen-agent/toolgate';
import { createLlmPort } from '@zen-agent/llm-port';
import { createAuditPort } from '@zen-agent/audit';
import { createLarkBaseCardInventoryPort } from '@zen-agent/card-inventory';
import { createFulfillmentCoordinator } from '@zen-agent/fulfillment';
import { createTokenVerifier } from './auth.js';
import {
  createMemorySessionStore,
  createPersistentSessionStore,
  type PersistentSessionStore,
  type SessionStore,
} from './sessions.js';
import { createGateway } from './gateway.js';
import { ANON_ISS } from './activation.js';
import { createFsUserConfigStore } from './user-config-store.js';

export interface ServerOptions {
  /** 0 = 随机可用端口（测试用）。 */
  port: number;
  /** 监听地址，默认 '127.0.0.1'（本机开发）；容器/对外部署设 '0.0.0.0'。 */
  host?: string;
  /** 空值拒绝启动（验签 fail-closed 的前提）。 */
  jwtSecret: string;
  /** Ed25519 私钥派生种子；空值拒绝启动，经 env 注入不落仓/日志，插件只取得公钥。 */
  signingSecret: string;
  /** 外部签发方白名单；本机匿名激活的 iss 恒被接受，无需也无法经此项关闭。 */
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
  /** 代执行指令/等待客户端结果 TTL；缺省 60000ms。测试可缩短以验证主动超时。 */
  execInstructionTtlMs?: number;
  /** 历史压缩触发的上下文窗口 token 数（ZA_LLM_CONTEXT_WINDOW），默认 200000。 */
  compressContextWindow?: number;
  /** 历史压缩触发阈值比例（ZA_LLM_COMPRESS_THRESHOLD），默认 0.6。 */
  compressThreshold?: number;
  /** Access-Control-Allow-Origin 响应头值，默认 '*'。 */
  corsOrigin?: string;
  /**
   * server 通道凭证解析：ServerAdapter.credentialRef → 真值。由组装边界运行时注入、真值不入配置/日志/审计（SEC-01/02）。
   * 缺省或解析不到时 executeServer 返回 credential-unresolved。
   */
  resolveCredential?: (ref: string) => string | undefined;
  /**
   * 会话持久化落盘目录（P2）：设置即启用 `.za/sessions/<id>.jsonl` 落盘 + 重启重放 + 闲置清理；
   * 缺省=纯内存态（不落盘）。普通会话历史故障 fail-open；消息幂等占位故障 fail-closed，不启动回合。
   */
  sessionDir?: string;
  /** 会话闲置 TTL 毫秒，默认 3600000（1 小时）；仅在 sessionDir 启用时生效。 */
  sessionTtlMs?: number;
  /** 投递记录（求职 agent 业务日志）落盘目录；缺省 `.za/applications`。record-only 旁路、写失败 fail-open。 */
  applicationsDir?: string;
  /**
   * L2 用户覆盖层落盘根目录（adr-014）：设置即组装 fs UserConfigStore 注入 assembly，
   * compose 按 subject 合并 L2；缺省 = 不组装（纯 L1 装配）。布局 `<dir>/<tenant>/<hostUserId>.json`。
   */
  userConfigDir?: string;
  /** 配置草稿（teach 流）有效期毫秒；缺省 10 分钟。 */
  configDraftTtlMs?: number;
  /** generic 兜底 pack 的服务端准入名单（origin 精确值闭集）；缺省/空 = generic 永不激活（fail-closed，U7）。 */
  genericAllowlist?: string[];
  /** ADR-016：运营者预批准的服务端有界履约策略；不从客户端或模型上下文接受。 */
  fulfillmentPolicies?: BoundedFulfillmentPolicy[];
  /** Phase 3：可选飞书轻量卡密库存；未配置时不组装连接器，既有人工 intent 测试路径不变。 */
  cardInventory?: {
    baseToken: string;
    tableId: string;
    guideUrl: string;
    profile?: string;
    cliPath?: string;
  };
  /** 可信宿主可直接注入库存端口（测试/sidecar）；与 cardInventory CLI 配置互斥。 */
  cardInventoryPort?: CardInventoryPort;
  /** cardInventoryPort 模式下的固定使用说明 URL。 */
  cardInventoryGuideUrl?: string;
  /** 站点商品 id → 库存 productKey 闭集映射；仅服务端配置，供声明式零参数 prepare 工具引擎使用。 */
  fulfillmentProductKeys?: Record<string, string>;
}

export function parseFulfillmentProductKeys(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ZA_FULFILLMENT_PRODUCT_KEYS_JSON 必须是 JSON 对象');
  }
  const result: Record<string, string> = {};
  for (const [productId, productKey] of Object.entries(parsed)) {
    const normalizedId = productId.trim();
    const normalizedKey = typeof productKey === 'string' ? productKey.trim() : '';
    if (normalizedId === '' || normalizedKey === '' || normalizedId !== productId) {
      throw new Error('ZA_FULFILLMENT_PRODUCT_KEYS_JSON 的键和值必须是非空规范字符串');
    }
    result[normalizedId] = normalizedKey;
  }
  return result;
}

/**
 * ZA_GENERIC_ALLOWLIST 解析：逗号分隔，三种条目形态——`*`（任意站点）、`scheme://*.host`（该域及其子域）、
 * origin 精确值。空/未设 → []（generic 永不激活）；非法条目抛错（启动期 fail-fast）。
 * www/裸域互认在比对点归一（canonicalizeOrigin），此处只验值形。
 */
export function parseGenericAllowlist(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const entry of entries) {
    if (entry === '*') continue;
    let valid = false;
    try {
      // `scheme://*.host` 的 `*.` 不是合法 hostname，验值形时以占位 label 代入再校验其余部分。
      const probe = entry.replace('://*.', '://wildcard-probe.');
      valid = new URL(probe).origin === probe;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error(
        `ZA_GENERIC_ALLOWLIST 含非法条目：${entry}（须为 * / scheme://*.host / scheme://host[:port]，逗号分隔）`,
      );
    }
  }
  return entries;
}

export interface ServerPorts {
  assembly: AssemblyPort;
  toolgate: ToolGatePort;
  llm: LlmPort;
  audit: AuditPort;
  fulfillment?: FulfillmentCoordinatorPort;
  /** L2 用户覆盖层存储（adr-014）：assembly 与网关写入通道共用同一实例；缺省 = 未启用 L2。 */
  userConfigStore?: UserConfigStore;
}

export async function assemblePorts(options: ServerOptions): Promise<ServerPorts> {
  const userConfigStore =
    options.userConfigDir !== undefined
      ? createFsUserConfigStore({ dir: options.userConfigDir })
      : undefined;
  const assembly = createAssemblyPort({
    snapshotRoot: options.snapshotRoot,
    systemPromptPath: options.systemPromptPath,
    ...(userConfigStore !== undefined ? { userConfigStore } : {}),
  });
  // 触发快照惰性载入：坏快照 fail-fast（快照拒载错误），先于读全 pack 工具并集。
  await assembly.resolveFeature({ url: '' });
  // toolgate 分级判定的工具闭集（fail-closed 依据，U7）：全 pack 工具并集，按 toolId 去重。
  const tools = await assembly.allTools();
  // ADR-013：site 围栏（navigate 校验）+ 逐 pack 工具归属（命名空间纪律，跨 pack 同名 toolId 载入即拒启）。
  const sites = await assembly.listSites();
  const toolOwnership = await assembly.listToolOwnership();
  const toolgate = createToolGatePort({
    tools,
    sites,
    toolOwnership,
    signingSecret: options.signingSecret,
    ...(options.execInstructionTtlMs !== undefined ? { ttlMs: options.execInstructionTtlMs } : {}),
    fulfillmentPolicies: options.fulfillmentPolicies ?? [],
    ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}),
  });
  if (options.cardInventory !== undefined && options.cardInventoryPort !== undefined) {
    throw new Error('飞书 CLI 配置与注入库存端口不可同时设置');
  }
  const inventory =
    options.cardInventoryPort ??
    (options.cardInventory
      ? createLarkBaseCardInventoryPort({
          baseToken: options.cardInventory.baseToken,
          tableId: options.cardInventory.tableId,
          ...(options.cardInventory.profile !== undefined
            ? { profile: options.cardInventory.profile }
            : {}),
          ...(options.cardInventory.cliPath !== undefined
            ? { cliPath: options.cardInventory.cliPath }
            : {}),
        })
      : undefined);
  const guideUrl = options.cardInventory?.guideUrl ?? options.cardInventoryGuideUrl;
  if ((inventory === undefined) !== (guideUrl === undefined)) {
    throw new Error('卡密库存端口与使用说明 URL 必须同时配置');
  }
  const fulfillment =
    inventory !== undefined && guideUrl !== undefined
      ? createFulfillmentCoordinator({
          inventory,
          toolgate,
          guideUrl,
        })
      : undefined;
  return {
    assembly,
    toolgate,
    llm: createLlmPort({ allowedProviders: options.allowedProviders }),
    audit: createAuditPort({ sinkPath: options.auditSinkPath }),
    ...(fulfillment !== undefined ? { fulfillment } : {}),
    ...(userConfigStore !== undefined ? { userConfigStore } : {}),
  };
}

export interface RunningServer {
  port: number;
  /** 进程内组装端口；供可信连接器接线与集成测试使用，不经 HTTP 暴露。 */
  ports: ServerPorts;
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
  // L2 写入通道依赖（adr-014 §5）：校验基线取自装配快照（不可变），组装期定格一次即可。
  const userConfig =
    ports.userConfigStore !== undefined
      ? {
          store: ports.userConfigStore,
          ...(options.configDraftTtlMs !== undefined ? { draftTtlMs: options.configDraftTtlMs } : {}),
          configSchemas: await ports.assembly.listConfigSchemas(),
          l1Baseline: {
            tools: (await ports.assembly.allTools()).map((tool) => ({
              id: tool.id,
              riskTier: tool.riskTier,
            })),
            automations: (await ports.assembly.listAutomations()).map((descriptor) => ({
              id: descriptor.automation.id,
              ...(descriptor.automation.defaultPeriodMinutes !== undefined
                ? { defaultPeriodMinutes: descriptor.automation.defaultPeriodMinutes }
                : {}),
            })),
          },
        }
      : undefined;
  const gateway = createGateway({
    assembly: ports.assembly,
    llm: ports.llm,
    toolgate: ports.toolgate,
    ...(ports.fulfillment !== undefined ? { fulfillment: ports.fulfillment } : {}),
    fulfillmentProductKeys: options.fulfillmentProductKeys ?? {},
    audit: ports.audit,
    verifier: createTokenVerifier({
      jwtSecret: options.jwtSecret,
      // 自签必自验：匿名激活的 iss 与验签同属本进程，运维改白名单不得让 server 签出自己随即拒绝的令牌。
      issAllowlist: [...new Set([...options.issAllowlist, ANON_ISS])],
    }),
    store,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    maxTurnRounds: options.maxTurnRounds ?? 12,
    compressContextWindow: options.compressContextWindow ?? 200_000,
    compressThreshold: options.compressThreshold ?? 0.6,
    corsOrigin: options.corsOrigin ?? '*',
    applicationsDir: options.applicationsDir ?? '.za/applications',
    genericAllowlist: options.genericAllowlist ?? [],
    activationJwtSecret: options.jwtSecret,
    ...(userConfig !== undefined ? { userConfig } : {}),
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
    ports,
    close: () =>
      new Promise<void>((resolve, reject) => {
        gateway.shutdown();
        persistentStore?.stop();
        server.close((cause) => (cause ? reject(cause) : resolve()));
        server.closeAllConnections();
      }),
  };
}
