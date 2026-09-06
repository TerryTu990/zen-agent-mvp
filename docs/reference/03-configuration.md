# 配置参考（站点包 + 环境变量）

> 参考型文档：结构、字段、示例的权威导览。schema 事实权威在 `packages/contracts/schemas/`（registry / pack / tool-definition / user-overlay），env 读取权威在 `apps/server/src/main.ts`；本文与之冲突时以代码为准。
> 快照不可变纪律（U4）：改配置 = 发新版本（升 version + 替换目录内容），运行时永不就地改写。

## 1. 配置分层总览

| 层 | 位置 | 角色 |
|---|---|---|
| 稳定基座（L0） | `ZA_SYSTEM_PROMPT_PATH`（默认 `assets/system-prompt.md`） | 跨站点不变的 agent 治理基座（ZA-SYS-*） |
| 快照根 / 站点包（L1） | `ZA_SNAPSHOT_ROOT` 指向的目录 | registry + packs 两级站点配置（版本化不可变，U4） |
| 用户覆盖层（L2） | `ZA_USER_CONFIG_DIR`（默认 `.za/user-config`） | subject=(tenant, hostUserId) 维度的运行期覆盖；契约与只收紧语义见 `02-contracts.md` C7，本文只列落点与 env |
| 服务端 env | `ZA_*` 环境变量 | 端口/密钥/LLM 上游/落盘路径等运行参数（§4 全表） |

**「在哪些站点辅助」的开关归用户，不归运营者**：generic 兜底包无部署级准入名单——无站点 pack 命中且页面有 http(s) origin 即激活；
要让 Zen 不出现在某站点，走 L2 全局作用域的 `siteDenylist`（配置中心「不辅助的站点」面板可增删）。
命中即回落仅基座（站点包与通用兜底包都不装配），**终判在服务端 compose**：客户端据同一份名单跳过激活只是隐私侧不上报，不构成治理生效。
客户端侧不是若干点状判定，而是一条可陈述、可验收的**不变量 SD**：*URL 命中名单的页面对服务端完全惰性——
不发出任何上行帧、不接受任何下行指令的执行、不被登记为活跃执行页，也不激活*。
它由三处统一出口施加、共用同一份判定：上行帧的统一出口（覆盖 `context-report` / `snapshot-report` /
`exec-result` / 自动化回合的 `user-message` 等全部种类，无论来自 content 端口还是周期自动化）、
下行帧落到页面的统一出口（`exec-instruction` / `guide-action` / `snapshot-request`）、活跃执行页登记。
只掐上行而不管下行等于「照做但不告诉你」，故两个方向都收。
**唯一允许自命中页上行的例外**是 `{ok:false, error:'site-denied'}` 形态的拒绝回执（不含任何页面数据）——
没有它，服务端只能把「已下发未回」当超时，用户会以为拉黑生效却看不出指令其实被本机拒了。
面板在**本机确实跳过了该页激活**（background 在跳过当刻登记的事实）时给出客户端自述（composer 须知，
面板根 `data-state=denied`），且自述只陈述当下与此后、不断言过去。判据是那条跳过登记而非「当前 URL 命中名单」：
该页若在拉黑前已激活、服务端确实见过它并已按 `site-denied` 回落仅基座，客户端不得用猜测把那条已成立的上下文顶掉。
服务端 `site-denied` 装配结论目前在面板侧**无展示载体**（「本页生效」块 2026-09-07 撤除，
见 `../plans/2026-08-04-product-form-definition.md` §4 透明性行），锚点同该行：配置中心 Atelier 重做落地时裁决是否回挂。
拉黑前已上报的地址仍留在服务端会话上下文里，故下一轮 compose 仍按该 origin 判 `site-denied`。
**尚未收进不变量的边界**：`site_navigate` 与站点索引仍不认名单（模型仍可能提到该站点、仍可导航过去，
只是到了那里发不出帧也执行不了指令）。命中页的 content script 注入自 adr-027 起归入不变量 IN：
黑名单优先于授权，两轨都不注入——但拉黑只挡此后的注入，**拉黑前已注入的页里 content 不随名单变更消失，
需重载该页才彻底退出**；其间上行闸门照挡（不激活、不上报上下文、不进任务组页面清单）。
**降级语义（fail-open）**：L2 读失败（用户配置存储不可用）的那一轮读不到名单，黑名单整体不生效、该站点照常装配——
黑名单是隐私偏好而非安全边界，存储抖动期让整个产品停摆代价更大；
该轮在审计 assembly 事件里带 `userConfigDegraded` 可判读。同轮的工具面另按 fail-closed 一律 `forbidden`——那是执行授权，与此不同类。

