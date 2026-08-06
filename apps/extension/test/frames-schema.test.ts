import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  ClientCapability,
  ConfigDecisionFrame,
  ConfigDraftFrame,
  ContextReportFrame,
  DomStepAction,
  DownstreamFrame,
  ExecInstructionFrame,
  ExecResultFrame,
  GuideActionFrame,
  GuideActionKind,
  HitlDecisionFrame,
  HitlDecisionValue,
  HitlRequestFrame,
  HttpMethod,
  SnapshotReportFrame,
  SnapshotRequestFrame,
  TextDeltaFrame,
  ToolCardFrame,
  ToolCardStatus,
  TurnCompleteFrame,
  UpstreamFrame,
  UserMessageFrame,
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

function frameDefNamesOf(unionDef: 'upstreamFrame' | 'downstreamFrame'): string[] {
  return (defOf(unionDef).oneOf ?? []).map(({ $ref }) => $ref.split('/').pop() ?? '');
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
  'config-decision': true,
};

const downstreamMirror: Record<DownstreamFrame['type'], true> = {
  'text-delta': true,
  'turn-complete': true,
  'tool-card': true,
  'hitl-request': true,
  'exec-instruction': true,
  'guide-action': true,
  'snapshot-request': true,
  'config-draft': true,
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

/** `Record<keyof T, true>` 使 TS 侧漏抄字段在编译期即报错；键集再与 schema 属性集运行期对照。 */
const keysOf = <T extends object>(mirror: Record<keyof T, true>): string[] => Object.keys(mirror);

const FRAME_PROPERTY_MIRRORS: { def: string; keys: string[] }[] = [
  {
    def: 'contextReport',
    keys: keysOf<ContextReportFrame>({
      type: true, sessionId: true, url: true, title: true, featureId: true, snapshot: true,
    }),
  },
  {
    def: 'userMessage',
    keys: keysOf<UserMessageFrame>({
      type: true, sessionId: true, text: true, messageId: true,
      executionPreference: true, automationRunId: true, automationId: true,
    }),
  },
  {
    def: 'hitlDecision',
    keys: keysOf<HitlDecisionFrame>({
      type: true, sessionId: true, hitlId: true, decision: true, comment: true,
    }),
  },
  {
    def: 'execResult',
    keys: keysOf<ExecResultFrame>({
      type: true, sessionId: true, nonce: true, ok: true, status: true, body: true, error: true,
    }),
  },
  {
    def: 'snapshotReport',
    keys: keysOf<SnapshotReportFrame>({
      type: true, sessionId: true, requestId: true, url: true, title: true,
      pageInstanceId: true, elements: true, notices: true, evidence: true,
      text: true, textTruncated: true,
    }),
  },
  {
    def: 'configDecision',
    keys: keysOf<ConfigDecisionFrame>({
      type: true, sessionId: true, draftId: true, decision: true,
    }),
  },
  {
    def: 'textDelta',
    keys: keysOf<TextDeltaFrame>({ type: true, sessionId: true, delta: true, priority: true }),
  },
  {
    def: 'turnComplete',
    keys: keysOf<TurnCompleteFrame>({ type: true, sessionId: true, idle: true, messageId: true }),
  },
  {
    def: 'toolCard',
    keys: keysOf<ToolCardFrame>({
      type: true, sessionId: true, toolCallId: true, toolId: true, status: true, summary: true, mode: true,
    }),
  },
  {
    def: 'hitlRequest',
    keys: keysOf<HitlRequestFrame>({
      type: true, sessionId: true, hitlId: true, toolCallId: true, toolId: true, reason: true, params: true,
    }),
  },
  {
    def: 'execInstruction',
    keys: keysOf<ExecInstructionFrame>({
      type: true, sessionId: true, toolCallId: true, nonce: true, issuedAt: true,
      expiresAt: true, ttl: true, signature: true, request: true,
    }),
  },
  {
    def: 'guideAction',
    keys: keysOf<GuideActionFrame>({
      type: true, sessionId: true, action: true, selector: true, ref: true, message: true,
    }),
  },
  {
    def: 'snapshotRequest',
    keys: keysOf<SnapshotRequestFrame>({
      type: true, sessionId: true, requestId: true, evidenceRules: true, includeText: true,
    }),
  },
  {
    def: 'configDraft',
    keys: keysOf<ConfigDraftFrame>({
      type: true, sessionId: true, draftId: true, scope: true, summary: true, change: true,
    }),
  },
];

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

  /**
   * type 闭集一致拦不住字段级漂移：镜像少抄一个字段时类型与 schema 各自自洽，全部单测仍绿。
   * 逐帧对账属性集把两个方向都钉死——Record 键由 TS 侧编译期强制穷举（`tsc` 在 build 中跑，
   * 覆盖 test 目录），值与 schema 属性集运行期比对。
   */
  it.each(FRAME_PROPERTY_MIRRORS)('$def 的属性集与 schema 一致（U5 手抄镜像防漂移）', ({ def, keys }) => {
    expect([...keys].sort()).toEqual(Object.keys(defOf(def).properties).sort());
  });

  it('属性集对账覆盖全部帧定义：新增帧漏加镜像行即失败', () => {
    const covered = FRAME_PROPERTY_MIRRORS.map(({ def }) => def).sort();
    const declared = [...frameDefNamesOf('upstreamFrame'), ...frameDefNamesOf('downstreamFrame')].sort();
    expect(covered).toEqual(declared);
  });
});
