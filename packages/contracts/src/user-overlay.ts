/**
 * C7 用户配置层类型与组合校验器——结构权威在 schemas/user-overlay.schema.json，类型为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 *
 * 跨字段语义（同一 toolId 同时出现在 riskTierRaise 与 disabledTools 拒绝、packConfig 按 pack 声明的
 * configSchema 校验）JSON Schema 表达不了——校验唯一入口是 validateUserOverlay（schema + 语义组合），
 * 消费方 MUST 经其校验，不得旁路只跑 schema 或自写解析。
 */
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JsonObject } from './json.js';
import type { QuickAction } from './config-snapshot.js';
import type { RiskTier } from './tool-definition.js';

/** L2 归属键，取自每次请求的 C2 claims（adr-014 §1）。 */
export interface UserConfigSubject {
  tenant: string;
  hostUserId: string;
}

export type UserOverlayEntryOrigin = 'manual' | 'teach';

/** 个人规则/事实条目（R4：逐条带来源与作用域）。 */
export interface UserOverlayEntry {
  id: string;
  text: string;
  /** 缺省 = 整 pack 生效；compose 按当前 featureId 过滤。 */
  featureId?: string;
  /** manual=面板手工录入；teach=对话草稿经 config-decision 确认写入。 */
  origin: UserOverlayEntryOrigin;
  /** origin=teach 时产草稿的会话。 */
  sourceSessionId?: string;
  /** ISO 8601 date-time。 */
  createdAt: string;
}

/** riskTier 只收紧闭集（R1）：无 auto——L2 结构上不存在放宽表达力；合并语义恒 max(L1, L2)。 */
export type UserOverlayRiskTierRaise = 'hitl' | 'forbidden';

export interface UserOverlayRestrictions {
  /** toolId → 收紧后分级；UI「禁用」列 = forbidden。 */
  riskTierRaise?: Record<string, UserOverlayRiskTierRaise>;
  /** 语义 = 从工具面移除不展示；与 riskTierRaise 同 toolId 双重声明由组合校验器拒绝。 */
  disabledTools?: string[];
}

export type UserOverlayVerbosity = 'concise' | 'standard' | 'detailed';

export interface UserOverlayPackPreferences {
  verbosity?: UserOverlayVerbosity;
}

/**
 * "*" 全局作用域：跨站规则/事实与偏好；结构上无 enabled/restrictions/packConfig（无对应工具面），
 * 偏好仅 verbosity。
 */
export interface UserOverlayGlobalScope {
  /** 上限 200 条（schema maxItems），facts 同。 */
  rules?: UserOverlayEntry[];
  facts?: UserOverlayEntry[];
  preferences?: { verbosity?: UserOverlayVerbosity };
  /**
   * 站点黑名单（R1 只收紧）：命中的 origin 上不装配任何站点包，回落仅基座。
   * 条目两形态——"scheme://host[:port]" 精确 origin 或 "scheme://*.host" 该域及子域；
   * 文法不含全通配（schema 层拒 "*"）。终判在服务端 compose（U7），客户端跳过激活不构成治理生效。
   */
  siteDenylist?: string[];
  /**
   * 站点注入授权集（adr-027 轨二）：用户显式授权 Zen 在这些 origin 上常驻内容脚本。
   * 条目为精确 origin "scheme://host[:port]"，协议闭集 http/https，无通配形态。
   * 准入维度而非治理维度——授权只决定 agent 在该站点是否存在，不改任何 riskTier / 工具面 / HITL 判定，
   * 与 restrictions 的只收紧正交。客户端注入面取本集合与浏览器授权的交集，黑名单命中时优先不注入。
   */
  grantedOrigins?: string[];
  /** 跨站自建快捷提问（R-5）：上限 20 条（schema maxItems）。 */
  quickActions?: QuickAction[];
  /**
   * 停用的快捷提问 id（R1 只收紧）：结构上只有 id，无改写模板的表达力——
   * 用户能让某条不出现，不能让它变成别的问法。命中的 id 网关查表也不认（按未知 id 原样发送）。
   */
  disabledQuickActions?: string[];
}

