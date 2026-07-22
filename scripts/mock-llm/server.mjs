/**
 * 确定性 mock LLM（OpenAI chat completions 兼容，仅 stream:true）。
 * 供 llm-port 集成测试与 E2E 编排使用：按规则对 (system 拼接, 最后 user) 产出固定回复。
 * 判定优先级（更具体优先）：存在 role:tool 观察 → 代执行回喂轮，据 observation 产出总结文本；
 * 否则按关键词 + 工具可见性触发代执行 tool_call（取消/刷新/清空）；再判 R5 引导；末位 R1-R4 文本。
 * tool_call 产出 OpenAI tool_calls 流式 delta（arguments 分片，与 llm-port 增量聚合契约对齐）；
 * 文本内容拆 ≥3 个 SSE chunk 下发以覆盖流式分片路径。纯 node 内建，无依赖。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const REPLY_R1_HIT = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_DETAIL = '这是订单详情页：展示订单号、状态与金额，可通过返回链接回到订单列表。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3_REFUSE = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';
const REPLY_R4_ADMIN = '订单为何处于当前状态属业务判断，不在本功能的讲解范围内，需联系订单管理员了解。';

const GUIDE_TOOL = 'guide_highlight';
const GUIDE_LOCATE_RE = /在哪|哪里|哪儿|怎么找|如何找到|定位/;

const TOOL_CANCEL = 'order-list.cancel-order';
const TOOL_REFRESH = 'order-list.refresh-orders';
const TOOL_PURGE = 'order-list.purge-orders';
const TOOL_PAGE_OPERATE = 'order-list.page-operate';
const TOOL_SNAPSHOT = 'page_snapshot';
const TOOL_SEND_EMAIL = 'mail-126.send-email';
const TOOL_BROWSE = 'browse.page-operate';
const TOOL_XIANYU_ORDERS = 'xianyu-orders.page-operate';
const TOOL_XIANYU_SEND = 'xianyu-fulfillment.send-test-message';
const TOOL_XIANYU_INTENT = 'xianyu-fulfillment.execute-intent';
const TOOL_XIANYU_PREPARE = 'prepare_xianyu_fulfillment';
const TOOL_XIANYU_SHIPPING = 'xianyu-shipping.execute-intent';
const TOOL_XIANYU_SHIPPING_PREPARE = 'prepare_xianyu_shipping';

/** llm-port 出网把点分 toolId 的点替换为 '__'（OpenAI 函数名不含点）；比对前归一还原。 */
function normalizeToolName(name) {
  return typeof name === 'string' ? name.replaceAll('__', '.') : name;
}

/** 请求 tools 是否携带指定 name 的工具（OpenAI function 形态或裸 name；wire 名归一后比对）。 */
function hasTool(body, name) {
  return (
    Array.isArray(body?.tools) &&
    body.tools.some(
      (t) => normalizeToolName(t?.function?.name) === name || normalizeToolName(t?.name) === name,
    )
  );
}

/**
 * 代执行回喂轮的 observation 文本——仅当消息尾部就是 role:tool（其后无更新 user 消息）才成立。
 * 契约感知：服务端把 execEcho(assistant)+observation(role:tool) 追加在末尾后立即再调本轮，
 * 故回喂轮的最后一条必是 role:tool；而 history 现持久化历史工具轮，新 user 回合的尾部是 role:user，
 * 若只取"数组中最后一条 role:tool"会误把上一回合的陈旧观测当作本回合回喂，令新 user 指令走不到工具触发。
 * 非 null 即"回喂轮"，据此产出总结文本而非再次触发工具。
 */
function lastToolObs(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1];
  return last?.role === 'tool' ? String(last.content ?? '') : null;
}

