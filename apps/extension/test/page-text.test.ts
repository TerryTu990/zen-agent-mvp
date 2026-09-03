// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractPageText } from '../src/page-text.js';
import { MAX_PAGE_TEXT_LENGTH } from '../src/tuning.js';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '文章页';
});

describe('extractPageText：正文根选择', () => {
  it('<article> 优先于 body 其余内容', () => {
    document.body.innerHTML = `
      <div>侧栏推荐位</div>
      <article><p>正文第一段</p><p>正文第二段</p></article>
      <div>页脚版权</div>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('正文第一段');
    expect(text).toContain('正文第二段');
    expect(text).not.toContain('侧栏推荐位');
    expect(text).not.toContain('页脚版权');
  });

  it('无 <article> 时取 <main>', () => {
    document.body.innerHTML = `
      <div>无关侧栏</div>
      <main><p>主区正文</p></main>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('主区正文');
    expect(text).not.toContain('无关侧栏');
  });

  it('无 <article>/<main> 时取 [role="main"]', () => {
    document.body.innerHTML = `
      <div>无关侧栏</div>
      <div role="main"><p>role 主区正文</p></div>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('role 主区正文');
    expect(text).not.toContain('无关侧栏');
  });

  it('三者皆无时退回 body', () => {
    document.body.innerHTML = '<div><p>裸 body 正文</p></div>';
    expect(extractPageText(document).text).toContain('裸 body 正文');
  });

  it('隐藏的 <article> 不被选为正文根，让位给可见的 <main>', () => {
    document.body.innerHTML = `
      <article style="display:none"><p>过期草稿内容</p></article>
      <main><p>当前正文</p></main>
    `;
    const { text } = extractPageText(document);
    expect(text).toBe('当前正文');
  });

  it('同名候选有多个时取第一个可见的（首个 hidden 不吃掉后续）', () => {
    document.body.innerHTML = `
      <article hidden><p>旧路由正文</p></article>
      <article><p>新路由正文</p></article>
    `;
    expect(extractPageText(document).text).toBe('新路由正文');
  });

  it('候选根自身可见但祖先不可见时同样跳过（祖先链参与判定）', () => {
    document.body.innerHTML = `
      <div style="display:none"><article><p>被隐藏容器包住的正文</p></article></div>
      <main><p>真正显示的正文</p></main>
    `;
    expect(extractPageText(document).text).toBe('真正显示的正文');
  });

  it('全部候选根不可见时退回 body，且隐藏候选的内容不进结果', () => {
    document.body.innerHTML = `
      <article aria-hidden="true"><p>隐藏文章内容</p></article>
      <p>裸 body 可见段落</p>
    `;
    const { text } = extractPageText(document);
    expect(text).toBe('裸 body 可见段落');
  });

  it('<aside> 内的 <article> 不被选为正文根（侧栏推荐卡不当整页正文）', () => {
    document.body.innerHTML = `
      <aside><article><p>相关阅读推荐卡片</p></article></aside>
      <main><p>本页真正的正文</p></main>
    `;
    expect(extractPageText(document).text).toBe('本页真正的正文');
  });

  it('<nav> 内的 <article> 同样跳过（被剔除区域的判定覆盖整条祖先链）', () => {
    document.body.innerHTML = `
      <nav><article><p>导航区推广条</p></article></nav>
      <main><p>本页真正的正文</p></main>
    `;
    expect(extractPageText(document).text).toBe('本页真正的正文');
  });

  it('候选根全落在被剔除区域时退回 body，且该区域内容不进结果', () => {
    document.body.innerHTML = `
      <footer><article><p>页脚里的推广文章</p></article></footer>
      <p>裸 body 可见段落</p>
    `;
    expect(extractPageText(document).text).toBe('裸 body 可见段落');
  });

  it('<article> 优先级高于同页 <main>（嵌套关系不影响选择）', () => {
    document.body.innerHTML = `
      <main><p>外层主区文字</p><article><p>文章正文</p></article></main>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('文章正文');
    expect(text).not.toContain('外层主区文字');
  });
});

