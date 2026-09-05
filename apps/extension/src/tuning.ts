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

/**
 * 视口优先配额的外扩阈值（CSS px）：视口上下左右各外扩这一段仍算「用户当下够得着」，
 * 其内的控件先分配 ref。无布局信息（jsdom）时本阈值不参与判定。
 */
export const VIEWPORT_MARGIN_PX = 200;

/** DOM 静默窗：连续无变更达此毫秒数即视为页面静定，可开始采集。 */
export const DOM_SETTLE_QUIET_MS = 300;
/**
 * 静默窗总等待上限：到点无论是否静定一律采集。
 * 页面可能永远在变（轮播/计时器），控制流不交给页面。
 */
export const DOM_SETTLE_TIMEOUT_MS = 1500;