/** 首轮工具触发：按关键词 + 工具可见性产出 tool_call；无命中返回 null。 */
function pickToolCall(u, body) {
  const ord = u.match(/ORD-\d+/);
  if (u.includes('取消') && ord && hasTool(body, TOOL_CANCEL)) {
    return { id: 'call_cancel', name: TOOL_CANCEL, arguments: JSON.stringify({ orderId: ord[0] }) };
  }
  if (u.includes('刷新') && hasTool(body, TOOL_REFRESH)) {
    return { id: 'call_refresh', name: TOOL_REFRESH, arguments: JSON.stringify({}) };
  }
  if ((u.includes('清空') || u.includes('删除所有')) && hasTool(body, TOOL_PURGE)) {
    return { id: 'call_purge', name: TOOL_PURGE, arguments: JSON.stringify({}) };
  }
  // dom 代操作首轮：先观察（快照），后续轮见 decide 的快照观察分支。
  if (u.includes('在页面上') && hasTool(body, TOOL_SNAPSHOT)) {
    return { id: 'call_snapshot', name: TOOL_SNAPSHOT, arguments: JSON.stringify({}) };
  }
  // 126 发送邮件（ADR-013 every-call）：先观察快照取发送按钮 ref，后续轮走 sendEmailCall。
  if (u.includes('发送邮件') && hasTool(body, TOOL_SEND_EMAIL) && hasTool(body, TOOL_SNAPSHOT)) {
    return { id: 'call_snapshot', name: TOOL_SNAPSHOT, arguments: JSON.stringify({}) };
  }
  if (u.includes('发送闲鱼测试消息') && hasTool(body, TOOL_XIANYU_SEND) && hasTool(body, TOOL_SNAPSHOT)) {
    return { id: 'call_snapshot', name: TOOL_SNAPSHOT, arguments: JSON.stringify({}) };
  }
  return null;
}

/** 快照观察轮 → send-email 单步点击批次：从快照取按钮 ref，task 固定（同任务连发以判别 every-call 不复用）。 */
function sendEmailCall(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    snap = { elements: [] };
  }
  const elements = Array.isArray(snap.elements) ? snap.elements : [];
  const button = elements.find((e) => e?.role === 'button') ?? elements[0];
  return {
    id: 'call_send_email',
    name: TOOL_SEND_EMAIL,
    arguments: JSON.stringify({
      task: '发送邮件给测试收件人',
      steps: [{ action: 'click', ref: button?.ref ?? 'za-0' }],
      summary: '点击发送按钮发送邮件',
    }),
  };
}

function sendXianyuTestCall(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    snap = { elements: [] };
  }
  const elements = Array.isArray(snap.elements) ? snap.elements : [];
  const button = elements.find((e) => String(e?.label ?? '').replace(/\s+/g, '') === '发送') ?? elements[0];
  return {
    id: 'call_xianyu_send',
    name: TOOL_XIANYU_SEND,
    arguments: JSON.stringify({
      task: '发送闲鱼非秘密测试消息',
      steps: [{ action: 'click', ref: button?.ref ?? 'za-send' }],
      summary: '对外发送已准备好的非秘密测试占位内容',
    }),
  };
}

function executeXianyuIntentCall(userText) {
  const match = userText.match(/履约意图\s+([0-9a-f-]{16,})/i);
  return {
    id: 'call_xianyu_intent',
    name: TOOL_XIANYU_INTENT,
    arguments: JSON.stringify({ intentId: match?.[1] ?? 'missing-intent' }),
  };
}

function executePreparedXianyuIntentCall(obs, toolName = TOOL_XIANYU_INTENT) {
  let intentId = 'missing-intent';
  try {
    const parsed = JSON.parse(obs);
    if (typeof parsed.intentId === 'string') intentId = parsed.intentId;
  } catch {
    // 保持闭集占位，让服务端 fail-closed。
  }
  return {
    // 同一会话可能顺序处理多个订单；调用 ID 绑定 opaque intent，避免测试 mock
    // 把不同订单伪装成同一个 tool call 重放而被服务端正确拒绝。
    id: `${toolName === TOOL_XIANYU_SHIPPING ? 'call_xianyu_shipping_intent' : 'call_xianyu_intent'}_${intentId}`,
    name: toolName,
    arguments: JSON.stringify({ intentId }),
  };
}

/** 快照观察轮 → generic browse 单步点击批次：从快照取首个 button（缺省首元素）ref，task 固定（同任务连发以判别 every-call 不复用）。 */
function browseOperateCall(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    snap = { elements: [] };
  }
  const elements = Array.isArray(snap.elements) ? snap.elements : [];
  const button = elements.find((e) => e?.role === 'button') ?? elements[0];
  return {
    id: 'call_browse',
    name: TOOL_BROWSE,
    arguments: JSON.stringify({
      task: '通用页面代操作演练',
      plan: ['先 page_snapshot 观察', '单步点击目标元素'],
      steps: [{ action: 'click', ref: button?.ref ?? 'za-0' }],
      summary: '点击页面上的目标按钮（通用站点，无专属配置）',
    }),
  };
}