**快照根当前事实（2026-09-03）**：生产快照根 = `assets/`（`manifest.json` registry 2.0.0），**只登记通用兜底包 `generic-web`**；
站点包 `xianyu-seller` / `yinxiang` 已下线到 `examples/site-packs/`（完整可装配的快照根，测试与评测继续覆盖），
重新上架＝把 pack 目录放回 `assets/packs/` 并登记进 `assets/manifest.json`（版本须与 `pack.json` 一致，否则拒载）。
验收/评测另用 `examples/acceptance`。

## 2. 站点包目录结构（快照根全貌）

```
<ZA_SNAPSHOT_ROOT>/
├── manifest.json                     # registry 登记表（必填）
│     { "version": "0.1.0",           #   registry 整体 semver，装配与审计回写
│       "packs": [                    #   登记项须与各 pack.json 的 packId/version 一致，
│         { "packId": "…", "version": "…" } ]}  # 不一致 fail-closed 拒载
└── packs/
    └── <packId>/                     # 目录名 == packId（^[a-z][a-z0-9-]*$）
        ├── pack.json                 # pack 清单（必填，字段见 §3.1）
        ├── features/                 # 功能目录（features[] 声明的每项必须齐备三件套）
        │   └── <featureId>/
        │       ├── feature.md        # 功能规则（ZA-FEAT-NN）：agent 在该功能内怎么讲/做/不做
        │       ├── facts.md          # 功能事实：页面构成/字段/API/元素锚点（讲解与操作依据）
        │       └── tools.json        # 工具定义数组（每元素过 C1 契约，见 §3.2）
        ├── skills/                   # 可选：功能技法
        │   └── <fn>/SKILL.md         #   目录存在则 SKILL.md 必填，缺失拒载
        ├── docs/                     # 可选：站点操作文档（渐进披露）
        │   └── <name>.md             #   frontmatter title/summary 进索引，正文经 pack_doc 按需读
        └── eval/                     # 可选：评测场景（装配器不加载，评测脚本用）
            └── scenarios.json        #   讲解/装配换出/引导/工具/HITL/自动化 六维度
```

**legacy 形态**：根 manifest 无 `packs` 数组时按单 pack 处理（`config-snapshot.schema.json`，缺省 packId=`default`、无 site 围栏），旧快照零迁移可用。

## 3. 新增一个站点：完整示例

以接入虚构站点 `wiki.example.com`（知识库，辅助"创建页面"功能）为例，只需在快照根加文件、**零代码改动**：

### 3.0 步骤

1. `manifest.json` 的 `packs` 数组登记 `{ "packId": "wiki-example", "version": "0.1.0" }`
2. 新建 `packs/wiki-example/pack.json`（§3.1）
3. 新建 `packs/wiki-example/features/wiki-page/{feature.md, facts.md, tools.json}`（§3.2）
4. （可选）`docs/`、`skills/`、`eval/`
5. 重启服务端（快照惰性载入一次并缓存；坏配置启动期 fail-fast 报 `快照拒载：…`）
6. 若该站点要用周期自动化，在配置中心「全局设置 → 已授权常驻的站点」授权该 origin
   （adr-027 轨二：无手势唤醒要求该 origin 已授权；会话内点图标即用，不需预先声明）

### 3.1 pack.json

```json
{
  "packId": "wiki-example",
  "version": "0.1.0",
  "summary": "Example Wiki 知识库：创建与编辑页面",
  "site": {
    "origin": "https://wiki.example.com",
    "locations": ["/spaces", "/pages"]
  },
  "tenant": "wiki",
  "featureIdRules": [
    { "urlPattern": "wiki\\.example\\.com/pages", "featureId": "wiki-page" }
  ],
  "features": ["wiki-page"]
}
```

