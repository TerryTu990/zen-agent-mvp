/**
 * C4 配置快照类型——权威在 schemas/config-snapshot.schema.json，本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */

/** url → featureId 映射规则：urlPattern 为 ECMAScript 正则源串，对完整 URL 做 test。 */
export interface FeatureIdRule {
  urlPattern: string;
  featureId: string;
}

/**
 * 快照清单（manifest.json）：版本化不可变快照的根（U4）——
 * MVP git 文件布局与标准版配置中心产出物同构，升级换生产端不换消费端。
 */
export interface ConfigSnapshotManifest {
  version: string;
  /** 有序规则表，首个命中生效；无命中 = 仅装配稳定基座（fail-safe）。 */
  featureIdRules: FeatureIdRule[];
  /** 声明时装配器启动校验功能目录齐备，缺失 fail-closed 拒载。 */
  features?: string[];
}
