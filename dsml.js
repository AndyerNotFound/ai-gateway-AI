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

// ================= DSML tool-call parsing/scrubbing (formerly inlined in gateway.js) =================
const DSML_TAG_MAX = 256;      // max believable length of a single tag (longer = treat as plain text)
const DSML_WS_MAX = 1024;      // max trailing whitespace deferred (beyond that, just release)
const DSML_BLOCK_MAX = 65536;  // max characters swallowed per markup block (beyond that, fail open)
/* Markup prefix dialects (three observed): (1) the bar with DSML in it (2) fully bare <invoke ...> (3) only the bar left, like <|tool_calls>.
 *   (1)(2) are recognized by tag name; (3) requires "bar before the keyword" so content like <div data-k="a|b"> is not misread as markup. */
const DSML_OPEN_CALLS = /<(?![\/])[^>]*DSML[^>]*(?:tool_)?calls>/i;         // (1) DSML-bearing is authoritative (avoids eating content)
const DSML_OPEN_CALLS_WEAK = /<(?![\/])[^>]*[｜|][^>]*(?:tool_)?calls>/i;   // (3) no DSML text left, only the bar prefix
const DSML_OPEN_INVOKE = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b[^>]*>/i;
/* *Closing tags / inner tags may appear bare without the DSML prefix: verified that deepseek-v4.1-flash (NIM) only puts the bar on the outer tag,
 *   the inner layer is <invoke name="..."> / <parameter ...> / </invoke> / </tool_calls> -- earlier versions demanded a DSML marker on the terminator,
 *   the terminator was never found, everything got eaten to stream end: content was wiped clean yet never counted as a "block end", so backfill never fired (verified 2026-10-16). */
