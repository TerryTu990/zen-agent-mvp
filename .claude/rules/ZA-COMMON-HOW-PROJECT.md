---
paths:
  - "**/*.ts"
  - "**/*.mts"
---

# ZA-HOW-PROJECT — 编码规范·TS/ESM 特定层（开发期）

> 本文件是 `ZA-COMMON-HOW.md` 同分区子文件（HOW 空间续号 09–13），按 paths 加载：操作 `**/*.ts` / `**/*.mts` 时进上下文。
> 仅收 zen-agent-mvp 的语言/框架/工具链特定规范；普适元准则见 `ZA-COMMON-HOW.md`。
> 事实权威以 `README.md`（工具链与版本）+ `tsconfig.base.json` + `pnpm-workspace.yaml` 为准。

---

## ZA-C-HOW-09*  全 ESM
**全仓纯 ESM（`module/moduleResolution: NodeNext`），禁 CommonJS。**
- 用 `import`/`export`，禁 `require`/`module.exports`。
- 判定：新增 CommonJS 写法或非 NodeNext 解析假设 → 触发，改回 ESM。

> 反例：在某包里写 `const x = require('...')` → 破坏纯 ESM 基线 → 违反 HOW-09。

---

## ZA-C-HOW-10*  严格 TS 基线不得放宽
**`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 是 `tsconfig.base.json` 基线，禁在子包放宽。**
- 不得在子包 tsconfig 关闭上述任一项来"绕过"类型错误。
- 判定：子包 tsconfig 覆盖关闭严格项，或用 `as any`/`@ts-ignore` 规避而非修类型 → 触发，改回严格。

> 反例：某文件类型难搞就在包级 tsconfig 关 `noUncheckedIndexedAccess` → 放宽基线 → 违反 HOW-10。

---

## ZA-C-HOW-11*  catalog 统一版本
**跨包共享依赖统一入 `pnpm-workspace.yaml` catalog、以 `catalog:` 引用，禁各包分散钉版。**
- 新增跨包共享依赖应先入 catalog 再 `catalog:` 引用；当前清单以 `pnpm-workspace.yaml` 为准。
- 判定：某包 package.json 直接钉 catalog 已管理依赖的具体版本号 → 触发，改回 `catalog:`。

> 反例：在 apps/server 里把 zod 钉成具体版本号而非 `catalog:` → 版本分散漂移 → 违反 HOW-11。

---

## ZA-C-HOW-12~  测试串行
**`pnpm test` 走 `--workspace-concurrency=1` 串行（vitest），避免 fsevents 抖动。**
- 跑全量测试用根 `pnpm test`（已配串行）；偏离（并行跑）须说明理由并自担抖动风险。

---

## ZA-C-HOW-13~  风格匹配周边
**新代码命名/import 解构惯例匹配周边既有风格。**
- 可解构的 import 尽量解构（如 `import { foo } from 'bar'`）；命名随同目录既有惯例。
- 偏离须有理由。
