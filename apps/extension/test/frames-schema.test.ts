import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ClientCapability,
  DomStepAction,
  DownstreamFrame,
  GuideActionKind,
  HitlDecisionValue,
  HttpMethod,
  ToolCardStatus,
  UpstreamFrame,
} from '../src/frames.js';

interface FrameDef {
  properties: {
    type?: { const?: string };
    decision?: { enum?: string[] };
    status?: { enum?: string[] };
    action?: { enum?: string[] };
    method?: { enum?: string[] };
  };
}

interface C3Schema {
  $defs: Record<string, FrameDef & { enum?: string[]; oneOf?: { $ref: string }[] }>;
}

const schemaPath = new URL(
  '../../../packages/contracts/schemas/client-access-layer.schema.json',
  import.meta.url,
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as C3Schema;

function defOf(name: string) {
  const def = schema.$defs[name];
  if (!def) throw new Error(`schema $defs 缺少 ${name}`);
  return def;
}

function frameTypesOf(unionDef: 'upstreamFrame' | 'downstreamFrame'): string[] {
  const refs = defOf(unionDef).oneOf ?? [];
  return refs.map(({ $ref }) => {
    const name = $ref.split('/').pop() ?? '';
    const type = defOf(name).properties.type?.const;
    if (!type) throw new Error(`schema $defs/${name} 缺少 properties.type.const`);
    return type;
  });
}

// Record 键取自 frames.ts 联合类型：镜像漂移时先在编译期爆错，再由运行时与 schema 对照。
const upstreamMirror: Record<UpstreamFrame['type'], true> = {
  'context-report': true,
  'user-message': true,
  'hitl-decision': true,
  'exec-result': true,
  'snapshot-report': true,
};

const downstreamMirror: Record<DownstreamFrame['type'], true> = {
  'text-delta': true,
  'turn-complete': true,
  'tool-card': true,
  'hitl-request': true,
  'exec-instruction': true,
  'guide-action': true,
  'snapshot-request': true,
};

const capabilityMirror: Record<ClientCapability, true> = {
  identity: true,
  'context-report': true,
  'conversation-hitl': true,
  'page-action': true,
  'delegated-execution': true,
};

const hitlDecisionMirror: Record<HitlDecisionValue, true> = { approve: true, reject: true };

const toolCardStatusMirror: Record<ToolCardStatus, true> = {
  running: true,
  succeeded: true,
  failed: true,
};

const guideActionMirror: Record<GuideActionKind, true> = { highlight: true, 'scroll-to': true };

const httpMethodMirror: Record<HttpMethod, true> = {
  GET: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

const domStepActionMirror: Record<DomStepAction, true> = {
  navigate: true,
  waitFor: true,
  click: true,
  fill: true,
  select: true,
  read: true,
  scroll: true,
  highlight: true,
};

describe('frames.ts 与 C3 schema 的闭集同构', () => {
  it('上行帧 type 闭集一致', () => {
    expect(Object.keys(upstreamMirror).sort()).toEqual(frameTypesOf('upstreamFrame').sort());
  });

  it('下行帧 type 闭集一致', () => {
    expect(Object.keys(downstreamMirror).sort()).toEqual(frameTypesOf('downstreamFrame').sort());
  });

  it('五能力闭集一致（U5）', () => {
    expect(Object.keys(capabilityMirror).sort()).toEqual([...(defOf('capability').enum ?? [])].sort());
  });

  it('hitl decision 枚举一致', () => {
    expect(Object.keys(hitlDecisionMirror).sort()).toEqual(
      [...(defOf('hitlDecision').properties.decision?.enum ?? [])].sort(),
    );
  });

  it('tool-card status 枚举一致', () => {
    expect(Object.keys(toolCardStatusMirror).sort()).toEqual(
      [...(defOf('toolCard').properties.status?.enum ?? [])].sort(),
    );
  });

  it('guide-action 动作闭集一致', () => {
    expect(Object.keys(guideActionMirror).sort()).toEqual(
      [...(defOf('guideAction').properties.action?.enum ?? [])].sort(),
    );
  });

  it('exec http 请求 method 闭集一致', () => {
    expect(Object.keys(httpMethodMirror).sort()).toEqual(
      [...(defOf('httpExecRequest').properties.method?.enum ?? [])].sort(),
    );
  });

  it('dom 步骤动作闭集一致', () => {
    expect(Object.keys(domStepActionMirror).sort()).toEqual(
      [...(defOf('domStep').properties.action?.enum ?? [])].sort(),
    );
  });
});
