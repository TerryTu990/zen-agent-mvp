import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type {
  AssemblyPort,
  ComposeResult,
  ConfigSnapshotManifest,
  InjectionBlock,
  InjectionDescription,
  PackManifest,
  ReadPackDocResult,
  RegistryManifest,
  SiteDescriptor,
  SkillAsset,
  ToolDefinition,
  ToolOwnership,
} from '@zen-agent/contracts';

export interface AssemblyOptions {
  /** 配置快照根目录：registry 形态含 manifest.json + packs/；legacy 形态含 manifest.json + features/ + skills/。 */
  snapshotRoot: string;
  /** 跨功能稳定基座（system prompt）文件路径，随快照一次载入。 */
  systemPromptPath: string;
}

/** 单次读取 pack 文档正文的字节上限（渐进披露：正文按需取，防单次回喂过量）。 */
const PACK_DOC_MAX_BYTES = 20 * 1024;

interface FeatureAssets {
  featureRules: string;
  facts: string;
  tools: ToolDefinition[];
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
  /** null = 无 site 围栏（legacy 缺省 pack / generic 兜底 pack），不参与 origin 匹配与站点索引。 */
  origin: string | null;
  /** generic 兜底 pack：无站点 pack 命中时兜底激活（origin=null、locations=[]）。 */
  generic: boolean;
  /** claims.tenant → origin 路由键（ADR-013）；缺省=不参与 per-origin 身份路由。 */
  tenant: string | undefined;
  /** 路径前缀（已归一去尾斜杠，'/' 表整站）；legacy 为空数组。 */
  locations: string[];
  rules: CompiledRule[];
  features: Map<string, FeatureAssets>;
  skills: SkillAsset[];
  /** docs/ 渐进披露索引；docs/ 为空则 null（零注入）。 */
  docsIndex: string | null;
  /** docs/ 绝对目录（readPackDoc 围栏基准）；docsIndex=null 时为 null。 */
  docsDir: string | null;
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
  const toolsPath = join(featureDir, 'tools.json');
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
    return element as ToolDefinition;
  });
  return { featureRules, facts, tools };
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
function loadDocs(packRoot: string): { docsIndex: string | null; docsDir: string | null } {
  const docsDir = join(packRoot, 'docs');
  if (!existsSync(docsDir)) return { docsIndex: null, docsDir: null };
  const files = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return { docsIndex: null, docsDir: null };
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
  return { docsIndex: lines.join('\n'), docsDir };
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

function loadPack(
  packRoot: string,
  entry: { packId: string; version: string },
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
  return {
    packId: pack.packId,
    version: pack.version,
    summary: pack.summary ?? null,
    origin: site === undefined ? null : site.origin,
    generic,
    tenant: pack.tenant,
    locations: site === undefined ? [] : (site.locations ?? ['/']).map(normalizeLocation),
    rules,
    features,
    skills: loadSkills(packRoot),
    docsIndex: docs.docsIndex,
    docsDir: docs.docsDir,
  };
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
    origin: null,
    generic: false,
    tenant: undefined,
    locations: [],
    rules,
    features,
    skills: loadSkills(options.snapshotRoot),
    docsIndex: docs.docsIndex,
    docsDir: docs.docsDir,
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
 * compose 与 describeInjection 的同源装配（单一产出函数投影两视图），
 * 保证「查看到的注入构成」与「实际注入内容」一致。返回值为缓存的深拷贝，
 * 调用方变更不回写快照（U4）。packId=null → 仅基座（skills/docs/工具面均空）。
 */
function assembleInjection(
  snapshot: LoadedSnapshot,
  packId: string | null,
  featureId: string | null,
): AssembledInjection {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  // 站点索引跨功能稳定（不随 featureId 变），全局计算、只按当前激活 pack 标注（当前）；<2 site → null。
  const sitesIndex = buildSitesIndex(snapshot, packId);
  const blocks: InjectionBlock[] = [{ kind: 'system-prompt', bytes: bytes(snapshot.systemPrompt) }];
  if (sitesIndex !== null) blocks.push({ kind: 'sites-index', bytes: bytes(sitesIndex) });

  if (packId === null) {
    return {
      compose: {
        snapshotVersion: snapshot.version,
        packId: null,
        packVersion: null,
        systemPrompt: snapshot.systemPrompt,
        featureRules: null,
        facts: null,
        skills: [],
        tools: [],
        docsIndex: null,
        sitesIndex,
      },
      description: { snapshotVersion: snapshot.version, packId: null, featureId, blocks, toolIds: [] },
    };
  }

  const pack = snapshot.packs.get(packId);
  if (pack === undefined) {
    throw new Error(`装配拒绝：packId ${packId} 不在当前快照内`);
  }
  let feature: FeatureAssets | null = null;
  if (featureId !== null) {
    const found = pack.features.get(featureId);
    if (found === undefined) {
      throw new Error(`装配拒绝：featureId ${featureId} 不在 pack ${packId} 内`);
    }
    feature = found;
  }
  const tools =
    feature === null ? [] : feature.tools.filter((tool) => tool.featureIds.includes(featureId!));
  if (feature !== null) {
    blocks.push(
      { kind: 'feature-rules', bytes: bytes(feature.featureRules) },
      { kind: 'facts', bytes: bytes(feature.facts) },
    );
  }
  for (const skill of pack.skills) {
    blocks.push({ kind: 'skill', id: skill.id, bytes: bytes(skill.content) });
  }
  if (pack.docsIndex !== null) {
    blocks.push({ kind: 'docs-index', bytes: bytes(pack.docsIndex) });
  }
  return {
    compose: {
      snapshotVersion: snapshot.version,
      packId: pack.packId,
      packVersion: pack.version,
      systemPrompt: snapshot.systemPrompt,
      featureRules: feature === null ? null : feature.featureRules,
      facts: feature === null ? null : feature.facts,
      skills: structuredClone(pack.skills),
      tools: structuredClone(tools),
      docsIndex: pack.docsIndex,
      sitesIndex,
    },
    description: {
      snapshotVersion: snapshot.version,
      packId: pack.packId,
      featureId,
      blocks,
      toolIds: tools.map((tool) => tool.id),
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
    async compose({ packId, featureId }) {
      return assembleInjection(getSnapshot(), packId, featureId).compose;
    },
    async describeInjection({ packId, featureId }) {
      return assembleInjection(getSnapshot(), packId, featureId).description;
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
  };
}
