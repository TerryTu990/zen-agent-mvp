# adr-020: pack 契约 v2、registry 与存储分发

## 状态

提议（2026-08-04，随 `plans/2026-08-04-site-pack-and-user-config-tech-plan.md` 定稿；
与 adr-014 配套——L2 用户层在彼、pack 层与存储在此）

## 背景

产品定位（通用插件 + 站点包）要求 pack 支持三种来源：**官方**（平台维护，如 xianyu-seller）、
**社区**（第三方作者发布共享）、**自建**（用户为无人覆盖的站点自写，知识型 pack 即两个 markdown）。
维护责任跟随来源；官方 pack 受 ZA-EVAL 评测纪律约束。

现状（P1 去硬编码后）：pack 生效唯一路径是随服务端部署的 git 目录——`assets/manifest.json`
（registry 雏形：version + packs 列表）+ `assets/packs/xianyu-seller/`；assembly 启动读入不可变快照，
URL 匹配激活；插件端对 pack 零感知（options 仅 `za.token`/`za.serverBaseUrl`）。三来源中仅官方有
入口（=发版）；自建技术上可行（自托管者改 assets/ + manifest，host-demo 验收已证零核心改动）但无
产品入口；社区完全缺位。定稿设计稿 packs 页承诺：来源徽章、导入、社区浏览、启停、导出/卸载、更新提示。

## 决策

### 1. 布局不变，知识型 pack 合法

目录布局维持 U4 同构：`packs/<packId>/{pack.json, features/<id>/{feature.md, facts.md, tools.json},
skills/, docs/, eval/}`。`tools.json`、`capabilities`、锚点均可缺省——仅 feature.md + facts.md 的
知识型 pack 必须通过校验（生态冷启动约束），验收含 knowledge-only fixture。

### 2. pack.json v2 新增字段（全部可选；每字段必须挂装配端实施步或锚点）

| 字段 | 语义 | 落点 |
|---|---|---|
| `site.exclude[]` | 否定路径前缀（Tampermonkey `@exclude` 范式），命中即不匹配 | P2.5-a：resolvePack 排除判定 |
| `engines.contract` | 平台契约 semver 范围（VS Code `engines` 范式）；不满足**拒载**，不降级猜测 | P2.5-a：载入期校验 |
| `capabilities.anchors` | 引导锚点清单 `featureId → [{id, role, label, selectorHint}]`；失配降级（R6），非准入门槛 | 挂 D2 |
| `capabilities.skills[]` / `docs[]` | skills/docs 闭单，补目录扫描缺口 | P2.5-a：载入对账 |
| `capabilities.preparation.workflows[]` | pack 声明其使用的 workflows **⊆ 服务端已实现闭集**，载入期交叉校验（服务端 allOf 分形与语义分支原样保留；真泛化挂锚点） | P2.5-a |
| `configSchema` | **pack 声明用户可配置点**（JSON Schema + 默认值，纯数据）；L2 `packConfig` 的值按此校验（adr-014）；参数值以结构化数据注入工具调用/装配，不进自由文本，不改变工具 riskTier 与治理面 | P2.5-a：schema 合法性校验；P2.5-b：装配注入 |
| `integrity` | canonical 文件清单 sha256，U4 不可变的机械化验证 | P3.5 |

configSchema 是「个人差异参数层」的 pack 侧：可变空间由 pack 作者定义，用户只在空间内取值——
不触碰 R1 只收紧。

### 3. registry：内容与指针分离

`assets/manifest.json` 演进为 registry（仍是文件）：

- 登记项新增 `source: official|community|local`（P2.5-a；packs 页与注入视图来源徽章的数据源；
  仅展示归属，签名信任另有锚点）与 `hash`（P3.5；更新提示 = hash 比对，回滚 = 改指针）。
- **内容体**（packs/ 目录）不可变、按 packId@version 寻址；**指针**（registry）小而多变。
  该分离是后续一切演进（分发/多租户/DB）的结构基础。

### 4. 多租户模型：共享内容 + 租户指针清单

- pack 内容是共享资产——多租户 MUST NOT 表现为 per-tenant 拷贝；per-tenant 的只有**租户装配清单**
  （tenant → [packId@version, enabled, …]）。
- 装配解析为 `(tenant, url) → 租户 pack 集合 → pack → featureId`；C2 claims.tenant 与 pack.schema
  的 tenant 路由字段已预留，加法启用。
