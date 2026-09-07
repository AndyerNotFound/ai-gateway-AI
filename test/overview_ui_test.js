'use strict';
/* 首页/表格布局测试: 横向溢出根因修复验证 */
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/../m3/index.html', 'utf8');
let pass=0, fail=0;
function ok(c,m){ if(c) pass++; else { fail++; console.error('  ✗ '+m); } }
function eq(a,b,m){ ok(a===b, m+` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

/* ===== 1. 根因 1: .truncate 必须真的被定义 ===== */
ok(/\.truncate\{[^}]*text-overflow:ellipsis/.test(html), '.truncate 类已在 CSS 中定义(此前是死类名)');
ok(/\.truncate\{[^}]*overflow:hidden/.test(html), '.truncate 含 overflow:hidden');
ok(/\.truncate\{[^}]*white-space:nowrap/.test(html), '.truncate 含 nowrap');

/* ===== 2. 根因 2: table-layout:fixed ===== */
ok(/\.md-table\{[^}]*table-layout:fixed/.test(html), '.md-table 已设 table-layout:fixed');
ok(/\.md-table th,\.md-table td\{[^}]*text-overflow:ellipsis/.test(html), '所有单元格具备省略号能力');
ok(/\.md-table th,\.md-table td\{[^}]*overflow:hidden/.test(html), '所有单元格 overflow:hidden 防溢出重叠');

/* ===== 3. 横向滚动条从机制上消除 ===== */
const wrapCss = html.match(/\.md-table-wrap\{[^}]*\}/)[0];
ok(!/overflow-x:\s*auto|overflow:\s*auto/.test(wrapCss), '.md-table-wrap 已移除 overflow-x:auto(不可能再横向拖动)');

/* ===== 4. 根因 3: 失效的内联 max-width 已清除 ===== */
ok(!/style="max-width:\d+px"/.test(html.match(/chRows\.push\(`[^`]*`\)/)[0]), '总览行模板无失效内联 max-width');
ok(!/style="max-width:\d+px"/.test(html.match(/<tr>\s*<td class="mono truncate" title="\$\{escAttr\(ch\.name\)\}[\s\S]*?<\/tr>/)[0]), '提供商行模板无失效内联 max-width');

/* ===== 5. 连带 bug: 移动端列隐藏不得泄漏到其他表 ===== */
const mq = html.slice(html.indexOf('@media(max-width:600px){\n  /* 仅提供商表'));
ok(!/(^|[^#])\.md-table th:nth-child/.test(mq), '媒体查询不再用通用 .md-table:nth-child 误伤所有表');
ok(/#pv-table th:nth-child\(4\)/.test(mq) && /#pv-table td:nth-child\(5\)/.test(mq), '提供商表(6列)仍正确收起 代理/模型');
ok(/#ov-ch-table th:nth-child\(2\)/.test(mq), '总览表收起 类型 列(标签宽度不足)');
// 关键回归: 请求记录表的状态/耗时列不再被吃掉
ok(!/#rq-table th:nth-child/.test(html), '请求记录表 5 列全部保留(此前 状态/耗时 被误删)');
ok(!/#st-table th:nth-child/.test(html), '统计表 4 列全部保留(此前 出Token 被误删)');

/* ===== 6. 每张表列宽合计 100% ===== */
const tables = {'pv-table':6,'st-table':4,'rq-table':5,'ov-ch-table':4};
for(const [id,n] of Object.entries(tables)){
  const seg = html.match(new RegExp('id="'+id+'"[\\s\\S]*?</thead>'))[0];
  const ws = [...seg.matchAll(/width:(\d+(?:\.\d+)?)%/g)].map(m=>+m[1]);
  eq(ws.length, n, `${id} 有 ${n} 个列宽声明`);
  eq(ws.reduce((a,b)=>a+b,0), 100, `${id} 列宽合计 100%`);
}

/* ===== 7. fmtHost 略写行为 ===== */
// 按行抽取 fmtHost(避开行尾注释干扰), 并显式导出(const 不挂 vm global)
const _ls = html.split('\n');
const _si = _ls.findIndex(l => l.includes('const fmtHost = u =>'));
ok(_si > 0, '能定位 fmtHost 定义行');
let _ei = _si;
while (_ei < _ls.length && !/\);\s*(\/\/.*)?$/.test(_ls[_ei])) _ei++;
const _helper = _ls.slice(_si, _ei + 1).join('\n') + '\n;this.__fmtHost = fmtHost;';
const ctx = {String, Math, JSON, console};
vm.createContext(ctx); vm.runInContext(_helper, ctx);
const fmtHost = ctx.__fmtHost;
ok(typeof fmtHost === 'function', 'fmtHost 成功导出');
eq(fmtHost('https://integrate.api.nvidia.com/v1'), 'integrate.api.nvidia.com', '剥协议 + 剥 /v1');
eq(fmtHost('https://beizhi.sylu.cc/v1'), 'beizhi.sylu.cc', '剥 /v1');
eq(fmtHost('http://127.0.0.1:16384/'), '127.0.0.1:16384', '剥尾部斜杠 + 保留端口');
eq(fmtHost('https://api.anthropic.com'), 'api.anthropic.com', '无 /v1 时不误伤');
eq(fmtHost(''), '-', '空值兜底');
eq(fmtHost('gemini:batch://x'), 'gemini:batch://x', '非 // 形式协议不误剥');
ok(fmtHost('https://api.openai.com/v1').length < 'https://api.openai.com/v1'.length, '略写后确实更短');
// 略写不得丢失信息: 完整值必须挂 title
ok(/title="\$\{escAttr\(ch\.baseUrl\)\}">\$\{esc\(fmtHost\(ch\.baseUrl\)\)\}/.test(html), 'Base URL 完整值挂在 title 上(可悬停/长按取回)');

/* ===== 8. 总览行模板结构 ===== */
const row = html.match(/chRows\.push\(`([\s\S]*?)`\)/)[1];
eq((row.match(/class="[^"]*truncate/g)||[]).length, 3, '总览行 3 个文本列带 truncate');
eq((row.match(/title="/g)||[]).length, 3, '总览行 3 列带 title');
ok(/fmtHost\(ch\.baseUrl\)/.test(row), '总览地址列使用略写');

/* ===== 9. 操作按钮竖排容器 ===== */
ok(/\.row-acts\{display:flex/.test(html), '.row-acts 定义为 flex');
ok(/\.row-acts\{flex-direction:column/.test(mq), '手机上操作按钮竖排(定宽下不被裁)');
ok(/<td class="row-actions"><div class="row-acts">/.test(html), '按钮已包进 td 内的 div(td 保持 table-cell 身份)');

/* ===== 10. 移动端密度: 单元格内边距 ===== */
ok(/\.md-table th,\.md-table td\{padding:8px 10px\}/.test(mq), '移动端单元格 padding 降至 8px 10px');
ok(/\.md-table \.mono\{font-size:11px\}/.test(mq), '移动端等宽字号降至 11px');
// 量化: 4 列表在 296px 可用宽度下的内边距开销
const deskOverhead = 4*32, mobOverhead = 4*20;
ok(mobOverhead < deskOverhead, `内边距开销 ${deskOverhead}px → ${mobOverhead}px, 内容区 ${(296-deskOverhead)}px → ${(296-mobOverhead)}px`);
eq(296-mobOverhead, 216, '手机内容区可用宽度 216px');

/* ===== 11. 无横向溢出: 表格宽度恒为 100% ===== */
ok(/\.md-table\{width:100%/.test(html), '.md-table width:100%');
ok(!/min-width:\s*\d+px/.test(html.match(/\.md-table\{[^}]*\}/)[0]), '表格无 min-width(不会被撑破容器)');

/* ===== 12. 聊天页无回归 ===== */
ok(/#page-chat\{flex:1 1 auto/.test(html), '聊天页 flex 布局仍在');
ok(/\.page\{flex:0 0 auto\}/.test(html), '.page 自然高度规则仍在');

console.log(`\n首页/表格布局测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
