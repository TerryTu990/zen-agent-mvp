/**
 * 会话网关：HTTP 上行帧（C3 schema 校验 fail-closed）→ agent 回合 → SSE 下行帧。
 * 每轮注入由 assembly.compose 整段重建覆写（不 append 进历史）；
 * 工具面（guide 内建工具 + 宿主 API 工具）由服务端注入 LLM；宿主 API 代执行的分级/HITL 判定
 * 只在 toolgate、fail-closed（U7），LLM 失败以脱敏文案下发（SEC-04）。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type {
  AssemblyPort,
  AuditEvent,
  AuditPort,
  ComposeResult,
  DownstreamFrame,
  ExecResultFrame,
  GuideActionKind,
  GuideActionFrame,
  HitlDecisionValue,
  IdentityClaims,
  JsonObject,
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  Observation,
  ToolCardStatus,
  ToolDefinition,
  ToolGatePort,
  UpstreamFrame,
} from '@zen-agent/contracts';
import type { TokenVerifier } from './auth.js';
import type { SessionState, SessionStore } from './sessions.js';

export interface GatewayDeps {
  assembly: AssemblyPort;
  llm: LlmPort;
  toolgate: ToolGatePort;
  audit: AuditPort;
  verifier: TokenVerifier;
  store: SessionStore;
  heartbeatMs: number;
}

/** 执行结局 → 审计 outcome 闭集映射；deny/reject 不产 tool-execution（未执行），故只映射已执行结果。 */
function execOutcome(observation: Observation): 'ok' | 'error' | 'timeout' | 'invalid-result' {
  if (observation.ok) return 'ok';
  if (observation.error === 'invalid-result') return 'invalid-result';
  if (observation.error === 'timeout') return 'timeout';
  return 'error';
}

/** agent loop 轮数上限：防 LLM 反复触发工具无法收敛而失控烧配额。 */
const MAX_TURN_ROUNDS = 4;

export interface Gateway {
  handler(req: IncomingMessage, res: ServerResponse): void;
  /** 结束全部 SSE 长连接并清心跳，使 server.close 可完成。 */
  shutdown(): void;
}

const require = createRequire(import.meta.url);

function createFrameValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  const schemaPath = require.resolve(
    '@zen-agent/contracts/schemas/client-access-layer.schema.json',
  );
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
}

const UPSTREAM_TYPES: ReadonlySet<string> = new Set([
  'context-report',
  'user-message',
  'hitl-decision',
  'exec-result',
]);

const CORS_ORIGIN = { 'access-control-allow-origin': '*' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_ORIGIN });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, CORS_ORIGIN);
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * built-in 引导工具：不入 tools.json、不经 toolgate（那是 M3 宿主 API 工具路径）。
 * 仅当 composed.facts 非 null（当前功能有登记锚点）时注入；selector 取自 facts 登记锚点由
 * feature.md 运行期规则约束 LLM，服务端不校验其是否真在 facts 内（失配由客户端降级兜底）。
 */
const GUIDE_TOOL_NAME = 'guide_highlight';

const GUIDE_TOOL_SPEC: LlmToolSpec = {
  name: GUIDE_TOOL_NAME,
  description:
    '当用户询问某操作/入口在页面哪里时，用它高亮或滚动到当前功能页面上 facts 已登记的元素，帮助用户定位。selector 必须取自本功能 facts 中登记的元素锚点（如 #btn-export）；action 用 highlight 高亮或 scroll-to 滚动。',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'selector'],
    properties: {
      action: { enum: ['highlight', 'scroll-to'] },
      selector: { type: 'string' },
      message: { type: 'string' },
    },
  },
};

const GUIDE_ACTIONS: ReadonlySet<string> = new Set(['highlight', 'scroll-to']);

/**
 * 把 guide_highlight tool-call 的实参规整为下行页面动作帧；message 缺省则省略（U1 纯数据）。
 * action 越 highlight|scroll-to 闭集或 selector 非非空串 → null：服务端不下发违反 C3 契约的帧
 * （LLM 幻觉出的非法引导参数在此被拦，改走文本降级）。
 */
