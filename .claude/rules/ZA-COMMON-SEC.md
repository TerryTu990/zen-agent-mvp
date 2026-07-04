# ZA-SEC — 安全红线（开发期）

> **全局常驻**：secret 与凭证在任何读写/日志/提交点都可能触发，故不加 paths。
> 编号 `ZA-C-SEC-<NN><级>`，强制级语义见 `ZA-COMMON-META.md` 头。

---

## ZA-C-SEC-01*  secret 永不入仓/Context/日志  【hook 强制：za-secret-guard + za-bash-guard 暂存扫描】
**secret/凭证值 MUST NOT 出现在仓库、Context、trace、`.za/events.jsonl` 与任何日志；密钥走 `.env` / `credentials.local.json`（gitignore 强制）。**
- LLM API key 走环境变量、由 llm-port 托管，MUST NOT 落仓。
- `.za/events.jsonl` 落盘前对已知 secret 值脱敏（审计事件契约 C5 要求）。
- 判定：secret 值进入对话/配置/用例/mock/日志/提交 → 触发，停止，脱敏并撤回。
- 残余面：hook 只扫工具的字面待写内容；经解释器拼接/编码（`node -e`/`python -c`/`base64`）间接落值属已知残余面，仍须自守。

> 反例：把真实 API key 粘进某测试 fixture 提交 → secret 入仓 → 违反 SEC-01；
> 正解：走 `.env`，代码只读环境变量。

---

## ZA-C-SEC-02*  凭证一律运行时注入不写值  【hook 强制：za-secret-guard】
**配置（`assets/features/<id>/tools.json` adapter 模板等）/用例/mock 内凭证 MUST NOT 写真值，一律运行时注入：LLM 密钥经环境变量由 llm-port 托管；宿主身份只经短期 JWT（C2 claims）与用户页面会话透传——平台零特权、不存用户凭证。**
- 判定：配置/用例/mock 出现凭证明文值 → 触发，改为运行时注入。

> 反例：tools.json 的 adapter 请求模板写死 `Authorization: Bearer eyJ...` 真值 → 凭证明文入制品 → 违反 SEC-02；
> 正解：身份由插件在页面环境以用户会话携带，平台制品不出现凭证值。

---

## ZA-C-SEC-03*  凭证读禁区  【hook 强制：za-secret-guard(Bash/Read/Grep)】
**凭证文件闭集（`credentials.local.json` / `.env` 含 `.env.*` / `.git/config`）禁 read/bash/grep 访问。**
- za-secret-guard 对 Bash 读命令与 Read/Grep 工具的闭集路径命中即拦。
- 判定：开发期对凭证闭集做 read/bash/grep 取值 → 触发，停止。

> 残余面：hook 拦的是字面命令/路径；经解释器拼接或编码（`node -e`/`python -c`/`base64`）间接读取属已知残余面，仍须自守。

---

## ZA-C-SEC-04*  错误与日志不泄敏感信息
**对外错误消息/SSE 帧/审计事件 MUST NOT 回显 secret 值、JWT 原文、用户会话凭证或敏感栈细节；只暴露可定位、不可利用的最小信息。**
- 面向客户端的 error、HITL/tool 卡片内容不含密钥值与 token 原文；诊断细节落本地日志（且按 SEC-01 脱敏），不进对外响应。
- 凭证/secret 相关失败以键名/引用名报错（如"LLM 密钥解析失败"），不带值。
- 判定：error/响应/事件把 secret 值或 token 原文回显给调用方 → 触发，脱敏后只留最小可定位信息。

> 反例：toolgate 身份校验失败把完整 JWT 拼进回喂 observation → token 经错误路径进 agent 上下文与审计流 → 违反 SEC-04；
> 正解：observation 只写"身份校验失败（exp 过期）"。
