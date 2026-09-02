import type { ExecutionPreference } from './frames.js';

/** 本机执行偏好（chrome.storage.local）：选项页写入，面板随每条用户消息读取。 */
export const EXECUTION_PREFERENCE_KEY = 'za.executionPreference';

export const EXECUTION_PREFERENCE_OPTIONS: ReadonlyArray<{ value: ExecutionPreference; label: string }> = [
  { value: 'auto', label: '自动选择' },
  { value: 'dom-only', label: '仅客户端 DOM' },
  { value: 'prefer-client-api', label: '优先客户端 API' },
  { value: 'prefer-server-api', label: '优先服务端 API' },
];

/** 未配置或存量非法值一律回退 auto。 */
export function parseExecutionPreference(value: unknown): ExecutionPreference {
  return EXECUTION_PREFERENCE_OPTIONS.some((option) => option.value === value)
    ? (value as ExecutionPreference)
    : 'auto';
}