function guideFrame(sessionId: string, params: Record<string, unknown>): GuideActionFrame | null {
  const action = params['action'];
  const selector = params['selector'];
  if (typeof action !== 'string' || !GUIDE_ACTIONS.has(action)) return null;
  if (typeof selector !== 'string' || selector === '') return null;
  const message = params['message'];
  return {
    type: 'guide-action',
    sessionId,
    action: action as GuideActionKind,
    selector,
    ...(typeof message === 'string' ? { message } : {}),
  };
}

function buildSystemContent(composed: ComposeResult): string {
  const parts = [composed.systemPrompt];
  if (composed.featureRules !== null) parts.push(composed.featureRules);
  if (composed.facts !== null) parts.push(composed.facts);
  for (const skill of composed.skills) parts.push(skill.content);
  return parts.join('\n\n');
}

/** 宿主 API 工具定义 → LLM 工具面：name=toolId，装配对 agent 透明（LLM 不感知分级/通道）。 */
function toLlmToolSpec(tool: ToolDefinition): LlmToolSpec {
  return { name: tool.id, description: tool.description, params: tool.params };
}

interface SessionRuntime {
  subscribers: Set<ServerResponse>;
  /** 同会话回合串行链：user-message 依次排队，避免历史交错。 */
  turnChain: Promise<void>;
  /** HITL 挂起等待器：hitlId → resolver；hitl-decision 到达时解析，回合恢复。 */
  pendingHitl: Map<string, (decision: HitlDecisionValue) => void>;
  /** 代执行挂起等待器：nonce → resolver；exec-result 到达时解析，回合恢复。 */
  pendingExec: Map<string, (result: ExecResultFrame) => void>;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const validateFrame = createFrameValidator();
  const runtimes = new Map<string, SessionRuntime>();
  const openStreams = new Map<ServerResponse, () => void>();