| 字段 | 必填 | 语义 |
|---|---|---|
| `packId` / `version` | ✅ | 须与目录名、registry 登记一致 |
| `name` | ⬜ | pack 人读名（packs 页 / 注入透明视图 / 确认卡展示，如"闲鱼卖家"）；缺省=展示回退 packId |
| `summary` | ⬜ | 一句话站点用途——进"已安装站点索引"（跨站发现层），缺省回退 packId |
| `generic` | ⬜ | `const true`：声明本 pack 为"无站点 pack 命中"时的兜底包；**与 `site` 互斥**、禁声明 `automations`（schema allOf 强制），不参与 origin/location 匹配与站点索引；无站点 pack 命中且页面有 http(s) origin 即**无条件激活**（无部署级准入名单；用户可用 L2 站点黑名单按站点关停），激活时以活跃页 origin 运行时绑定；registry 至多登记一个 |
| `site` | 条件 | **非 generic 时必填；`generic: true` 时 MUST 省略**（schema allOf 强制，写了即拒载） |
| `site.origin` | ✅（有 `site` 时） | 激活围栏：`scheme://host[:port]` 精确匹配（无路径无尾斜杠）；同时是 http/server 工具请求与 navigate 目标的 origin 围栏 |
| `site.locations` | ⬜ | 路径前缀数组（最长前缀胜出）；省略=整站 `["/"]` |
| `site.exclude` | ⬜ | 否定路径前缀数组（Tampermonkey `@exclude` 范式）：命中任一前缀即不匹配本 pack，判定优先于 `locations` |
| `tenant` | ⬜ | per-origin 身份路由键：`claims.tenant` 匹配它时会话记住该 origin 的宿主身份；单租户/无宿主身份诉求可省 |
| `featureIdRules` | ✅ | pack 激活后的 url→featureId 有序映射（ECMAScript 正则，首个命中生效） |
| `features` | ⬜ | 功能闭单；声明则启动校验目录齐备（缺失拒载），省略则按目录扫描 |
| `automations` | ⬜ | 周期自动化声明（adr-019，≤5 条，纯调度/提示词数据不承载治理）：每条 `{id, prompt, workRoutes, executionPreference, defaultPeriodMinutes?}`——`workRoutes` 是工作页判定前缀（激活页 URL 去 origin 后的 path+hash 须以任一前缀开头，origin 恒取 `site.origin`），`executionPreference` 闭集 `auto` / `dom-only` / `prefer-client-api` / `prefer-server-api`，`defaultPeriodMinutes` 省略时按 5 分钟。`id` 跨 pack 唯一（载入期查重拒载）；generic pack 禁声明 |
| `engines.contract` | ⬜ | 平台兼容声明（VS Code engines 范式，adr-020）：对 contracts 导出 `contractVersion` 的 semver range；载入期比对，range 非法或不满足即拒载（不降级猜测） |
| `capabilities` | ⬜ | 结构化能力声明（MCP capabilities 范式），全部可选，知识型 pack（仅 feature.md+facts.md）合法缺省：`skills`（`skills/` 目录闭单，与目录**双向对账**——声明多一项或目录多一项均拒载）、`docs`（`docs/` 内相对路径闭单，同样双向对账）、`anchors`（featureId → 引导锚点数组 `{id, role, label, selectorHint?}`，契约定义的结构化锚点登记位，失配降级、不作准入门槛；装配端尚未接线消费，现行实践仍把定位锚点写在 `facts.md`，见 §3.3） |
| `configSchema` | ⬜ | pack 声明的用户可配置点（adr-020）：一份**扁平顶层** JSON Schema 对象——必带 `type: "object"` + `properties`（键闭集即可配置点）+ `additionalProperties: false`，顶层不得出现 `$ref`/`allOf`/`patternProperties` 等组合关键字（键的值 schema 可任意复杂，复用走 `$defs` + 值内 `$ref`）。载入期校验形态与可编译性，两者任一不过即拒载；L2 `packConfig` 写入期按它校验（未声明或值越界即拒），注入期按同一份顶层 `properties` 取键，故写入端与注入端同源。取值以结构化数据注入，不改变工具 riskTier 与治理面 |
| `integrity` | ⬜ | canonical 文件清单 sha256（U4 不可变的机械化验证）：键=pack 内相对路径、值=sha256 hex。装配端校验启用锚点=打包分发落地时，当前只做契约校验、不比对内容 |

