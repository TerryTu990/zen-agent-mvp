/**
 * C4 配置快照类型——权威在 schemas/config-snapshot.schema.json（pack/registry 部分在
 * schemas/pack.schema.json 与 schemas/registry.schema.json），本文件为其手写同构投影。
 * codegen 引入锚点 = 契约首次进入高频变更期；在此之前改 schema 须同步手改本文件。
 */
import type { JsonObject } from './json.js';

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
  /** 否定路径前缀（Tampermonkey @exclude 范式）：命中任一前缀即不匹配本 pack，优先于 locations 判定。 */
  exclude?: string[];
}

/** 平台兼容声明（VS Code engines 范式）：contract 为对 contractVersion 的 semver range，载入期不满足即拒载。 */
export interface PackEngines {
  contract: string;
}

/** 引导锚点：role/label 与快照元素词汇对齐；selectorHint 失配时客户端静默降级为文字说明（R6）。 */
export interface PackAnchor {
  id: string;
  role: string;
  label: string;
  selectorHint?: string;
}

/** 结构化能力声明（MCP capabilities 范式）：全部可选，知识型 pack 合法缺省。 */
export interface PackCapabilities {
  /** featureId → 引导锚点清单；装配端消费锚点 = D2。 */
  anchors?: Record<string, PackAnchor[]>;
  /** skills/<fn>/ 闭单：载入期与目录扫描对账。 */
  skills?: string[];
  /** docs/ 内文档相对路径闭单：载入期与目录扫描对账。 */
  docs?: string[];
  /** pack 使用的准备 workflows ⊆ 服务端已实现闭集，载入期交叉校验。 */
  preparation?: { workflows: string[] };
}

/** canonical 文件清单 sha256（键 = pack 内相对路径，值 = sha256 hex）；装配端校验启用锚点 = P3.5。 */
export type PackIntegrity = Record<string, string>;

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
  /** pack 人读名（packs 页/注入视图/确认卡展示）；缺省=展示回退 packId。 */
  name?: string;
  /** 激活围栏；generic pack MUST 省略（互斥），站点 pack 必填（schema allOf 强制）。 */
  site?: SiteFence;
  /** claims.tenant → origin 路由用（任务组）；MVP 单租户 demo 可省。 */
  tenant?: string;
  /** generic 兜底 pack 标记：无站点 pack 命中时兜底激活，围栏由网关运行时绑定活跃页 origin；与 site 互斥。 */
  generic?: true;
  featureIdRules: FeatureIdRule[];
  features?: string[];
  /** adr-019 周期自动化声明（纯调度/提示词数据，不承载治理）；generic pack 禁声明（schema allOf 强制）。 */
  automations?: PackAutomation[];
  engines?: PackEngines;
  capabilities?: PackCapabilities;
  /** pack 声明的用户可配置点（adr-020）：JSON Schema 对象；L2 packConfig 写入期按此校验。 */
  configSchema?: JsonObject;
  integrity?: PackIntegrity;
}

/** pack 周期自动化声明：客户端按此调度周期唤醒并发起自动回合；id 跨 pack 唯一（载入期查重拒载）。 */
export interface PackAutomation {
  id: string;
  prompt: string;
  /** 工作页判定：激活页 URL 去 origin 后（path+hash）须以任一前缀开头；origin 恒取 pack.site.origin。 */
  workRoutes: string[];
  executionPreference: 'auto' | 'dom-only' | 'prefer-client-api' | 'prefer-server-api';
  defaultPeriodMinutes?: number;
}

/** pack 来源归属（adr-020）：仅展示归属（来源徽章），载入校验对三来源一律相同；缺省 = official。 */
export type PackSource = 'official' | 'community' | 'local';

/** registry 登记项：packId+version 须与 packs/<packId>/pack.json 一致（不一致 fail-closed 拒载）。 */
export interface RegistryPackEntry {
  packId: string;
  version: string;
  source?: PackSource;
  /** pack 内容 sha256 指针：更新提示 = hash 比对，回滚 = 改指针；装配端启用锚点 = P3.5。 */
  hash?: string;
}

/** 全局 registry（registry 形态的根 manifest.json，权威 schemas/registry.schema.json）：已安装 pack 登记表。 */
export interface RegistryManifest {
  version: string;
  packs: RegistryPackEntry[];
}
