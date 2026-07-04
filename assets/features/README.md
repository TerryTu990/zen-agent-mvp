# assets/features/ — 功能配置目录（C4 快照布局）

每个功能一个目录，目录名即 `featureId`（文法 `^[a-z][a-z0-9-]*$`，与
`manifest.json` 的 `featureIdRules[].featureId` 及工具定义的 `featureIds[]` 三处一致）：

```
features/<featureId>/
├── feature.md    # 功能规则：agent 在该功能内怎么讲、怎么引导、哪些事不做
├── facts.md      # 功能事实：页面/字段/流程/元素锚点等可陈述事实（ZA-SYS-04 的事实源）
└── tools.json    # 工具定义数组，元素契约 = packages/contracts/schemas/tool-definition.schema.json
```

快照根的 `manifest.json`（契约 = `config-snapshot.schema.json`）声明版本与 url→featureId
映射规则；快照整体版本化不可变（U4），MVP 由 git 文件直接充当快照，标准版配置中心产出
同构布局、装配器零改动。

完整示例见 `examples/host-demo/config/`（后续开发与评测的锚定样例）。
