import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@zen-agent/contracts';
import {
  executionPreferenceInstruction,
  selectToolsForPreference,
} from '../src/execution-preference.js';

const base = {
  description: 'test',
  featureIds: ['orders'],
  riskTier: 'auto' as const,
  params: { type: 'object' },
  resultSchema: { type: 'object' },
};
const tools: ToolDefinition[] = [
  {
    ...base,
    id: 'dom',
    execution: 'client',
    adapter: { kind: 'dom', pathPrefixes: ['/orders'] },
  },
  {
    ...base,
    id: 'client-api',
    execution: 'client',
    adapter: { method: 'POST', urlTemplate: 'https://host.example/api/orders' },
  },
  {
    ...base,
    id: 'server-api',
    execution: 'server',
    adapter: { method: 'POST', urlTemplate: 'https://host.example/api/orders' },
  },
];

describe('服务端执行偏好工具面', () => {
  it('auto 保留声明工具；其它模式只保留对应通道', () => {
    expect(selectToolsForPreference(tools, 'auto').map((tool) => tool.id)).toEqual([
      'dom',
      'client-api',
      'server-api',
    ]);
    expect(selectToolsForPreference(tools, 'dom-only').map((tool) => tool.id)).toEqual(['dom']);
    expect(selectToolsForPreference(tools, 'prefer-client-api').map((tool) => tool.id)).toEqual([
      'client-api',
    ]);
    expect(selectToolsForPreference(tools, 'prefer-server-api').map((tool) => tool.id)).toEqual([
      'server-api',
    ]);
  });

  it('受限模式明确要求不可用时暂停，auto 不额外注入', () => {
    expect(executionPreferenceInstruction('auto')).toBeNull();
    expect(executionPreferenceInstruction('dom-only')).toContain('暂停');
    expect(executionPreferenceInstruction('prefer-client-api')).toContain('不得改用');
    expect(executionPreferenceInstruction('prefer-server-api')).toContain('服务端');
  });
});
