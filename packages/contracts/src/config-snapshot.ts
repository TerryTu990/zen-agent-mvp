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
 * legacy 形态（无 pack 化）：装配器按缺省 packId="default"、无 site 围栏载入。
 */
export interface ConfigSnapshotManifest {
  version: string;
  /** 有序规则表，首个命中生效；无命中 = 仅装配稳定基座（fail-safe）。 */
  featureIdRules: FeatureIdRule[];
  /** 声明时装配器启动校验功能目录齐备，缺失 fail-closed 拒载。 */
  features?: string[];
}

/** pack 激活围栏（pack.json site）：origin 精确匹配 + locations 路径前缀（缺省整站 `/`）。 */
export interface SiteFence {
  /** 精确匹配的页面 origin（scheme://host[:port]，无路径无尾斜杠）。 */
  origin: string;
  /** 路径前缀数组，同 origin 多 pack 最长前缀胜出；省略时装配器按缺省 `["/"]` 处理。 */
  locations?: string[];
}

/**
 * 站点包清单（packs/<packId>/pack.json，权威 schemas/pack.schema.json）：
 * 布局同构于 legacy 快照子树 + site 围栏 + packId 命名空间（U4）。
 */
export interface PackManifest {
  packId: string;
  /** pack 独立 semver，发布后不可变（改配置=发新版本）。 */
  version: string;
  /** 一句话站点用途（渐进披露第一层）：进入"已安装站点索引"供 agent 跨站发现；缺省=索引回退用 packId。 */
  summary?: string;
  /** 激活围栏；generic pack MUST 省略（互斥），站点 pack 必填（schema allOf 强制）。 */
  site?: SiteFence;
  /** claims.tenant → origin 路由用（任务组）；MVP 单租户 demo 可省。 */
  tenant?: string;
  /** generic 兜底 pack 标记：无站点 pack 命中时兜底激活，围栏由网关运行时绑定活跃页 origin；与 site 互斥。 */
  generic?: true;
  featureIdRules: FeatureIdRule[];
  features?: string[];
}

/** 全局 registry（registry 形态的根 manifest.json，权威 schemas/registry.schema.json）：已安装 pack 登记表。 */
export interface RegistryManifest {
  version: string;
  packs: Array<{ packId: string; version: string }>;
}