  const runtimeOf = (sessionId: string): SessionRuntime => {
    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        subscribers: new Set(),
        turnChain: Promise.resolve(),
        pendingHitl: new Map(),
        pendingExec: new Map(),
      };
      runtimes.set(sessionId, runtime);
    }
    return runtime;
  };

  const broadcast = (sessionId: string, frame: DownstreamFrame): void => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const subscriber of runtime.subscribers) subscriber.write(payload);
  };

  const notify = (sessionId: string, notice: string): void => {
    broadcast(sessionId, { type: 'text-delta', sessionId, delta: notice });
  };

  /**
   * 记一条审计事件（record-only 旁路，U6/C5）：网关只传 schema 允许字段（不含实参/响应体/签名/secret），
   * 脱敏前置由此构造保证、audit sink 再兜一层。eventId/ts 就地生成；audit.record 契约不抛，无需 try/catch。
   */
  const recordEvent = (
    sessionId: string,
    claims: IdentityClaims,
    featureId: string | null,
    body: Pick<AuditEvent, 'type' | 'data'>,
  ): void => {
    deps.audit.record({
      eventId: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      userId: claims.hostUserId,
      tenant: claims.tenant,
      ...(featureId !== null ? { featureId } : {}),
      ...body,
    } as AuditEvent);
  };

  /** 等待客户端 hitl-decision；resolver 先注册再下发帧，避免决策先于等待器到达而丢帧。 */
  function waitForHitl(sessionId: string, hitlId: string): Promise<HitlDecisionValue> {
    const runtime = runtimeOf(sessionId);
    return new Promise((resolve) => runtime.pendingHitl.set(hitlId, resolve));
  }

  /** 等待客户端 exec-result；同理先注册 nonce 等待器，再下发 exec-instruction 帧。 */
  function waitForExec(sessionId: string, nonce: string): Promise<ExecResultFrame> {
    const runtime = runtimeOf(sessionId);
    return new Promise((resolve) => runtime.pendingExec.set(nonce, resolve));
  }

  /**
   * 单个宿主 API 工具调用的代执行子流程：一切分级/HITL/结果判定都在 toolgate（U7 fail-closed），
   * 网关只按判定下发帧、挂起等待客户端回传、把规整后的 observation 交回 agent loop。
   * tool-card 摘要仅取 toolId（不含实参值，SEC-04）；deny/reject 时自造 ok:false observation。
   */
  async function runExecSubflow(
    session: SessionState,
    claims: IdentityClaims,
    featureId: string | null,
    tool: ToolDefinition,
    call: { toolCallId: string; params: JsonObject },
  ): Promise<Observation> {
    const { sessionId } = session;
    const { toolCallId, params } = call;
    broadcast(sessionId, {
      type: 'tool-card',
      sessionId,
      toolCallId,
      toolId: tool.id,
      status: 'running',
      summary: tool.id,
    });
    const finish = (status: ToolCardStatus): void => {
      broadcast(sessionId, { type: 'tool-card', sessionId, toolCallId, toolId: tool.id, status });
    };

    const decision = await deps.toolgate.decide({
      sessionId,
      toolCallId,
      toolId: tool.id,
      params,
      claims,
    });
    recordEvent(sessionId, claims, featureId, {
      type: 'tool-decision',
      data: {
        toolCallId,
        toolId: tool.id,
        riskTier: tool.riskTier,
        verdict: decision.verdict,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
    });
    if (decision.verdict === 'deny') {
      finish('failed');
      return { toolCallId, ok: false, content: null, error: decision.reason ?? 'denied' };
    }
    if (decision.verdict === 'hitl') {
      const hitlId = randomUUID();
      const decided = waitForHitl(sessionId, hitlId);
      broadcast(sessionId, {
        type: 'hitl-request',
        sessionId,
        hitlId,
        toolCallId,
        toolId: tool.id,
        params,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      });
      const verdict = await decided;
      recordEvent(sessionId, claims, featureId, {
        type: 'hitl-verdict',
        data: { hitlId, toolCallId, decision: verdict },
      });
      if (verdict === 'reject') {
        finish('failed');
        return { toolCallId, ok: false, content: null, error: 'user-rejected' };
      }
    }

    const startedAt = Date.now();
    const instruction = await deps.toolgate.issueExecInstruction({
      sessionId,
      toolCallId,
      toolId: tool.id,
      params,
    });
    const result = waitForExec(sessionId, instruction.nonce);
    broadcast(sessionId, instruction);
    const execResult = await result;
    const observation = await deps.toolgate.acceptExecResult({ sessionId, result: execResult });
    finish(observation.ok ? 'succeeded' : 'failed');
    recordEvent(sessionId, claims, featureId, {
      type: 'tool-execution',
      data: {
        toolCallId,
        toolId: tool.id,
        execution: tool.execution,
        nonce: instruction.nonce,
        outcome: execOutcome(observation),
        ...(typeof execResult.status === 'number' ? { status: execResult.status } : {}),
        durationMs: Date.now() - startedAt,
      },
    });
    return observation;
  }

  async function runTurn(
    session: SessionState,
    text: string,
    claims: IdentityClaims,
  ): Promise<void> {
    const { sessionId } = session;
    const { featureId } = await deps.assembly.resolveFeature({ url: session.currentUrl ?? '' });
    const composed = await deps.assembly.compose({ sessionId, featureId });
    // 注入自省与 compose 同源：审计 assembly 事件记录本轮 agent 看到了什么（只记 id 与版本，不落全文）。
    const injection = await deps.assembly.describeInjection({ sessionId, featureId });
    recordEvent(sessionId, claims, featureId, {
      type: 'assembly',
      data: {
        snapshotVersion: injection.snapshotVersion,
        featureId,
        toolIds: injection.toolIds,
        skillIds: composed.skills.map((skill) => skill.id),
      },
    });
    const hostToolsById = new Map(composed.tools.map((tool) => [tool.id, tool]));
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemContent(composed) },
      ...session.history,
      { role: 'user', content: text },
    ];
    const guideTools: LlmToolSpec[] = composed.facts !== null ? [GUIDE_TOOL_SPEC] : [];
    const tools: LlmToolSpec[] = [...guideTools, ...composed.tools.map(toLlmToolSpec)];
    // 全回合累积的用户可见文本：多轮中只有最终一轮产出气泡文本，作为本回合 assistant 历史。
    let visibleText = '';

    for (let round = 0; round < MAX_TURN_ROUNDS; round += 1) {
      let roundText = '';
      let call: { toolCallId: string; name: string; params: JsonObject } | null = null;
      for await (const event of deps.llm.chat(tools.length > 0 ? { messages, tools } : { messages })) {
        if (event.kind === 'text-delta') {
          roundText += event.delta;
          visibleText += event.delta;
          broadcast(sessionId, { type: 'text-delta', sessionId, delta: event.delta });
        } else if (event.kind === 'tool-call') {
          call = { toolCallId: event.toolCallId, name: event.name, params: event.params };
          break;
        } else if (event.kind === 'done' && event.stopReason === 'error') {
          // llm-port 错误文案契约上只含键名/状态类别，不含 env 值与密钥（SEC-04）
          const notice = `服务暂时不可用（${event.error ?? '未知错误'}）`;
          visibleText += notice;
          notify(sessionId, notice);
        }
      }
      // 无工具调用（纯文本/错误收尾）：本回合终结。
      if (call === null) break;

      if (call.name === GUIDE_TOOL_NAME) {
        // 引导是终结动作：直接下发页面动作帧，本回合结束——不回喂 observation、不再等 LLM。
        const frame = guideFrame(sessionId, call.params);
        if (frame !== null) {
          broadcast(sessionId, frame);
        } else {
          const notice = '未能定位到目标元素。';
          visibleText += notice;
          notify(sessionId, notice);
        }
        break;
      }

      const tool = hostToolsById.get(call.name);
      if (tool === undefined) {
        // 白名单外的工具名（LLM 幻觉）：如实告知不支持，回合终结、不 fail。
        const notice = '该操作暂未支持。';
        visibleText += notice;
        notify(sessionId, notice);
        break;
      }

      const observation = await runExecSubflow(session, claims, featureId, tool, call);
      // 回喂 agent：assistant 调用轮（本轮文本，通常为空）+ observation（仅规整结果，U7）。
      // LlmMessage 端口冻结无 tool_calls 字段，故 assistant 轮不回声 tool_calls；MVP 由 mock 凭
      // 末条 role:tool 观察驱动总结。补 tool_calls 回声的锚点＝llm-port 接真实 provider 时评估。
      messages.push({ role: 'assistant', content: roundText });
      messages.push({
        role: 'tool',
        toolCallId: call.toolCallId,
        content: JSON.stringify(observation.ok ? observation.content : { error: observation.error }),
      });
    }

    deps.store.appendHistory(sessionId, { role: 'user', content: text });
    if (visibleText !== '') {
      deps.store.appendHistory(sessionId, { role: 'assistant', content: visibleText });
    }
  }

  async function handleFrames(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionState,
    claims: IdentityClaims,
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!validateFrame(frame)) {
      sendJson(res, 400, { error: '帧不过 client-access-layer 契约' });
      return;
    }
    const type = (frame as { type: string }).type;
    if (!UPSTREAM_TYPES.has(type)) {
      sendJson(res, 400, { error: '仅接受上行帧' });
      return;
    }
    const upstream = frame as UpstreamFrame;
    if (upstream.sessionId !== session.sessionId) {
      sendJson(res, 400, { error: '帧 sessionId 与路径不一致' });
      return;
    }
    switch (upstream.type) {
      case 'context-report':
        deps.store.setContext(session.sessionId, upstream.url);
        sendNoContent(res);
        return;
      case 'user-message': {
        const runtime = runtimeOf(session.sessionId);
        runtime.turnChain = runtime.turnChain
          .then(() => runTurn(session, upstream.text, claims))
          .catch((cause) => {
            // 回合内部异常不外泄细节（SEC-04）：客户端只见类别，明细留本地日志
            console.error('agent 回合异常：', cause);
            broadcast(session.sessionId, {
              type: 'text-delta',
              sessionId: session.sessionId,
              delta: '服务暂时不可用（内部错误）',
            });
          });
        sendJson(res, 202, { accepted: true });
        return;
      }
      case 'hitl-decision': {
        // 解析挂起的 HITL 等待器使回合恢复；无对应等待器＝已决策/失效，409（不改回合状态）。
        const resolve = runtimeOf(session.sessionId).pendingHitl.get(upstream.hitlId);
        if (resolve === undefined) {
          sendJson(res, 409, { error: 'HITL 决策无对应挂起回合（已处理或失效）' });
          return;
        }
        runtimeOf(session.sessionId).pendingHitl.delete(upstream.hitlId);
        resolve(upstream.decision);
        sendJson(res, 202, { accepted: true });
        return;
      }
      case 'exec-result': {
        // nonce 等待器在网关层即为一次性：命中即摘除，二次到达（重放）无等待器→409、不再入 toolgate。
        const resolve = runtimeOf(session.sessionId).pendingExec.get(upstream.nonce);
        if (resolve === undefined) {
          sendJson(res, 409, { error: '代执行结果无对应挂起回合（已处理、重放或伪造 nonce）' });
          return;
        }
        runtimeOf(session.sessionId).pendingExec.delete(upstream.nonce);
        resolve(upstream);
        sendJson(res, 202, { accepted: true });
        return;
      }
    }
  }

  function handleEvents(res: ServerResponse, session: SessionState): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...CORS_ORIGIN,
    });
    res.write(': ping\n\n');
    const runtime = runtimeOf(session.sessionId);
    runtime.subscribers.add(res);
    const timer = setInterval(() => {
      res.write(': ping\n\n');
    }, deps.heartbeatMs);
    timer.unref();
    const cleanup = (): void => {
      clearInterval(timer);
      runtime.subscribers.delete(res);
      openStreams.delete(res);
    };
    openStreams.set(res, cleanup);
    res.on('close', cleanup);
  }

  async function handleInjection(res: ServerResponse, session: SessionState): Promise<void> {
    const { featureId } = await deps.assembly.resolveFeature({ url: session.currentUrl ?? '' });
    const description = await deps.assembly.describeInjection({
      sessionId: session.sessionId,
      featureId,
    });
    sendJson(res, 200, description);
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS_ORIGIN,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }
    const claims = await deps.verifier.verify(req.headers.authorization);
    if (claims === null) {
      sendJson(res, 401, { error: '身份校验未通过' });
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'POST' && pathname === '/v1/sessions') {
      const session = deps.store.create(claims);
      recordEvent(session.sessionId, claims, null, {
        type: 'session-start',
        data: { clientKind: 'extension', iss: claims.iss },
      });
      sendJson(res, 201, { sessionId: session.sessionId });
      return;
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(frames|events|injection)$/.exec(pathname);
    if (match) {
      const sessionId = decodeURIComponent(match[1]!);
      const session = deps.store.get(sessionId);
      if (!session || session.ownerSub !== claims.sub) {
        sendJson(res, 404, { error: '会话不存在' });
        return;
      }
      // 每次请求以当前验签结果刷新会话身份，代执行门禁始终按最新有效 claims 判定（U7）。
      deps.store.refreshClaims(sessionId, claims);
      if (match[2] === 'frames' && req.method === 'POST') return handleFrames(req, res, session, claims);
      if (match[2] === 'events' && req.method === 'GET') return handleEvents(res, session);
      if (match[2] === 'injection' && req.method === 'GET') return handleInjection(res, session);
    }
    sendJson(res, 404, { error: '未知路由' });
  }

  return {
    handler(req, res) {
      void dispatch(req, res).catch((cause) => {
        console.error('请求处理异常：', cause);
        if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
        else res.end();
      });
    },
    shutdown() {
      for (const [stream, cleanup] of [...openStreams]) {
        cleanup();
        stream.end();
      }
    },
  };
}
