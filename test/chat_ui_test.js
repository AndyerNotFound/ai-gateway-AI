'use strict';
/* 聊天页 UI 布局测试: 从 m3/index.html 抽取聊天函数, 用 DOM 桩驱动真实断言 */
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/../m3/index.html', 'utf8');

let pass = 0, fail = 0; const fails = [];
function ok(c, m){ if(c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
function eq(a,b,m){ ok(a===b, m + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

/* ---- 抽取聊天函数块 ---- */
const start = html.indexOf('// ---------- 聊天: 滚动锁定 / 渲染 ----------');
const end   = html.indexOf('async function sendChat');
ok(start > 0 && end > start, '能定位聊天函数块');
const code = html.slice(start, end);

/* ---- DOM 桩 ---- */
function mkEl(){
  const el = {
    _html:'', scrollTop:0, scrollHeight:500, clientHeight:300,
    classList:{ s:new Set(), toggle(c,f){ f?el.classList.s.add(c):el.classList.s.delete(c); }, has(c){return el.classList.s.has(c);} },
    hidden:false, dataset:{}, style:{}, listeners:{},
    addEventListener(t,f){ (el.listeners[t]=el.listeners[t]||[]).push(f); },
    appendChild(){}, removeChild(){}, setAttribute(){}, select(){}, focus(){},
    closest(){ return null; },
  };
  Object.defineProperty(el,'innerHTML',{ get(){return el._html;}, set(v){ el._html=v; } });
  return el;
}
const msgsEl = mkEl(), jumpEl = mkEl(), inputEl = mkEl();
inputEl.scrollHeight = 20;
const els = { '#ch-messages':msgsEl, '#ch-jump':jumpEl, '#ch-input':inputEl };

const Store = { chat:{ messages:[], inst:'', streaming:false } };
const snacks = [];
const ctx = {
  $: s => els[s] || null,
  esc: s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
  snack: (m,e) => snacks.push(m),
  Store, console, Date, Math, JSON, navigator:{}, window:{ isSecureContext:false },
  document:{ createElement:()=>mkEl(), body:{appendChild(){},removeChild(){}} },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code + '\n;this.__fns={renderChatMessages,chatAtBottom,chatUpdateJump,chatNow,chatAutoGrow,copyText};this.__getStick=()=>chatStick;', ctx);
const F = ctx.__fns;

/* ================= 1. 空状态 ================= */
Store.chat.messages = [];
F.renderChatMessages(true);
ok(/empty-state/.test(msgsEl._html), '无消息时显示空状态提示');
ok(!jumpEl._html && jumpEl.hidden === true, '空状态时"回到底部"按钮隐藏');

/* ================= 2. 气泡结构 (MD3 卡片风) ================= */
Store.chat.messages = [
  {role:'user', content:'第一条 用户消息', t:'09:15'},
  {role:'assistant', content:'助手回复 with English words and https://example.com/very/long/path/that/should/not/break/mid/word', t:'09:15'},
];
F.renderChatMessages(true);
const h = msgsEl._html;
eq((h.match(/class="chat-msg /g)||[]).length, 2, '渲染出 2 个 .chat-msg 节点');
ok(/chat-msg user/.test(h), '第1条带 user 类');
ok(/chat-msg ai/.test(h), '第2条带 ai 类');
eq((h.match(/chat-ava/g)||[]).length, 2, '每条消息都有头像');
eq((h.match(/class="chat-bubble/g)||[]).length, 2, '每条消息都有气泡');
eq((h.match(/chat-copy/g)||[]).length, 2, '每条消息都有复制按钮');
ok(/data-copy="0"/.test(h) && /data-copy="1"/.test(h), '复制按钮带正确索引');
ok(/<textarea/.test(html) && !/<input type="text" id="ch-input"/.test(html), '输入框已改为 textarea');

/* ================= 3. 旧 bug 回归: align-self 失效 ================= */
ok(!/align-self/.test(h), '不再使用失效的 align-self 内联定位');
const cssChat = html.slice(html.indexOf('/* ---------- 聊天页'), html.indexOf('</style>'));
ok(/#ch-messages\{[^}]*display:flex/.test(cssChat), '#ch-messages 已是 flex 容器(滚动锁定/间距生效前提)');
ok(/#ch-messages\{[^}]*overflow-y:auto/.test(cssChat), '#ch-messages 自带滚动');
ok(/gap:14px/.test(cssChat), '消息间距由 flex gap 统一控制');

/* ================= 4. 100vh 魔数已清除 ================= */
ok(!/calc\(100vh\s*-\s*200px\)/.test(html), '聊天卡片不再用 100vh 魔数高度');
ok(/#page-chat\{[^}]*flex:1 1 auto/.test(cssChat), '#page-chat 用 flex 自适应撑满');
ok(/\.main\{[^}]*display:flex;flex-direction:column/.test(html), '.main 改为 flex 列容器');
ok(/\.page\{flex:0 0 auto\}/.test(cssChat), '其他页保持自然高度(不被 flex 压缩)');

/* ================= 5. 字体/断词修复 ================= */
ok(!/id="ch-messages" class="log-box"/.test(html), '消息区已脱离 log-box 等宽样式');
ok(/word-break:normal/.test(cssChat) && /overflow-wrap:anywhere/.test(cssChat), '气泡改为不断词 + 任意处换行');

/* ================= 6. 转义 (XSS 回归) ================= */
Store.chat.messages = [{role:'user', content:'<img src=x onerror=alert(1)> "引号" & 与'}];
F.renderChatMessages(true);
ok(!/<img/.test(msgsEl._html), '消息内容中的 HTML 被转义(无注入)');
ok(/&lt;img/.test(msgsEl._html), '转义结果正确');

/* ================= 7. 流式光标 ================= */
Store.chat.messages = [{role:'user',content:'q'},{role:'assistant',content:'部分回答'}];
Store.chat.streaming = true;
F.renderChatMessages(true);
ok(/chat-bubble chat-cursor/.test(msgsEl._html), '流式时最后一条 AI 气泡带光标');
ok((msgsEl._html.match(/chat-cursor/g)||[]).length === 1, '光标只出现一次');
Store.chat.streaming = false;
F.renderChatMessages(true);
ok(!/chat-cursor/.test(msgsEl._html), '流式结束后光标移除');

/* ================= 8. 滚动锁定 ================= */
msgsEl.scrollTop = 0; msgsEl.scrollHeight = 500; msgsEl.clientHeight = 300; // 距底 200 > 80
Store.chat.messages = [{role:'assistant',content:'x'}];
F.renderChatMessages();
ok(ctx.__getStick() === false, '用户上滑离开底部 → 取消自动跟随');
eq(msgsEl.scrollTop, 0, '取消跟随后不强制滚到底部');
ok(jumpEl.hidden === false, '此时显示"回到底部"按钮');
msgsEl.scrollTop = 200; // 500-200-300=0 < 80
F.renderChatMessages();
ok(ctx.__getStick() === true, '回到底部附近 → 恢复自动跟随');
ok(jumpEl.hidden === true, '贴底时隐藏"回到底部"按钮');
F.renderChatMessages(true);
ok(ctx.__getStick() === true, 'force 参数强制跟随(发送新消息时)');
msgsEl.scrollTop = 0; F.renderChatMessages(true);
ok(msgsEl.scrollTop === msgsEl.scrollHeight, 'force 渲染后滚动到底');

/* ================= 9. 时间戳 ================= */
ok(/^\d{2}:\d{2}$/.test(F.chatNow()), `chatNow 产出 HH:MM (${F.chatNow()})`);

/* ================= 10. textarea 自动增高上限 ================= */
inputEl.scrollHeight = 999; F.chatAutoGrow(inputEl);
eq(inputEl.style.height, '132px', '输入框增高封顶 132px(约4行)');
inputEl.scrollHeight = 30; F.chatAutoGrow(inputEl);
eq(inputEl.style.height, '30px', '短内容按实际高度');

/* ================= 11. 事件绑定完整性 ================= */
const bind = html.slice(html.indexOf('// 聊天页事件'));
for (const id of ['#ch-send','#ch-input','#ch-clear','#ch-inst','#ch-messages','#ch-jump'])
  ok(bind.includes(`$('${id}')?.addEventListener`), `已绑定 ${id} 事件`);
ok(/confirm\(/.test(bind), '清空有二次确认');
ok(/e\.key==='Enter' && !e\.shiftKey/.test(bind), 'Enter 发送 / Shift+Enter 换行');

/* ================= 12. 安全区 ================= */
ok(/env\(safe-area-inset-bottom\)/.test(cssChat), '输入行适配全面屏安全区');

console.log(`\n聊天页 UI 测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
