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
 * 工具栏点击：启用 → 打开，顺序不可换；建组与之并行推进，不让它挡在打开前面
 * （`open()` 只能在用户手势内调用，链路越长越容易错过手势）。
 */
export async function runToolbarSidePanelAction(action: ToolbarSidePanelAction): Promise<void> {
  const activating = action.activatePage();
  await action.enablePanel();
  await action.openPanel();
  await activating;
}