export interface UserOverlayPackScope {
  /** pack 级关停；只允许 false，缺省 = 启用（R1 只收紧）。 */
  enabled?: false;
  /** 上限 200 条（schema maxItems），facts 同。 */
  rules?: UserOverlayEntry[];
  facts?: UserOverlayEntry[];
  /** 本 pack 作用域的自建快捷提问（R-5）：上限 20 条（schema maxItems）。 */
  quickActions?: QuickAction[];
  /** 停用的快捷提问 id（含 L1 声明与全局 L2 条目）；只收紧，语义同全局作用域。 */
  disabledQuickActions?: string[];
  restrictions?: UserOverlayRestrictions;
  /** 键值按该 pack 声明的 configSchema（adr-020）校验；schema 不存在或值越界即拒。 */
  packConfig?: JsonObject;
  preferences?: UserOverlayPackPreferences;
}

export interface UserOverlay {
  schemaVersion: 1;
  subject: UserConfigSubject;
  /** 键 "*" = 全局作用域（UserOverlayGlobalScope 形状，schema properties."*" 强制）；其余键 = packId。上限 100 键（schema maxProperties）。 */
  packs: Record<string, UserOverlayGlobalScope | UserOverlayPackScope>;
}

export interface UserOverlayValidationIssue {
  /** JSON Pointer 风格定位（如 /packs/xianyu-seller/restrictions）。 */
  path: string;
  message: string;
  /**
   * 'scale' = 仅规模上界越界（条目数/作用域数），结构本身合法。读路径可据此对既有存量放行
   * （规模上界是写入期约束，不应使早于该约束写下的 overlay 变为不可读）；写入期一律拒收。
   */
  kind?: 'scale';
}

export interface ValidateUserOverlayOptions {
  /**
   * packId → 该 pack 声明的 configSchema（pack.json configSchema，adr-020）。
   * 提供时对 packConfig fail-closed：无对应 schema、schema 编译失败或值越界均拒。
   * 缺省 = 跳过 packConfig 语义检查（结构校验仍生效）——写入通道 MUST 提供本表（adr-014 §2 写入期校验）。
   */
  configSchemas?: Record<string, JsonObject>;
}

export type UserOverlayValidationResult =
  | { ok: true; overlay: UserOverlay }
  | { ok: false; issues: UserOverlayValidationIssue[] };

/** 仅规模类的 schema 关键字：越界不代表结构非法（见 UserOverlayValidationIssue.kind）。 */
const SCALE_KEYWORDS = new Set(['maxItems', 'maxProperties']);

const overlaySchemaUrl = new URL('../schemas/user-overlay.schema.json', import.meta.url);

let overlayValidator: ValidateFunction | null = null;

function getOverlayValidator(): ValidateFunction {
  if (overlayValidator === null) {
    // allErrors：规模上界（maxItems/maxProperties）在关键字求值序里先于结构下探，
    // 单错短路会让「既超规模又结构非法」的样本只报出规模错——读路径的 scale 放行据此会被绕过。
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats.default(ajv);
    overlayValidator = ajv.compile(JSON.parse(readFileSync(overlaySchemaUrl, 'utf8')) as object);
  }
  return overlayValidator;
}

/**
 * pack configSchema 的唯一编译定义（strict + 标准 formats）：载入期拒载判定（assembly）与
 * 写入期 packConfig 校验共用，保证「合法 JSON Schema」只有一种判定；不可编译即 throw（fail-closed）。
 */
export function compileConfigSchema(configSchema: JsonObject): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  addFormats.default(ajv);
  return ajv.compile(configSchema);
}

function validatePackConfig(
  packId: string,
  packConfig: JsonObject,
  configSchema: JsonObject | undefined,
  issues: UserOverlayValidationIssue[],
): void {
  const path = `/packs/${packId}/packConfig`;
  if (configSchema === undefined) {
    issues.push({ path, message: `pack "${packId}" 未声明 configSchema，packConfig 拒收` });
    return;
  }
  let validate: ValidateFunction;
  try {
    validate = compileConfigSchema(configSchema);
  } catch {
    issues.push({ path, message: `pack "${packId}" 的 configSchema 不是可编译 JSON Schema，packConfig 拒收` });
    return;
  }
  if (!validate(packConfig)) {
    for (const error of validate.errors ?? []) {
      issues.push({ path: `${path}${error.instancePath}`, message: error.message ?? '越出 configSchema 声明空间' });
    }
  }
}

