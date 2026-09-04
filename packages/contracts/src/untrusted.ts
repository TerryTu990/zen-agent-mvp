/**
 * 不可信内容结构化定界（L0 常量层）：把「页面/工具/pack 文档带回来的内容」与「平台注入的治理文本」
 * 在同一条 prompt 里划开边界，使模型可机械分辨哪段是数据、哪段是指令。
 * kind 是闭集、定界串形状与 nonce 生成都在本层定死——pack/L2 对本层零表达力（U8）。
 * 防伪造靠 nonce 每会话随机 + 包裹前剥除正文里同形的串：攻击者既猜不中本会话 nonce，
 * 也无法用预置的开合标记提前闭合定界区。
 */
import { randomBytes } from 'node:crypto';

/** 定界 kind 闭集：一个成员对应一类不可信内容采集面，新增采集面须先在此登记。 */
export const UNTRUSTED_KINDS = [
  'page-text',
  'page-elements',
  'tool-result',
  'pack-doc',
  'group-pages',
] as const;

export type UntrustedKind = (typeof UNTRUSTED_KINDS)[number];

export function isUntrustedKind(value: string): value is UntrustedKind {
  return (UNTRUSTED_KINDS as readonly string[]).includes(value);
}

/** 定界串同形匹配：开标记带 kind、合标记只带 nonce；剥离按形状而非按本会话 nonce，猜测的 nonce 同样被剥。 */
const DELIMITER_PATTERN = /⟪\/?untrusted:[^⟫\n]*⟫/g;

/** 会话级定界 nonce：16 位十六进制，由服务端生成后在本会话内复用。 */
export function untrustedNonce(): string {
  return randomBytes(8).toString('hex');
}

/** 剥除任何定界形状的串——用于包裹前的输入侧净化，也用于消费方按结构解析前的剥壳。 */
export function stripUntrustedDelimiters(text: string): string {
  return text.replace(DELIMITER_PATTERN, '');
}

/**
 * 把不可信正文包进本会话定界串。正文先剥除同形串再包裹，故产物中开合标记恒各一个、必然配对。
 * 开合标记各占一行：消费方按行解析清单/首行页标注的既有不变量不因包裹而失效。
 */
export function wrapUntrusted(kind: UntrustedKind, nonce: string, body: string): string {
  return `⟪untrusted:${kind}:${nonce}⟫\n${stripUntrustedDelimiters(body)}\n⟪/untrusted:${nonce}⟫`;
}

/**
 * 无损消毒：只剔除双向控制符（U+202A-202E、U+2066-2069）与零宽/不可见格式字符
 * （U+200B-200F、U+2060-2064、U+FEFF）——它们不产生可见文本，却能让读者看到的与实际值不一致
 * （视觉反转、藏字）。换行、缩进、普通空白与全角标点都是可读文本本身，一律保留。
 * 采集正文用本口径：正文要与页面上呈现的一致，任何会改写可读字符的归一都不适用。
 */
export function stripInvisibleFormatChars(text: string): string {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
}

/**
 * 单行展示消毒：无损口径 + NFKC 归一 + 剔除控制字符与行分隔符。
 * 展示位（HITL 卡目标地址与控件标签、清单单元格）是单行、短串语义：换行能伪造整行，
 * 全角/兼容形能让域名与控件名有第二种同形写法，故此处归一；正文采集不适用本口径。
 */
export function stripDisplayUnsafeChars(text: string): string {
  return stripInvisibleFormatChars(text)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}