**generic 兜底包最小形态**（`assets/packs/generic-web/pack.json` 即此形态）：无 `site`、无 `automations`，激活完全由服务端准入名单决定。

```json
{
  "packId": "generic-web",
  "version": "0.3.0",
  "generic": true,
  "featureIdRules": [{ "urlPattern": ".*", "featureId": "browse" }],
  "features": ["browse"]
}
```

### 3.2 tools.json（三种 adapter 各一例）

```json
[
  {
    "id": "wiki-example.page-operate",
    "featureIds": ["wiki-page"],
    "description": "在 Wiki 页面上可见地代用户操作（点击/填写/读取）。使用前必须先调用 page_snapshot；steps 的 ref 必须取自最近一次快照。task 在整个任务期间保持不变（首批授权一次，后续批次跨工具自动放行）；首批附 plan 列任务大步骤。",
    "params": {
      "type": "object",
      "additionalProperties": false,
      "required": ["task", "steps", "summary"],
      "properties": {
        "task":    { "type": "string", "description": "任务标题（授权作用域标识，跨站沿用同一标题）" },
        "plan":    { "type": "array", "items": { "type": "string" }, "description": "任务级大步骤（授权卡呈现）" },
        "steps":   { "type": "array", "minItems": 1, "maxItems": 20, "items": { "type": "object" } },
        "summary": { "type": "string", "description": "面向用户的操作摘要" }
      }
    },
    "execution": "client",
    "riskTier": "hitl",
    "adapter": { "kind": "dom", "pathPrefixes": ["/pages"] },
    "resultSchema": { "type": "object", "properties": { "reads": { "type": "object" }, "completedSteps": { "type": "number" } } }
  },
  {
    "id": "wiki-example.publish-page",
    "featureIds": ["wiki-page"],
    "description": "点击发布按钮把页面对外发布。对外不可撤回：每次调用单独确认，授权不复用。",
    "params": { "type": "object", "additionalProperties": false, "required": ["task", "steps", "summary"],
      "properties": { "task": { "type": "string" }, "steps": { "type": "array", "minItems": 1, "maxItems": 1, "items": { "type": "object" } }, "summary": { "type": "string" } } },
    "execution": "client",
    "riskTier": "hitl",
    "hitlMode": "every-call",
    "adapter": { "kind": "dom", "pathPrefixes": ["/pages"] },
    "resultSchema": { "type": "object", "required": ["reads", "completedSteps"], "properties": { "reads": { "type": "object" }, "completedSteps": { "type": "number" } } }
  },
  {
    "id": "wiki-example.list-templates",
    "featureIds": ["wiki-page"],
    "description": "查询可用页面模板列表（平台级只读接口，服务端直调）。",
    "params": { "type": "object", "additionalProperties": false, "properties": {} },
    "execution": "server",
    "riskTier": "auto",
    "adapter": {
      "method": "GET",
      "urlTemplate": "https://wiki.example.com/api/templates",
      "headers": { "Authorization": "Bearer {{credential}}" },
      "credentialRef": "wikiPlatformKey"
    },
    "resultSchema": { "type": "object", "required": ["templates"], "properties": { "templates": { "type": "array" } } }
  }
]
```

工具配置的三个决策维度：

| 维度 | 取值 | 怎么选 |
|---|---|---|
| `execution` × adapter | `client`+http（用户 cookie 代发宿主 API）/ `client`+`kind:'dom'`（可见页面代操作）/ `server`（平台凭证直调只读接口） | 用户身份的写操作走 client；页面演示/表单走 dom；平台级只读走 server |
| `riskTier` | `auto` 直执 / `hitl` 须授权 / `forbidden` 恒拒 | 只读→auto；有副作用→hitl；危险动作→forbidden |
| `hitlMode` | 缺省（任务级：一任务一确认，跨工具复用）/ `every-call`（次次确认） | **对外不可撤回动作（发送/发布/删除）必须 every-call** |