/**
 * user-overlay 组合校验（消费方唯一入口）：schema（ajv strict + additionalProperties:false 全程）
 * 通过后追加跨字段语义检查。不含「L2 低于 L1 的 riskTier 声明写入期拒绝」——该判定需 L1 工具面，
 * 归合并链路（P2.5-b compose/写入端点）持 L1 基线执行。
 */
export function validateUserOverlay(
  value: unknown,
  options?: ValidateUserOverlayOptions,
): UserOverlayValidationResult {
  const validate = getOverlayValidator();
  if (!validate(value)) {
    return {
      ok: false,
      issues: (validate.errors ?? []).map((error) => ({
        path: error.instancePath,
        message: error.message ?? 'schema 校验不通过',
        ...(SCALE_KEYWORDS.has(error.keyword) ? { kind: 'scale' as const } : {}),
      })),
    };
  }
  const overlay = value as UserOverlay;
  const issues: UserOverlayValidationIssue[] = [];
  for (const [packId, scope] of Object.entries(overlay.packs)) {
    if (packId === '*') continue;
    const packScope = scope as UserOverlayPackScope;
    const riskTierRaise = packScope.restrictions?.riskTierRaise ?? {};
    for (const toolId of packScope.restrictions?.disabledTools ?? []) {
      if (Object.hasOwn(riskTierRaise, toolId)) {
        issues.push({
          path: `/packs/${packId}/restrictions`,
          message: `toolId "${toolId}" 同时出现在 riskTierRaise 与 disabledTools，双重声明拒绝`,
        });
      }
    }
    if (packScope.packConfig !== undefined && options?.configSchemas !== undefined) {
      validatePackConfig(packId, packScope.packConfig, options.configSchemas[packId], issues);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, overlay };
}

export interface UserOverlayL1ToolBaseline {
  id: string;
  riskTier: RiskTier;
}

/**
 * 写入期只收紧校验的 L1 基线（U1：JSON 可序列化，写入通道自 assembly 端口取得后传入）：
 * tools 的 id 为跨 pack 去重后的全局并集（载入期命名空间纪律保证唯一）。
 * 口径与合并期不同且刻意为之：写入期用全局并集只判「声明值是否低于 L1」（放宽面），
 * 不判 toolId 归属哪个 pack；作用域归属与越界引用归合并期按激活 pack 闭集逐条失效——
 * 两口径分工不构成放宽面（并集里查不到的 toolId 写入期放过、合并期必失效）。
 */
export interface UserOverlayL1Baseline {
  tools: UserOverlayL1ToolBaseline[];
}

const riskTierOrder: Record<RiskTier, number> = { auto: 0, hitl: 1, forbidden: 2 };

/**
 * 写入期只收紧校验（R1，adr-014 §3）：L2 riskTierRaise 低于 L1 声明值拒绝。
 * 前提：overlay 已过 validateUserOverlay。
 * 引用不在基线内的 toolId 不在此拒——越界引用归合并期逐条失效语义（不构成放宽面）。
 */
export function validateOverlayAgainstL1(
  overlay: UserOverlay,
  l1Baseline: UserOverlayL1Baseline,
): UserOverlayValidationResult {
  const issues: UserOverlayValidationIssue[] = [];
  const baseTiers = new Map(l1Baseline.tools.map((tool) => [tool.id, tool.riskTier]));
  for (const [packId, scope] of Object.entries(overlay.packs)) {
    if (packId === '*') continue;
    const packScope = scope as UserOverlayPackScope;
    for (const [toolId, declared] of Object.entries(packScope.restrictions?.riskTierRaise ?? {})) {
      const baseTier = baseTiers.get(toolId);
      if (baseTier === undefined) continue;
      if (riskTierOrder[declared] < riskTierOrder[baseTier]) {
        issues.push({
          path: `/packs/${packId}/restrictions/riskTierRaise/${toolId}`,
          message: `声明分级 "${declared}" 低于 L1 基线 "${baseTier}"，只收紧不放宽，写入期拒绝`,
        });
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, overlay };
}
