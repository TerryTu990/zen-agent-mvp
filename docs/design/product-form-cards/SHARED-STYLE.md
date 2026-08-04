# Zen Agent 设计稿共享规范（所有卡片必须遵守）

## 文件约定
- 每个设计稿是一个完全自包含的 HTML 文件：内联 CSS，无外部字体/图片/JS/CDN。
- 文件第一行必须是 dsCard 注释（按各卡片规格填写）：
  `<!-- @dsCard name="…" subtitle="…" group="…" viewport="宽x高" -->`
- 全部 UI 文案用中文（保留必要英文术语如 pack、BYOK）。
- 只做浅色主题。页面背景用 --bg，卡面用 --surface。
- 内容必须具体真实（真实的示例文案、数据、按钮），禁止 lorem ipsum 或「示例文本」占位。

## 设计令牌（每个文件把这段 CSS 原样内联进 <style>，再写自己的样式）

```css
:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --ink: #1a1d21;
  --ink-2: #4b5563;
  --muted: #8a919c;
  --line: #e5e7eb;
  --line-strong: #d1d5db;
  --brand: #0f766e;        /* 主色：禅青 */
  --brand-soft: #e6f2f1;   /* 主色浅底 */
  --auto: #16803c;  --auto-bg: #e8f5ec;    /* 风险档 auto */
  --hitl: #b45309;  --hitl-bg: #fdf3e3;    /* 风险档 hitl */
  --off:  #b91c1c;  --off-bg:  #fdeaea;    /* forbidden / 已关闭 */
  --info-bg: #eef4fd; --info: #1d4ed8;
  --radius: 12px; --radius-sm: 8px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  background: var(--bg); color: var(--ink);
  font-size: 13px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
```

## 通用视觉规则
- 卡面：background var(--surface); border 1px solid var(--line); border-radius var(--radius)。不用重投影，最多 `box-shadow: 0 1px 2px rgba(0,0,0,.04)`。
- 徽章（badge）：11px、padding 2px 8px、圆角 999px、用对应色 + 浅底（如 riskTier 三档用 --auto/--hitl/--off 配对底色）。
- 主按钮：background var(--brand)、白字、圆角 8px、padding 6px 14px。次按钮：白底 1px var(--line-strong) 边框。危险按钮：白底红字红边。
- 标题层级：面板标题 15px/600；分区标题 13px/600；正文 13px；辅助 12px --muted。
- 侧边栏类卡片（group=侧边栏/透明性）：视口宽 380，body 直接就是面板内容（宽度 100%），高度按规格。
- 配置中心类卡片（group=配置中心）：视口宽 960，页面左侧 200px 固定导航（列出四个配置分区：站点包 / 个人定制 / 自动化 / 全局设置，当前项高亮 --brand-soft 底 + --brand 字），右侧为该卡片的内容区。四张配置卡都用同一导航结构，只是高亮项不同。
- 每张卡底部不留版权/水印/无关文字。

## 产品口径（文案必须与此一致）
- 产品名：Zen Agent。定位：可被用户塑形的浏览器 agent。
- 信任阶梯四档：讲解（看）→ 引导（指）→ 代执行（做）→ 自动化（托管）。
- 配置四层：L0 平台基座（不可改）/ L1 站点包 pack / L2 个人定制（只能收紧权限，不能放宽）/ L3 自动化。
- 风险三档文案：自动执行（auto）/ 需确认（hitl）/ 已禁用（off 或 forbidden）。
- 示例站点与 pack：闲鱼（pack：闲鱼卖家 xianyu-seller，官方）、Notion（社区 pack）、自建 pack 示例「公司 CRM」。
- 代执行强调：一次性签名指令、服务端判定、全程审计留痕。