/** 闲鱼订单快照 → 选择“待发货”并读取当前结果；只使用本次快照里的可见 ref。 */
function xianyuOrdersCall(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    snap = { elements: [] };
  }
  const elements = Array.isArray(snap.elements) ? snap.elements : [];
  const pending = elements.find((e) => String(e?.label ?? '').startsWith('待发货')) ?? elements[0];
  const result = elements.find((e) => String(e?.label ?? '').includes('暂无数据')) ?? pending;
  return {
    id: 'call_xianyu_orders',
    name: TOOL_XIANYU_ORDERS,
    arguments: JSON.stringify({
      task: '筛选闲鱼待发货订单',
      plan: ['读取当前订单状态', '选择待发货', '重新观察页面结果'],
      steps: [
        { action: 'click', ref: pending?.ref ?? 'za-pending' },
        { action: 'read', ref: result?.ref ?? 'za-empty', name: 'pendingResult' },
      ],
      summary: '筛选待发货订单并读取页面结果',
    }),
  };
}

/** 快照观察 notices 首条；无提示返回 null——有提示即"被页面校验拦截"，不再继续操作。 */
function firstNotice(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    return null;
  }
  const notices = Array.isArray(snap.notices) ? snap.notices : [];
  return typeof notices[0] === 'string' && notices[0] !== '' ? notices[0] : null;
}

function firstBlockingNotice(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    return null;
  }
  const notices = Array.isArray(snap.notices) ? snap.notices : [];
  const blocking = notices.find((notice) => typeof notice === 'string' && !notice.startsWith('消息回执数：'));
  return blocking ?? null;
}

function receiptCountsSinceLastUser(body) {
  const counts = [];
  const messages = body?.messages ?? [];
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      start = index + 1;
      break;
    }
  }
  for (const message of messages.slice(start)) {
    if (message?.role !== 'tool') continue;
    const match = String(message.content ?? '').match(
      /"message-receipts":\{"count":(\d+),"latest":"(未读|已读)"\}/,
    );
    if (match) counts.push(Number(match[1]));
  }
  return counts;
}

function messageReceiptEvidence(obs) {
  try {
    const evidence = JSON.parse(obs)?.evidence?.['message-receipts'];
    if (
      Number.isInteger(evidence?.count) &&
      (evidence?.latest === '未读' || evidence?.latest === '已读')
    ) {
      return evidence;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 快照观察轮 → page-operate 批次：从快照 elements 取首个输入框与按钮的 ref，
 * 产出 fill+click+read 三步（read 键固定 noteValue，供回喂轮匹配）。
 */
function pageOperateCall(obs) {
  let snap;
  try {
    snap = JSON.parse(obs);
  } catch {
    snap = { elements: [] };
  }
  const elements = Array.isArray(snap.elements) ? snap.elements : [];
  const input = elements.find((e) => String(e?.role ?? '').startsWith('input'));
  const button = elements.find((e) => e?.role === 'button');
  const steps = [
    { action: 'fill', ref: input?.ref ?? 'za-0', value: 'mock-note' },
    { action: 'click', ref: button?.ref ?? 'za-0' },
    { action: 'read', ref: input?.ref ?? 'za-0', name: 'noteValue' },
  ];
  return {
    id: 'call_page_operate',
    name: TOOL_PAGE_OPERATE,
    arguments: JSON.stringify({
      task: '给订单添加备注',
      steps,
      summary: '在页面上填写备注并保存',
    }),
  };
}

/**
 * 回喂轮总结：obs 是服务端回喂的 observation 内容串（成功=body 的 JSON，失败={"error":...}）。
 * 更具体（成功带 orderId/count）优先于失败类别，失败类别再兜底 MOCK-OBS-DEFAULT。
 */
function summarizeObs(obs) {
  const ok = obs.includes('"ok":true');
  if (ok && /orderId/.test(obs)) {
    const ord = obs.match(/ORD-\d+/);
    return `已为你取消订单 ${ord ? ord[0] : ''}。`;
  }
  if (ok && /count/.test(obs)) {
    const c = obs.match(/"count":\s*(\d+)/);
    return `已刷新，当前 ${c ? c[1] : ''} 笔订单。`;
  }
  if (obs.includes('user-rejected')) return '已取消该操作，未做任何更改。';
  if (obs.includes('user-stopped')) return '已按你的要求停止页面操作。';
  if (obs.includes('forbidden')) return '抱歉，该操作不被允许执行。';
  if (/invalid-result|exec-failed|timeout|replayed/.test(obs)) return '操作未成功完成。';
  return 'MOCK-OBS-DEFAULT';
}

// ---- ADR-013 批次④ M5 跨站任务组剧本（run-m5.mjs 专用，加法式；仅在夹具工具/哨兵命中时触发）----
const TOOL_A_OPERATE = 'order-list.page-operate';
const TOOL_B_OPERATE = 'site-b.page-operate';
const TOOL_B_SUBMIT = 'site-b.confirm-submit';
const SITE_B_URL = 'http://127.0.0.1:4174/site-b.html';
// 越界目标：不属任何已安装 pack 的 origin（4199 无 pack）→ toolgate 签发前 fence-violation 拒绝。
const FENCE_URL = 'http://127.0.0.1:4199/blocked.html';

const snapshotCall = () => ({ id: 'call_snapshot', name: TOOL_SNAPSHOT, arguments: JSON.stringify({}) });

/** 某工具名是否在本请求历史里被 assistant 调用过（OpenAI tool_calls 形态）——判跨站流程已推进到哪一步。 */
function calledTool(body, name) {
  return (body?.messages ?? []).some(
    (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => normalizeToolName(tc?.function?.name) === name),
  );
}

function toolCallCountSinceLastUser(body, name) {
  const messages = body?.messages ?? [];
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') break;
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    count += message.tool_calls.filter((tc) => normalizeToolName(tc?.function?.name) === name).length;
  }
  return count;
}

/** 消息序列里最近一条含 elements 的快照观测的 elements 数组（供跨轮取 ref）。 */
function lastSnapshotElements(body) {
  const msgs = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role !== 'tool') continue;
    const content = String(m.content ?? '');
    if (!content.includes('"elements"')) continue;
    try {
      const snap = JSON.parse(content);
      if (Array.isArray(snap.elements)) return snap.elements;
    } catch {
      return [];
    }
  }
  return [];
}

