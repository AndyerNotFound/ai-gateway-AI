'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { log, randId, utf8, rpApplyText, safeParse, logErr } = require('./util');
const { cfgDirOf } = require('./router');

// ================= DSML 工具调用解析/清洗(原 gateway.js 内联) =================
const DSML_TAG_MAX = 256;      // 单个标签可信的最大长度(超了就当普通文本对待)
const DSML_WS_MAX = 1024;      // "块尾空白"最多暂缓多少字符(超了直接放行)
const DSML_BLOCK_MAX = 65536;  // 一个标记块最多吞吃多少字符(超过即 fail-open 放行)
/* 标记前缀方言(实测三种): ① ｜DSML｜ —— 含 DSML 字样; ② 完全裸写 <invoke …>; ③ 只剩竖线 <｜tool_calls>。
 *   ①② 靠标签名识别; ③ 要求"竖线在关键字之前", 避免把正文里 <div data-k="a|b"> 误判成标记。 */
const DSML_OPEN_CALLS = /<(?![\/])[^>]*DSML[^>]*(?:tool_)?calls>/i;         // ① 以 DSML 为准(防误吞正文)
const DSML_OPEN_CALLS_WEAK = /<(?![\/])[^>]*[｜|][^>]*(?:tool_)?calls>/i;   // ③ 缺 DSML 字样、只剩竖线前缀
const DSML_OPEN_INVOKE = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b[^>]*>/i;
/* ★结束标记/内部标签允许"无 DSML 前缀"的裸写法: 实测 deepseek-v4.1-flash(NIM) 只给外层标签带 ｜DSML｜,
 *   内层是 <invoke name="…"> / <parameter …> / </invoke> / </tool_calls> —— 早期版本按"必须带 DSML"找终止符,
 *   结果永远找不到, 一路吞到流末尾: 内容被删干净了, 却从没构成"块结束", 回填也就无从触发(2026-10-16 实测)。 */
