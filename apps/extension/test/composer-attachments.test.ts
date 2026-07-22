// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  appendAttachmentsToPrompt,
  isSupportedAttachment,
  MAX_ATTACHMENT_BYTES,
  prepareAttachments,
} from '../src/composer-attachments.js';

describe('composer attachments', () => {
  it('reads supported text files and includes their content in the prompt', async () => {
    const file = new File(['# 售后规则\n虚拟商品发出后请核对订单状态。'], 'rules.md', { type: 'text/markdown' });

    const attachments = await prepareAttachments([file]);
    const prompt = appendAttachmentsToPrompt('分析库存', attachments);

    expect(prompt).toContain('rules.md');
    expect(prompt).toContain('虚拟商品发出后');
  });

  it('rejects unsupported binary files and oversized text files', async () => {
    const binary = new File(['binary'], 'photo.png', { type: 'image/png' });
    const inventory = new File(['sku,card'], 'inventory.csv', { type: 'text/csv' });
    const oversized = new File(['x'.repeat(MAX_ATTACHMENT_BYTES + 1)], 'large.txt', { type: 'text/plain' });

    expect(isSupportedAttachment(binary)).toBe(false);
    await expect(prepareAttachments([binary])).rejects.toThrow('暂不支持');
    await expect(prepareAttachments([inventory])).rejects.toThrow('暂不支持');
    await expect(prepareAttachments([oversized])).rejects.toThrow('超过 128 KB');
  });

  it('sanitizes filenames used in attachment boundaries', async () => {
    const [attachment] = await prepareAttachments([new File(['ok'], '<cards>.txt', { type: 'text/plain' })]);

    expect(attachment?.name).toBe('_cards_.txt');
  });

  it('fails closed for credential-like filenames and content', async () => {
    const namedInventory = new File(['普通文本'], 'card-inventory.txt', { type: 'text/plain' });
    const tokenContent = new File(['token: not-a-real-token'], 'notes.txt', { type: 'text/plain' });
    const opaqueLines = new File(['ABCDEFGHIJKLMNOPQRSTUVWX'], 'notes.md', { type: 'text/markdown' });

    await expect(prepareAttachments([namedInventory])).rejects.toThrow('疑似敏感数据文件');
    await expect(prepareAttachments([tokenContent])).rejects.toThrow('已阻止发送');
    await expect(prepareAttachments([opaqueLines])).rejects.toThrow('已阻止发送');
  });
});
