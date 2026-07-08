# job-detail 功能事实

> ⚠ 待核：以下页面路径、DOM 锚点与接口地址均为雏形占位，须在真实 zhipin 登录态页面核对后填实
> （触发锚点：接入真实 zhipin 页面做首轮评测时）。未核实前不得当作已知事实向用户陈述。

## 页面构成

- 职位详情页（路径约 `⚠待核`，雏形 `/job_detail/...`）：职位名 / 薪资区间 / 职位职责 / 任职要求 /
  工作地点 / 公司信息 / "立即沟通"按钮（可能还有"投递简历/正式申请"入口）。

## 可读取用于匹配评估的字段

- 职位职责、任职要求（硬性条件如经验年限、学历、英语、技能栈、年龄）、工作地点、薪资区间、公司规模/性质。
- 这些是 `skills/jd-match` 硬淘汰（H1-H6）与软评分（S1-S4）、回复概率（R1-R3）判定的完整输入。

## 交互锚点

- ⚠ 待核：任职要求是否折叠、公司信息是否异步加载。
- ⚠ 待核："立即沟通"按钮文案/aria-label/角色与 ref 结构；打招呼（`job-detail.greet`）click 步骤 ref 取自最近一次 `page_snapshot`，不写死选择器。
- ⚠ 待核：是否存在独立"投递简历/正式申请"入口——正式投递走 `job-detail.formal-apply`（every-call），与"立即沟通"打招呼区分。
- ⚠ 待核：点"立即沟通"后是原地保留还是跳转聊天页——续作回列表用内建 `site_navigate` 时以实际列表页 URL 为准。

## 服务端薪资参考接口（salary-benchmark）

- ⚠ 待核：`job-detail.salary-benchmark` 的真实第三方薪资接口地址（tools.json urlTemplate 暂占位绝对 URL）、
  查询参数与返回结构；凭证经 `credentialRef: zhipinSalaryKey` 运行时注入（对应 env `ZA_CRED_ZHIPIN_SALARY_KEY`），真值不入配置。
