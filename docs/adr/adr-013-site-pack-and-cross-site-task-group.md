# adr-013: 站点包（site pack）= 可分发子 agent + 跨站点任务组升级路径

## 状态

提议（2026-07-05 初稿；同日按评审意见修订 v2：location 匹配 / 迁移策略 / 实改面补全 / 业界参照，待 Terry 复审）

## 背景

现快照是单宿主假定：`manifest.json` 的 `featureIdRules` 只按 URL 正则匹配、无 origin 维度；skills 快照全局注入（所有 SKILL.md 进每轮上下文）；featureId/toolId 是全局命名空间。要接入第二个站点（如 https://codeflow.asia/ ）即暴露三个缺口：① 配置无法以站点为单位打包分发与独立版本化；② A 站 skills/规则会注入 B 站会话（跨站干扰）；③ 存在一个业务跨多个系统操作的真实场景，而 adr-012 组键=origin 使切 origin 即换会话，任务上下文断裂。宗旨自证：站点包让注入面精确对齐用户所在系统（准确性），任务组让跨系统业务不断链（辅助完成整个业务）。

## 决策

### 1. pack 目录形态（站点 = 分发单元，布局同构于现快照子树，U4）

```
packs/<packId>/
├── pack.json            # {packId, version(semver), site:{origin, locations?}, featureIdRules, features[]}
├── features/<id>/{feature.md, facts.md, tools.json}
├── skills/<fn>/SKILL.md
└── eval/                # 该站点评测素材同包（ZA-EVAL 素材同仓：pack 分发到哪，评测跟到哪）
```

- 激活键 = `site.origin`（精确匹配）+ `site.locations`（路径前缀数组，缺省 `["/"]` 即整站）：同 origin 多 pack 按**最长前缀胜出**——nginx location 前缀语义的最小子集，不取正则/修饰符/通配符域名（锚点：真实宿主出现该需求时评估）。同 origin 前缀重复 → 载入期 fail-closed 拒载。`featureIdRules` 降为 pack 内规则，仅在 pack 激活后参与匹配。
- skills 从快照全局收敛为 **pack 作用域**：只随所属 pack 激活注入。
- featureId/toolId 命名空间 = `<packId>` 限定（审计与端口以 `{packId, featureId}` 二元组定位），跨 pack 不冲突。
- `system-prompt.md` 仍是平台级跨站稳定基座（prompt 缓存前缀），不进 pack。

### 2. 安装与发现

全局 registry（现根 manifest.json 升级）：`{version, packs:[{packId, version}]}`。安装 = pack 目录入 `packs/` + registry 登记（MVP 即 git 操作；标准版=配置中心按 pack 发布）。装配引擎启动全量载入并逐 pack fail-closed 校验（拒载语义沿用现 loadSnapshot）。

### 3. 激活与隔离

- `resolveFeature(url)` 升为两级：origin 精确匹配 + 最长 location 前缀 → 唯一 pack；pack 内 featureIdRules → featureId。无 pack 命中 → 仅装稳定基座（现 fail-safe 语义不变）。判定权威在服务端，对话内容不可改变（装配透明）。
- **换出即卸载**：逐回合全量重组（system 注入整段重建 + 工具白名单重投影）已天然保证切站点后上一 pack 的规则/skills/工具不再出现——无需显式"卸载"动作。还缺的四件才是本 ADR 的实改面：skills 收敛 pack 作用域（现为全局注入）；命名空间限定；审计事件补 `{packId, packVersion}`；评测 runner 按 pack 发现 `eval/`（现写死单配置目录，不改则 §4"改 pack 必跑评测"落空）。
- 对话历史残留分两种：跨 origin 不存在（adr-012 组键=origin，切站=换会话）；同 origin 跨 pack（location 切换）共享会话历史，回合注入边界标记（"以下对话发生在 X 系统"）防历史误导——与 §5 任务组切站为同一机制，一处实现两处复用。会话组键保持 origin 不变。

### 4. 版本与失效

pack 独立 semver；发布后不可变，改配置=发新版本（U4）；会话进行中升级 → 下一回合重组自然生效，回滚=registry 改回旧版本号。卸载=registry 去登记，该站点回落"仅基座"。改 pack 必跑该 pack 的 eval/（ZA-EVAL）。存量迁移：未 pack 化的现有快照按缺省 `packId=default` 载入，工具/审计引用不破坏——新旧并存，全部迁完后移除缺省。