describe('extractPageText：非正文与不可见内容剔除', () => {
  it('script/style/nav/header/footer/aside 内容不进结果', () => {
    document.body.innerHTML = `
      <header>站点导航头</header>
      <nav>目录导航</nav>
      <aside>相关阅读</aside>
      <script>const injected = '脚本内容';</script>
      <style>.cls { content: '样式内容'; }</style>
      <p>真正的正文</p>
      <footer>备案与版权</footer>
    `;
    const { text } = extractPageText(document);
    expect(text).toBe('真正的正文');
  });

  it('正文容器内的 nav/script 仍剔除，文内旁注（aside）属正文予以保留', () => {
    document.body.innerHTML = `
      <article>
        <nav>文内目录</nav>
        <p>正文段落</p>
        <aside>延伸阅读</aside>
        <script>const x = '文内脚本';</script>
      </article>
    `;
    expect(extractPageText(document).text).toBe('正文段落\n\n延伸阅读');
  });

  it('内联 display:none / visibility:hidden 元素不进结果（含祖先）', () => {
    document.body.innerHTML = `
      <article>
        <p style="display:none">隐藏段落</p>
        <div style="visibility:hidden"><p>不可见容器内段落</p></div>
        <p>可见段落</p>
      </article>
    `;
    const { text } = extractPageText(document);
    expect(text).toBe('可见段落');
  });
});

describe('extractPageText：同源 iframe 下钻', () => {
  it('正文根内的同源 iframe 按文档序追加在顶层正文之后', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main>';
    const frame = document.createElement('iframe');
    document.querySelector('main')!.appendChild(frame);
    frame.contentDocument!.body.innerHTML = '<article><p>帧内正文</p></article>';

    expect(extractPageText(document).text).toBe('顶层正文\n\n帧内正文');
  });

  it('正文根之外的同源 iframe 不进正文（小部件/广告帧不得冒充正文）', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main><div class="widget"></div>';
    const outside = document.createElement('iframe');
    document.querySelector('.widget')!.appendChild(outside);
    outside.contentDocument!.body.innerHTML = '<article><p>小部件广告文案</p></article>';

    const result = extractPageText(document).text;
    expect(result).toBe('顶层正文');
    expect(result).not.toContain('小部件广告文案');
  });

  it('零尺寸帧（埋点/工具帧）不下钻', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main>';
    const beacon = document.createElement('iframe');
    beacon.setAttribute('width', '0');
    beacon.setAttribute('height', '0');
    document.querySelector('main')!.appendChild(beacon);
    beacon.contentDocument!.body.innerHTML = '<article><p>埋点文案</p></article>';

    expect(extractPageText(document).text).toBe('顶层正文');
  });

  it('同源 XML/SVG 子文档（body 为 null）不抛异常，顶层正文照常返回', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main>';
    const frame = document.createElement('iframe');
    document.querySelector('main')!.appendChild(frame);
    // XML/SVG 文档的 body 恒为 null；直接构造该形态，避免依赖 jsdom 的导航实现。
    const xmlDoc = new DOMParser().parseFromString('<rss><item>订阅项</item></rss>', 'text/xml');
    expect(xmlDoc.body).toBeNull();
    Object.defineProperty(frame, 'contentDocument', { get: () => xmlDoc });

    expect(() => extractPageText(document)).not.toThrow();
    // 整份跳过而非取回：XML 帧内容不得混进正文，顶层正文照常返回。
    expect(extractPageText(document).text).toBe('顶层正文');
  });

  it('顶层无正文根时，同源 iframe 内的 <article> 仍能取到', () => {
    document.body.innerHTML = '';
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frame.contentDocument!.body.innerHTML =
      '<nav>帧内导航</nav><article><p>帧内文章正文</p></article>';

    expect(extractPageText(document).text).toBe('帧内文章正文');
  });

  it('跨源 iframe（contentDocument 不可达）跳过、不阻断顶层正文', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main>';
    const crossOrigin = document.createElement('iframe');
    document.body.appendChild(crossOrigin);
    Object.defineProperty(crossOrigin, 'contentDocument', {
      get() {
        throw new Error('cross-origin frame access denied');
      },
    });

    expect(extractPageText(document).text).toBe('顶层正文');
  });

  it('落在 <aside> 内或被隐藏的 iframe 不下钻', () => {
    document.body.innerHTML = '<main><p>顶层正文</p></main><aside id="sidebar"></aside>';
    const inAside = document.createElement('iframe');
    document.querySelector('#sidebar')!.appendChild(inAside);
    inAside.contentDocument!.body.innerHTML = '<article><p>侧栏帧广告</p></article>';
    const hidden = document.createElement('iframe');
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
    hidden.contentDocument!.body.innerHTML = '<article><p>隐藏帧内容</p></article>';

    expect(extractPageText(document).text).toBe('顶层正文');
  });
});

