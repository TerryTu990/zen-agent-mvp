import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type {
  AssemblyPort,
  AutomationDescriptor,
  ComposeResult,
  ConfigSnapshotManifest,
  InjectionBlock,
  InjectionDescription,
  InjectionToolDescriptor,
  JsonObject,
  PackAutomation,
  PackDescriptor,
  PackFeatureDescriptor,
  PackManifest,
  PackToolDescriptor,
  ReadPackDocResult,
  RegistryManifest,
  RiskTier,
  SiteDescriptor,
  SkillAsset,
  ToolDefinition,
  ToolOwnership,
  UserConfigStore,
  UserConfigSubject,
  UserInjectionEntry,
  UserOverlay,
  UserOverlayEntry,
  UserOverlayPackScope,
  UserOverlayRestrictions,
} from '@zen-agent/contracts';
import {
  checkContractCompatibility,
  compileConfigSchema,
  contractVersion,
  isDomTool,
  preparationWorkflows,
} from '@zen-agent/contracts';
import type { PackSource } from '@zen-agent/contracts';

export interface AssemblyOptions {
  /** 配置快照根目录：registry 形态含 manifest.json + packs/；legacy 形态含 manifest.json + features/ + skills/。 */
  snapshotRoot: string;
  /** 跨功能稳定基座（system prompt）文件路径，随快照一次载入。 */
  systemPromptPath: string;
  /**
   * L2 用户覆盖层存储端口（adr-014，组装点注入）：注入且 compose 提供 subject 时启用 L2 合并；
   * 缺省 = 纯 L1 装配。每回合单次 read 定格、不进快照缓存（快照仍不可变，U4）。
   */
  userConfigStore?: UserConfigStore;
}

/** 单次读取 pack 文档正文的字节上限（渐进披露：正文按需取，防单次回喂过量）。 */
const PACK_DOC_MAX_BYTES = 20 * 1024;

interface FeatureAssets {
  featureRules: string;
  facts: string;
  tools: ToolDefinition[];
  /** 功能人读标题（feature.md frontmatter title）；未声明为 null，展示回退 featureId。 */
  title: string | null;
}

interface CompiledRule {
  pattern: RegExp;
  featureId: string;
}

/**
 * 载入后的单个 pack（legacy 快照 = 唯一 packId="default" 的 pack，origin=null 无围栏）。
 * origin/locations 为 registry 形态的激活围栏；legacy 恒 origin=null 表整站不设围栏。
 */
interface LoadedPack {
  packId: string;
  version: string;
  /** 一句话站点用途（渐进披露第一层）；缺省 null，站点索引回退用 packId。 */
  summary: string | null;
  /** pack 人读名（pack.json name）；缺省 null，展示回退 packId。 */
  name: string | null;
  /** registry 登记来源（来源徽章数据源）；registry 缺省与 legacy 均为 official。 */
  source: PackSource;
  /** null = 无 site 围栏（legacy 缺省 pack / generic 兜底 pack），不参与 origin 匹配与站点索引。 */
  origin: string | null;
  /** generic 兜底 pack：无站点 pack 命中时兜底激活（origin=null、locations=[]）。 */
  generic: boolean;
  /** claims.tenant → origin 路由键（ADR-013）；缺省=不参与 per-origin 身份路由。 */
  tenant: string | undefined;
  /** 路径前缀（已归一去尾斜杠，'/' 表整站）；legacy 为空数组。 */
  locations: string[];
  /** 否定路径前缀（site.exclude，已归一）：命中任一即不匹配本 pack，优先于 locations；无声明为空数组。 */
  exclude: string[];
  rules: CompiledRule[];
  features: Map<string, FeatureAssets>;
  skills: SkillAsset[];
  /** docs/ 渐进披露索引；docs/ 为空则 null（零注入）。 */
  docsIndex: string | null;
  /** docs/ 绝对目录（readPackDoc 围栏基准）；docsIndex=null 时为 null。 */
  docsDir: string | null;
  /** adr-019 周期自动化声明；无声明为空数组。 */
  automations: PackAutomation[];
  /** pack 声明的用户可配置点（adr-020）；null = 未声明（L2 packConfig 写入期无表项即拒）。 */
  configSchema: JsonObject | null;
}

interface LoadedSnapshot {
  /** registry/legacy 根版本。 */
  version: string;
  systemPrompt: string;
  packs: Map<string, LoadedPack>;
  /** legacy 形态的缺省 pack id（"default"）；registry 形态为 null。 */
  legacyPackId: string | null;
  /** registry 内至多一个的 generic 兜底 pack id；无则 null（legacy 恒 null）。 */
  genericPackId: string | null;
}

const require = createRequire(import.meta.url);

function loadContractSchema(fileName: string): object {
  const schemaPath = require.resolve(`@zen-agent/contracts/schemas/${fileName}`);
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
}

function createValidator(fileName: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  addFormats.default(ajv);
  return ajv.compile(loadContractSchema(fileName));
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`快照拒载：无法读取 ${path}`, { cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`快照拒载：${path} 不是合法 JSON`, { cause });
  }
}

