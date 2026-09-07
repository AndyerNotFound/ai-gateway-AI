'use strict';
/* 其他页面布局审计修复验证: 端口/路由/统计/日志/控件 */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../m3/index.html', 'utf8');
let pass=0, fail=0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('  ✗ '+m); } }
function eq(a,b,m){ ok(a===b, m+` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }
const css = sel => { const r = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}'); const m=html.match(r); return m?m[1]:''; };

/* ===== 1. 路由页: 尾部 baseUrl 不再挤压主信息 ===== */
const rtRow = html.slice(html.indexOf('async function renderRouting'), html.indexOf('async function renderKeys'));
ok(/class="trailing text muted small"/.test(rtRow), '路由页尾部改用 .trailing.text(可收缩+截断)');
ok(/fmtHost\(ch\.baseUrl\)/.test(rtRow), '路由页 baseUrl 走略写');
ok(/title="\$\{escAttr\(ch\.baseUrl\)\}"/.test(rtRow), '路由页完整 URL 挂 title');
ok(/class="t" title="\$\{escAttr\(ch\.name\)\}"/.test(rtRow), '路由页渠道名补 title');
ok(/class="s" title=/.test(rtRow), '路由页模型列表补 title');

/* ===== 2. .trailing.text 定义完整性 ===== */
const tt = css('.md-list-item .trailing.text');
for (const p of ['flex-shrink:1','min-width:0','overflow:hidden','text-overflow:ellipsis','white-space:nowrap','max-width:45%'])
  ok(tt.includes(p), `.trailing.text 含 ${p}`);
ok(css('.md-list-item .trailing').includes('flex-shrink:0'), '按钮型 .trailing 仍不收缩(按钮不被压扁)');

/* ===== 3. 端口页: 手机上按钮组独立成行 ===== */
const mq = html.slice(html.indexOf('@media(max-width:600px){\n  /* 仅提供商表'), html.indexOf('/* ---------- 聊天页'));
ok(/\.md-list-item\{flex-wrap:wrap/.test(mq), '手机上列表项允许换行');
ok(/\.md-list-item \.trailing:not\(\.text\)\{flex-basis:100%/.test(mq), '按钮型尾部占满整行(换到第二行)');
ok(/:not\(\.text\)/.test(mq), '用 :not(.text) 精确排除文本型尾部(路由页不受影响)');
ok(/\.md-list-item \.trailing \.md-btn\{flex:1 1 0;min-width:0\}/.test(mq), '按钮均分第二行宽度');
// 量化: 修复前 3 按钮+图标 占掉多少名字宽度
const avail = 296, icon=40, gap=32, btns=190;
eq(avail - icon - gap - btns, 34, '修复前实例名仅剩 34px(会被省略号吃成单字母)');

/* ===== 4. 统计卡: 大数字不再撑破 grid 轨道 ===== */
ok(css('.stat-box').includes('min-width:0'), '.stat-box 补 min-width:0(grid 项默认 auto 会撑破轨道)');
const num = css('.stat-box .num');
for (const p of ['overflow:hidden','text-overflow:ellipsis','white-space:nowrap','font-variant-numeric:tabular-nums'])
  ok(num.includes(p), `.stat-box .num 含 ${p}`);

/* ===== 5. 日志页: 断词 + 撑满 ===== */
const lb = css('.log-box');
ok(!/word-break:break-all/.test(lb), '.log-box 不再 break-all 硬切英文/路径');
ok(/overflow-wrap:anywhere/.test(lb) && /word-break:normal/.test(lb), '.log-box 改为按需断词');
ok(/#page-logs\{[^}]*flex:1 1 auto/.test(html), '日志页 flex 撑满(与聊天页同构)');
ok(/#lg-box\{[^}]*max-height:none/.test(html), '日志框取消 400px 高度上限');
ok(/#page-logs \.md-card\{[^}]*min-height:0/.test(html), '日志卡片可收缩(不产生双重滚动)');

/* ===== 6. 控件样式收口 ===== */
eq((html.match(/class="sel"/g)||[]).length, 6, '6 个实例下拉全部改用 .sel');
eq((html.match(/class="num-in"/g)||[]).length, 1, '日志行数输入改用 .num-in');
eq((html.match(/width:160px/g)||[]).length, 0, '无残留固定 160px 内联宽度');
ok(/\.sel\{[^}]*min-width:0/.test(html) && /\.sel\{[^}]*flex:0 1 auto/.test(html), '.sel 可收缩不挤换行');
ok(/\.sel\{[^}]*max-width:170px/.test(html), '.sel 保留最大宽度上限');

/* ===== 7. 横向溢出机制性保证(全局扫描) ===== */
eq((html.match(/overflow-x:\s*auto/g)||[]).length, 0, '全站已无 overflow-x:auto(不可能横向拖动)');
eq((html.match(/<td[^>]*max-width/g)||[]).length, 0, '无残留 td 内联 max-width(规范忽略的空写)');
ok(/\.md-table\{[^}]*table-layout:fixed/.test(html), '表格仍为 fixed 布局');
ok(/\.truncate\{[^}]*text-overflow:ellipsis/.test(html), '.truncate 定义仍在');

/* ===== 8. 前两轮修复无回归 ===== */
ok(/#page-chat\{flex:1 1 auto/.test(html), '聊天页 flex 布局仍在');
ok(/\.page\{flex:0 0 auto\}/.test(html), '.page 自然高度规则仍在');
ok(/\.main\{[^}]*display:flex;flex-direction:column/.test(html), '.main flex 列容器仍在');
ok(/#ov-ch-table th:nth-child\(2\)/.test(mq), '总览表收起类型列规则仍在');
ok(!/(^|[^#])\.md-table th:nth-child/.test(mq), '通用 nth-child 泄漏未复发');
for (const [id,n] of Object.entries({'pv-table':6,'st-table':4,'rq-table':5,'ov-ch-table':4})) {
  const seg = html.match(new RegExp('id="'+id+'"[\\s\\S]*?</thead>'))[0];
  const ws = [...seg.matchAll(/width:(\d+)%/g)].map(m=>+m[1]);
  eq(ws.length, n, `${id} 列数 ${n}`);
  eq(ws.reduce((a,b)=>a+b,0), 100, `${id} 列宽合计 100%`);
}

/* ===== 9. 结构完整性 ===== */
const opens = (html.match(/<div[\s>]/g)||[]).length, closes = (html.match(/<\/div>/g)||[]).length;
eq(opens, closes, 'div 标签配平');
eq((html.match(/<select[\s>]/g)||[]).length, (html.match(/<\/select>/g)||[]).length, 'select 标签配平');

console.log(`\n其他页面布局测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