describe('extractPageText：空白归一与块级边界', () => {
  it('行内空白折叠为单空格、块级边界保留为换行，且结果无首尾空白', () => {
    document.body.innerHTML = `
      <article>
        <p>  第一段   有   多空格  </p>
        <p>第二段
           跨行</p>
      </article>
    `;
    const { text } = extractPageText(document);
    // 源码里的换行是行内空白（浏览器同样按空格渲染），只有块级边界才成行。
    expect(text).toBe('第一段 有 多空格\n\n第二段 跨行');
    expect(text).toBe(text.trim());
    expect(text).not.toMatch(/[^\S\n]{2}/);
    expect(text).not.toMatch(/\n{3}/);
    expect(text).not.toMatch(/\t/);
  });
});

describe('extractPageText：长度上限与截断标记', () => {
  it('超限即截断且 truncated 为真；未超限时 truncated 为假（同一断言在两种世界里不同）', () => {
    document.body.innerHTML = `<article><p>${'甲'.repeat(MAX_PAGE_TEXT_LENGTH + 50)}</p></article>`;
    const overflow = extractPageText(document);
    expect(overflow.truncated).toBe(true);
    expect(overflow.text).toHaveLength(MAX_PAGE_TEXT_LENGTH);

    document.body.innerHTML = `<article><p>${'甲'.repeat(MAX_PAGE_TEXT_LENGTH - 1)}</p></article>`;
    const withinLimit = extractPageText(document);
    expect(withinLimit.truncated).toBe(false);
    expect(withinLimit.text).toHaveLength(MAX_PAGE_TEXT_LENGTH - 1);
  });

  it('恰好等于上限不算截断（边界不误报）', () => {
    document.body.innerHTML = `<article><p>${'甲'.repeat(MAX_PAGE_TEXT_LENGTH)}</p></article>`;
    const exact = extractPageText(document);
    expect(exact.text).toHaveLength(MAX_PAGE_TEXT_LENGTH);
    expect(exact.truncated).toBe(false);
  });

  it('客户端上限不高于 C3 契约硬顶 40000', () => {
    expect(MAX_PAGE_TEXT_LENGTH).toBeLessThanOrEqual(40_000);
  });
});

describe('extractPageText：空页面', () => {
  it('无正文时返回空串且 truncated 为假', () => {
    document.body.innerHTML = '';
    expect(extractPageText(document)).toEqual({ text: '', truncated: false });
  });

  it('只有被剔除内容的页面同样返回空串', () => {
    document.body.innerHTML = '<nav>导航</nav><script>const x = 1;</script>';
    expect(extractPageText(document)).toEqual({ text: '', truncated: false });
  });
});

