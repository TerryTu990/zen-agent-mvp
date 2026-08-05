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

export interface UserOverlayAutomationPreference {
  enabled: boolean;
  /** 唤醒周期（分钟）；写入期校验 ≥ pack 预设周期且 ≥ 平台下限（频率只收紧）。 */
  minutes?: number;
}

export interface UserOverlayPackPreferences {
  verbosity?: UserOverlayVerbosity;
  /** 键 = 该 pack 声明的 automation id（adr-019）。 */
  automations?: Record<string, UserOverlayAutomationPreference>;
}

/**
 * "*" 全局作用域：跨站规则/事实与偏好；结构上无 enabled/restrictions/packConfig（无对应工具面），
 * 偏好仅 verbosity（automations 锚定 pack 声明，无全局语义）。
 */
export interface UserOverlayGlobalScope {
  rules?: UserOverlayEntry[];
  facts?: UserOverlayEntry[];
  preferences?: { verbosity?: UserOverlayVerbosity };
}

export interface UserOverlayPackScope {
  /** pack 级关停；只允许 false，缺省 = 启用（R1 只收紧）。 */
  enabled?: false;
  rules?: UserOverlayEntry[];
  facts?: UserOverlayEntry[];
  restrictions?: UserOverlayRestrictions;
  /** 键值按该 pack 声明的 configSchema（adr-020）校验；schema 不存在或值越界即拒。 */
  packConfig?: JsonObject;
  preferences?: UserOverlayPackPreferences;
}

export interface UserOverlay {
  schemaVersion: 1;
  subject: UserConfigSubject;
  /** 键 "*" = 全局作用域（UserOverlayGlobalScope 形状，schema properties."*" 强制）；其余键 = packId。 */
  packs: Record<string, UserOverlayGlobalScope | UserOverlayPackScope>;
}

export interface UserOverlayValidationIssue {
  /** JSON Pointer 风格定位（如 /packs/xianyu-seller/restrictions）。 */
  path: string;
  message: string;
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

const overlaySchemaUrl = new URL('../schemas/user-overlay.schema.json', import.meta.url);

let overlayValidator: ValidateFunction | null = null;

function getOverlayValidator(): ValidateFunction {
  if (overlayValidator === null) {
    const ajv = new Ajv2020({ strict: true });
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

export interface UserOverlayL1AutomationBaseline {
  id: string;
  /** pack 声明的预设唤醒周期（分钟）；缺省 = 仅平台下限约束。 */
  defaultPeriodMinutes?: number;
}

/**
 * 写入期只收紧校验的 L1 基线（U1：JSON 可序列化，写入通道自 assembly 端口取得后传入）：
 * tools/automations 的 id 均为跨 pack 去重后的全局并集（载入期命名空间纪律保证唯一）。
 * 口径与合并期不同且刻意为之：写入期用全局并集只判「声明值是否低于 L1」（放宽面），
 * 不判 toolId 归属哪个 pack；作用域归属与越界引用归合并期按激活 pack 闭集逐条失效——
 * 两口径分工不构成放宽面（并集里查不到的 toolId 写入期放过、合并期必失效）。
 */
export interface UserOverlayL1Baseline {
  tools: UserOverlayL1ToolBaseline[];
  automations: UserOverlayL1AutomationBaseline[];
}

const riskTierOrder: Record<RiskTier, number> = { auto: 0, hitl: 1, forbidden: 2 };

/** 平台唤醒周期下限（分钟）：任何 L2 minutes 声明不得低于此值。 */
const PLATFORM_MIN_AUTOMATION_MINUTES = 1;

/**
 * 写入期只收紧校验（R1，adr-014 §3）：L2 riskTierRaise 低于 L1 声明值拒绝；automation minutes
 * 低于 max(pack 预设周期, 平台下限) 拒绝。前提：overlay 已过 validateUserOverlay。
 * 引用不在基线内的 toolId/automation id 不在此拒——越界引用归合并期逐条失效语义（不构成放宽面）。
 */
export function validateOverlayAgainstL1(
  overlay: UserOverlay,
  l1Baseline: UserOverlayL1Baseline,
): UserOverlayValidationResult {
  const issues: UserOverlayValidationIssue[] = [];
  const baseTiers = new Map(l1Baseline.tools.map((tool) => [tool.id, tool.riskTier]));
  const automationBaselines = new Map(
    l1Baseline.automations.map((automation) => [automation.id, automation]),
  );
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
    for (const [automationId, preference] of Object.entries(
      packScope.preferences?.automations ?? {},
    )) {
      if (preference.minutes === undefined) continue;
      const baseline = automationBaselines.get(automationId);
      if (baseline === undefined) continue;
      const floor = Math.max(
        baseline.defaultPeriodMinutes ?? PLATFORM_MIN_AUTOMATION_MINUTES,
        PLATFORM_MIN_AUTOMATION_MINUTES,
      );
      if (preference.minutes < floor) {
        issues.push({
          path: `/packs/${packId}/preferences/automations/${automationId}/minutes`,
          message: `唤醒周期 ${preference.minutes} 分钟低于下限 ${floor}（max(pack 预设, 平台下限)），频率只收紧，写入期拒绝`,
        });
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, overlay };
}