const inputRefOf = (els) => (els.find((e) => String(e?.role ?? '').startsWith('input')) ?? els[0])?.ref ?? 'za-1';
const buttonRefOf = (els) => (els.find((e) => e?.role === 'button') ?? els[els.length - 1])?.ref ?? 'za-1';
const firstRefOf = (els) => els[0]?.ref ?? 'za-1';

/** 站点甲（pack A）侧：快照 → 读一格数据（任务级授权）→ 同任务 navigate 去站点乙 → 收尾。 */
function driveCrossPackA(body) {
  const obs = lastToolObs(body);
  if (obs === null) return { toolCall: snapshotCall() };
  // 快照观测同时含 url 与 elements：先判 elements（当前页快照），避免误入 navigate 结果分支。
  if (obs.includes('"elements"')) {
    const ref = firstRefOf(lastSnapshotElements(body));
    return {
      toolCall: {
        id: 'call_a_read',
        name: TOOL_A_OPERATE,
        arguments: JSON.stringify({
          task: '跨站读单',
          steps: [{ action: 'read', ref, name: 'cellValue' }],
          summary: '读取一格订单数据',
        }),
      },
    };
  }
  if (obs.includes('"reads"')) {
    return {
      toolCall: {
        id: 'call_a_nav',
        name: TOOL_A_OPERATE,
        arguments: JSON.stringify({
          task: '跨站读单',
          steps: [{ action: 'navigate', url: SITE_B_URL }],
          summary: '打开站点乙页面',
        }),
      },
    };
  }
  if (obs.includes('"url"')) return { text: '已打开站点乙页面，请在该页告诉我要提交的备注内容。' };
  return { text: '跨站演练在站点甲侧未能继续。' };
}

/** 越界路径：快照 → navigate 去无 pack 的 origin → toolgate fence-violation 拒绝 → 如实回报（不重试）。 */
function driveFence(body) {
  const obs = lastToolObs(body);
  if (obs === null) return { toolCall: snapshotCall() };
  if (obs.includes('"elements"')) {
    return {
      toolCall: {
        id: 'call_fence_nav',
        name: TOOL_A_OPERATE,
        arguments: JSON.stringify({
          task: '越界演练',
          steps: [{ action: 'navigate', url: FENCE_URL }],
          summary: '尝试跳转到站外地址',
        }),
      },
    };
  }
  // deny 回喂（obs 含 fence-violation）：不再跳转，如实告知被围栏拦截。
  return { text: '已阻止跳转：目标站点不在允许访问范围内（越界围栏拦截）。' };
}