const DSML_CLOSE_CALLS = /<\/(?:[^>]*[｜|][^>]*)?(?:tool_)?calls>/i;
const DSML_CLOSE_INVOKE = /<\/(?:[^>]*[｜|][^>]*)?invoke>/i;
const DSML_ANY_TAG = /<[^>]*DSML[^>]*>/i;
const DSML_BAR_KEY = /<[^>]*[｜|][^>]*(?:calls|invoke|parameter)\b/i;        // generic (3) recognizer (bar + keyword)
const DSML_BLOCK_TAG = /<\/?(?:[^>]*[｜|][^>]*)?(?:invoke|parameter|tool_calls|calls)\b[^>]*>/i;   // in-block / block-end tag
const DSML_INVOKE_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?invoke\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?invoke>/ig;
const DSML_PARAM_ANY = /<(?![\/])(?:[^>]*[｜|][^>]*)?parameter\b([^>]*)>([^]*?)<\/(?:[^>]*[｜|][^>]*)?parameter>/ig;
const DSML_ATTR_NAME = /name\s*=\s*[\"']([^\"']+)[\"']/i;
const DSML_CALLS_TAG = /<\/?[^>]*[｜|][^>]*(?:tool_)?calls>/ig;
/* Textual call -> [{name, arguments}]. Values are taken as raw strings; if the whole block is a JSON object/array it is parsed as such
 * (some MCP tools expect object arguments). Returns null when unparseable. */
function dsmlParseCall(block) {
  if (!block) return null;
/* *No longer strictly requires "DSML" inside a block: upstream variants emit bare tags (tool_calls/invoke/parameter), or even just JSON.
   *   requires only "structurally call-like" (invoke/parameter/tool_calls tags, or a name= attribute); otherwise untouched. */
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
return dsmlParseCallLoose(body);       // (2) loose fallback: missing </invoke> / self-closing / bare JSON shapes
}
/* (2) Loose fallback -- targets "structurally incomplete" upstream variants (rare, but they demonstrably cause whole blocks to be dropped = blank output):
 *     a) the model omits </invoke> or uses self-closing <invoke name="x"/> -> standard pairing regexes fail;
 *     b) <parameter ...> may likewise omit </parameter>;
 *     c) the whole block is actually JSON: {"name":"x","arguments":{...}} / [{"name":...}] / {"tool_calls":[...]}
 *   paired closing is no longer required: the first invoke/function/tool/call tag's name= in the block becomes the function name, and all parameters after it belong to it. */
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
/* Loose parameter scan: </parameter> is not required -- a parameter's value runs from one <parameter ...> to the next <parameter or the block end */
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
/* Backfill gate: the function name must match a tool the client declared this round, otherwise no backfill (prevents "discussing DSML syntax" from conjuring a call) */
/* *Evidence: every case of "markup block eaten but not backfilled" writes a line to log/dsml-miss.log
 *   (on by default; AGW_DSML_MISS_LOG=off disables, or set an absolute path). Write failures silence it automatically without touching the main flow. */
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
/* Backfill gate: the function name must match a tool the client declared this round (prevents "discussing DSML syntax" from conjuring a call).
 *   *2026-10-16 relaxation (verified: identical names still missed due to case/namespace differences -> whole blocks silently lost):
 *     fully identical names -> normalized names -> single-call fallback (prefer backfill over silently losing content); every relaxation/failure leaves evidence. */
function dsmlPickCall(calls, toolNames) {
  if (!calls || !calls.length) return null;
if (!toolNames) return null;                                       // no tools declared by the client -> conjure nothing
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
if (calls.length === 1) {                                          // single call: backfill even when the name misses (otherwise the whole block is lost)
    dsmlMissDump('pick-single-fallback', calls[0].name, 'declared=' + [...toolNames].join('|'));
    return calls[0];
  }
  dsmlMissDump('pick-rejected', calls.map(c => c.name).join('|'), 'declared=' + [...toolNames].join('|'));
  return null;
}
const DSML_TEXT_FIELD_RE = /^(content|text)$/;                              // content-type fields
const DSML_THINK_FIELD_RE = /^(reasoning_content|reasoning|thinking)$/;     // thinking-type fields

function dsmlNewState(canCall) { return { eat: null, held: '', pool: '', pend: '', polar: false, warned: false, canCall: !!canCall, call: null, openTag: '' }; }
function dsmlActive(st) { return !!(st && (st.pend || st.held || st.eat)); }
/* Feed a content fragment -> returns the text that can go to the client right now (may be empty: eaten or deferred)
 * State fields:
 *   eat   non-empty = currently swallowing a markup block ('calls' | 'invoke')
 *   pool  block text already swallowed, kept only to be returned verbatim on fail-open
 *   held  an unclosed tag tail (waiting for later fragments to complete it)
 *   pend  an unclassified tail (whitespace [+ half a closing tag]): dropped together if a block end like "</...calls>" follows
 *   polar = just exited a block, bailed out by an inner closing tag -- whitespace is deferred only in this phase (until it is clear whether this is a block end)
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
/* *Closing tags also arrive split across chunks (</ + bar + tool_calls>); the eating state must keep a tail fragment for reassembly --
         *   the whole segment went into pool, the closing tag could never be reassembled and the block ate all following content (reproduced). */
        const keep = Math.min(scoped.length, DSML_TAG_MAX);
        if (scoped.length > keep) st.pool += scoped.slice(0, scoped.length - keep);
        st.held = scoped.slice(scoped.length - keep);
if (st.pool.length + st.held.length > DSML_BLOCK_MAX) {   // (3) fail open: put back verbatim, never eat content
          dsmlMissDump('oversize-failopen', (st.openTag || '') + st.pool + st.held);
          if (!st.warned) { st.warned = true; try { log('[dsml] 吞吃 ' + (st.pool.length + st.held.length) + ' 字符仍未见结束标记, 判定为正文, 原样放行'); } catch (_) {} }
          out += (st.openTag || '') + st.pool + st.held; st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null;
        }
        break;
      }
      const blockTxt = (st.openTag || '') + st.pool + st.held + scoped.slice(0, m.index + m[0].length);
if (st.canCall) {                                   // markup block inside content -> parse first (backfill needs it), then drop
        let cs = null;
        try { cs = dsmlParseCall(blockTxt); } catch (e) { dsmlMissDump('parse-throw', blockTxt, e && e.message); }
        if (cs) st.call = (st.call || []).concat(cs);
        else dsmlMissDump('block-unparsed', blockTxt, fb ? 'closed-by-</invoke>' : null);   // ★不静默丢: 留证
      }
buf = scoped.slice(m.index + m[0].length);          // drop the whole block (closing tag included)
      st.pool = ''; st.held = ''; st.openTag = ''; st.eat = null; st.polar = fb; pos = 0;
      if (fb) polarAt = out.length;
      continue;
    }
    let i = buf.indexOf('<', pos);
    const iF = buf.indexOf('＜', pos);
if (iF >= 0 && (i < 0 || iF < i)) i = iF;    // *full-width opening bracket also counts as a tag start (leak prevention)
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
if (buf.length - i > DSML_TAG_MAX) { out += buf.slice(i); break; }   // cannot grow into a tag -> release
st.pend = ws;                                                      // whitespace must precede the tag
st.held = buf.slice(i);                                            // unclosed: defer until later fragments complete it
      break;
    }
    const tag = buf.slice(i, j + 1);
