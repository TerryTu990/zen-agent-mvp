# ADR-027 · 按需注入双轨模型（权限最小化）

- 状态：已接受（2026-09-04，Terry 裁决）
- 相关：adr-011（可见页面代操作）、adr-012（会话=标签组）、adr-013（站点包与跨站任务组）、
  adr-014（L2 用户配置层）、adr-021（用户自建触发器）、adr-023（任务组多 tab 工作区）
- 取代：无（收紧既有注入模型）

## 1. 背景与裁决来源

`docs/research/2026-09-03-benchmark-mechanisms.md` 的四张对标卡
（PC-GOV-10 / G3-01 / G3-02 / G3-03）都提到同一件事：插件以静态 `content_scripts: ["<all_urls>"]`
在用户访问的**每一个**页面上启动内容脚本——包括网银、内网与任何与 zen 无关的站点。
`docs/reviews/2026-09-03-audit-r1.md` 的 A-SEC-08 早已把它登记为能力缺口，锚点是「P3 商店上架权限模型评审时」。

对标研究把这四张卡**全部裁为 reject**，理由是 R9 的真实张力：watch 自动化的
「读类零配置任意站点可用」完全建立在常驻注入之上，一刀切改按需注入会打断它。

Terry 裁决**提前做**（`docs/plans/2026-09-03-terry-rulings-and-next-round.md` R-8），
但技术形态必须按 G3-02 的**双轨模型**，否则 R9 被破。裁决权在 Terry；本 ADR 记录这一提前的来源、
双轨的理由、R9 的代价，以及与 N2 站点黑名单的合流关系。

## 2. 决策

引入不变量 **IN**：

> content 脚本只出现在两类页面上：(a) 用户在本会话里对其发起了动作的页
> （图标 / 右键 / 快捷动作 / 服务端下发的定向帧）；(b) 用户为 watch 自动化显式授权过 origin 的页。
> 其余任何页面上，`document` 无 zen 注入痕迹。**注入面 = 授权集 − 站点黑名单。**

清单层面：删除 `content_scripts`（不再有任何静态注入面），`permissions` 增 `scripting`，
`host_permissions: ["<all_urls>"]` 降为 `optional_host_permissions`，`activeTab` 保留为手势注入的基础。

### 轨一 · 会话内按需注入

background 在用户手势（工具栏图标 / 右键兜底项 / 右键快捷提问）或**服务端下行定向帧到达**时，
用 `page-handles.ts` 的句柄→tabId 解析目标 tab，`chrome.scripting.executeScript({target:{tabId}, files:['dist/content.js']})`，
随后走既有 port 通道。注入与激活同出一口（`sendActivate`），故组内导航补发、拖 tab 入已映射组、
navigate 代执行开页这三条既有激活路径自动继承按需注入。`content.ts` 以 `window.__zaInjected` 守卫幂等，
容忍重复注入。注入点必须过站点黑名单判定（黑名单优先）。

定向帧到达时目标页尚未注入是按需注入模型下的常态：该形态先注入、等目标页端口接入再投递，
等待上限 `CONTENT_ATTACH_TIMEOUT_MS`。这段窗口里停止手势与站点拉黑都可能发生，故**投递重新排回
落页闸门**（`landOnPage`），停止态与黑名单恒在副作用发生的那一刻判、而非取址那一刻判过就一路放行
（不变量 ST 第二判、不变量 SD 第二句）。该路径在 `invariant-stop.test.ts` 的路径枚举里按帧种类各占一条。

### 轨二 · watch 自动化的显式 origin 授权

配置中心提供「授权此站点」：调 `chrome.permissions.request({origins:[origin + '/*']})`，
授权成功后 `chrome.scripting.registerContentScripts` 只对该 origin 动态注册（载荷恒为插件自带
`dist/content.js`），撤销授权即 `unregisterContentScripts`。注册 id 由 origin 确定性派生，
注册前按 id 注销即幂等，「谁注册了什么」可枚举、可对称撤销。

origin 授权集是**服务端 L2 的投影**（`user-overlay` 全局作用域 `grantedOrigins[]`）。
本地 `chrome.permissions` 状态与 L2 投影不一致时以**交集**为准。

配置中心**显示的**授权态同取交集：打开时以 `chrome.permissions.contains` 逐条对账 L2 声明，
本机缺失的条目就地标注「浏览器已撤销访问」并给出「重新授权」（直接再申请，不必先撤销），
自动化页的「站点未授权」判定与之同口径。浏览器侧的撤销（在 `chrome://extensions` 把站点访问
改回「点击时」）不通知扩展页，只认 L2 会把一个自动化其实跑不起来的站点显示成「已授权」，
而那正是注册面已按交集撤销注册、到点静默跳过的状态。

## 3. 权衡与不变量核对

