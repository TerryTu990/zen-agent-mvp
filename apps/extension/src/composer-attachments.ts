export const MAX_ATTACHMENT_COUNT = 3;
export const MAX_ATTACHMENT_BYTES = 128 * 1024;

const KNOWLEDGE_EXTENSIONS = new Set(['md', 'txt']);
const SENSITIVE_NAME = /(?:^|[._-])(env|inventory|card|credential|secret|token|key|password)(?:[._-]|$)|卡密|库存|密钥|令牌|凭证/i;
const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|(?:token|secret|password|api[_ -]?key|authorization|cookie|卡密|激活码|兑换码|密码|密钥|令牌|凭证)\s*[:=：]/i;
const OPAQUE_VALUE_LINE = /^[A-Za-z0-9_+/=-]{20,}$/;

export interface PreparedAttachment {
  name: string;
  content: string;
}

export function isSupportedAttachment(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return KNOWLEDGE_EXTENSIONS.has(extension) && (file.type === '' || file.type === 'text/plain' || file.type === 'text/markdown');
}

export async function prepareAttachments(files: readonly File[]): Promise<PreparedAttachment[]> {
  if (files.length > MAX_ATTACHMENT_COUNT) throw new Error(`每次最多上传 ${MAX_ATTACHMENT_COUNT} 个文件`);
  const prepared: PreparedAttachment[] = [];
  for (const file of files) {
    if (!isSupportedAttachment(file)) throw new Error(`暂不支持 ${file.name}，请选择 Markdown 或纯文本知识文档`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 128 KB 限制`);
    if (SENSITIVE_NAME.test(file.name)) throw new Error(`${file.name} 疑似敏感数据文件，禁止发送给智能体`);
    const content = await file.text();
    if (SENSITIVE_CONTENT.test(content) || content.split(/\r?\n/).some((line) => OPAQUE_VALUE_LINE.test(line.trim()))) {
      throw new Error(`${file.name} 疑似包含卡密、令牌或凭证，已阻止发送`);
    }
    prepared.push({ name: file.name.replace(/[<>\r\n]/g, '_'), content });
  }
  return prepared;
}

export function appendAttachmentsToPrompt(text: string, attachments: readonly PreparedAttachment[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments.map(({ name, content }) => `<attachment name="${name}">\n${content}\n</attachment>`);
  return `${text}\n\n以下是用户随消息提供的本地文件内容：\n${blocks.join('\n')}`;
}