const isDsml = DSML_ANY_TAG.test(tag) || DSML_BAR_KEY.test(tag) || DSML_BLOCK_TAG.test(tag);   // *bare calls/invoke/parameter count as markup (prefer over-eating; markup must never leak to the client)
    if (isDsml && tag.charAt(1) === '/') {                 // 孤立的块结束标记 → 连同它前面的空白一起丢
      out += st.polar ? pre.replace(/[ \t\r\n]+$/, '') : pre;
      pos = j + 1;
      continue;
    }
    out += pre;
    if (!isDsml) {
/* (2) Fully bare dialect (<tool_calls> without even a bar): by design the opening tag is not let through (to avoid eating content that discusses the format), but evidence is kept */
      if (!st.bareWarn && /^<\/?(?:tool_)?calls>$/i.test(tag)) {
        st.bareWarn = true;
        dsmlMissDump('bare-open-tag-leak', buf.slice(i, i + 240), '无前缀开始标记(疑似②全裸方言)');
      }
      out += tag; pos = j + 1; continue;
}   // ordinary tags (<div>, "a < b") -> verbatim    // ordinary tags (<div>, "a < b>") -> verbatim
    st.polar = false;
    if (DSML_OPEN_CALLS.test(tag) || DSML_OPEN_CALLS_WEAK.test(tag)) { st.eat = 'calls'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
    if (DSML_OPEN_INVOKE.test(tag)) { st.eat = 'invoke'; st.pool = ''; st.openTag = tag; pos = j + 1; continue; }
pos = j + 1; continue;                                 // other stray DSML tags -> drop
  }
if (st.polar && polarAt >= 0 && /\S/.test(out.slice(polarAt))) st.polar = false; // non-whitespace emitted -> no longer in the "block-end phase"
  if (final) {
if (st.eat) {                                          // (4) still inside a block at stream end (upstream truncated)
      const tail = (st.openTag || '') + st.pool + st.held;
let cs = null;                                       // *never discard on truncation either: backfill whenever a call can be assembled (the main blank-output source among rare variants)
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
/* *If the "unclosed tail" released at stream end belongs to the markup family (<...calls/invoke/parameter, or containing full/half-width bars), it must never be emitted as content --
       *   full-width '>' keeps a tag "unclosed" forever, leaking <| calls> verbatim to the client at finalization (user-confirmed 2026-10-16). */
      if (orphan && /(?:<|＜)[^]{0,80}(?:calls|invoke|parameter)\b|(?:<|＜)[^]{0,40}[｜|＜]/.test(orphan)) {
        dsmlMissDump('orphan-tag-released', orphan, 'hex=' + Buffer.from(orphan, 'utf8').toString('hex').slice(0, 300));
} else if (orphan) out += orphan;                    // an unclosed ordinary tail goes out as content (no loss)
      st.pend = ''; st.held = '';
    }
  }
  return out;
}
/* Whether the streaming chunk is left with "nothing at all" after scrubbing (no delta content, no finish_reason/usage/message) */
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
/* One state machine per field path (e.g. choices[0].delta.content); scrubs content/thinking fields in the response object.
 * Only whitelisted fields are touched -- role/id/model/finish_reason/tool args are never modified. Returns whether any rewrite happened. */
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
/* *If only whitespace remains after scrubbing (the whole delta was markup +/- newlines) -> drop the field entirely.
         *   keeping content:"" made clients insert an empty content segment between thinking and tool calls (reproduced 2026-10-16). */
        if (nt.trim() === '' && p.indexOf('.delta.') >= 0) delete v[k];
        else v[k] = nt;
      }
    }
  };
  walk(j, '', 0);
  return changed;
}
/* Canonical-event-level scrubbing (cross-format conversion path): one state machine each for content/thinking; tool_* events pass through untouched */
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
if (pending && toolNames && !sawTool) {                     // *backfill
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
/* Passthrough rewrite pipe (2026-10-15): carries both inc text replacement and built-in DSML scrubbing
 * *finalization (trailing partial line + state-machine residue) happens entirely inside this pipe: no bytes are lost even when the upstream's last line lacks a newline (the old res.end()-first version lost them).
 * *only the line that truly needs a rewrite is re-serialized; every other line passes through byte-for-byte. */
/* ---- DSML diagnostics log (records only while <instance-dir>/.dsml-diag exists; logs "shape" only, never content) ----
 * Purpose: diagnosing whether textual calls / empty chunks / backfill happened -- logs per response the field chunk count, whether DSML was seen,
 * the parsed function name, structured call count, finish in/out values, and whether backfill ran. No content is ever written. */
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
fs.mkdirSync(path.dirname(dsmlDiagCache.file), { recursive: true });   // create the log dir when missing, otherwise the write fails silently
    fs.appendFileSync(dsmlDiagCache.file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, rec)) + '\n');
  } catch (_) {}
}