**为什么必须双轨而不能只做轨一**：`activeTab` / `executeScript` 需要用户手势或已有 host 权限，
而 `auto-scan` 的周期唤醒是无手势触发的。只做轨一会让 watch 自动化在任何站点上都跑不起来。

**为什么授权集取交集而不是并集**：这是方向性约束。本机 `chrome.permissions` 多出来的 origin
不构成治理放行——治理终判恒在服务端 compose（U7）；L2 多出来的 origin 也拿不到浏览器授权，
写进去只是一条永远不生效的声明。取交集使两侧任一收紧都立即生效。

**U7（决策永远服务端 fail-closed）——不构成违反**：按需注入把「何时把执行器放进页面」从静态清单
挪到运行期，客户端不新增任何分级/HITL 判定。前提是授权集必须是服务端 L2 的投影——旧的
`za.autoActivate` 是纯客户端 origin 名单，若把注入面绑在它上面，就把「哪些站点允许 agent 存在」
这条准入判定固化在客户端。故 `za.autoActivate` 一并删除。

**R1 / ZA-C-AGENT-04（L2 只收紧）——不构成违反，靠 schema 分离**：`grantedOrigins` 是**准入维度**，
授权只决定 agent 在该站点是否存在，MUST NOT 改变任何工具的 riskTier、工具面成员或 HITL 判定。
它与 `restrictions` 物理分离，二者正交。授权后可用的工具集恒等于 pack 已声明的集合与 L2 收紧后的终值。

**U5（客户端五能力契约不随形态变）——不构成违反**：本改造只换「谁在何时把执行器放进页面」，
C3 上下行帧族（context-report / snapshot-request / domStep / exec-instruction）与五能力语义一字不动；
SDK / 浏览器壳形态各自决定注入方式，恰恰是 U5 想要的形态无关性。

**R2 / ZA-C-AGENT-03（pack 纯数据）——不构成违反**：注入与注册的载荷恒为插件自带的 `dist/content.js`，
pack 与 L2 都无从携带可执行代码。本 ADR MUST NOT 被读成「允许 pack 携带注入代码」。

**与 N2 站点黑名单的合流**：黑名单命中即两轨都不注入——轨一在 `sendActivate` 的既有黑名单闸门前退出，
轨二在注册面派生时把命中 origin 从目标集合中剔除并注销已有注册项。黑名单优先于授权，
故用户「不让 Zen 出现在这个站点」的意愿不会被一次授权覆盖。

## 4. 接受的代价

**R9 的限定**：watch 自动化在**未授权 origin 上不再零配置可用**——这是裁决明确接受的代价。
配置中心的自动化页与每一条未授权的触发器行都如实写明「自动化需先授权站点」，并就地给出授权入口。

**会话跨导航的连续性依赖授权**：`activeTab` 在标签页导航到新文档后被浏览器收回，
故只做手势注入时，一次手势的能力止于当前文档。跨导航、后台成员页与定向操作要求该 origin 已授权。
配置中心「全局设置 → 已授权常驻的站点」是这条能力的用户可见入口。

**注入失败不产生任何客户端信号**：缺 host 权限或页面本身不可注入时，background 就此收手——
不发 `activate`，落到该页的定向帧即丢帧、不改投他页；客户端**不单独提示**。
这类失败对用户不可观察，其后果（该页能力缺席）由服务端在 silent 页上的叙述兜住，
客户端不为一件自己判不准的事造 UI 面。

**撤销授权与拉黑不回收已注入页**：撤销授权只注销动态注册面，拉黑只让此后不再注入——
两者都不把已在页内的 content 撤出去，该页需重载才彻底退出。其间上行闸门照挡：
命中站点的页不激活会话、不上报页面上下文、不进任务组页面清单。
本 ADR 不引入 detach 语义（主动把执行器从已注入页里收回）。

**E2E 覆盖的残余面**：浏览器工具栏手势与 `chrome.permissions.request` 的授权气泡都是浏览器 UI，
Playwright 点不到。E2E 以两条等价前置替代（见 `scripts/e2e/extension-fixture.mjs`）：
以插件自身的公开 chrome API 复现图标点击的可观察产物；以「用户已授权站点访问」的清单装载。
**被测的仍是注入时机**——产品清单不含任何 `content_scripts`，页面上有没有 content 脚本完全由
background 的注入决定，与权限是否已授予无关。`activeTab` 手势授权路径本身不在自动化覆盖内。

## 5. 验收

- 不变量 IN 以「注入触发源」为单位枚举验收（`apps/extension/test/invariant-injection.test.ts`）：
  轨一每一种触发源各一条正例、「没有触发源」的情形单独成组、黑名单优先另成一组。
- E2E 全家族全绿，并新增一条断言「未打开面板的第三方页面上 `document` 无 zen 注入痕迹」
  （两条独立证据：扩展侧向该 tab 发消息无接收方；页面侧 document 上无 za- 命名节点）。