const DSML_CLOSE_CALLS = /<\/(?:[^>]*[｜|][^>]*)?(?:tool_)?calls>/i;
const DSML_CLOSE_INVOKE = /<\/(?:[^>]*[｜|][^>]*)?invoke>/i;
const DSML_ANY_TAG = /<[^>]*DSML[^>]*>/i;
const DSML_BAR_KEY = /<[^>]*[｜|][^>]*(?:calls|invoke|parameter)\b/i;        // ③ 的通用识别(竖线+关键字)
const DSML_BLOCK_TAG = /<\/?(?:[^>]*[｜|][^>]*)?(?:invoke|parameter|tool_calls|calls)\b[^>]*>/i;   // 块内/块尾标签
const DSML_INVOKE_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?invoke>/ig;
const DSML_PARAM_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?parameter\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?parameter>/ig;
const DSML_ATTR_NAME = /name\s*=\s*[\"']([^\"']+)[\"']/i;
const DSML_CALLS_TAG = /<\/?[^>]*[｜|][^>]*(?:tool_)?calls>/ig;
/* 文本态调用 → [{name, arguments}]。值按原样取字符串; 若整段是 JSON 对象/数组则解析为对象
 * (MCP 工具有的期望对象参数)。解析不出来返回 null。 */
function dsmlParseCall(block) {
  if (!block) return null;
  /* ★不再强制要求块内出现 "DSML": 上游变体会写成裸 tag(tool_calls/invoke/parameter), 甚至整块只是 JSON。
   *   只要求"结构上像一次调用"(含 invoke/parameter/tool_calls 标签, 或有 name= 属性), 否则不碰。 */
  const _raw = String(block);
  if (!/<(?![\/])(?:[^>]*[｜|][^>]*)?(?:invoke|function|tool|call|parameter|tool_calls|calls)\b/i.test(_raw)
      && !/name\s*=\s*["']/.test(_raw)) return null;
  const body = String(block).replace(DSML_CALLS_TAG, '');
  const out = [];
  DSML_INVOKE_ANY.lastIndex = 0;
  let m;
  while ((m = DSML_INVOKE_ANY.exec(body))) {
    const nm = DSML_ATTR_NAME.exec(m[1] || '');
    if (!nm) continue;
    const inner = m[2] || '';
    const args = {};
    DSML_PARAM_ANY.lastIndex = 0;
    let p;
    while ((p = DSML_PARAM_ANY.exec(inner))) {
      const pn = DSML_ATTR_NAME.exec(p[1] || '');
      if (!pn) continue;
      let v = String(p[2] == null ? '' : p[2]).trim();
      const t0 = v.charAt(0);
      if (t0 === '{' || t0 === '[') { try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (_) {} }
      args[pn[1]] = v;
    }
    out.push({ name: nm[1], arguments: JSON.stringify(args) });
  }
  if (out.length) return out;
  return dsmlParseCallLoose(body);       // ② 宽松兜底: 缺 </invoke> / 自闭合 / 裸 JSON 形态
}
/* ② 宽松兜底 —— 专门对付"结构不完整"的上游变体(小概率出现, 实测会造成整块被丢弃=空白):
 *     a) 模型漏写 </invoke> 或用了自闭合 <invoke name="x"/> → 标准配对正则配不上;
 *     b) <parameter …> 同样可能漏写 </parameter>;
 *     c) 整块其实是 JSON: {"name":"x","arguments":{…}} / [{"name":…}] / {"tool_calls":[…]}
 *   这里不再要求成对闭合: 取块内第一个 invoke/function/tool/call 标签的 name= 当函数名, 其后所有 parameter 归它。 */
function dsmlParseCallLoose(body) {
  const args = dsmlLooseParams(body);
  const nameTag = /<(?![\/])(?:[^>]*[｜|][^>]*)?(?:invoke|function|tool|call)\b([^>]*)>/i.exec(body);
  let name = null;
  if (nameTag) { const nm = DSML_ATTR_NAME.exec(nameTag[1] || ''); if (nm) name = nm[1]; }
  if (name) return [{ name, arguments: JSON.stringify(args || {}) }];
  const jm = /\{[\s\S]*\}/.exec(body);
  if (jm) {
    try {
      let j = JSON.parse(jm[0]);
      if (j && !Array.isArray(j) && j.tool_calls) j = j.tool_calls;
      const arr = Array.isArray(j) ? j : (j && j.name ? [j] : null);
      if (arr && arr.length) {
        const o = [];
        for (const it of arr) {
          if (!it || !it.name) continue;
          const a = it.arguments != null ? it.arguments : (it.parameters != null ? it.parameters : (it.args != null ? it.args : {}));
          o.push({ name: String(it.name), arguments: typeof a === 'string' ? a : JSON.stringify(a || {}) });
        }
        if (o.length) return o;
      }
    } catch (_) {}
  }
  return null;
}
/* 宽松参数扫描: 不要求 </parameter> 闭合 —— 一个 <parameter …> 到下一个 <parameter 或块尾算它的值 */
function dsmlLooseParams(body) {
  const re = /<(?![\/])(?:[^>]*DSML[^>]*)?parameter\b([^>]*)>/ig;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ attrs: m[1] || '', start: m.index + m[0].length });
  if (!marks.length) return null;
  const args = {};
  for (let i = 0; i < marks.length; i++) {
    const pn = DSML_ATTR_NAME.exec(marks[i].attrs);
    if (!pn) continue;
    let end;
    if (i + 1 < marks.length) {
      const k = body.lastIndexOf('<', marks[i + 1].start);
      end = (k > marks[i].start) ? k : marks[i + 1].start;
    } else end = body.length;
    let v = body.slice(marks[i].start, end)
                  .replace(/<\/(?:[^>]*?)(?:parameter|invoke|tool_calls|calls)>/ig, '')
                  .trim();
    const t0 = v.charAt(0);
    if (t0 === '{' || t0 === '[') { try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (_) {} }
    args[pn[1]] = v;
  }
  return Object.keys(args).length ? args : null;
}
/* 回填闸: 函数名必须命中客户端本次声明的工具, 否则不回填(防"讨论 DSML 语法"被凭空造出一次调用) */
/* ★留证: 任何"吞掉了标记块却没回填"的情况都写一行到 log/dsml-miss.log
 *   (默认开; AGW_DSML_MISS_LOG=off 可关, 也可指定绝对路径)。写盘失败自动闭嘴, 不影响主流程。 */
let _dsmlMissOff = false;
function dsmlMissPath() {
  try {
    return process.env.AGW_DSML_MISS_LOG || (((typeof __dirname !== 'undefined') ? __dirname : '.') + '/data/log/dsml-miss.log');
  } catch (_) { return './data/log/dsml-miss.log'; }
}
function dsmlMissDump(reason, raw, extra) {
  try {
    if (_dsmlMissOff || process.env.AGW_DSML_MISS_LOG === 'off') return;
    const p = dsmlMissPath();
    try { fs.mkdirSync(p.replace(/\/[^\/]*$/, ''), { recursive: true }); } catch (_) {}
    fs.appendFileSync(p, JSON.stringify({
      t: new Date().toISOString(), reason, extra: extra == null ? null : String(extra),
      raw: String(raw == null ? '' : raw)
    }) + '\n');
  } catch (_) { _dsmlMissOff = true; }
}
function dsmlNormName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
/* 回填闸: 函数名优先命中客户端本次声明的工具(防"讨论 DSML 语法"被凭空造出一次调用)。
 *   ★2026-10-16 放宽(实测完全同名会因大小写/命名空间差异漏掉 → 整块静默丢失):
 *     完全同名 → 规范化同名 → 单调用兜底(宁可回填也不静默丢正文); 每次放宽/失败都留证。 */
function dsmlPickCall(calls, toolNames) {
  if (!calls || !calls.length) return null;
  if (!toolNames) return null;                                       // 客户端没声明工具 → 不凭空白造
  if (toolNames.size === 0) { dsmlMissDump('pick-no-declared-tools', calls.map(c => c.name).join(','), null); return null; }
  for (const c of calls) if (c && toolNames.has(c.name)) return c;
  for (const c of calls) {
    if (!c || !c.name) continue;
    const n = dsmlNormName(c.name);
    if (!n) continue;
    for (const t of toolNames) {
      const tn = dsmlNormName(t);
      if (tn && (n === tn || n.endsWith(tn) || tn.endsWith(n))) { dsmlMissDump('pick-normalized', c.name, '→ ' + t); return c; }
    }
  }
  if (calls.length === 1) {                                          // 单调用: 名字没对上, 也回填(否则 = 整块丢失)
    dsmlMissDump('pick-single-fallback', calls[0].name, 'declared=' + [...toolNames].join('|'));
    return calls[0];
  }
  dsmlMissDump('pick-rejected', calls.map(c => c.name).join('|'), 'declared=' + [...toolNames].join('|'));
  return null;
}
const DSML_TEXT_FIELD_RE = /^(content|text)$/;                              // 正文类字段
const DSML_THINK_FIELD_RE = /^(reasoning_content|reasoning|thinking)$/;     // 思考类字段

function dsmlNewState(canCall) { return { eat: null, held: '', pool: '', pend: '', polar: false, warned: false, canCall: !!canCall, call: null, openTag: '' }; }
function dsmlActive(st) { return !!(st && (st.pend || st.held || st.eat)); }
/* 喂一个内容片段 → 返回"现在就能发给客户端"的文本(可能为空: 被吞吃或被暂缓)
 * 状态字段:
 *   eat   非空 = 正在吞吃一个标记块('calls' | 'invoke')
 *   pool  已经吞掉、只为 fail-open 时原样放回的块内文本
 *   held  未闭合的标签尾巴(等后续片段把标签补全)
 *   pend  还没定性的尾巴(空白 [+ 半截结束标记]): 若跟着来的是 "</…calls>" 这种块尾, 就一起丢掉
 *   polar = 刚从"块内"出来且是靠内层结束标记兜底的 —— 此阶段才暂缓空白(等到看清是不是块尾)
 */
function dsmlFeed(st, s, final) {
  if (!st) return s == null ? '' : String(s);
  let out = '';
  let buf = st.pend + st.held + (s == null ? '' : String(s));
  st.pend = ''; st.held = '';
  let pos = 0, polarAt = -1;
  for (;;) {
    if (st.eat) {
      const scoped = buf.slice(pos);
      const prim = st.eat === 'calls' ? DSML_CLOSE_CALLS : DSML_CLOSE_INVOKE;
      let m = prim.exec(scoped), fb = false;
      if (!m && st.eat === 'calls') { m = DSML_CLOSE_INVOKE.exec(scoped); fb = !!m; } // 上游漏了外层结束标记时的兜底
      if (!m) {
        /* ★结束标记也会被上游切成多段(</ + ｜DSML｜ + tool_calls>), 吞吃态里必须留一段尾巴参与拼接 ——
         *   整段丢进 pool 的话结束标记永远拼不出来, 块会吃掉后面整条正文(实测复现)。 */
        const keep = Math.min(scoped.length, DSML_TAG_MAX);
        if (scoped.length > keep) st.pool += scoped.slice(0, scoped.length - keep);
        st.held = scoped.slice(scoped.length - keep);
        if (st.pool.length + st.held.length > DSML_BLOCK_MAX) {   // ③ fail-open: 原样放回, 不吞正文
          dsmlMissDump('oversize-failopen', (st.openTag || '') + st.pool + st.held);
          if (!st.warned) { st.warned = true; try { log('[dsml] 吞吃 ' + (st.pool.length + st.held.length) + ' 字符仍未见结束标记, 判定为正文, 原样放行'); } catch (_) {} }
          out += (st.openTag || '') + st.pool + st.held; st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null;
        }
        break;
      }
      const blockTxt = (st.openTag || '') + st.pool + st.held + scoped.slice(0, m.index + m[0].length);
      if (st.canCall) {                                   // 正文里的标记块 → 先解析(回填要用), 再丢弃
        let cs = null;
        try { cs = dsmlParseCall(blockTxt); } catch (e) { dsmlMissDump('parse-throw', blockTxt, e && e.message); }
        if (cs) st.call = (st.call || []).concat(cs);
        else dsmlMissDump('block-unparsed', blockTxt, fb ? 'closed-by-</invoke>' : null);   // ★不静默丢: 留证
      }
      buf = scoped.slice(m.index + m[0].length);          // 整块(含结束标记)丢弃
      st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null; st.polar = fb; pos = 0;
      if (fb) polarAt = out.length;
      continue;
    }
    let i = buf.indexOf('<', pos);
    const iF = buf.indexOf('＜', pos);
    if (iF >= 0 && (i < 0 || iF < i)) i = iF;    // ★全角左括号也算标签起点(防漏)
    if (i < 0) {
      const t = buf.slice(pos);
      const ws = st.polar ? (/[ \t\r\n]+$/.exec(t) || [''])[0] : '';
      if (ws && ws.length <= DSML_WS_MAX) { out += t.slice(0, t.length - ws.length); st.pend = ws; }
      else out += t;
      break;
    }
    const pre = buf.slice(pos, i);
    const j = buf.indexOf('>', i);
    if (j < 0) {
      const ws = st.polar ? (/[ \t\r\n]+$/.exec(pre) || [''])[0] : '';
      out += ws ? pre.slice(0, pre.length - ws.length) : pre;
      if (buf.length - i > DSML_TAG_MAX) { out += buf.slice(i); break; }   // 长不成标签 → 放行
      st.pend = ws;                                                      // 空白要排在标签前面
      st.held = buf.slice(i);                                            // 未闭合: 暂缓, 等后续片段补全
      break;
    }
    const tag = buf.slice(i, j + 1);
    const isDsml = DSML_ANY_TAG.test(tag) || DSML_BAR_KEY.test(tag) || DSML_BLOCK_TAG.test(tag);   // ★裸的 calls/invoke/parameter 也算标记(宁可误吞, 绝不让标记漏给客户端)
    if (isDsml && tag.charAt(1) === '/') {                 // 孤立的块结束标记 → 连同它前面的空白一起丢
      out += st.polar ? pre.replace(/[ \t\r\n]+$/, '') : pre;
      pos = j + 1;
      continue;
    }
    out += pre;
    if (!isDsml) {
      /* ② 全裸方言(<tool_calls> 连竖线都没有): 按设计不放行开始标记(怕吃掉正文里对格式的讨论), 但留证 */
      if (!st.bareWarn && /^<\/?(?:tool_)?calls>$/i.test(tag)) {
        st.bareWarn = true;
        dsmlMissDump('bare-open-tag-leak', buf.slice(i, i + 240), '无前缀开始标记(疑似②全裸方言)');
      }
      out += tag; pos = j + 1; continue;
    }   // 普通标签(<div>、"a < b") → 原样    // 普通标签(<div>、"a < b>") → 原样
    st.polar = false;
    if (DSML_OPEN_CALLS.test(tag) || DSML_OPEN_CALLS_WEAK.test(tag)) { st.eat = 'calls'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    if (DSML_OPEN_INVOKE.test(tag)) { st.eat = 'invoke'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    pos = j + 1; continue;                                 // 其它孤立的 DSML 标签 → 丢掉
  }
  if (st.polar && polarAt >= 0 && /\S/.test(out.slice(polarAt))) st.polar = false; // 已发出非空白内容 → 不再是"块尾阶段"
  if (final) {
    if (st.eat) {                                          // ④ 流结束时仍在块内(上游截断)
      const tail = (st.openTag || '') + st.pool + st.held;
      let cs = null;                                       // ★截断也别直接丢: 能拼出调用就回填(小概率变体的主要空白来源)
      try { cs = dsmlParseCall(tail); } catch (_) {}
      if (cs) st.call = (st.call || []).concat(cs);
      else if (tail.trim()) dsmlMissDump('truncated-drop', tail, 'len=' + tail.length);
      if (!st.warned) {
        st.warned = true;
        try { log('[dsml] 流结束标记块仍未闭合(上游截断), ' + (cs ? '已尽力回填 ' + cs.length + ' 个调用' : '已丢弃 ' + tail.length + ' 字符')); } catch (_) {}
      }
      st.pool = ''; st.held = ''; st.pend = ''; st.eat = null; st.openTag = '';
    } else {
      const orphan = st.pend + st.held;
      /* ★流结束时释放的"未闭合尾巴"若是标记族(<…calls/invoke/parameter 或含 ｜/|/＜), 绝不能当正文发出去 ——
       *   全角 ’＞’ 会让标签永远"未闭合", 收尾时把 <｜ calls> 原样漏给客户端(2026-10-16 用户实锤)。 */
      if (orphan && /(?:<|＜)[^]{0,80}(?:calls|invoke|parameter)\b|(?:<|＜)[^]{0,40}[｜|＜]/.test(orphan)) {
        dsmlMissDump('orphan-tag-released', orphan, 'hex=' + Buffer.from(orphan, 'utf8').toString('hex').slice(0, 300));
      } else if (orphan) out += orphan;                    // 未闭合的普通尾巴当正文发出(不丢字)
      st.pend = ''; st.held = '';
    }
  }
  return out;
}
/* 清洗后这条流式分块是否已经"什么都不剩"(没有 delta 内容、没有 finish_reason/usage/message) */
function dsmlChunkPayloadEmpty(j) {
  const cs = j && j.choices;
  if (!Array.isArray(cs) || !cs.length) return false;
  if (j.usage != null || j.error != null) return false;
  for (const c of cs) {
    if (!c || typeof c !== 'object') return false;
    if (c.finish_reason) return false;
    if (c.message) return false;
    const d = c.delta;
    if (d && typeof d === 'object' && Object.keys(d).length) return false;
  }
  return true;
}
/* 按字段路径(choices[0].delta.content 这种)各自一个状态机, 清洗响应对象里的正文/思考字段。
 * 只动白名单字段 —— role/id/model/finish_reason/tool 参数一律不碰。返回是否发生过改写。 */
function dsmlCleanRespObj(j, states, final, withReasoning) {
  let changed = false;
  const walk = (v, path, depth) => {
    if (v == null || depth > 8) return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']', depth + 1); return; }
    if (typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      const val = v[k];
      const p = path ? path + '.' + k : k;
      if (typeof val !== 'string') { walk(val, p, depth + 1); continue; }
      const isText = DSML_TEXT_FIELD_RE.test(k);
      const isThink = withReasoning && DSML_THINK_FIELD_RE.test(k);
      if (!isText && !isThink) continue;
      const st = states.get(p);
      if (val.indexOf('<') < 0 && !dsmlActive(st)) continue;   // 快路径: 没 '<' 且状态空闲 → 不建状态、不解析
      const s2 = st || dsmlNewState(isText);
      if (!st) states.set(p, s2);
      const nt = dsmlFeed(s2, val, final);
      if (nt !== val) {
        changed = true;
        /* ★清洗后只剩空白(整条 delta 就是标记 ± 换行) → 字段直接去掉。
         *   留着 content:"" 会让客户端在"思考"和"工具调用"之间多插一段空正文(2026-10-16 实测复现)。 */
        if (nt.trim() === '' && p.indexOf('.delta.') >= 0) delete v[k];
        else v[k] = nt;
      }
    }
  };
  walk(j, '', 0);
  return changed;
}
/* canonical 事件层清洗(跨格式转换路径): 正文/思考各自一个状态机, tool_* 事件原样透传 */
function wrapDsmlClean(writer, cleanText, cleanReasoning, opts) {
  const toolNames = (opts && opts.toolNames) || null;
  const onDiag = (opts && opts.onDiag) || null;
  const stText = cleanText ? dsmlNewState(true) : null;
  const stThink = cleanReasoning ? dsmlNewState(false) : null;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };
  let pending = null, sawTool = false, diagDone = false;
  const collect = (st) => {
    if (st && st.call) {
      stat.blocks += st.call.length;
      for (const c of st.call) stat.names.push(c.name);
      pending = (pending || []).concat(st.call);
      st.call = null;
    }
  };
  const feed = (st, t) => {
    if (!st) return t == null ? '' : t;
    if ((t == null || t === '') && !dsmlActive(st)) return t == null ? '' : t;
    if (t && t.indexOf('<') < 0 && !dsmlActive(st)) return t;
    return dsmlFeed(st, t, false);
  };
  return {
    onEvent(ev) {
      if (!ev) return;
      if (ev.type === 'text') {
        const raw = ev.t == null ? '' : String(ev.t);
        if (raw && raw.indexOf('DSML') >= 0) stat.dsmlSeen = true;
        const t = feed(stText, ev.t);
        stat.content++;
        if (t !== raw) stat.emptied++;
        collect(stText);
        if (t) writer.onEvent({ type: 'text', t });
        return;
      }
      if (ev.type === 'reasoning') { stat.reasoning++; const t = feed(stThink, ev.t); if (t) writer.onEvent({ type: 'reasoning', t }); return; }
      if (ev.type === 'tool_start' || ev.type === 'tool_delta') { sawTool = true; stat.structured++; writer.onEvent(ev); return; }
      if (ev.type === 'end') {
        const t = stText ? dsmlFeed(stText, '', true) : '';
        collect(stText);
        if (t) writer.onEvent({ type: 'text', t });
        const r = stThink ? dsmlFeed(stThink, '', true) : '';
        if (r) writer.onEvent({ type: 'reasoning', t: r });
        stat.finishIn = ev.finish_reason || 'stop';
        if (pending && toolNames && !sawTool) {                     // ★回填
          const pick = dsmlPickCall(pending, toolNames);
          if (pick) {
            writer.onEvent({ type: 'tool_start', i: 0, id: randId('call_dsml_'), name: pick.name });
            writer.onEvent({ type: 'tool_delta', i: 0, s: pick.arguments });
            if (!ev.finish_reason || ev.finish_reason === 'stop') ev.finish_reason = 'tool_calls';
            stat.backfill = 'no-structured-call→tool_calls';
          } else stat.backfill = 'parsed-call-not-in-declared-tools';
        } else if (sawTool) stat.backfill = 'already-has-structured-call';
        pending = null;
        stat.finishOut = ev.finish_reason || 'stop';
        if (!diagDone) { diagDone = true; if (onDiag) onDiag(stat); }
        writer.onEvent(ev);
        return;
      }
      writer.onEvent(ev);
    },
  };
}
/* 直通路径改写管道(2026-10-15): 同时承载 inc 文本替换与内置 DSML 清洗
 * ★收尾(末行残留 + 状态机残留)全在本管道内做: 上游最后一行没有换行时也不会丢字(旧版先 res.end() 会丢)。
 * ★只在真的需要改写时才重新序列化那一行, 其余行逐字节原样透传。 */
