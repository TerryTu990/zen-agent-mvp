# assets/ — 生产配置快照根（C4 布局）

本目录是运行期装配制品的生产快照根：`system-prompt.md`（跨功能稳定基座）+
`features/<id>/` 三件套 + `skills/<fn>/SKILL.md` + 根 `manifest.json`。
布局与消费方式见 `features/README.md` 与 `skills/README.md`。

## 根 manifest.json 暂缺说明

`config-snapshot` 契约要求 `featureIdRules` 至少 1 条，且装配引擎对每条规则指向的
featureId 做 fail-closed 校验（功能目录三件套必须齐备，否则整快照拒载）。当前
`features/` 尚无实体功能，任何 manifest 都必然指向不存在的功能而被拒载，故不放置
占位 manifest（禁造假配置）。

- 补齐锚点：首个生产功能配置（`features/<id>/` 三件套）落地时，同步补
  `manifest.json{version, featureIdRules, features}`。
- 在此之前，开发与 E2E 以 `examples/host-demo/config/` 为快照根（server 启动参数指定）。