### 5. 跨站点任务组（adr-012 组键升级路径）

默认路径不变：组键=origin，一站一会话。用户**显式发起**跨站点任务时升级——

- **组键 origin → taskGroupId**：插件侧创建任务组，后续导航到的站点标签页并入组；一组一会话、单桥单 SSE、活跃页路由（adr-012 全部机制复用，仅组键换值）。
- **装配随活跃页换 pack**：每回合按活跃页 URL 激活对应 pack——逐回合重组天然支持，装配引擎零新机制；组内切站时注入边界标记（"以下对话发生在 X 站点"）防历史误导。
- **多宿主身份**：C2 claims 契约不变（单对象），会话状态从单 claims 升为 per-origin 映射；toolgate 按目标工具所属 pack 的 origin 取 claims，缺失/过期即 fail-closed 拒绝并驱动该站点身份获取（U7）。
- **工具围栏随站点生效**：签发校验补 origin 维度——目标 URL 的 origin+path 必须落在签发工具所属 pack 的 `site` 围栏内（dom `pathPrefixes` 由 pack.site.origin 补齐为绝对围栏；http adapter 相对模板同理锚定）。exec-instruction 仍只发活跃页，目标 origin ≠ 活跃页 origin 时不签发。

## 理由

- pack 布局 = 现快照子树 + pack.json，registry 是"快照的快照"——消费端（assembly）仍读同构布局，标准版配置中心的发布产出物即 pack（U4 升级=换生产端不换消费端）。
- 隔离不靠新增"卸载机制"，靠已有的逐回合全量重组 + adr-012 会话按 origin 分组——结构性成立，只补 skills 作用域这一处真实缺口。
- 任务组方案把新增面收敛到两点（per-origin claims 映射、围栏带 origin），SSE/路由/装配全部复用既有机制；契约不分叉（U5：任务组封装在插件形态内，服务端只见会话与 URL）。
- 业界参照：按 URL 激活的可分发行为包 = Chrome 扩展 `matches` / Tampermonkey `@match` / VS Code `activationEvents` / Home Assistant 集成目录；最长前缀匹配 = nginx location 前缀语义；包分发与登记 = Claude Code 插件（plugin.json + marketplace）；跨站任务组 = claude-in-chrome 一对话一跨域标签组；per-origin 身份 = Playwright browser context 按 origin 持登录态。

## 被否方案

- **多站点仍一张全局 featureIdRules 表**（不引入 pack）：正则可写全 URL 匹配多站，但 skills 全局注入的干扰无解、无分发单元、评测素材无归属——三个缺口一个不解。
- **跨站点任务组=会话联邦**（各 origin 独立会话 + 任务组实体跨会话共享任务备忘）：不动组键与 SSE，但引入跨会话状态同步与多 agent loop 一致性这一新复杂面，且用户对话分散多处——复杂度答不上宗旨基准。
- **组键无条件升为 taskGroupId**（取消 origin 默认）：日常单站场景被迫感知"任务组"概念，为少数场景加重多数路径。
- **一域名一包硬限定**：规避同会话跨 pack 历史残留最简单，但真实宿主常在一个域名下部署多套系统（/crm、/erp），会把这类宿主挡在 pack 机制外；最长前缀匹配 + 边界标记以极小复杂度换全覆盖。
- **会话组键升 origin+location**（同域多 pack 各开会话）：历史彻底隔离，但插件须感知 pack 边界（装配知识外泄客户端），且 SPA 站内换路径会把一次对话拦腰截断。

## 后果

- 正：站点配置成为可独立分发/版本化/评测的自治单元（"子 agent"）；跨站干扰被结构性排除；跨系统业务可在一个会话内完成。
- 负：装配载入从一级变两级（registry→pack），审计与 eval 需带 packId 维度；任务组把"多宿主身份获取"提前暴露（每个站点各需一次身份获取，插件 UX 需引导）。
- 分期：pack 机制先行（demo config 迁为首个 pack；codeflow pack 的 facts 纳入站点组件库交互提示——E2E 实证：一条"Semi 下拉须点选项行"可省数轮摸索）；任务组挂锚点——**第二个真实站点 pack 接入且出现跨站业务场景时**实施 §5。
- 锚点：pack 间依赖/组合（一个业务域拆多 pack）——出现真实复用场景时评估；pack 签名与来源信任（第三方分发）——pack 越出本仓分发时评估。