/** 站点乙（pack B）侧：快照 → 填表（任务级授权）→ confirm-submit 单独确认（every-call）→ 收尾。 */
function driveSiteB(body) {
  if (calledTool(body, TOOL_B_SUBMIT)) return { text: '已在站点乙提交表单，跨站演练完成。' };
  const obs = lastToolObs(body);
  if (obs === null) return { toolCall: snapshotCall() };
  if (!calledTool(body, TOOL_B_OPERATE)) {
    if (obs.includes('"elements"')) {
      const ref = inputRefOf(lastSnapshotElements(body));
      return {
        toolCall: {
          id: 'call_b_fill',
          name: TOOL_B_OPERATE,
          arguments: JSON.stringify({
            task: '站点乙填表',
            steps: [
              { action: 'fill', ref, value: '跨站演练备注' },
              { action: 'read', ref, name: 'fieldValue' },
            ],
            summary: '在站点乙填写备注',
          }),
        },
      };
    }
    return { toolCall: snapshotCall() };
  }
  // 已填表未提交：以最近快照的按钮 ref 点提交（confirm-submit 为 every-call，仍单独弹卡）。
  const ref = buttonRefOf(lastSnapshotElements(body));
  return {
    toolCall: {
      id: 'call_b_submit',
      name: TOOL_B_SUBMIT,
      arguments: JSON.stringify({
        task: '站点乙提交',
        steps: [{ action: 'click', ref }],
        summary: '点击提交按钮',
      }),
    },
  };
}

function driveStop(body) {
  const obs = lastToolObs(body);
  if (obs === null) return { toolCall: snapshotCall() };
  if (obs.includes('"elements"')) {
    const elements = lastSnapshotElements(body);
    const input = elements.find((item) => String(item?.role ?? '').startsWith('input')) ?? elements[0];
    return {
      toolCall: {
        id: 'call_stop_operate',
        name: TOOL_B_OPERATE,
        arguments: JSON.stringify({
          task: '停止演练',
          steps: [
            { action: 'fill', ref: input?.ref ?? 'za-1', value: '停止前首步' },
            { action: 'read', ref: input?.ref ?? 'za-1', name: 'fieldValue' },
          ],
          summary: '执行可由用户中止的两步页面操作',
        }),
      },
    };
  }
  if (obs.includes('user-stopped')) return { text: '已按用户要求停止，后续步骤没有继续执行。' };
  if (obs.includes('user-rejected')) return { text: '已取消停止后的重试。' };
  return { text: '停止演练已结束。' };
}

/**
 * M5 跨站任务组剧本分派：站点乙工具在场（回合已切到 pack B）优先走 driveSiteB；
 * 否则按当前回合驱动语（u）判越界/跨站演练。非 M5 上下文返回 null 走既有决策。
 */
function driveDrill(u, body) {
  if (u.includes('停止演练')) return driveStop(body);
  if (hasTool(body, TOOL_B_OPERATE) || hasTool(body, TOOL_B_SUBMIT)) return driveSiteB(body);
  if (u.includes('越界演练')) return driveFence(body);
  if (u.includes('跨站演练')) return driveCrossPackA(body);
  return null;
}

/**
 * 返回 { text } 或 { toolCall:{ name, arguments } }。
 * R5 先判：定位问句时，仅当请求带引导工具、facts 登记了 #btn-export、且问句确指该锚点（问"导出"）
 * 才产出引导 tool_call；否则退化为文本 MOCK-NO-ANCHOR。
 * 问句锚点相关性（`导出`）是必要项：order-list 的 facts 恒含 #btn-export，仅凭 sys 含锚点
 * 无法把"打印发票"这类无登记锚点的定位问句判为降级——它是失配/降级路径唯一可判据。
 */
