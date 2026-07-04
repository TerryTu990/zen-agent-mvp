/**
 * 会话网关：HTTP 上行帧（C3 schema 校验 fail-closed）→ agent 回合 → SSE 下行帧。
 * 每轮注入由 assembly.compose 整段重建覆写（不 append 进历史）；
 * M1 不给 LLM 传 tools（工具面接入锚点=M3），LLM 失败以脱敏文案下发（SEC-04）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type {
  AssemblyPort,
  ComposeResult,
  DownstreamFrame,
  GuideActionFrame,
  GuideActionKind,
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  UpstreamFrame,
} from '@zen-agent/contracts';
import type { TokenVerifier } from './auth.js';
import type { SessionState, SessionStore } from './sessions.js';

export interface GatewayDeps {
  assembly: AssemblyPort;
  llm: LlmPort;
  verifier: TokenVerifier;
  store: SessionStore;
  heartbeatMs: number;
}

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

interface SessionRuntime {
  subscribers: Set<ServerResponse>;
  /** 同会话回合串行链：user-message 依次排队，避免历史交错。 */
  turnChain: Promise<void>;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const validateFrame = createFrameValidator();
  const runtimes = new Map<string, SessionRuntime>();
  const openStreams = new Map<ServerResponse, () => void>();

  const runtimeOf = (sessionId: string): SessionRuntime => {
    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      runtime = { subscribers: new Set(), turnChain: Promise.resolve() };
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

  async function runTurn(session: SessionState, text: string): Promise<void> {
    const { sessionId } = session;
    const { featureId } = await deps.assembly.resolveFeature({ url: session.currentUrl ?? '' });
    const composed = await deps.assembly.compose({ sessionId, featureId });
    // 注入自省与 compose 同源，可随时按 featureId 重放；每轮记 audit assembly 事件的锚点=M4
    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemContent(composed) },
      ...session.history,
      { role: 'user', content: text },
    ];
    const tools: LlmToolSpec[] = composed.facts !== null ? [GUIDE_TOOL_SPEC] : [];
    let assistantText = '';
    for await (const event of deps.llm.chat(
      tools.length > 0 ? { messages, tools } : { messages },
    )) {
      if (event.kind === 'text-delta') {
        assistantText += event.delta;
        broadcast(sessionId, { type: 'text-delta', sessionId, delta: event.delta });
      } else if (event.kind === 'tool-call') {
        if (event.name === GUIDE_TOOL_NAME) {
          // 引导是终结动作：直接下发页面动作帧，本回合结束——不回喂 observation、不再等 LLM。
          const frame = guideFrame(sessionId, event.params);
          if (frame !== null) {
            broadcast(sessionId, frame);
          } else {
            const notice = '未能定位到目标元素。';
            assistantText += notice;
            broadcast(sessionId, { type: 'text-delta', sessionId, delta: notice });
          }
        } else {
          // 宿主 API 工具（tools.json）接入 agent 回合的锚点=M3；此前只如实告知不支持，不 fail。
          const notice = '该操作暂未支持。';
          assistantText += notice;
          broadcast(sessionId, { type: 'text-delta', sessionId, delta: notice });
        }
        break;
      } else if (event.kind === 'done' && event.stopReason === 'error') {
        // llm-port 错误文案契约上只含键名/状态类别，不含 env 值与密钥（SEC-04）
        const notice = `服务暂时不可用（${event.error ?? '未知错误'}）`;
        assistantText += notice;
        broadcast(sessionId, { type: 'text-delta', sessionId, delta: notice });
      }
    }
    deps.store.appendHistory(sessionId, { role: 'user', content: text });
    if (assistantText !== '') {
      deps.store.appendHistory(sessionId, { role: 'assistant', content: assistantText });
    }
  }

  async function handleFrames(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionState,
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
          .then(() => runTurn(session, upstream.text))
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
      default:
        sendJson(res, 501, {
          error: 'NOT_IMPLEMENTED: M3 代执行+HITL——hitl-decision / exec-result 帧处理',
        });
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
      const session = deps.store.create(claims.sub);
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
      if (match[2] === 'frames' && req.method === 'POST') return handleFrames(req, res, session);
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