function errorsText(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

function loadFeature(
  featuresDir: string,
  featureId: string,
  validateTool: ValidateFunction,
): FeatureAssets {
  const featureDir = join(featuresDir, featureId);
  const readText = (file: string): string => {
    try {
      return readFileSync(join(featureDir, file), 'utf8');
    } catch (cause) {
      throw new Error(`快照拒载：功能 ${featureId} 缺 ${file}`, { cause });
    }
  };
  const featureRules = readText('feature.md');
  const facts = readText('facts.md');
  const title = parseFrontmatter(featureRules).title ?? null;
  const toolsPath = join(featureDir, 'tools.json');
  // knowledge-only pack 合法（adr-020 §1）：tools.json 可缺省，工具面按空处理；存在则仍全量校验。
  if (!existsSync(toolsPath)) {
    return { featureRules, facts, tools: [], title };
  }
  const toolsRaw = readJson(toolsPath);
  if (!Array.isArray(toolsRaw)) {
    throw new Error(`快照拒载：功能 ${featureId} 的 tools.json 须为数组`);
  }
  const tools = toolsRaw.map((element, index) => {
    if (!validateTool(element)) {
      throw new Error(
        `快照拒载：功能 ${featureId} 的 tools.json[${index}] 不过 tool-definition 契约：${errorsText(validateTool)}`,
      );
    }
    const tool = element as ToolDefinition;
    assertPreparationIntegrity(featureId, index, tool);
    return tool;
  });
  return { featureRules, facts, tools, title };
}

/** preparation 跨字段完整性（schema 表达不了的引用一致性）：不满足即拒载（fail-closed）。 */
function assertPreparationIntegrity(featureId: string, index: number, tool: ToolDefinition): void {
  const preparation = tool.authorization?.preparation;
  if (preparation === undefined) return;
  const reject = (reason: string): never => {
    throw new Error(`快照拒载：功能 ${featureId} 的 tools.json[${index}] preparation ${reason}`);
  };
  if (!(preparation.productParam in preparation.params)) {
    reject(`productParam "${preparation.productParam}" 不是 params 的键`);
  }
  if (!('orderId' in preparation.params)) {
    reject('params 缺 orderId（两类履约工作流的端口输入均要求订单号派生源）');
  }
  if (preparation.paramEvidence !== undefined && !(preparation.paramEvidence.param in preparation.params)) {
    reject(`paramEvidence.param "${preparation.paramEvidence.param}" 不是 params 的键`);
  }
  if (!isDomTool(tool)) reject('仅支持 dom 工具（证据配方在 adapter.snapshotEvidence）');
  else {
    const rule = (tool.adapter.snapshotEvidence ?? []).find((r) => r.id === preparation.evidence.rule);
    if (rule === undefined) {
      reject(`evidence.rule "${preparation.evidence.rule}" 不在 adapter.snapshotEvidence 中`);
    } else {
      for (const status of [preparation.evidence.before, preparation.evidence.after]) {
        if (status !== undefined && !rule.statuses.includes(status)) {
          reject(`evidence 状态 "${status}" 不在规则 "${rule.id}" 的 statuses 闭集中`);
        }
      }
    }
  }
}

function loadSkills(packRoot: string): SkillAsset[] {
  const skillsDir = join(packRoot, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const skillPath = join(skillsDir, id, 'SKILL.md');
      try {
        return { id, content: readFileSync(skillPath, 'utf8') };
      } catch (cause) {
        throw new Error(`快照拒载：skill ${id} 缺 SKILL.md`, { cause });
      }
    });
}

/** 解析 markdown frontmatter 的 title/summary（仅取这两键，供 docs 索引渐进披露用）。 */
function parseFrontmatter(raw: string): { title?: string; summary?: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const result: { title?: string; summary?: string } = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'title') result.title = value;
    else if (key === 'summary') result.summary = value;
  }
  return result;
}

/**
 * pack docs/ 渐进披露索引：仅注入每篇 frontmatter 标题+一句摘要（正文经 pack_doc 按需取）。
 * docs/ 缺失或无 .md → 返回 {index:null}（零注入，对验收非阻塞）。
 */
