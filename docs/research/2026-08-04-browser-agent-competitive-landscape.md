# 浏览器 agent 竞品格局与 Zen Agent 差异化定位

> 状态：调研快照，2026-08-04，基于公开网络信息，时效性有限。
> 目的：支撑通用插件产品化的差异化定位，配套 `docs/plans/2026-08-04-generic-extension-productization.md`。
> 口径：Zen Agent 定位为「可被用户塑形的浏览器 agent harness」（类比：浏览器 agent 的
> Claude Code / AI 时代的 Tampermonkey）——按站点/功能动态装配规则/skills/工具面/自动化，
> 提供功能讲解 + UI 引导 + 受控代执行。

## 1. 核心结论

**没有与「用户可深度定制 harness × 受治理代执行」完全重合的产品**：这两件事分别有人在做，
但无人同时做。定制深的产品（DAP、可编程插件）不做受治理代执行；代执行强的产品（大厂浏览器
agent、开源框架）不开放 harness 级定制。右上角空位真实存在。

**警讯**：Claude for Chrome 2026 年已明显向 skills / custom instructions 收敛——styles 迁移为
skills，Claude Code 可给 Chrome 注入自定义 skills 与 system prompt。「纯定制」这一单点的差异化
窗口有限，Zen Agent 的护城河不能压在「可定制」本身（详见 §3、§4）。

## 2. 竞品六类

### 2.1 大厂通用浏览器 agent

- **Claude for Chrome**：2025-08 千人试点 → 2025-12 向全付费计划开放；站点级权限白名单 +
  ask-before-acting / act-without-asking 两档授权；不可逆操作仍强制确认。
- **Gemini in Chrome**：多 tab 上下文、Google 全家桶集成、AI Pro/Ultra 档提供 auto-browse。
- **ChatGPT Agent**：Atlas 浏览器 2026-07-09 关停，能力并入 ChatGPT/Codex/Chrome。
- **Perplexity Comet**。

**与 Zen Agent 的差异**：通用模型裸推 DOM、无站点级知识注入、治理粒度粗（站点白名单 + 两档
授权，远不到 riskTier/HITL 分级）、绑定自家模型。大厂的产品逻辑是「一个 agent 通吃所有网站」，
站点级深度知识与用户塑形不在其结构性路线上。

### 2.2 BYOK/开源浏览器 agent

- **Nanobrowser**：开源、多 agent 架构（Planner/Navigator）、支持 OpenAI/Anthropic/Gemini/
  Ollama 等任意兼容端点、本地运行以隐私为卖点。
- **Browser Use**：开源框架、WebVoyager 89.1% SOTA、社区 marketplace 已有 1200+ 自动化分享。
- **Do Browser**、**BrowserAgent**。

**差异**：这一类开放的是任务脚本/工作流的定制，而非 agent 行为规则与知识的定制——用户写的是
「替我做什么」，改不了「agent 该怎么想/知道什么/什么不能做」；且无服务端 fail-closed 治理、
无审计。BYOK 与开源本身不构成对 Zen Agent 的威胁，反而验证了多模型中立的需求。

### 2.3 可编程 AI 插件（最接近的一类）

- **HARPA AI**：100+ 预置 page-aware 命令、用户可自建带参数插值的自定义命令、数据抽取到
  Sheets/CSV/JSON、价格监控、可触发 Make/Zapier/n8n webhook、Grid API 编排。

**差异**：HARPA 是命令/工作流范式——用户定制的仍是「做什么」，而非「agent 该怎么想/知道什么/
什么不能做」这一 harness 层；且无风险分级 HITL、无一次性签名代执行契约。它证明了「用户可编程
的浏览器 AI」有市场与成熟 UX，但没有跨进治理这一侧。

### 2.4 AI 侧边栏助手

- **Monica**（多模型 + 图像视频生成）、**Sider**（常驻侧栏 + 阅读写作）、**MaxAI**（屏幕上下文
  右键动作）。

**差异**：只读不代执行；调研未见 per-site custom instructions/memory。与 Zen Agent 只在
「讲解」一维有重叠，不构成定位冲突。

### 2.5 DAP 数字采纳平台（ToB 镜像）

- **WalkMe**：企业级、SAP/Workday/Salesforce 深集成。
- **Whatfix**：walkthrough/self-help。
- **Pendo**：分析先行，2026 推出 Agent Analytics（prompt 级追踪、rage prompt 检测、合规监控）。

**差异**：配置主体是厂商而非用户、企业采购、无自助/个人版、不代执行。DAP 反向证明了
「站点级引导知识」有付费市场——Zen Agent 可以打「self-serve DAP」叙事：把厂商专属的站点
引导配置能力交到用户/长尾团队手里，并叠加 DAP 从不提供的受治理代执行。