**平台保留入参 `targetPage`**：dom 工具的 `params` MUST NOT 声明 `targetPage`——该键由平台在载入期统一增广为可选的任务组页面句柄（定向到组内其他页执行，adr-023），pack 自声明即语义劫持，启动期拒载。保留面仅此一名，其余参数名（含 `page`，如列表工具的页码）pack 自由使用。

### 3.3 feature.md / facts.md 要点

- `feature.md`（规则·守）：编号 `ZA-FEAT-NN`；讲清"该功能内 agent 怎么讲、什么必经工具、什么不做"。操作类功能记得写"先 `page_snapshot` 后动作、以页面证据复核成败"与 task 标题保持纪律。
- `facts.md`（事实）：页面构成、元素定位锚点（aria-label/文本/角色，勿依赖动态 id）、操作 API、站点组件库交互注意（如自绘下拉须点选项）。事实不足会直接导致讲解臆造与操作失误——参照 `examples/acceptance/packs/mail-126` 的写法；`examples/site-packs/packs/xianyu-seller` 是含 `automations` 的完整站点包样例。

## 4. 服务端环境变量全表

事实权威：`apps/server/src/main.ts`（读取与启动期校验）+ `packages/llm-port/src/index.ts`（LLM 上游六项惰性读取：base/model/key + 三层超时）。

### 必填（缺失拒启）

| 变量 | 作用 |
|---|---|
| `ZA_JWT_SECRET` | JWT 验签密钥（HS256），也是 `POST /v1/activation` 匿名激活的签发密钥 |
| `ZA_SIGNING_SECRET` | 服务端派生 Ed25519 私钥的一次性指令签名种子（U7）；插件仅经已鉴权 SSE 取得公钥 |
| `ZA_SNAPSHOT_ROOT` | 快照根目录（§2） |

### 网络与运行

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_HOST` | `127.0.0.1` | 监听地址；容器/对外部署设 `0.0.0.0`（对外暴露是有意决策，不做默认） |
| `ZA_PORT` | `8787` | 监听端口 |
| `ZA_CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` 响应头 |
| `ZA_JWT_ISS_ALLOWLIST` | `zen-agent-anon` | 外部签发方的 iss 白名单（逗号分隔）；匿名激活签发的 `zen-agent-anon` 由服务端在组装时无条件并入，覆盖或漏填此项都不会让服务端拒绝自己签发的令牌 |
| `ZA_MAX_TURN_ROUNDS` | `12` | agent loop 单回合轮数上限（跨站任务建议 40） |
| `ZA_MAX_CONSECUTIVE_FAILURES` | `3` | 同工具同因连续失败的止损上限：达此值即终结回合（`turn-complete.reason=consecutive-failures`），任一次成功清零；与 `ZA_MAX_TURN_ROUNDS` 并列，先到者生效。取值须为正整数，写错拒启 |
| `ZA_NAV_ATTACH_WAIT_MS` | `8000` | 非定向 `open_url` / `site_navigate` 成功后、回喂前等待落点页接入会话（组页面表中该地址的页、或导航后新出现/换址的页转 active/background；落点识别不绑请求地址等值，覆盖重定向）的上限毫秒；回喂 observation 附 `attached: true|false` 与相应指引。`0` = 不等待、只看当前表。取值须为非负整数，写错拒启 |

### LLM 上游（openai 兼容；调用时惰性读取）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_LLM_BASE_URL` | 无（缺失→对话降级"服务暂不可用"） | 上游 base URL |
| `ZA_LLM_MODEL` | 无 | 缺省模型 |
| `ZA_LLM_API_KEY` | 可选 | 上游 Bearer 密钥 |
| `ZA_LLM_CONTEXT_WINDOW` | `200000` | 历史压缩的上下文窗口 token 数 |
| `ZA_LLM_COMPRESS_THRESHOLD` | `0.6` | 压缩触发比例（(0,1]） |
| `ZA_LLM_TIMEOUT_MS` | 未设（不启用该层） | 单次上游调用（含流式读取全程）的绝对上限毫秒 |
| `ZA_LLM_FIRST_CHUNK_MS` | 未设（不启用该层） | 请求发出到收到首个响应字节的上限毫秒（上游挂起不再让回合永远转圈） |
| `ZA_LLM_IDLE_MS` | 未设（不启用该层） | 相邻响应字节之间的静默上限毫秒（每收到一片即重置） |

