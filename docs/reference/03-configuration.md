# 配置参考（站点包 + 环境变量）

> 参考型文档：结构、字段、示例的权威导览。schema 事实权威在 `packages/contracts/schemas/`（registry / pack / tool-definition），env 读取权威在 `apps/server/src/main.ts`；本文与之冲突时以代码为准。
> 快照不可变纪律（U4）：改配置 = 发新版本（升 version + 替换目录内容），运行时永不就地改写。

## 1. 配置三层总览

| 层 | 位置 | 角色 |
|---|---|---|
| 快照根（站点包） | `ZA_SNAPSHOT_ROOT` 指向的目录 | registry + packs 两级站点配置；当前验收用 `examples/acceptance`，生产预留 `assets/`（首个生产功能落地时补 manifest） |
| 稳定基座 | `ZA_SYSTEM_PROMPT_PATH`（默认 `assets/system-prompt.md`） | 跨功能不变的 agent 治理基座（ZA-SYS-*） |
| 服务端 env | `ZA_*` 环境变量 | 端口/密钥/LLM 上游/落盘路径等运行参数（§4 全表） |

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
            └── scenarios.json        #   讲解/引导/工具/HITL/拒答 五维度
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
6. 扩展 manifest.json 的 `host_permissions`/`content_scripts.matches` 加该 origin（客户端能注入的前提）

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
| `summary` | ⬜ | 一句话站点用途——进"已安装站点索引"（跨站发现层），缺省回退 packId |
| `site.origin` | ✅ | 激活围栏：`scheme://host[:port]` 精确匹配（无路径无尾斜杠）；同时是 http/server 工具请求与 navigate 目标的 origin 围栏 |
| `site.locations` | ⬜ | 路径前缀数组（最长前缀胜出）；省略=整站 `["/"]` |
| `tenant` | ⬜ | per-origin 身份路由键：`claims.tenant` 匹配它时会话记住该 origin 的宿主身份；单租户/无宿主身份诉求可省 |
| `featureIdRules` | ✅ | pack 激活后的 url→featureId 有序映射（ECMAScript 正则，首个命中生效） |
| `features` | ⬜ | 功能闭单；声明则启动校验目录齐备（缺失拒载），省略则按目录扫描 |

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

### 3.3 feature.md / facts.md 要点

- `feature.md`（规则·守）：编号 `ZA-FEAT-NN`；讲清"该功能内 agent 怎么讲、什么必经工具、什么不做"。操作类功能记得写"先 `page_snapshot` 后动作、以页面证据复核成败"与 task 标题保持纪律。
- `facts.md`（事实）：页面构成、元素定位锚点（aria-label/文本/角色，勿依赖动态 id）、操作 API、站点组件库交互注意（如自绘下拉须点选项）。事实不足会直接导致讲解臆造与操作失误——参照 `examples/acceptance/packs/mail-126` 的写法。

## 4. 服务端环境变量全表

事实权威：`apps/server/src/main.ts`（读取与校验）+ `packages/llm-port/src/index.ts`（LLM 三项惰性读取）。

### 必填（缺失拒启）

| 变量 | 作用 |
|---|---|
| `ZA_JWT_SECRET` | JWT 验签密钥（HS256），也是 demo-token 签发密钥 |
| `ZA_SIGNING_SECRET` | 代执行指令一次性签名密钥（U7） |
| `ZA_SNAPSHOT_ROOT` | 快照根目录（§2） |

### 网络与运行

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_HOST` | `127.0.0.1` | 监听地址；容器/对外部署设 `0.0.0.0`（对外暴露是有意决策，不做默认） |
| `ZA_PORT` | `8787` | 监听端口 |
| `ZA_CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` 响应头 |
| `ZA_JWT_ISS_ALLOWLIST` | `zen-agent-demo` | 验签 iss 白名单（逗号分隔） |
| `ZA_MAX_TURN_ROUNDS` | `12` | agent loop 单回合轮数上限（跨站任务建议 40） |

### LLM 上游（openai 兼容；调用时惰性读取）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_LLM_BASE_URL` | 无（缺失→对话降级"服务暂不可用"） | 上游 base URL |
| `ZA_LLM_MODEL` | 无 | 缺省模型 |
| `ZA_LLM_API_KEY` | 可选 | 上游 Bearer 密钥 |
| `ZA_LLM_CONTEXT_WINDOW` | `200000` | 历史压缩的上下文窗口 token 数 |
| `ZA_LLM_COMPRESS_THRESHOLD` | `0.6` | 压缩触发比例（(0,1]） |

### 路径与数据（相对路径按进程 cwd 解析——容器内用绝对路径）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_SYSTEM_PROMPT_PATH` | `assets/system-prompt.md` | 稳定基座文件（只读） |
| `ZA_AUDIT_SINK` | `.za/events.jsonl` | 审计事件落点（append-only JSONL，落盘前脱敏，旁路 fail-open） |
| `ZA_SESSION_DIR` | `.za/sessions` | 会话持久化目录（`<sessionId>.jsonl`，TTL 清理，fail-open） |
| `ZA_SESSION_TTL_MS` | `3600000` | 会话闲置 TTL（1h） |

### 凭证与演示

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZA_CRED_<UPPER_SNAKE(ref)>` | 无 | server 通道凭证真值：`credentialRef` 驼峰转大写蛇形（`wikiPlatformKey → ZA_CRED_WIKI_PLATFORM_KEY`）；解析不到 → `credential-unresolved`，真值不落配置/日志/审计 |
| `ZA_DEMO_TOKEN_ENABLED` | 关（`==="1"` 才开） | `/demo-token` 自签端点（仅本机开发/E2E；生产保持关闭） |
| `ZA_JWT_ISS` | `zen-agent-demo` | demo-token 签发的 iss |

生产的用户令牌不走 demo-token：由管理员经 `release/sign-token.sh` 在服务器容器内签发（iss=`zen-agent`，须列入 `ZA_JWT_ISS_ALLOWLIST`），用户在扩展选项页配置。

### 客户端（扩展）配置

扩展经 `chrome.storage.local` 配置：`za.token`（平台 JWT）、`za.serverBaseUrl`（默认 `http://127.0.0.1:8787`）、`za.autoActivate`（origin 数组，命中即自动挂面板——**仅验收自动化用**，产品默认点图标激活）。

## 5. 运行数据落点（`.za/`，已 gitignore）

| 路径 | 内容 | 语义 |
|---|---|---|
| `.za/events.jsonl` | 审计事件（C5 schema，脱敏后） | record-only 旁路；审计故障不进控制流（U6） |
| `.za/sessions/<id>.jsonl` | 会话事件流（claims 投影 + 对话历史） | append-only + 重启重放；含对话内容，按敏感数据对待 |
