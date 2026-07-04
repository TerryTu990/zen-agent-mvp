# assets/skills/ — 运行期 skills（装配期按需注入）

每个 skill 一个目录：

```
skills/<fn>/
└── SKILL.md    # 该能力的操作方法：给 agent 的步骤化指引与可照抄示例
```

skill 是"用"的一面（怎么做好某类事），与 system-prompt/feature 规则"守"的一面分立；
由装配器在 compose 时按功能配置选择注入，注入构成经 describeInjection 可自省。
MVP 骨架期暂无 skill，首个 skill 随 M1 讲解闭环按真实需要引入。