### 2.6 垂直卖家工具

- **Seller Assistant**、**SellingPilot**（Chrome/Edge/紫鸟浏览器）、国内闲鱼/拼多多生态工具
  （多账号智能客服、AI 自动回复、自动发货、比价选品，已高度内卷）。

**差异**：写死的功能点工具而非可定制 agent 平台。这一战场靠单个 commerce 变体打功能战没有
优势（见 §4 劣势），但它是 pack 生态可覆盖的长尾之一。

### 2.7 旁证：Tampermonkey 生态

Tampermonkey 生态已出现「AI 生成 userscript」工具链，验证了个人定制浏览器行为的长尾需求
真实存在；但其产物是任意 JS 代码——可分享性差、不可审、执行任意代码。这反衬 pack 纯数据
范式的取舍是对的：可分享、可审、不执行任意代码，同时解决 CWS 合规与第三方 pack 安全。

## 3. 定位差异：两轴分析

以**定制深度**（不可改 → 命令/脚本 → harness 级）×**执行治理**（只读 → 粗放代执行 →
分级 HITL+审计）两轴看：

- 大厂通用 agent：定制浅、治理中；
- HARPA / Browser Use：定制中、治理弱；
- DAP：定制深，但配置主体是厂商、且不代执行；
- **右上角（harness 级定制 × fail-closed 治理 × 站点知识深度）为空位**。

由此，差异化叙事应是**三件套组合而非单点**：

1. **站点级 harness（pack）**，而非账号级一段 custom instruction——规则/事实/工具面/自动化
   随站点与功能装配，深度与粒度是大厂 skills 收敛路线达不到的；
2. **可托付的执行治理**——riskTier 分级、HITL、一次性签名代执行、旁路审计，把「敢让它做」
   建立在契约而非信任上；
3. **中立与所有权**——BYOK 多模型、配置本地可导出，用户的塑形成果归用户。

三者大厂各有结构性障碍：站点级知识运营与其「一个 agent 通吃」的产品逻辑相斥；细粒度治理
契约与其消费级体验目标冲突；中立与自家模型绑定直接对立。单点会被追平（§1 警讯即例证），
组合才是护城河。

## 4. Zen Agent 优劣势

### 优势

- **架构与定位天然咬合**：pack 就是 harness 的声明式载体，治理链路（分级/HITL/签名/审计）
  现成；pack 纯数据同时解决 CWS 合规与第三方 pack 安全两件事。
- **配置深度上限已被生产验证**：xianyu-seller pack 在生产运行，覆盖周期触发、服务端
  prepare、外部账本，证明 pack 范式撑得起真实业务复杂度。
- **BYOK/多模型顺手**：llm-port 端口化使模型中立几乎零成本。
- **市场佐证**：DAP 市场证明站点级引导知识值钱；Tampermonkey/HARPA/Browser Use 社区证明
  用户定制的长尾需求真实。

### 劣势

- **定制能力尚未产品化**：目前是 git 配置文件；HARPA 已有成熟的命令编辑 UX，Browser Use
  有 1200+ 社区分享。定制深度领先但可用性落后。
- **分发与开箱体验落后**：未上架 CWS、需自托管 server。
- **单点资源 vs 大厂迭代速度**：向 skills/custom instructions 的趋同是现在进行时，窗口期
  以季度计。
- **国内垂直战场已卷**：单靠 commerce 变体打功能战无优势，必须以平台叙事进入。

### 总结

空位真实存在且无人占；护城河不在「可定制」本身，而在「定制 × 治理 × 站点知识生态」的
组合；最大风险不是方向而是**产品化速度**——差异化叙事的三件套里，第一件（pack 的自助
创建与分发体验）是当前最薄弱、也是配套产品化计划要优先补的一环。

## Sources

- https://www.minded.com/blog/best-ai-browser-agents-2026
- https://www.usecarly.com/blog/best-ai-browser-agents/
- https://claude.com/claude-for-chrome
- https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- https://www.ai-toolbox.co/claude-management-and-productivity/how-to-set-up-claude-custom-instructions-2026
- https://harpa.ai/welcome 与 https://harpa.ai/grid/web-automation
- https://github.com/nanobrowser/nanobrowser
- https://www.firecrawl.dev/blog/best-browser-agents
- https://www.pendo.io/pendo-blog/top-10-digital-adoption-platforms/
- https://userpilot.com/blog/walkme-vs-whatfix/
- https://www.sellerassistant.app/download/ 与 https://www.sellingpilot.com/helpcenter/en/extension/
- https://www.datacamp.com/blog/top-agentic-ai-chrome-extensions