function decide(sys, u, body) {
  // M5 跨站任务组剧本（加法式）：命中即接管，不影响既有场景。
  const drill = driveDrill(u, body);
  if (drill !== null) return drill;
  const obs = lastToolObs(body);
  if (obs === null && u.includes('自动履约扫描') && hasTool(body, TOOL_XIANYU_PREPARE)) {
    return { toolCall: snapshotCall() };
  }
  if (obs === null && u.includes('自动发货') && hasTool(body, TOOL_XIANYU_SHIPPING_PREPARE)) {
    return { toolCall: snapshotCall() };
  }
  if (obs === null && u.includes('履约意图') && hasTool(body, TOOL_XIANYU_INTENT)) {
    return { toolCall: snapshotCall() };
  }
  if (obs !== null) {
    const shippingIntentCount = toolCallCountSinceLastUser(body, TOOL_XIANYU_SHIPPING);
    if (shippingIntentCount > 0) {
      return obs.includes('"shipmentConfirmed":true')
        ? { text: '订单平台状态已明确变为已发货。' }
        : { text: '订单发货状态未能明确确认，已转人工且不会自动重试。' };
    }
    const shippingPrepareCount = toolCallCountSinceLastUser(body, TOOL_XIANYU_SHIPPING_PREPARE);
    if (shippingPrepareCount > 0 && obs.includes('"intentId"')) {
      return { toolCall: executePreparedXianyuIntentCall(obs, TOOL_XIANYU_SHIPPING) };
    }
    const xianyuIntentCount = toolCallCountSinceLastUser(body, TOOL_XIANYU_INTENT);
    if (xianyuIntentCount > 0 && u.includes('旧意图再新单') && hasTool(body, TOOL_XIANYU_PREPARE)) {
      if (obs.includes('"deliveryConfirmed":true')) return { toolCall: snapshotCall() };
      if (obs.includes('"elements"')) {
        return {
          toolCall: {
            id: 'call_xianyu_prepare_after_old_intent',
            name: TOOL_XIANYU_PREPARE,
            arguments: JSON.stringify({}),
          },
        };
      }
    }
    if (xianyuIntentCount > 0) {
      if (obs.includes('"deliveryConfirmed":true')) {
        return { text: '页面新回执已确认履约消息送达。' };
      }
      return { text: '页面回执未明确增加或等待超时，履约状态已转人工且不会自动重发。' };
    }
    const xianyuPrepareCount = toolCallCountSinceLastUser(body, TOOL_XIANYU_PREPARE);
    if (xianyuPrepareCount === 1 && u.includes('双单预算')) {
      return {
        toolCall: {
          id: 'call_xianyu_prepare_second_order',
          name: TOOL_XIANYU_PREPARE,
          arguments: JSON.stringify({}),
        },
      };
    }
    if (xianyuPrepareCount > 0 && obs.includes('"intentId"')) {
      return { toolCall: executePreparedXianyuIntentCall(obs) };
    }
    const xianyuSendCount = toolCallCountSinceLastUser(body, TOOL_XIANYU_SEND);
    if (xianyuSendCount > 0 && !obs.includes('"elements"')) {
      if (obs.includes('user-stopped')) return { text: '已按用户要求停止，后续没有重发消息。' };
      return { toolCall: snapshotCall() };
    }
    if (xianyuSendCount > 0 && obs.includes('"elements"')) {
      const blocking = firstBlockingNotice(obs);
      if (blocking !== null) return { text: `页面提示：${blocking}，发送结果不明确；已停止且不会自动重发。` };
      const counts = receiptCountsSinceLastUser(body);
      const prior = counts[counts.length - 2];
      const current = counts[counts.length - 1];
      const currentEvidence = messageReceiptEvidence(obs);
      if (
        prior !== undefined &&
        current === prior + 1 &&
        currentEvidence !== null
      ) {
        return { text: '页面已明确回显测试消息发送成功。' };
      }
      return { text: '发送后页面复核没有得到明确成功证据，结果不明确；已停止且不会自动重发。' };
    }
    // 快照观察轮：据 elements 决策 dom 批次（agent-in-the-loop 的确定性替身）；
    // 快照带 notices＝页面有拦截性提示 → 如实报告而非继续操作（成功幻觉的反面路径）。
    if (obs.includes('"elements"') && hasTool(body, TOOL_PAGE_OPERATE)) {
      const notice = firstNotice(obs);
      if (notice !== null) return { text: `页面提示：${notice}，已停止操作，请先处理该提示。` };
      return { toolCall: pageOperateCall(obs) };
    }
    if (obs.includes('"elements"') && u.includes('自动发货') && hasTool(body, TOOL_XIANYU_SHIPPING_PREPARE)) {
      return {
        toolCall: {
          id: 'call_xianyu_shipping_prepare',
          name: TOOL_XIANYU_SHIPPING_PREPARE,
          arguments: JSON.stringify({}),
        },
      };
    }
    if (obs.includes('"elements"') && hasTool(body, TOOL_XIANYU_ORDERS)) {
      const notice = firstNotice(obs);
      if (notice !== null) return { text: `页面提示：${notice}，已停止筛选。` };
      return { toolCall: xianyuOrdersCall(obs) };
    }
    // 126 发送邮件快照观察轮：取发送按钮 ref，走 send-email（每次单独确认）。
    if (obs.includes('"elements"') && hasTool(body, TOOL_SEND_EMAIL)) {
      return { toolCall: sendEmailCall(obs) };
    }
    if (
      obs.includes('"elements"') &&
      u.includes('自动履约扫描') &&
      hasTool(body, TOOL_XIANYU_PREPARE)
    ) {
      return {
        toolCall: {
          id: 'call_xianyu_prepare',
          name: TOOL_XIANYU_PREPARE,
          arguments: JSON.stringify({}),
        },
      };
    }
    if (obs.includes('"elements"') && hasTool(body, TOOL_XIANYU_SEND)) {
      const notice = firstBlockingNotice(obs);
      if (notice !== null) return { text: `页面提示：${notice}，已停止发送。` };
      if (hasTool(body, TOOL_XIANYU_INTENT) && u.includes('履约意图')) {
        return { toolCall: executeXianyuIntentCall(u) };
      }
      return { toolCall: sendXianyuTestCall(obs) };
    }
    // generic browse 快照观察轮：有拦截提示即停，否则单步点击批次（每批单独确认）。
    if (obs.includes('"elements"') && hasTool(body, TOOL_BROWSE)) {
      const notice = firstNotice(obs);
      if (notice !== null) return { text: `页面提示：${notice}，已停止操作。` };
      return { toolCall: browseOperateCall(obs) };
    }
    // dom 结果回喂轮：报告 read 采集值。
    if (obs.includes('"reads"')) {
      if (calledTool(body, TOOL_XIANYU_ORDERS)) {
        return { text: '已选择待发货；下一步必须重新读取页面快照，复核订单状态与空态结果。' };
      }
      const m = obs.match(/"noteValue":"([^"]*)"/);
      return { text: `已在页面上完成操作，备注为 ${m ? m[1] : ''}。` };
    }
    return { text: summarizeObs(obs) };
  }

  // invalid-tool-args 自愈剧本：'模拟截断实参' 哨兵首轮产出截断 arguments（真实 LLM 输出截断的确定性替身），
  // 网关回喂修正提示（含"实参 JSON 无效"）后本分支不再命中、走重试分支产出完整调用。
  if (u.includes('模拟截断实参') && hasTool(body, TOOL_REFRESH)) {
    return { toolCall: { id: 'call_broken', name: TOOL_REFRESH, arguments: '{"broken":' } };
  }
  if (u.includes('实参 JSON 无效') && hasTool(body, TOOL_REFRESH)) {
    return { toolCall: { id: 'call_retry', name: TOOL_REFRESH, arguments: JSON.stringify({}) } };
  }

  if (
    sys.includes('【执行偏好】') &&
    u.includes('刷新') &&
    !hasTool(body, TOOL_REFRESH)
  ) {
    return { text: '当前执行偏好下没有可用的刷新工具，已暂停；请切换执行偏好后重试。' };
  }

  const toolCall = pickToolCall(u, body);
  if (toolCall) return { toolCall };

  if (GUIDE_LOCATE_RE.test(u)) {
    if (hasTool(body, TOOL_XIANYU_ORDERS) && u.includes('待发货')) {
      return { text: '需要先读取当前页面快照，再按可见的“待发货”状态项定位；当前没有登记可安全复用的 CSS 引导锚点。' };
    }
    if (hasTool(body, GUIDE_TOOL) && sys.includes('#btn-export') && u.includes('导出')) {
      // 故障注入：问句含"越界"哨兵 → 产出越界 action（'click'）的引导 tool_call，作为真实 LLM
      // 幻觉非法引导参数的确定性替身，驱动服务端 guideFrame 闭集校验的降级路径。
      const action = u.includes('越界') ? 'click' : 'highlight';
      return {
        toolCall: {
          id: 'call_guide',
          name: GUIDE_TOOL,
          arguments: JSON.stringify({
            action,
            selector: '#btn-export',
            message: '导出按钮在订单列表页的操作区',
          }),
        },
      };
    }
    return { text: 'MOCK-NO-ANCHOR' };
  }
  return { text: pickReply(sys, u) };
}