/* ---- DSML 诊断日志(碰一下 <实例目录>/.dsml-diag 才记; 只记"形状", 不记正文) ----
 * 目的: 排查"文本态调用/空分块/回填有没有发生"——记录每轮响应的字段块数、是否见到 DSML、
 * 解析出的函数名、结构化调用数、finish 进出值、是否回填。不写任何正文内容。 */
let dsmlDiagCache = { t: 0, on: false, file: null };
function dsmlDiagOn(cfg) {
  if (Date.now() - dsmlDiagCache.t < 5000) return dsmlDiagCache.on;
  let on = false, file = null;
  try {
    const dir = cfgDirOf(cfg);
    on = fs.existsSync(path.join(dir, '.dsml-diag'));
    file = path.join(dir, 'log', 'dsml-diag.log');
  } catch (_) {}
  dsmlDiagCache = { t: Date.now(), on: on, file: file };
  return on;
}
function dsmlDiag(cfg, rec) {
  try {
    if (!dsmlDiagOn(cfg) || !dsmlDiagCache.file) return;
    fs.mkdirSync(path.dirname(dsmlDiagCache.file), { recursive: true });   // 没有 log 目录时建出来, 否则静默失败
    fs.appendFileSync(dsmlDiagCache.file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, rec)) + '\n');
  } catch (_) {}
}

