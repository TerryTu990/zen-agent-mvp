export interface ToolbarSidePanelAction {
  /**
   * 把该标签页的面板置为可用。面板默认整体禁用（只在 zen 组标签页启用），
   * 而 `sidePanel.open()` 对禁用中的标签页不生效——不先启用就点不开。
   */
  enablePanel(): Promise<void>;
  openPanel(): Promise<void>;
  activatePage(): Promise<void>;
}

/**
 * 工具栏点击：enable → open 在**同一任务内**依次发出，中间 MUST NOT await——
 * `open()` 只能在用户手势内调用，任何 await 都会让手势失效、点击彻底无反应。
 * 顺序仍有意义：启用请求先于打开请求发出；建组并行推进，不挡在打开前面。
 */
export function runToolbarSidePanelAction(action: ToolbarSidePanelAction): Promise<void> {
  const enabling = action.enablePanel();
  const opening = action.openPanel();
  const activating = action.activatePage();
  return Promise.all([enabling, opening, activating]).then(() => undefined);
}