- 租户私有 pack（如企业内部系统包）：内容体仍为文件（P4 上传后按 hash 落盘）；**可见域在清单侧
  声明**（可见性是「租户-包」关系属性，不是内容属性；被否：写死在 pack.json 内）。
- 未来唯一可能入 DB 的部分就是这张指针/清单表（触发条件见 §6）；内容体永不入 DB。

### 5. 分发与产品入口补齐

- MVP 维持 git 目录（adr-007）；**P3.5 打包分发**：目录原样 zip + sha256，导入/导出/卸载走此形态
  （npm 不可变版本 / OCI digest 范式）；社区目录先 GitHub 仓库形式，不建 marketplace 产品。
- 载入校验对三来源一律相同（纯数据、schema、riskTier 声明、engines）——治理不因来源打折；
  官方 pack 额外过 ZA-EVAL 评测门。
- 设计稿 packs 页元素 → 落点：来源徽章（P2.5-a）；导入/导出/卸载/社区浏览/更新提示（P3.5）；
  **pack 启停开关 = 用户级状态，归 adr-014 L2 `enabled?: false`**（自托管单用户场景亦可直接改 registry）。

### 6. 存储矩阵

沿技术方案 §4：服务端 pack = git fs（S2 换配置中心产出同构快照，消费端零改动）；用户配置 =
服务端 JSON 文件（adr-014）；插件端不存 pack（P3.5 评估缓存，先自证消费方）。DB 引入触发条件
（命中任一才迁）：① 在线多写者事务；② 按租户/用户条件查询定向；③ 规模致整目录读入瓶颈；
④ 变更审计独立于发布节奏。迁移形态：指针/清单入 DB、内容体仍为不可变文件。

## 理由

- 「共享内容 + 指针」直接沿用现有 assets 结构的自然纹理（manifest.json 本就是指针表雏形），
  多租户/分发/DB 全部是这张表的演进，零推倒。
- 业界参照：Chrome/Tampermonkey `matches`/`@exclude`（站点匹配）、VS Code `engines` 与
  `contributes.configuration`（兼容拒载与用户配置点声明）、MCP capabilities（结构化能力对象）、
  npm/OCI（不可变版本 + digest 指针 + blob/manifest 分离——即本 ADR 多租户与分发的存储原型）、
  Claude Code plugin（plugin.json + marketplace，adr-013 已引）。
- 完整产品视角：契约一次定全（exclude/engines/capabilities/configSchema/integrity 覆盖到社区分发与
  P4 私有 pack），分期只切实现不切契约；「schema 接受但引擎无视」被明令禁止，每字段带落点。

## 被否方案

- capability 声明用平铺布尔（表达力不足）或自由字符串（不可校验，无法 fail-closed）。
- per-tenant pack 拷贝：内容冗余、版本漂移、升级即 N 份补丁。
- 可见域写在 pack.json：同一 pack 多租户订阅时可见性随内容走，改可见性=发新版，语义错位。
- DB 起步存 pack：无触发信号先付成本，牺牲 git diff/评测纪律的文件工作流（META-01）。
- preparation 语义「上移为 pack 声明」的原草案：服务端 allOf 分形与分支拆不掉，声明只是冗余复述——
  降格为子集交叉校验，真泛化挂锚点。

## 后果

- 正面：三来源获得统一契约与校验门；packs 页全部界面元素有数据字段支撑；多租户有明确模型且
  MVP 零成本预留；分发形态与回滚机械化（hash 指针）。
- 负面：registry 从「纯版本清单」长出治理属性（source/hash/租户清单），需要 schema 与迁移用例；
  P3.5 导入路径引入「非 git 来源的 pack」，评测纪律（ZA-EVAL）对社区/自建包不可强制，只能靠
  载入校验 + 用户责任边界。
- 实施映射：P2.5-a（v2 字段 + 载入语义 + registry source）→ P3.5（zip/sha256/hash 指针/导入导出/
  社区目录/L2 导出）→ P4（租户清单 + 私有 pack 上传 + 触发条件评估 DB）。
- deferral 登记：preparation 真泛化（第二个履约站点 pack 接入时）；pack 签名与来源信任
  （越出本仓分发时，adr-013:85）；插件端 pack 缓存（P3.5 先自证消费方）；pack 组合/优先级
  （一站点多 pack，P5）；用户自建触发器契约（adr-019 自动化泛化落地时）。