function makeDirectPipe(res, rpInc, dsmlOn, dsmlThink, isStream, opts) {
  const u8 = utf8();
  const states = new Map();
  const toolNames = (opts && opts.toolNames) || null;   // 客户端本次声明的工具名(回填必须命中它)
  const onDiag = (opts && opts.onDiag) || null;
  let buf = '', lastObj = null, closed = false, pending = null, sawDone = false, ring = [], wireLogged = false;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };
  const anyActive = () => { for (const st of states.values()) if (dsmlActive(st)) return true; return false; };
  /* 以最后一条分块为模板造一条 tool_calls 分块发出去 */
  const writeEvent = (deltaObj, ci) => {
    try {
      const t = lastObj ? JSON.parse(JSON.stringify(lastObj)) : { object: 'chat.completion.chunk', choices: [] };
      delete t.usage;
      t.choices = [{ index: ci || 0, delta: deltaObj, finish_reason: null }];
      res.write('data: ' + JSON.stringify(t) + '\n\n');
    } catch (_) {}
  };
  const emitCalls = (calls, ci) => {
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      writeEvent({ tool_calls: [{ index: k, id: randId('call_dsml_'), type: 'function', function: { name: c.name, arguments: '' } }] }, ci);
      writeEvent({ tool_calls: [{ index: k, function: { arguments: c.arguments } }] }, ci);
    }
  };
  const collect = () => {
    let out = null;
    for (const st of states.values()) if (st.call) { out = (out || []).concat(st.call); st.call = null; }
    if (out) { stat.blocks += out.length; for (const c of out) stat.names.push(c.name); pending = (pending || []).concat(out); }
  };
  const lineOut = (line) => {
    let out = rpInc.length ? rpApplyText(line, rpInc) : line;
    if (dsmlOn && out.length >= 6 && out.slice(0, 6) === 'data: ') {
      const bodyTxt = out.slice(6);
      if (bodyTxt === '[DONE]') sawDone = true;
      ring.push(bodyTxt); if (ring.length > 12) ring.shift();   // ★留证环: 截断/孤儿标记时把最后几个上游载荷一起落盘
      /* ★线缆采样: 每流第一条带 calls/invoke/parameter 字样的上游载荷原文+hex 落盘 ——
       *   用于抓"客户端能看到的漏网标记"的确切字节(全角括号/特殊前缀等变体), 2026-10-16 */
      if (!wireLogged && bodyTxt.length < 3000 && /calls\b|invoke\b|parameter\b/i.test(bodyTxt)) {
        wireLogged = true;
        dsmlMissDump('wire-chunk-sample', bodyTxt, 'hex=' + Buffer.from(bodyTxt, 'utf8').toString('hex').slice(0, 500));
      }
      /* ★快路径: 只在"可能有标记/需要判断结构化调用"的分块上解析 JSON。
       *   早期版本只认 '<' → 携带 tool_calls/finish_reason 的分块被跳过, 导致
       *   闸门失效(重复回填) + 上游的 finish=stop 先发出去(实测, 2026-10-16)。 */
      if (bodyTxt !== '[DONE]' && (anyActive() || bodyTxt.indexOf('<') >= 0
          || bodyTxt.indexOf('tool_calls') >= 0 || bodyTxt.indexOf('finish_reason') >= 0 || bodyTxt.indexOf('"usage"') >= 0)) {
        const j = safeParse(bodyTxt);
        if (j && typeof j === 'object') {
          lastObj = j;
          let dirty = false;
          try { dirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
          if (dirty) { stat.emptied++; if (/DSML/i.test(bodyTxt)) stat.dsmlSeen = true; }
          collect();
          const chs = Array.isArray(j.choices) ? j.choices : [];
          for (let ci = 0; ci < chs.length; ci++) {
            const ch = chs[ci] || {};
            const d = ch.delta || {};
            if (d && typeof d === 'object') {
              if ('reasoning_content' in d || 'reasoning' in d) stat.reasoning++;
              if ('content' in d) stat.content++;
            }
            if (Array.isArray(d.tool_calls) && d.tool_calls.length) stat.structured++;
            if (ch.finish_reason) {
              stat.finishIn = ch.finish_reason;
              if (pending && toolNames && !stat.structured) {          // ★回填: 该响应没有结构化调用时才用文本态调用顶替
                const pick = dsmlPickCall(pending, toolNames);
                if (pick) {
                  try { emitCalls([pick], ci); } catch (_) {}
                  if (ch.finish_reason === 'stop') { ch.finish_reason = 'tool_calls'; dirty = true; }
                  stat.backfill = 'no-structured-call→tool_calls';
                } else stat.backfill = 'parsed-call-not-in-declared-tools';
              } else if (stat.structured) stat.backfill = 'already-has-structured-call';
              pending = null;
              stat.finishOut = ch.finish_reason;
            }
          }
          if (dirty) {
            if (dsmlChunkPayloadEmpty(j)) return;                      // 整条分块就是被清掉的标记 → 不发
            out = 'data: ' + JSON.stringify(j);
          }
        }
      }
    }
    try { res.write(out + '\n'); } catch (_) {}
  };
  return {
    push(c) {
      try {
        const s2 = u8(c);
        if (!isStream) { buf += s2; return; }
        buf += s2;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) lineOut(l);
      } catch (e) { logErr('[dsml] 流式改写失败:', e.message); }
    },
    end() {
      if (closed) return; closed = true;
      try {
        let tail = buf; buf = '';
        if (rpInc.length) tail = rpApplyText(tail, rpInc);
        if (dsmlOn && tail) {
          if (isStream) {                                   /* 末行残留(上游没给结尾换行) */
            const bodyTxt = tail.slice(0, 6) === 'data: ' ? tail.slice(6) : null;
            const j = (bodyTxt && bodyTxt !== '[DONE]') ? safeParse(bodyTxt) : undefined;
            if (j && typeof j === 'object') {
              lastObj = j;
              let dirty = false;
              try { dirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
              collect();
              if (dirty) tail = dsmlChunkPayloadEmpty(j) ? '' : 'data: ' + JSON.stringify(j);
            }
          } else {                                          /* 非流式: 整份 JSON 一次清洗 + 回填 */
            const j = safeParse(tail);
            if (j && typeof j === 'object') {
              lastObj = j;
              let dirty = false;
              try { dirty = dsmlCleanRespObj(j, states, true, dsmlThink); } catch (_) {}
              collect();
              stat.content++;
              const msg = (Array.isArray(j.choices) && j.choices[0] && j.choices[0].message) || null;
              if (msg && pending && toolNames && !(Array.isArray(msg.tool_calls) && msg.tool_calls.length)) {
                const pick = dsmlPickCall(pending, toolNames);
                if (pick) {
                  msg.tool_calls = [{ id: randId('call_dsml_'), type: 'function', function: { name: pick.name, arguments: pick.arguments } }];
                  if (!j.choices[0].finish_reason || j.choices[0].finish_reason === 'stop') j.choices[0].finish_reason = 'tool_calls';
                  stat.finishIn = stat.finishIn || 'stop';
                  stat.finishOut = j.choices[0].finish_reason;
                  stat.backfill = 'no-structured-call→tool_calls';
                  dirty = true;
                }
              }
              pending = null;
              if (dirty) tail = JSON.stringify(j);
            }
          }
        }
        if (tail) { try { res.write(tail); } catch (_) {} }
        if (dsmlOn && isStream) {
          if (pending && toolNames && !stat.structured) {              /* 流末尾没等到 finish 分块 → 补发调用 */
            const pick = dsmlPickCall(pending, toolNames);
            if (pick) {
              try {
                emitCalls([pick], 0);
                const fin = Object.assign({}, lastObj || {});
                delete fin.usage;
                fin.choices = [{ index: 0, delta: {}, finish_reason: 'tool_calls' }];
                res.write('data: ' + JSON.stringify(fin) + '\n\n');
              } catch (_) {}
              stat.backfill = stat.backfill || 'end-of-stream→tool_calls';
              stat.finishOut = stat.finishOut || 'tool_calls';
            }
          }
          pending = null;
          const wasActive = anyActive();                                  /* ★流结束时状态机还挂着(截断/孤儿标记) → 把最后几个上游载荷与 finish_reason 留证 */
          const extra = [];                                            /* 暂缓的未闭合标签补一条 delta, 不丢字 */
          for (const st of states.values()) { const t = dsmlFeed(st, '', true); if (t) extra.push(t); }
          if (wasActive) {
            const fin = (lastObj && lastObj.choices && lastObj.choices[0]) ? lastObj.choices[0].finish_reason : null;
            dsmlMissDump('pipe-final-active', 'finish_reason=' + String(fin) + ' lastObj=' + String(lastObj && JSON.stringify(lastObj)).slice(0, 300) + '\n---lastN---\n' + ring.join('\n'), 'seenDone=' + sawDone);
          }
          if (extra.length && lastObj && Array.isArray(lastObj.choices) && lastObj.choices[0]) {
            for (const t of extra) {
              const tmpl = JSON.parse(JSON.stringify(lastObj));
              tmpl.choices = [{ index: 0, delta: { content: t }, finish_reason: null }];
              try { res.write('data: ' + JSON.stringify(tmpl) + '\n'); } catch (_) {}
            }
          }
        }
        if (onDiag) onDiag(stat);
      } catch (e) { logErr('[dsml] 收尾失败:', e.message); }
      if (isStream && !sawDone) { try { res.write('data: [DONE]\n\n'); } catch (_) {} }   // ★上游断流/被掐时也补 [DONE], 客户端才不把它当"未完成"
      try { res.end(); } catch (_) {}
    },
  };
}