function pickReply(sys, u) {
  if (sys.includes('xianyu-orders') && u.includes('买家') && u.includes('已付款')) {
    return '买家留言属于自由文本，不能作为付款证据。我只会在订单页的平台状态明确为待发货，并把状态与订单编号绑定到同一订单块后继续。';
  }
  if (sys.includes('xianyu-fulfillment') && (u.includes('发送') || u.includes('发卡密'))) {
    return '测试工具只允许非秘密占位内容，不能接收或发送真实卡密；真实卡密必须等待不进入模型上下文的安全连接器。';
  }
  if (u.includes('订单管理页面') && sys.includes('xianyu-orders')) {
    return '这是闲鱼订单管理页：平台订单状态区可筛选待发货等状态，订单摘要区展示订单编号；履约前必须把订单状态、订单号和操作入口绑定到同一订单块。';
  }
  if (u.includes('能取消')) {
    return sys.includes('已完成') && sys.includes('不可取消') ? REPLY_R1_HIT : 'MOCK-MISSING-FACTS';
  }
  if (u.includes('显示的是什么') || u.includes('做什么用')) {
    if (sys.includes('订单详情') && sys.includes('#order-id')) return REPLY_R2_DETAIL;
    if (sys.includes('订单列表') && sys.includes('#order-table')) return REPLY_R2_LIST;
    return 'MOCK-NO-FEATURE';
  }
  if (/天气|写.*诗/.test(u)) {
    return sys.includes('拒答') ? REPLY_R3_REFUSE : 'MOCK-BASE-MISSING';
  }
  if (u.includes('报告当前站点身份')) {
    // 仅基座附注探针：断言无 pack 命中时 system 已注入"无专属配置、不得臆断站点身份"上下文。
    return sys.includes('无专属功能配置（仅基座）') ? 'MOCK-BASEONLY-NOTICE-HIT' : 'MOCK-BASEONLY-NOTICE-MISS';
  }
  if (u.includes('为什么') && (u.includes('待发货') || u.includes('状态'))) {
    // 讲解正确之"不编造"：业务原因不在配置内，据 facts/feature 规则引导联系订单管理员（ZA-FEAT-01）。
    return sys.includes('订单管理员') ? REPLY_R4_ADMIN : 'MOCK-MISSING-ADMIN-FACT';
  }
  return 'MOCK-DEFAULT';
}