/** docs/ 递归列举 .md 相对路径（/ 分隔）：索引、capabilities.docs 闭单对账与 readPackDoc 围栏共用同一文件集。 */
function listDocFiles(docsDir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listDocFiles(join(docsDir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

function loadDocs(packRoot: string): {
  docsIndex: string | null;
  docsDir: string | null;
  docFiles: string[];
} {
  const docsDir = join(packRoot, 'docs');
  if (!existsSync(docsDir)) return { docsIndex: null, docsDir: null, docFiles: [] };
  const files = listDocFiles(docsDir);
  if (files.length === 0) return { docsIndex: null, docsDir: null, docFiles: [] };
  const lines = [
    '# 站点操作文档索引',
    '需要详细操作步骤/参考资料时，用 pack_doc 工具按下方文件名（path）读取正文：',
    '',
  ];
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(join(docsDir, file), 'utf8'));
    const title = fm.title ?? file;
    lines.push(`- \`${file}\`：${title}${fm.summary ? ` —— ${fm.summary}` : ''}`);
  }
  return { docsIndex: lines.join('\n'), docsDir, docFiles: files };
}

function compileRules(
  featureIdRules: PackManifest['featureIdRules'],
  features: Map<string, FeatureAssets>,
  label: string,
): CompiledRule[] {
  return featureIdRules.map(({ urlPattern, featureId }) => {
    if (!features.has(featureId)) {
      throw new Error(`快照拒载：${label} featureIdRules 指向包外功能 ${featureId}`);
    }
    try {
      return { pattern: new RegExp(urlPattern), featureId };
    } catch (cause) {
      throw new Error(`快照拒载：${label} urlPattern 非法正则 ${urlPattern}`, { cause });
    }
  });
}

function loadFeaturesOf(
  packRoot: string,
  declared: string[] | undefined,
  validateTool: ValidateFunction,
): Map<string, FeatureAssets> {
  const featuresDir = join(packRoot, 'features');
  const featureIds =
    declared ??
    (existsSync(featuresDir)
      ? readdirSync(featuresDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : []);
  const features = new Map<string, FeatureAssets>();
  for (const featureId of featureIds) {
    features.set(featureId, loadFeature(featuresDir, featureId, validateTool));
  }
  return features;
}

/** location 归一：去尾斜杠（'/' 保持）；用于前缀比对与最长前缀排序。 */
function normalizeLocation(loc: string): string {
  return loc !== '/' && loc.endsWith('/') ? loc.slice(0, -1) : loc;
}

/** 路径段前缀匹配：'/' 匹配一切；'/console' 匹配 '/console' 与 '/console/...'，不匹配 '/consolex'。 */
function locationMatches(path: string, loc: string): boolean {
  if (loc === '/') return true;
  return path === loc || path.startsWith(`${loc}/`);
}

/** 前缀特异度（最长前缀胜出的排序键）：'/' 最不特异（0）。 */
function locationRank(loc: string): number {
  return loc === '/' ? 0 : loc.length;
}

/** 闭单对账（双向）：声明缺实体或实体越闭单均拒载（adr-020 §2 capabilities.skills/docs）。 */
function assertClosedList(
  packId: string,
  label: string,
  declared: string[] | undefined,
  actual: string[],
): void {
  if (declared === undefined) return;
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);
  for (const id of declared) {
    if (!actualSet.has(id)) {
      throw new Error(`快照拒载：pack ${packId} capabilities.${label} 声明 ${id} 在目录中缺失`);
    }
  }
  for (const id of actual) {
    if (!declaredSet.has(id)) {
      throw new Error(`快照拒载：pack ${packId} ${label} 目录含闭单外条目 ${id}`);
    }
  }
}

/** pack v2 载入期语义（adr-020 §2）：engines 兼容 / 闭单对账 / workflows 子集 / configSchema 合法性，任一不过拒载。 */
function assertPackV2Semantics(pack: PackManifest, skills: SkillAsset[], docFiles: string[]): void {
  const contractRange = pack.engines?.contract;
  if (contractRange !== undefined) {
    const compat = checkContractCompatibility(contractRange);
    if (!compat.compatible) {
      const detail =
        compat.reason === 'invalid-range'
          ? `范围串非法：${contractRange}`
          : `范围 ${contractRange} 不含平台契约版本 ${contractVersion}`;
      throw new Error(`快照拒载：pack ${pack.packId} engines.contract ${detail}`);
    }
  }
  assertClosedList(pack.packId, 'skills', pack.capabilities?.skills, skills.map((s) => s.id));
  assertClosedList(pack.packId, 'docs', pack.capabilities?.docs, docFiles);
  for (const workflow of pack.capabilities?.preparation?.workflows ?? []) {
    if (!(preparationWorkflows as readonly string[]).includes(workflow)) {
      throw new Error(
        `快照拒载：pack ${pack.packId} capabilities.preparation.workflows 声明 ${workflow} 不在服务端已实现闭集 [${preparationWorkflows.join(', ')}] 内`,
      );
    }
  }
  if (pack.configSchema !== undefined) {
    try {
      compileConfigSchema(pack.configSchema);
    } catch (cause) {
      throw new Error(
        `快照拒载：pack ${pack.packId} configSchema 不是合法 JSON Schema：${(cause as Error).message}`,
        { cause },
      );
    }
  }
}

function loadPack(
  packRoot: string,
  entry: { packId: string; version: string; source?: PackSource },
  validatePack: ValidateFunction,
  validateTool: ValidateFunction,
): LoadedPack {
  const manifest = readJson(join(packRoot, 'pack.json'));
  if (!validatePack(manifest)) {
    throw new Error(
      `快照拒载：pack ${entry.packId} 的 pack.json 不过 pack 契约：${errorsText(validatePack)}`,
    );
  }
  const pack = manifest as PackManifest;
  if (pack.packId !== entry.packId) {
    throw new Error(
      `快照拒载：registry 登记 packId=${entry.packId} 与 pack.json packId=${pack.packId} 不一致`,
    );
  }
  if (pack.version !== entry.version) {
    throw new Error(
      `快照拒载：pack ${entry.packId} registry 版本 ${entry.version} 与 pack.json 版本 ${pack.version} 不一致`,
    );
  }
  const generic = pack.generic === true;
  const site = pack.site;
  if (generic && site !== undefined) {
    throw new Error(`快照拒载：generic pack ${entry.packId} 不得声明 site 围栏`);
  }
  if (!generic && site === undefined) {
    throw new Error(`快照拒载：pack ${entry.packId} 缺 site 围栏`);
  }
  const features = loadFeaturesOf(packRoot, pack.features, validateTool);
  const rules = compileRules(pack.featureIdRules, features, `pack ${pack.packId}`);
  const docs = loadDocs(packRoot);
  const skills = loadSkills(packRoot);
  assertPackV2Semantics(pack, skills, docs.docFiles);
  return {
    packId: pack.packId,
    version: pack.version,
    summary: pack.summary ?? null,
    name: pack.name ?? null,
    source: entry.source ?? 'official',
    origin: site === undefined ? null : site.origin,
    generic,
    tenant: pack.tenant,
    locations: site === undefined ? [] : (site.locations ?? ['/']).map(normalizeLocation),
    exclude: (site?.exclude ?? []).map(normalizeLocation),
    rules,
    features,
    skills,
    docsIndex: docs.docsIndex,
    docsDir: docs.docsDir,
    automations: pack.automations ?? [],
    configSchema: pack.configSchema ?? null,
  };
}

/** automation id 跨 pack 重复 → 载入期 fail-closed 拒载（id 是 alarm/单飞锁/完成帧的全局关联键）。 */
function assertNoDuplicateAutomationIds(packs: LoadedPack[]): void {
  const seen = new Map<string, string>();
  for (const pack of packs) {
    for (const automation of pack.automations) {
      const prior = seen.get(automation.id);
      if (prior !== undefined) {
        throw new Error(
          `快照拒载：automation id ${automation.id} 在 pack ${prior} 与 ${pack.packId} 重复`,
        );
      }
      seen.set(automation.id, pack.packId);
    }
  }
}

/** 同 origin 内 location 前缀重复 → 载入期 fail-closed 拒载（避免激活歧义）。 */
function assertNoDuplicateLocations(packs: LoadedPack[]): void {
  const seen = new Map<string, string>();
  for (const pack of packs) {
    if (pack.origin === null) continue;
    for (const loc of pack.locations) {
      const key = `${pack.origin}\n${loc}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new Error(
          `快照拒载：origin ${pack.origin} 的 location 前缀 ${loc} 在 pack ${prior} 与 ${pack.packId} 重复`,
        );
      }
      seen.set(key, pack.packId);
    }
  }
}

/** 快照一次载入 + fail-closed 全量校验；载入后内容只读缓存（U4 不可变）。根 manifest 二形态判别（registry / legacy）。 */
function loadSnapshot(options: AssemblyOptions): LoadedSnapshot {
  const manifestPath = join(options.snapshotRoot, 'manifest.json');
  const manifestRaw = readJson(manifestPath);

  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(options.systemPromptPath, 'utf8');
  } catch (cause) {
    throw new Error(`快照拒载：无法读取稳定基座 ${options.systemPromptPath}`, { cause });
  }

  const validateTool = createValidator('tool-definition.schema.json');
  const isRegistry =
    typeof manifestRaw === 'object' && manifestRaw !== null && Array.isArray((manifestRaw as { packs?: unknown }).packs);

  if (isRegistry) {
    const validateRegistry = createValidator('registry.schema.json');
    if (!validateRegistry(manifestRaw)) {
      throw new Error(`快照拒载：registry manifest.json 不过 registry 契约：${errorsText(validateRegistry)}`);
    }
    const registry = manifestRaw as RegistryManifest;
    const validatePack = createValidator('pack.schema.json');
    const packs = new Map<string, LoadedPack>();
    let genericPackId: string | null = null;
    for (const entry of registry.packs) {
      if (packs.has(entry.packId)) {
        throw new Error(`快照拒载：registry 重复登记 pack ${entry.packId}`);
      }
      const packRoot = join(options.snapshotRoot, 'packs', entry.packId);
      const loaded = loadPack(packRoot, entry, validatePack, validateTool);
      if (loaded.generic) {
        if (genericPackId !== null) {
          throw new Error(
            `快照拒载：registry 存在两个 generic pack：${genericPackId} 与 ${entry.packId}（至多一个）`,
          );
        }
        genericPackId = entry.packId;
      }
      packs.set(entry.packId, loaded);
    }
    assertNoDuplicateLocations([...packs.values()]);
    assertNoDuplicateAutomationIds([...packs.values()]);
    return { version: registry.version, systemPrompt, packs, legacyPackId: null, genericPackId };
  }

  // legacy 形态：现 featureIdRules 快照——按缺省 packId="default"、无 site 围栏载入（语义与现状一致）。
  const validateManifest = createValidator('config-snapshot.schema.json');
  if (!validateManifest(manifestRaw)) {
    throw new Error(
      `快照拒载：legacy manifest.json 不过 config-snapshot 契约（含 featureIdRules 等必备项）：${errorsText(validateManifest)}`,
    );
  }
  const manifest = manifestRaw as ConfigSnapshotManifest;
  const features = loadFeaturesOf(options.snapshotRoot, manifest.features, validateTool);
  const rules = compileRules(manifest.featureIdRules, features, 'legacy');
  const docs = loadDocs(options.snapshotRoot);
  const defaultPack: LoadedPack = {
    packId: 'default',
    version: manifest.version,
    summary: null,
    name: null,
    source: 'official',
    origin: null,
    generic: false,
    tenant: undefined,
    locations: [],
    exclude: [],
    rules,
    features,
    skills: loadSkills(options.snapshotRoot),
    docsIndex: docs.docsIndex,
    docsDir: docs.docsDir,
    automations: [],
    configSchema: null,
  };
  return {
    version: manifest.version,
    systemPrompt,
    packs: new Map([['default', defaultPack]]),
    legacyPackId: 'default',
    genericPackId: null,
  };
}

/** origin+最长 location 前缀 → 唯一激活 pack；无站点命中回落 generic 兜底 pack（URL 不可解析不兜底）。legacy 恒返回缺省 pack。 */
function resolvePack(snapshot: LoadedSnapshot, url: string): LoadedPack | null {
  if (snapshot.legacyPackId !== null) {
    return snapshot.packs.get(snapshot.legacyPackId) ?? null;
  }
  let origin: string;
  let path: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    path = parsed.pathname;
  } catch {
    return null;
  }
  let best: LoadedPack | null = null;
  let bestRank = -1;
  for (const pack of snapshot.packs.values()) {
    if (pack.origin !== origin) continue;
    // site.exclude 优先于 locations：命中任一否定前缀即整 pack 不匹配（adr-020 §2）。
    if (pack.exclude.some((ex) => locationMatches(path, ex))) continue;
    for (const loc of pack.locations) {
      if (!locationMatches(path, loc)) continue;
      const rank = locationRank(loc);
      if (rank > bestRank) {
        bestRank = rank;
        best = pack;
      }
    }
  }
  if (best !== null) return best;
  return snapshot.genericPackId !== null ? (snapshot.packs.get(snapshot.genericPackId) ?? null) : null;
}

/** pack 的可达入口 URL（origin + 首个 location 前缀）：site_navigate 的导航目标即取自此清单。 */
function navigableUrl(pack: LoadedPack): string {
  const loc = pack.locations[0] ?? '/';
  return `${pack.origin}${loc === '/' ? '/' : loc}`;
}

/**
 * 已安装站点索引（渐进披露第一层）：列出全部带 site 的 pack（用途+可达 URL），当前激活 pack 标注（当前）。
 * <2 个带 site 的 pack → null（单 site/legacy 无跨站发现意义，保持现状不注入）。
 */
function buildSitesIndex(snapshot: LoadedSnapshot, currentPackId: string | null): string | null {
  const sitePacks = [...snapshot.packs.values()].filter((pack) => pack.origin !== null);
  if (sitePacks.length < 2) return null;
  const lines = [
    '# 已安装站点索引',
    '平台可辅助以下站点。你当前所在的站点已标注（当前）；需要在其他站点完成的任务，用 site_navigate 导航到对应 URL：',
    '',
  ];
  for (const pack of sitePacks) {
    const label = pack.summary ?? pack.packId;
    const current = pack.packId === currentPackId ? '（当前）' : '';
    lines.push(`- ${label}：${navigableUrl(pack)}${current}`);
  }
  return lines.join('\n');
}

interface AssembledInjection {
  compose: ComposeResult;
  description: InjectionDescription;
}

/**
 * 本回合定格的 L2 读取结果（adr-014）：compose/describeInjection 每次调用单次 read、
 * 不进快照缓存（快照仍不可变，U4）。degraded=true 表示 read 抛错且无缓存——
 * rules/facts fail-open、工具面全 forbidden 的拆分降级（U7 存储故障不得放宽治理）。
 */
interface L2Context {
  degraded: boolean;
  overlay: UserOverlay | null;
  revision?: string;
  stale?: true;
}

async function readL2(
  store: UserConfigStore | undefined,
  subject: UserConfigSubject | undefined,
): Promise<L2Context | undefined> {
  if (store === undefined || subject === undefined) return undefined;
  try {
    const result = await store.read(subject);
    return {
      degraded: false,
      overlay: result.overlay,
      revision: result.revision,
      ...(result.stale === true ? { stale: true as const } : {}),
    };
  } catch {
    return { degraded: true, overlay: null };
  }
}

const RISK_TIER_RANK: Record<RiskTier, number> = { auto: 0, hitl: 1, forbidden: 2 };

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIER_RANK[b] > RISK_TIER_RANK[a] ? b : a;
}

const USER_ENTRY_ORIGIN_LABELS: Record<UserOverlayEntry['origin'], string> = {
  manual: '手动添加',
  teach: '对话确认',
};

/** L2 条目渲染（R4 逐条来源标注）：文本内嵌条目 id 与来源，供透明视图与审计定位。 */
function renderUserEntry(entry: UserOverlayEntry): UserInjectionEntry {
  return {
    id: entry.id,
    text: `[${entry.id}] ${entry.text}（来源：${USER_ENTRY_ORIGIN_LABELS[entry.origin]}）`,
  };
}

/** featureId 过滤：条目缺省 featureId = 整 pack 生效；有值须 === 当前 featureId 才注入。 */
function filterUserEntries(
  entries: UserOverlayEntry[] | undefined,
  featureId: string | null,
): UserOverlayEntry[] {
  return (entries ?? []).filter(
    (entry) => entry.featureId === undefined || entry.featureId === featureId,
  );
}

/**
 * L1 工具面与 L2 restrictions 的收紧合并（adr-014 §3）：riskTier 恒 max(L1, L2)；
 * disabledTools 从可见面移除但 descriptors 保留为 forbidden（幻觉调用仍被拒的数据源）；
 * 越界引用逐条失效不阻断其余，收入 invalidRefs 供网关落审计——判定基线是 packToolIds
 * （激活 pack 全量工具闭集，与写入期 validateOverlayAgainstL1 同口径）：引用同 pack
 * 其他 feature 工具的合法收紧不算越界，feature 过滤只决定本轮是否参与合并。
 */
function mergeToolFace(
  tools: ToolDefinition[],
  restrictions: UserOverlayRestrictions | undefined,
  scopeKey: string,
  packToolIds: Set<string>,
): { visible: ToolDefinition[]; descriptors: InjectionToolDescriptor[]; invalidRefs: string[] } {
  const raise = restrictions?.riskTierRaise ?? {};
  const disabled = new Set(restrictions?.disabledTools ?? []);
  const invalidRefs = [
    ...Object.keys(raise).filter((id) => !packToolIds.has(id)),
    ...[...disabled].filter((id) => !packToolIds.has(id)),
  ];
  const descriptors = tools.map((tool): InjectionToolDescriptor => {
    const declared = raise[tool.id];
    const merged = disabled.has(tool.id)
      ? 'forbidden'
      : declared !== undefined
        ? maxTier(tool.riskTier, declared)
        : tool.riskTier;
    return {
      toolId: tool.id,
      baseTier: tool.riskTier,
      effectiveTier: merged,
      origin: 'L1',
      ...(merged !== tool.riskTier ? { tightenedBy: scopeKey } : {}),
    };
  });
  return { visible: tools.filter((tool) => !disabled.has(tool.id)), descriptors, invalidRefs };
}

/**
 * compose 与 describeInjection 的同源装配（单一产出函数投影两视图），
 * 保证「查看到的注入构成」与「实际注入内容」一致。返回值为缓存的深拷贝，
 * 调用方变更不回写快照（U4）。packId=null → 仅基座（skills/docs/工具面均空）。
 * l2 提供时按 adr-014 合并：注入序 L0 → sitesIndex → L1 feature/facts →
 * L2 "*" 全局 → L2 pack 级 → skills → docsIndex；blocks 的 origin 标注仅在
 * L2 参与时产出（缺省 = legacy 未标注，兼容既有消费方）。
 */
function assembleInjection(
  snapshot: LoadedSnapshot,
  packId: string | null,
  featureId: string | null,
  l2?: L2Context,
): AssembledInjection {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  const l2Active = l2 !== undefined;
  // enabled:false（L2 pack 级关停）：该 pack 按未激活装配（回落仅基座），pack 作用域条目与工具面一并回落。
  const requestedScope =
    l2Active && !l2.degraded && packId !== null && l2.overlay !== null
      ? l2.overlay.packs[packId]
      : undefined;
  const packDisabled = (requestedScope as UserOverlayPackScope | undefined)?.enabled === false;
  const disabledPackId = packDisabled ? packId : null;
  const activePackId = packDisabled ? null : packId;

  // 站点索引跨功能稳定（不随 featureId 变），全局计算、只按当前激活 pack 标注（当前）；<2 site → null。
  const sitesIndex = buildSitesIndex(snapshot, activePackId);
  const origin = (layer: 'L0' | 'L1'): { origin?: 'L0' | 'L1' } => (l2Active ? { origin: layer } : {});
  const blocks: InjectionBlock[] = [
    { kind: 'system-prompt', bytes: bytes(snapshot.systemPrompt), ...origin('L0') },
  ];
  if (sitesIndex !== null) blocks.push({ kind: 'sites-index', bytes: bytes(sitesIndex), ...origin('L0') });

  let pack: LoadedPack | null = null;
  let feature: FeatureAssets | null = null;
  if (activePackId !== null) {
    const found = snapshot.packs.get(activePackId);
    if (found === undefined) {
      throw new Error(`装配拒绝：packId ${activePackId} 不在当前快照内`);
    }
    pack = found;
    if (featureId !== null) {
      const featureFound = pack.features.get(featureId);
      if (featureFound === undefined) {
        throw new Error(`装配拒绝：featureId ${featureId} 不在 pack ${activePackId} 内`);
      }
      feature = featureFound;
    }
  }
  const l1Tools =
    feature === null ? [] : feature.tools.filter((tool) => tool.featureIds.includes(featureId!));
  if (feature !== null) {
    blocks.push(
      { kind: 'feature-rules', bytes: bytes(feature.featureRules), ...origin('L1') },
      { kind: 'facts', bytes: bytes(feature.facts), ...origin('L1') },
    );
  }

  const userRules: UserInjectionEntry[] = [];
  const userFacts: UserInjectionEntry[] = [];
  if (l2Active && !l2.degraded && l2.overlay !== null) {
    const scopeIds = activePackId !== null ? ['*', activePackId] : ['*'];
    for (const scopeId of scopeIds) {
      const scope = l2.overlay.packs[scopeId];
      if (scope === undefined) continue;
      for (const entry of filterUserEntries(scope.rules, featureId).map(renderUserEntry)) {
        blocks.push({ kind: 'user-rules', id: entry.id, bytes: bytes(entry.text), origin: 'L2' });
        userRules.push(entry);
      }
      for (const entry of filterUserEntries(scope.facts, featureId).map(renderUserEntry)) {
        blocks.push({ kind: 'user-facts', id: entry.id, bytes: bytes(entry.text), origin: 'L2' });
        userFacts.push(entry);
      }
    }
  }

  if (pack !== null) {
    for (const skill of pack.skills) {
      blocks.push({ kind: 'skill', id: skill.id, bytes: bytes(skill.content), ...origin('L1') });
    }
    if (pack.docsIndex !== null) {
      blocks.push({ kind: 'docs-index', bytes: bytes(pack.docsIndex), ...origin('L1') });
    }
  }

  let visibleTools = l1Tools;
  let effectiveTools: InjectionToolDescriptor[] | undefined;
  let invalidRefs: string[] = [];
  if (l2Active) {
    if (l2.degraded) {
      // 读失败且无缓存的拆分降级：规则/事实 fail-open 纯 L1，治理面 fail-closed——全部工具置
      // forbidden 且可见面清空（含用户已 disabled 的工具不复现、agent 不在注定失败的调用上空转）；
      // descriptors 保留全量 forbidden 作幻觉调用拒绝的数据源（U7）。
      visibleTools = [];
      effectiveTools = l1Tools.map(
        (tool): InjectionToolDescriptor => ({
          toolId: tool.id,
          baseTier: tool.riskTier,
          effectiveTier: 'forbidden',
          origin: 'L1',
          tightenedBy: 'storage-failure',
        }),
      );
    } else {
      const restrictions = packDisabled
        ? undefined
        : (requestedScope as UserOverlayPackScope | undefined)?.restrictions;
      const packToolIds = new Set(
        pack === null
          ? []
          : [...pack.features.values()].flatMap((assets) => assets.tools.map((tool) => tool.id)),
      );
      const merged = mergeToolFace(l1Tools, restrictions, packId ?? '*', packToolIds);
      visibleTools = merged.visible;
      effectiveTools = merged.descriptors;
      invalidRefs = merged.invalidRefs;
    }
  }
  const l2Extras: Partial<ComposeResult> = l2Active
    ? {
        ...(l2.revision !== undefined ? { userConfigRevision: l2.revision } : {}),
        ...(l2.degraded ? { userConfigDegraded: 'fail-open-closed' as const } : { userRules, userFacts }),
        ...(effectiveTools !== undefined ? { effectiveTools } : {}),
        ...(invalidRefs.length > 0 ? { invalidRefs } : {}),
        ...(l2.stale === true ? { userConfigStale: true as const } : {}),
        ...(disabledPackId !== null ? { packDisabled: true as const, disabledPackId } : {}),
      }
    : {};

  return {
    compose: {
      snapshotVersion: snapshot.version,
      packId: pack === null ? null : pack.packId,
      packVersion: pack === null ? null : pack.version,
      systemPrompt: snapshot.systemPrompt,
      featureRules: feature === null ? null : feature.featureRules,
      facts: feature === null ? null : feature.facts,
      skills: pack === null ? [] : structuredClone(pack.skills),
      tools: structuredClone(visibleTools),
      docsIndex: pack === null ? null : pack.docsIndex,
      sitesIndex,
      ...l2Extras,
    },
    description: {
      snapshotVersion: snapshot.version,
      packId: pack === null ? null : pack.packId,
      featureId,
      blocks,
      toolIds: visibleTools.map((tool) => tool.id),
      ...(pack !== null ? { packVersion: pack.version, packSource: pack.source } : {}),
      ...(pack !== null && pack.name !== null ? { packName: pack.name } : {}),
      ...(feature?.title != null ? { featureTitle: feature.title } : {}),
      ...(effectiveTools !== undefined ? { tools: structuredClone(effectiveTools) } : {}),
      ...(l2Active && l2.revision !== undefined ? { userConfigRevision: l2.revision } : {}),
      ...(disabledPackId !== null ? { disabledPackId } : {}),
    },
  };
}

export function createAssemblyPort(options: AssemblyOptions): AssemblyPort {
  let snapshot: LoadedSnapshot | undefined;
  const getSnapshot = (): LoadedSnapshot => (snapshot ??= loadSnapshot(options));
  return {
    async resolveFeature({ url }) {
      const snap = getSnapshot();
      const pack = resolvePack(snap, url);
      if (pack === null) {
        return { packId: null, packVersion: null, featureId: null, snapshotVersion: snap.version };
      }
      const hit = pack.rules.find((rule) => rule.pattern.test(url));
      return {
        packId: pack.packId,
        packVersion: pack.version,
        featureId: hit?.featureId ?? null,
        snapshotVersion: snap.version,
        ...(pack.generic ? { generic: true } : {}),
      };
    },
    async compose({ packId, featureId, subject }) {
      const l2 = await readL2(options.userConfigStore, subject);
      return assembleInjection(getSnapshot(), packId, featureId, l2).compose;
    },
    async describeInjection({ packId, featureId, subject }) {
      const l2 = await readL2(options.userConfigStore, subject);
      return assembleInjection(getSnapshot(), packId, featureId, l2).description;
    },
    async readPackDoc({ packId, docPath }): Promise<ReadPackDocResult> {
      if (packId === null) return { ok: false, error: '无激活 pack，无可读文档' };
      const pack = getSnapshot().packs.get(packId);
      if (pack === undefined || pack.docsDir === null) {
        return { ok: false, error: '当前 pack 无文档' };
      }
      const target = resolve(pack.docsDir, docPath);
      const base = resolve(pack.docsDir);
      if (target !== base && !target.startsWith(base + sep)) {
        return { ok: false, error: '文档路径越出 docs/ 围栏' };
      }
      let buf: Buffer;
      try {
        buf = readFileSync(target);
      } catch {
        return { ok: false, error: '文档不存在' };
      }
      if (buf.length > PACK_DOC_MAX_BYTES) {
        return { ok: true, content: buf.subarray(0, PACK_DOC_MAX_BYTES).toString('utf8'), truncated: true };
      }
      return { ok: true, content: buf.toString('utf8'), truncated: false };
    },
    async allTools() {
      const byId = new Map<string, ToolDefinition>();
      for (const pack of getSnapshot().packs.values()) {
        for (const feature of pack.features.values()) {
          for (const tool of feature.tools) byId.set(tool.id, tool);
        }
      }
      return structuredClone([...byId.values()]);
    },
    async listSites() {
      const sites: SiteDescriptor[] = [];
      for (const pack of getSnapshot().packs.values()) {
        if (pack.origin === null) continue;
        sites.push({
          packId: pack.packId,
          origin: pack.origin,
          ...(pack.tenant !== undefined ? { tenant: pack.tenant } : {}),
          locations: [...pack.locations],
        });
      }
      return sites;
    },
    async listToolOwnership() {
      const ownership: ToolOwnership[] = [];
      for (const pack of getSnapshot().packs.values()) {
        for (const feature of pack.features.values()) {
          for (const tool of feature.tools) ownership.push({ packId: pack.packId, toolId: tool.id });
        }
      }
      return ownership;
    },
    async listAutomations() {
      const descriptors: AutomationDescriptor[] = [];
      for (const pack of getSnapshot().packs.values()) {
        if (pack.origin === null) continue;
        for (const automation of pack.automations) {
          descriptors.push({ packId: pack.packId, origin: pack.origin, automation });
        }
      }
      return structuredClone(descriptors);
    },
    async listPacks() {
      const descriptors: PackDescriptor[] = [];
      for (const pack of getSnapshot().packs.values()) {
        const tools = new Map<string, PackToolDescriptor>();
        const features: PackFeatureDescriptor[] = [];
        for (const [featureId, assets] of pack.features) {
          features.push({ featureId, ...(assets.title !== null ? { title: assets.title } : {}) });
          for (const tool of assets.tools) {
            tools.set(tool.id, {
              toolId: tool.id,
              baseTier: tool.riskTier,
              description: tool.description,
            });
          }
        }
        descriptors.push({
          packId: pack.packId,
          version: pack.version,
          source: pack.source,
          ...(pack.name !== null ? { name: pack.name } : {}),
          ...(pack.summary !== null ? { summary: pack.summary } : {}),
          ...(pack.origin !== null ? { origin: pack.origin, locations: [...pack.locations] } : {}),
          ...(pack.generic ? { generic: true as const } : {}),
          features,
          tools: [...tools.values()],
          automations: pack.automations.map((automation) => ({
            id: automation.id,
            ...(automation.defaultPeriodMinutes !== undefined
              ? { defaultPeriodMinutes: automation.defaultPeriodMinutes }
              : {}),
          })),
          ...(pack.configSchema !== null ? { configSchema: pack.configSchema } : {}),
        });
      }
      return structuredClone(descriptors);
    },
    async listConfigSchemas() {
      const schemas: Record<string, JsonObject> = {};
      for (const pack of getSnapshot().packs.values()) {
        if (pack.configSchema !== null) schemas[pack.packId] = pack.configSchema;
      }
      return structuredClone(schemas);
    },
  };
}
