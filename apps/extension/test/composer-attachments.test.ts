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
    const file = new File(['orderId,card\n1001,ABC-123'], 'cards.csv', { type: 'text/csv' });

    const attachments = await prepareAttachments([file]);
    const prompt = appendAttachmentsToPrompt('分析库存', attachments);

    expect(prompt).toContain('cards.csv');
    expect(prompt).toContain('1001,ABC-123');
  });

  it('rejects unsupported binary files and oversized text files', async () => {
    const binary = new File(['binary'], 'photo.png', { type: 'image/png' });
    const oversized = new File(['x'.repeat(MAX_ATTACHMENT_BYTES + 1)], 'large.txt', { type: 'text/plain' });

    expect(isSupportedAttachment(binary)).toBe(false);
    await expect(prepareAttachments([binary])).rejects.toThrow('暂不支持');
    await expect(prepareAttachments([oversized])).rejects.toThrow('超过 128 KB');
  });

  it('sanitizes filenames used in attachment boundaries', async () => {
    const [attachment] = await prepareAttachments([new File(['ok'], '<cards>.txt', { type: 'text/plain' })]);

    expect(attachment?.name).toBe('_cards_.txt');
  });
});
