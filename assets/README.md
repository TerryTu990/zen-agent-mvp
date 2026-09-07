# assets/ — Zen Agent 生产配置快照根

本目录是运行期装配制品的生产快照根，也是运行期治理的 SSOT（`ZA-C-AGENT-01`）：
`system-prompt.md`（跨站点稳定基座，规则编号 `ZA-SYS-NN`）+ 根 `manifest.json`（registry）+
`packs/<packId>/`（站点包：`pack.json` + `features/<id>/{feature.md, facts.md, tools.json}` + `skills/<fn>/SKILL.md` + `eval/`）。

## 当前快照事实（2026-09-03）

- registry（`manifest.json` 2.3.0）**只登记 `generic-web`** 一个 pack；它以 `generic: true` 声明为兜底包，
  不参与 origin/location 匹配——无站点 pack 命中且页面有 http(s) origin 时**无条件激活**（无部署级准入名单），
  激活时以活跃页 origin 运行时绑定。用户可用 L2 站点黑名单（`siteDenylist`）按站点关停，终判在服务端 compose。
- 站点包 `xianyu-seller` / `yinxiang` 已于 2026-09-03 下线到 `examples/site-packs/`，不在生产快照内；
  重新上架＝把 pack 目录放回 `packs/` 并在 `manifest.json` 登记（版本须与 `pack.json` 一致，否则拒载）。
- `examples/acceptance/packs/generic-web` 是本目录同名包的**逐字节镜像**，由 `apps/server/test/generic-pack-mirror.test.ts` 强校验；
  改本目录的 generic-web 必须同步改该镜像，否则测试红。

## 发布纪律

- 快照内容变更必须同时提升 registry 与对应 pack 的版本（U4：快照不可变，改配置＝发新版本）。
- 改本目录任何文件后 MUST 跑 `pnpm eval`（≥3 跑，`ZA-C-EVAL-01/02`）；基座与 registry 改动跑全量，单 pack 改动跑该 packId 子集。
- **基座与 feature 的部分字面被确定性 mock LLM 当作探针**（`scripts/mock-llm/server.mjs`）：改措辞前先 grep 该文件与
  `apps/server/test/server.test.ts`、`scripts/e2e/run-g6-explain-pack.mjs`，保留探针字面或同步改齐；禁靠改探针把红评测改绿。
- 生产按版本目录上传、完整拒载校验后切换；禁止覆盖活动快照目录。
- pack 制品 MUST 纯数据（`ZA-C-AGENT-03`）：无 js/mjs、无内联脚本、无远程代码引用。
