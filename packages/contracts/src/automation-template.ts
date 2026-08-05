/**
 * 平台内建自动化模板闭集（adr-021）——L0 平台代码，非 pack 声明、非用户数据：
 * 用户自建触发器（user-overlay watches）只能引用本闭集并提供参数，模板本身不可被用户或 pack 定义。
 * 模板是「机制」侧的通用能力（R9 读类自动化零配置任意站点可用），故不随 pack 版本化。
 */
import type { JsonObject } from './json.js';

/** 模板 id 闭集；新增成员属 U3 加法（旧 watch 原样有效），删除成员即破坏性变更。 */
export type AutomationTemplateId = 'page-watch';

/** 平台唤醒周期下限（分钟）：用户自建触发器不得低于此值；模板参数 schema 以此为 minutes.minimum。 */
export const PLATFORM_MIN_WATCH_MINUTES = 5;

/** 关注点文本上限（字符）：进自动回合提示词，故与规则条目一样受上界约束。 */
export const WATCH_FOCUS_MAX_LENGTH = 200;

/** 单个 watch 的唤醒周期上限（分钟）：与客户端 alarm 排程上界同值，超出的实例写入期即拒收。 */
const WATCH_MAX_MINUTES = 60;

export interface PlatformAutomationTemplate {
  id: AutomationTemplateId;
  /** 配置中心与报告卡的展示名。 */
  title: string;
  /** 面向用户的模板用途说明。 */
  description: string;
  /**
   * v1 闭集恒 true：本模板发起的自动回合由服务端强制只读工具面（R7 结构强制，不依赖模型自觉、平台级不可配置）。
   * 用字面量类型而非 boolean——可写模板无法被静默引入，须先扩类型并显式实现放行分支（缺省 fail-closed）。
   */
  readOnly: true;
  /**
   * 实例参数的结构权威：写入期以 compileConfigSchema 编译后校验 watch 的参数投影（url/minutes/focus）。
   * url 的可解析性与协议闭集属语义判定，由 validateUserOverlay 承担（schema 只判类型与长度上界）。
   */
  paramsSchema: JsonObject;
}

const PAGE_WATCH_PARAMS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'minutes'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    minutes: { type: 'integer', minimum: PLATFORM_MIN_WATCH_MINUTES, maximum: WATCH_MAX_MINUTES },
    focus: { type: 'string', minLength: 1, maxLength: WATCH_FOCUS_MAX_LENGTH },
  },
};

export const PLATFORM_AUTOMATION_TEMPLATES: readonly PlatformAutomationTemplate[] = [
  {
    id: 'page-watch',
    title: '页面变化监测',
    description:
      '按周期读取你已打开并加入会话组的目标页，与上轮快照比对；有变化时产出报告，无变化不打扰。' +
      '平台不会自动新建页面。比对面为可交互要素、表格与列表项、页面提示文本与标题，不含普通段落正文。',
    readOnly: true,
    paramsSchema: PAGE_WATCH_PARAMS_SCHEMA,
  },
];

/** 闭集查表（消费方唯一入口）：未命中即非法 templateId，调用方按 fail-closed 拒绝。 */
export function findAutomationTemplate(templateId: string): PlatformAutomationTemplate | undefined {
  return PLATFORM_AUTOMATION_TEMPLATES.find((template) => template.id === templateId);
}
