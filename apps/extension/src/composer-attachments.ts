export const MAX_ATTACHMENT_COUNT = 3;
export const MAX_ATTACHMENT_BYTES = 128 * 1024;

const TEXT_EXTENSIONS = new Set(['csv', 'json', 'log', 'md', 'txt', 'xml', 'yaml', 'yml']);

export interface PreparedAttachment {
  name: string;
  content: string;
}

export function isSupportedAttachment(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXTENSIONS.has(extension);
}

export async function prepareAttachments(files: readonly File[]): Promise<PreparedAttachment[]> {
  if (files.length > MAX_ATTACHMENT_COUNT) throw new Error(`每次最多上传 ${MAX_ATTACHMENT_COUNT} 个文件`);
  const prepared: PreparedAttachment[] = [];
  for (const file of files) {
    if (!isSupportedAttachment(file)) throw new Error(`暂不支持 ${file.name}，请选择文本、Markdown、CSV 或 JSON 文件`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 128 KB 限制`);
    prepared.push({ name: file.name.replace(/[<>\r\n]/g, '_'), content: await file.text() });
  }
  return prepared;
}

export function appendAttachmentsToPrompt(text: string, attachments: readonly PreparedAttachment[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments.map(({ name, content }) => `<attachment name="${name}">\n${content}\n</attachment>`);
  return `${text}\n\n以下是用户随消息提供的本地文件内容：\n${blocks.join('\n')}`;
}