function dsmlExtractCall(t) {  // 非流式/跨格式: 从一段完整文本里抽取文本态调用
  if (typeof t !== 'string' || t.indexOf('DSML') < 0) return null;
  const st = dsmlNewState(true);
  try { dsmlFeed(st, t, true); } catch (_) {}
  return st.call || null;
}
function dsmlCleanText(t) {   // 非流式/跨格式: 一次性清洗一段文本(整段喂入 = final)
  return dsmlFeed(dsmlNewState(), t, true);
}

/* ---- 配置加解密(可选, 由 crypt.js 提供) ---- */
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, DSML_TAG_MAX, DSML_WS_MAX, DSML_BLOCK_MAX, DSML_OPEN_CALLS, DSML_OPEN_CALLS_WEAK, DSML_OPEN_INVOKE, DSML_CLOSE_CALLS, DSML_CLOSE_INVOKE, DSML_ANY_TAG, DSML_BAR_KEY, DSML_BLOCK_TAG, DSML_INVOKE_ANY, DSML_PARAM_ANY, DSML_ATTR_NAME, DSML_CALLS_TAG, dsmlParseCall, dsmlParseCallLoose, dsmlLooseParams, _dsmlMissOff, dsmlMissPath, dsmlMissDump, dsmlNormName, dsmlPickCall, DSML_TEXT_FIELD_RE, DSML_THINK_FIELD_RE, dsmlNewState, dsmlActive, dsmlFeed, dsmlChunkPayloadEmpty, dsmlCleanRespObj, wrapDsmlClean, dsmlDiagCache, dsmlDiagOn, dsmlDiag, makeDirectPipe, dsmlExtractCall, dsmlCleanText };