describe('extractPageText：多候选正文根（A-PAGE-06 / PC-PAGE-08）', () => {
  it('多张 <article> 的列表页取最近公共祖先，全部卡片进正文', () => {
    document.body.innerHTML = `
      <nav>站点导航</nav>
      <div id="feed">
        <article><p>第一条动态</p></article>
        <article><p>第二条动态</p></article>
        <article><p>第三条动态</p></article>
      </div>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('第一条动态');
    expect(text).toContain('第二条动态');
    expect(text).toContain('第三条动态');
    expect(text).not.toContain('站点导航');
  });

  it('多候选的公共祖先退到 body 时，导航/页脚仍按退回面剔除', () => {
    document.body.innerHTML = `
      <header>站点头</header>
      <article><p>评论一</p></article>
      <footer>版权</footer>
      <article><p>评论二</p></article>
    `;
    const { text } = extractPageText(document);
    expect(text).toBe('评论一\n\n评论二');
  });

  it('嵌套同类候选不误上提（外层 article 已含内层）', () => {
    document.body.innerHTML = `
      <div>侧栏推荐位</div>
      <article><p>主文</p><article><p>内嵌引用</p></article></article>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('主文');
    expect(text).toContain('内嵌引用');
    expect(text).not.toContain('侧栏推荐位');
  });

  it('文章头（正文根内的 <header>）保留：标题/作者/日期不再随退回面规则丢失', () => {
    document.body.innerHTML = `
      <article>
        <header><h1>季度财报解读</h1><span>作者：张三</span></header>
        <p>正文首段</p>
      </article>
    `;
    const { text } = extractPageText(document);
    expect(text).toContain('季度财报解读');
    expect(text).toContain('作者：张三');
  });
});

describe('extractPageText：块级结构保留（A-PAGE-07 / PC-PAGE-08）', () => {
  it('标题按级数加 # 前缀，段落与列表项各自成行', () => {
    document.body.innerHTML = `
      <article>
        <h1>大标题</h1>
        <p>首段</p>
        <h2>小节</h2>
        <ul><li>要点一</li><li>要点二</li></ul>
      </article>
    `;
    const lines = extractPageText(document).text.split('\n').filter((line) => line !== '');
    expect(lines).toEqual(['# 大标题', '首段', '## 小节', '要点一', '要点二']);
  });

  it('表格按行成段、单元格以 | 分隔（价格/库存表可被逐行差分）', () => {
    document.body.innerHTML = `
      <article>
        <table>
          <tr><th>商品</th><th>价格</th></tr>
          <tr><td>甲</td><td>19.9</td></tr>
        </table>
      </article>
    `;
    const lines = extractPageText(document).text.split('\n').filter((line) => line !== '');
    expect(lines).toEqual(['商品 | 价格', '甲 | 19.9']);
  });

  it('<br> 成行；相邻行内元素不被强行拆行', () => {
    document.body.innerHTML = '<article><p>上行<br>下行</p><p>粗体<b>相连</b></p></article>';
    expect(extractPageText(document).text).toBe('上行\n下行\n\n粗体 相连');
  });

  it('open shadow root 内的正文可取到（Web Components 站点不再正文为空）', () => {
    document.body.innerHTML = '<main><p>轻 DOM 正文</p><div id="host"></div></main>';
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML =
      '<p>影子正文</p>';
    const { text } = extractPageText(document);
    expect(text).toContain('轻 DOM 正文');
    expect(text).toContain('影子正文');
  });
});

describe('extractPageText：按行边界截断', () => {
  it('截断落在行边界上，不把最后一行切成半句', () => {
    const head = Array.from({ length: 40 }, (_, i) => `<p>${'甲'.repeat(300)}${i}</p>`).join('');
    document.body.innerHTML = `<article>${head}</article>`;
    const { text, truncated } = extractPageText(document);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_PAGE_TEXT_LENGTH);
    // 最后一行是完整段落：其长度与源段落一致（未被从中间切断）。
    expect(text.split('\n').at(-1)).toMatch(/^甲+\d+$/);
  });
});