### 路径与数据（相对路径按进程 cwd 解析——容器内用绝对路径）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_SYSTEM_PROMPT_PATH` | `assets/system-prompt.md` | 稳定基座文件（只读） |
| `ZA_AUDIT_SINK` | `.za/events.jsonl` | 审计事件落点（append-only JSONL，落盘前脱敏，旁路 fail-open） |
| `ZA_SESSION_DIR` | `.za/sessions` | 会话持久化目录（`<sessionId>.jsonl`，TTL 清理，fail-open） |
| `ZA_SESSION_TTL_MS` | `3600000` | 会话闲置 TTL（1h） |
| `ZA_USER_CONFIG_DIR` | `.za/user-config` | L2 用户覆盖层存储目录（C7；按 subject 二级分段落一个 JSON 文件，临时文件 + 同目录 rename 原子写）。**容器部署必须外置到持久卷并给运行用户写权限**——落在镜像层时写入抛 `write-failed`，且 overlay 随容器重建丢失 |
| `ZA_APPLICATIONS_DIR` | `.za/applications` | 投递记录业务日志目录（`record_application`/`list_applications` 内建工具落点，按天 `<YYYY-MM-DD>.jsonl`）；record-only 旁路 fail-open，与审计事件流分立。同样须随容器持久化 |

### 凭证

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_CRED_<UPPER_SNAKE(ref)>` | 无 | server 通道凭证真值：`credentialRef` 驼峰转大写蛇形（`wikiPlatformKey → ZA_CRED_WIKI_PLATFORM_KEY`）；解析不到 → `credential-unresolved`，真值不落配置/日志/审计 |

用户令牌零配置：扩展首次运行以本地安装 id 向 `POST /v1/activation` 换取 24h 短时效令牌（adr-022），无 env 门控、无管理员签发环节。

### 客户端（扩展）配置

扩展经 `chrome.storage.local` 配置：`za.serverBaseUrl`（默认 `http://127.0.0.1:8787`）。
身份键 `za.installId`（安装 id）与 `za.anonToken`（激活所得令牌缓存）、
注入面缓存键 `za.siteDenylist` / `za.grantedOrigins`（均为 L2 的本机镜像，配置中心保存后同步）
由扩展自行维护，非用户直接配置项。

**注入模型（adr-027）**：产品清单不声明任何 `content_scripts`，插件默认不进入任何页面。
会话内能力由 background 在用户手势或服务端定向帧到达时逐次注入（轨一）；
周期自动化要求该 origin 已在配置中心授权，授权后按 origin 动态注册常驻脚本（轨二）。
旧的 `za.autoActivate` 已删除——它是纯客户端 origin 名单，与「准入判定不下放客户端」（U7）有张力。

## 5. 运行数据落点（`.za/`，已 gitignore）

| 路径 | 内容 | 语义 |
|---|---|---|
| `.za/events.jsonl` | 审计事件（C5 schema，脱敏后） | record-only 旁路；审计故障不进控制流（U6） |
| `.za/sessions/<id>.jsonl` | 会话事件流（claims 投影 + 对话历史） | append-only + 重启重放；含对话内容，按敏感数据对待 |
| `.za/user-config/<tenant 段>/<hostUserId 段>.json` | L2 用户覆盖层（C7 结构：个人规则/事实、只收紧限制、pack 配置与偏好、自建触发器） | 事实源、非缓存：原子写，读失败降级到 lastGood 并标 `stale`；路径段经 URL 编码 + `-<sha256 前 8 hex>` 后缀消歧，勿按 subject 原值猜路径；含用户内容，按敏感数据对待 |
| `.za/applications/<YYYY-MM-DD>.jsonl` | 投递记录业务日志（company/position/reason 等业务字段） | record-only 旁路 fail-open；与审计流分立（审计不收工具 params，U6） |

四者均随 `.za/` 落在进程 cwd 下（相对路径），容器部署 MUST 逐个映射到持久卷——尤其 `.za/user-config`：
它是 L2 的事实源而非缓存，丢失即用户配置丢失，写不进即 `PUT /v1/user-config` 失败。
