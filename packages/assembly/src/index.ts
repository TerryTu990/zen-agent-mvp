import type { AssemblyPort } from '@zen-agent/contracts';

export interface AssemblyOptions {
  /** 配置快照根目录（manifest.json + features/ + skills/ 所在，布局见 C4）。 */
  snapshotRoot: string;
}

export function createAssemblyPort(options: AssemblyOptions): AssemblyPort {
  void options;
  return {
    resolveFeature() {
      throw new Error(
        'NOT_IMPLEMENTED: M1 讲解闭环——manifest.featureIdRules 有序首中匹配 url → featureId',
      );
    },
    compose() {
      throw new Error(
        'NOT_IMPLEMENTED: M1 讲解闭环——快照读取与注入组合（基座 + feature.md + facts.md + skills + 工具白名单）',
      );
    },
    describeInjection() {
      throw new Error(
        'NOT_IMPLEMENTED: M1 讲解闭环——注入自省（与 compose 同源，供审计 assembly 事件）',
      );
    },
  };
}
