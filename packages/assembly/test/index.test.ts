import { describe, expect, it } from 'vitest';
import { createAssemblyPort } from '../src/index.js';

describe('createAssemblyPort', () => {
  it('可构造端口实例，占位方法如实抛 NOT_IMPLEMENTED', () => {
    const port = createAssemblyPort({ snapshotRoot: '/dev/null' });
    expect(() => port.resolveFeature({ url: 'http://localhost/' })).toThrow(/^NOT_IMPLEMENTED/);
    expect(() => port.compose({ sessionId: 's1', featureId: null })).toThrow(/^NOT_IMPLEMENTED/);
    expect(() => port.describeInjection({ sessionId: 's1', featureId: null })).toThrow(
      /^NOT_IMPLEMENTED/,
    );
  });
});
