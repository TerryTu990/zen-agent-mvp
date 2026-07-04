import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type {
  AssemblyPort,
  ComposeResult,
  ConfigSnapshotManifest,
  InjectionBlock,
  InjectionDescription,
  SkillAsset,
  ToolDefinition,
} from '@zen-agent/contracts';

export interface AssemblyOptions {
  /** 配置快照根目录（manifest.json + features/ + skills/ 所在，布局见 C4）。 */
  snapshotRoot: string;
  /** 跨功能稳定基座（system prompt）文件路径，随快照一次载入。 */
  systemPromptPath: string;
}

interface FeatureAssets {
  featureRules: string;
  facts: string;
  tools: ToolDefinition[];
}

interface CompiledRule {
  pattern: RegExp;
  featureId: string;
}

interface LoadedSnapshot {
  version: string;
  systemPrompt: string;
  rules: CompiledRule[];
  features: Map<string, FeatureAssets>;
  skills: SkillAsset[];
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

function loadSkills(snapshotRoot: string): SkillAsset[] {
  const skillsDir = join(snapshotRoot, 'skills');
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

/** 快照一次载入 + fail-closed 全量校验；载入后内容只读缓存（U4 不可变）。 */
function loadSnapshot(options: AssemblyOptions): LoadedSnapshot {
  const manifestPath = join(options.snapshotRoot, 'manifest.json');
  const manifestRaw = readJson(manifestPath);
  const validateManifest = createValidator('config-snapshot.schema.json');
  if (!validateManifest(manifestRaw)) {
    throw new Error(`快照拒载：manifest.json 不过 config-snapshot 契约（含 featureIdRules 等必备项）：${errorsText(validateManifest)}`);
  }
  const manifest = manifestRaw as ConfigSnapshotManifest;

  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(options.systemPromptPath, 'utf8');
  } catch (cause) {
    throw new Error(`快照拒载：无法读取稳定基座 ${options.systemPromptPath}`, { cause });
  }

  const featuresDir = join(options.snapshotRoot, 'features');
  const featureIds =
    manifest.features ??
    (existsSync(featuresDir)
      ? readdirSync(featuresDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : []);

  const validateTool = createValidator('tool-definition.schema.json');
  const features = new Map<string, FeatureAssets>();
  for (const featureId of featureIds) {
    features.set(featureId, loadFeature(featuresDir, featureId, validateTool));
  }

  const rules = manifest.featureIdRules.map(({ urlPattern, featureId }) => {
    if (!features.has(featureId)) {
      throw new Error(`快照拒载：featureIdRules 指向快照外功能 ${featureId}`);
    }
    try {
      return { pattern: new RegExp(urlPattern), featureId };
    } catch (cause) {
      throw new Error(`快照拒载：urlPattern 非法正则 ${urlPattern}`, { cause });
    }
  });

  return {
    version: manifest.version,
    systemPrompt,
    rules,
    features,
    skills: loadSkills(options.snapshotRoot),
  };
}

interface AssembledInjection {
  compose: ComposeResult;
  description: InjectionDescription;
}

/**
 * compose 与 describeInjection 的同源装配（单一产出函数投影两视图），
 * 保证「查看到的注入构成」与「实际注入内容」一致。返回值为缓存的深拷贝，
 * 调用方变更不回写快照（U4）。
 */
function assembleInjection(snapshot: LoadedSnapshot, featureId: string | null): AssembledInjection {
  let feature: FeatureAssets | null = null;
  if (featureId !== null) {
    const found = snapshot.features.get(featureId);
    if (found === undefined) {
      throw new Error(`装配拒绝：featureId ${featureId} 不在当前快照内`);
    }
    feature = found;
  }
  const tools =
    feature === null ? [] : feature.tools.filter((tool) => tool.featureIds.includes(featureId!));
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  const blocks: InjectionBlock[] = [{ kind: 'system-prompt', bytes: bytes(snapshot.systemPrompt) }];
  if (feature !== null) {
    blocks.push(
      { kind: 'feature-rules', bytes: bytes(feature.featureRules) },
      { kind: 'facts', bytes: bytes(feature.facts) },
    );
  }
  for (const skill of snapshot.skills) {
    blocks.push({ kind: 'skill', id: skill.id, bytes: bytes(skill.content) });
  }
  return {
    compose: {
      snapshotVersion: snapshot.version,
      systemPrompt: snapshot.systemPrompt,
      featureRules: feature === null ? null : feature.featureRules,
      facts: feature === null ? null : feature.facts,
      skills: structuredClone(snapshot.skills),
      tools: structuredClone(tools),
    },
    description: {
      snapshotVersion: snapshot.version,
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
      const hit = snap.rules.find((rule) => rule.pattern.test(url));
      return { featureId: hit?.featureId ?? null, snapshotVersion: snap.version };
    },
    async compose({ featureId }) {
      return assembleInjection(getSnapshot(), featureId).compose;
    },
    async describeInjection({ featureId }) {
      return assembleInjection(getSnapshot(), featureId).description;
    },
  };
}
