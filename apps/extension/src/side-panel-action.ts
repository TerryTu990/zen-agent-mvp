export interface ToolbarSidePanelAction {
  openPanel(): Promise<void>;
  activatePage(): Promise<void>;
}

export function runToolbarSidePanelAction(action: ToolbarSidePanelAction): Promise<void> {
  const opening = action.openPanel();
  const activating = action.activatePage();
  return Promise.all([opening, activating]).then(() => undefined);
}
