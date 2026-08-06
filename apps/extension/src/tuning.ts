/** 扩展端页面观察与代执行行为的调参汇聚点。 */

export const MAX_ELEMENTS = 150;
export const MAX_LABEL_LENGTH = 80;
export const MAX_NOTICES = 10;
export const MAX_NOTICE_LENGTH = 200;
/**
 * 单次正文回喂上限：够装一篇长文（中文约 5000-6000 字 / 英文约 2000 词），
 * 又把最坏一轮的上下文开销压在万级 token 内。C3 契约硬顶为 40000，本值须始终不高于它。
 */
export const MAX_PAGE_TEXT_LENGTH = 12000;

export const STEP_PACE_MS = 350;
