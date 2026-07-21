import { isDomTool, type ExecutionPreference, type ToolDefinition } from '@zen-agent/contracts';

export function selectToolsForPreference(
  tools: readonly ToolDefinition[],
  preference: ExecutionPreference,
): ToolDefinition[] {
  switch (preference) {
    case 'auto':
      return [...tools];
    case 'dom-only':
      return tools.filter(isDomTool);
    case 'prefer-client-api':
      return tools.filter((tool) => tool.execution === 'client' && !isDomTool(tool));
    case 'prefer-server-api':
      return tools.filter((tool) => tool.execution === 'server');
  }
}

export function executionPreferenceInstruction(preference: ExecutionPreference): string | null {
  switch (preference) {
    case 'auto':
      return null;
    case 'dom-only':
      return '【执行偏好】本回合只允许客户端 DOM 页面操作。若没有对应 DOM 工具，明确说明当前通道不可用并暂停，不得改用客户端 API 或服务端 API。';
    case 'prefer-client-api':
      return '【执行偏好】本回合只允许客户端页面会话发起 API。若没有对应客户端 API 工具，明确说明当前通道不可用并暂停，不得改用 DOM 或服务端 API。';
    case 'prefer-server-api':
      return '【执行偏好】本回合只允许服务端发起 API。若没有对应服务端 API 工具，明确说明当前通道不可用并暂停，不得改用 DOM 或客户端 API。';
  }
}
