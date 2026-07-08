# job-search 功能事实

> 部分锚点已于真实登录态（geek 端·苏州）核实；仍标 `⚠待核` 者未经真实交互验证，不得当作已知事实向用户陈述。

## 页面构成

- geek（求职者）端职位搜索/列表页，真实路径 `https://www.zhipin.com/web/geek/jobs`（**非** `/web/geek/job`）：
  顶部搜索关键词框（`input`，placeholder「搜索职位、公司」）+ 城市/求职类型/薪资待遇/工作经验/学历要求/公司行业/公司规模 筛选条 + 职位卡片列表。
- 职位卡片容器 `.job-card-wrap`（当前激活项带 `.active`；一页约 45 张）；卡片含：职位名（`[class*="job-name"]`）/
  薪资区间（`[class*="salary"]`）/ 公司名（`[class*="company"]`）/ 城市·经验·学历标签（`[class*="tag"]`，约 6 个）/「立即沟通」入口。
- 列表页右侧会内嵌当前选中职位的详情预览（含「职位描述」「工作地址」BOSS 活跃状态），非独立详情页。

## 筛选交互

- 筛选控件为**自定义下拉，非原生 `<select>`**（页面 `select` 元素数为 0）：筛选条容器 `.filter-condition` /
  `.c-filter-condition`；每个下拉触发器 `.condition-filter-select`（文案如「求职类型」「薪资待遇」），
  展开的选项面板 `.filter-select-dropdown`（如「不限/全职/兼职」）。走 page-operate 时用 **click 命中选项行，勿用 fill**。
- 城市：当前城市标签 `.city-label.active` / `.cur-city-label`（如「苏州」）。
- ⚠ 待核：薪资/经验是否为级联或滑块;若为滑块，以 `page_snapshot` 暴露的可交互 ref 为准。

## "立即沟通"按钮（打招呼锚点）

- 卡片上按钮**文案确为「立即沟通」**（激活/hover 卡片上可见）；`job-search.greet` 的 click 步骤 ref 一律取自最近一次
  `page_snapshot`，不写死选择器。
- ⚠ 待核：点「立即沟通」后是否跳转聊天页、跳转后 URL 形态——续作回列表用内建 `site_navigate` 时以实际列表页 URL 为准
  （该动作对外不可撤回，仅在授权后由 greet 执行，故此项留到打招呼阶段核实）。

## 只读查职位接口（query-jobs）

- ⚠ 待核：`job-search.query-jobs` 的真实职位查询接口地址（tools.json 中 urlTemplate 暂占位 `/api/...` 相对路径）、
  查询参数名（关键词/城市/薪资/分页）与返回 JSON 结构。未核实前只依据实际返回字段，不臆造。

## 读取

- 用 page-operate 的 `read` 步骤（带 `name` 键）采集职位卡片文本（职位名/薪资/公司/标签），回报给用户用于匹配判断，
  不臆造卡片未显示的信息。

## 已知：自动化导航限制

- 直接 `goto` 或点导航栏「简历」链接（href 确为 `/web/geek/resume`）在自动化会话下会被弹回 `/web/geek/jobs`——
  zhipin 对自动化跨页导航有拦截。简历页锚点需由用户在页面手动进入后再采集。