function makeDirectPipe(res, rpInc, dsmlOn, dsmlThink, isStream, opts) {
  const u8 = utf8();
  const states = new Map();
const toolNames = (opts && opts.toolNames) || null;   // tool names the client declared this round (backfill must match one)
  const onDiag = (opts && opts.onDiag) || null;
  let buf = '', lastObj = null, closed = false, pending = null, sawDone = false, ring = [], wireLogged = false;
  const stat = { reasoning: 0, content: 0, emptied: 0, blocks: 0, structured: 0, finishIn: null, finishOut: null, backfill: null, dsmlSeen: false, names: [] };
  const anyActive = () => { for (const st of states.values()) if (dsmlActive(st)) return true; return false; };
/* Synthesize a tool_calls chunk from the last chunk as a template and emit it */
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
ring.push(bodyTxt); if (ring.length > 12) ring.shift();   // *evidence ring: on truncation/orphan markup, persist the last few upstream payloads too
/* *Wire sampling: the first upstream payload per stream containing calls/invoke/parameter is dumped raw + hex to disk --
       *   captures the exact bytes of "markup the client could see" (full-width brackets / special prefixes and other variants), 2026-10-16 */
      if (!wireLogged && bodyTxt.length < 3000 && /calls\b|invoke\b|parameter\b/i.test(bodyTxt)) {
        wireLogged = true;
        dsmlMissDump('wire-chunk-sample', bodyTxt, 'hex=' + Buffer.from(bodyTxt, 'utf8').toString('hex').slice(0, 500));
      }
/* *Fast path: parse JSON only on chunks that might contain markup or need structured-call decisions.
       *   earlier versions only looked for '<' -> chunks carrying tool_calls/finish_reason were skipped, causing
       *   gate failure (duplicate backfill) + the upstream's finish=stop going out first (observed 2026-10-16). */
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
if (pending && toolNames && !stat.structured) {          // *backfill: substitute a textual call only when the response has no structured one
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
if (dsmlChunkPayloadEmpty(j)) return;                      // the whole chunk was scrubbed markup -> send nothing
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
if (isStream) {                                   /* trailing partial line (upstream sent no final newline) */
            const bodyTxt = tail.slice(0, 6) === 'data: ' ? tail.slice(6) : null;
            const j = (bodyTxt && bodyTxt !== '[DONE]') ? safeParse(bodyTxt) : undefined;
            if (j && typeof j === 'object') {
              lastObj = j;
              let dirty = false;
              try { dirty = dsmlCleanRespObj(j, states, false, dsmlThink); } catch (_) {}
              collect();
              if (dirty) tail = dsmlChunkPayloadEmpty(j) ? '' : 'data: ' + JSON.stringify(j);
            }
} else {                                          /* non-streaming: scrub the whole JSON once + backfill */
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
if (pending && toolNames && !stat.structured) {              /* no finish chunk by stream end -> emit the call */
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
const wasActive = anyActive();                                  /* *state machine still attached at stream end (truncation/orphan markup) -> keep the last few upstream payloads and finish_reason as evidence */
const extra = [];                                            /* deferred unclosed tags get a delta appended, no loss */
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

function dsmlExtractCall(t) {  // non-streaming/cross-format: extract textual calls from a complete text
  if (typeof t !== 'string' || t.indexOf('DSML') < 0) return null;
  const st = dsmlNewState(true);
  try { dsmlFeed(st, t, true); } catch (_) {}
  return st.call || null;
}
function dsmlCleanText(t) {   // non-streaming/cross-format: scrub a whole text at once (full input = final)
  return dsmlFeed(dsmlNewState(), t, true);
}

/* ---- Config encryption (optional, provided by crypt.js) ---- */
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, DSML_TAG_MAX, DSML_WS_MAX, DSML_BLOCK_MAX, DSML_OPEN_CALLS, DSML_OPEN_CALLS_WEAK, DSML_OPEN_INVOKE, DSML_CLOSE_CALLS, DSML_CLOSE_INVOKE, DSML_ANY_TAG, DSML_BAR_KEY, DSML_BLOCK_TAG, DSML_INVOKE_ANY, DSML_PARAM_ANY, DSML_ATTR_NAME, DSML_CALLS_TAG, dsmlParseCall, dsmlParseCallLoose, dsmlLooseParams, _dsmlMissOff, dsmlMissPath, dsmlMissDump, dsmlNormName, dsmlPickCall, DSML_TEXT_FIELD_RE, DSML_THINK_FIELD_RE, dsmlNewState, dsmlActive, dsmlFeed, dsmlChunkPayloadEmpty, dsmlCleanRespObj, wrapDsmlClean, dsmlDiagCache, dsmlDiagOn, dsmlDiag, makeDirectPipe, dsmlExtractCall, dsmlCleanText };
