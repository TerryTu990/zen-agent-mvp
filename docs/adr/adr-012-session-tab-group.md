# adr-012: 会话绑定同宿主源标签页组，组内单 SSE + 帧路由

## 状态

已接受（2026-07-05，Terry 裁定）

## 背景

多标签页各自注入 agent；sessionId 曾以全局键存 `chrome.storage.local`，导致多页共享一会话且**各挂一条 SSE**：服务端广播使签名执行指令被多页重复执行（副作用×2）、HITL 卡片多处弹出竞态、对话镜像交错、context-report 后写覆盖污染装配上下文。claude-in-chrome 以 tab group 显式绑定"会话↔标签页组"；MVP 也存在一会话跨多页面的真实场景（同一工作流开多页）。

## 决策

- **会话粒度 = 同宿主源标签页组**：以页面 origin 为组键，一组一会话；sessionId 按 origin 存 `chrome.storage.session`（跨 SW 重启存活、随浏览器关闭清除）。
- **插件 background 每组单桥单 SSE**：组内成员（标签页端口）注册进成员表；下行帧按类型路由——会话帧（text-delta / tool-card / status）**全员镜像**；HITL / exec-instruction / guide-action **仅活跃页**（最近可见的成员，content script 于 visibilitychange 时重新 announce）。
- **上行**：user-message 任一成员可发，background 回显给其余成员（user-echo）保持对话镜像一致；context-report 以活跃页为准驱动装配。
- **"组"封装在插件形态内**：契约与服务端零改动，不引入 tabId 等形态特有字段（U5）。

## 理由

- 单 SSE + 显式路由**结构性消灭**重复执行：exec 指令只到达一个成员，而非靠去重兜底。
- HITL 只弹在用户正注视的页面，裁决无竞态。
- 活跃页跟随用户视线，装配上下文不被后台页覆盖。
- 活跃页追踪恰是 adr-011 DOM 代操作的前提（agent 操作的目标页 = 活跃页）。

## 被否方案

- **一页一会话**：改动最小（约 15 行），但违背"一会话跨多页"的真实场景，且每页独立对话割裂工作流。
- **tabId 进契约/服务端路由**：形态差异外泄进契约，违 U5。

## 后果

- 正：四类多页问题一次性消除；服务端每会话只剩一个订阅者，广播语义退化为单播但接口不变。
- 负：background 从"每页一桥"重构为"每组一桥"，路由策略成为插件内新的复杂点（以纯函数模块承载，可单测）。
- 锚点：跨窗口分组、一浏览器多会话并行（真正的 tab-group 管理 UI）——出现多会话并行的真实场景时评估。