function splitInThree(text) {
  const chars = Array.from(text);
  const step = Math.ceil(chars.length / 3);
  const parts = [];
  for (let i = 0; i < chars.length; i += step) parts.push(chars.slice(i, i + step).join(''));
  while (parts.length < 3) parts.push('');
  return parts;
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
}

function handleChat(req, res) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(res, 400, 'invalid JSON body');
      return;
    }
    if (!Array.isArray(body?.messages)) {
      sendError(res, 400, 'messages must be an array');
      return;
    }
    if (body.stream !== true) {
      sendError(res, 400, 'only stream:true is supported');
      return;
    }
    const sys = body.messages
      .filter((m) => m?.role === 'system')
      .map((m) => String(m.content ?? ''))
      .join('\n');
    const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user');
    const u = String(lastUser?.content ?? '');
    const decision = decide(sys, u, body);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const base = {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: typeof body.model === 'string' ? body.model : 'mock-model',
    };
    const send = (choice) => {
      res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
    };
    send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
    if (decision.toolCall) {
      const fragments = splitInThree(decision.toolCall.arguments);
      fragments.forEach((arguments_, i) => {
        const tc =
          i === 0
            ? {
                index: 0,
                id: decision.toolCall.id ?? 'call_guide',
                type: 'function',
                function: { name: decision.toolCall.name, arguments: arguments_ },
              }
            : { index: 0, function: { arguments: arguments_ } };
        send({ index: 0, delta: { tool_calls: [tc] }, finish_reason: null });
      });
      send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    } else {
      for (const part of splitInThree(decision.text)) {
        send({ index: 0, delta: { content: part }, finish_reason: null });
      }
      send({ index: 0, delta: {}, finish_reason: 'stop' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

export function startMockLlm({ port = Number(process.env.MOCK_LLM_PORT ?? 8788) } = {}) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      handleChat(req, res);
      return;
    }
    sendError(res, 404, 'not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMockLlm().then(
    ({ port }) => console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`),
    (err) => {
      console.error(`mock-llm 启动失败：${err.message}`);
      process.exit(1);
    },
  );
}
