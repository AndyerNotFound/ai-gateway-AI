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

// ================= 小工具(原 gateway.js 内联) =================
const VERSION = '1.4.8';

/* ================= 小工具 ================= */
function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }

const { StringDecoder } = require('string_decoder');
/* ★跨分块安全解码（2026-09-18）：多字节字符被 TCP 分块切断时，逐块 toString('utf8') 会解出
 *  U+FFFD 乱码（响应流/请求体都会中招，只取决于分块时机）。用法：const u8 = utf8(); buf += u8(chunk); */
function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }

/* ★HTTP 响应头值只能是 Latin-1：渠道名若是中文(如 "Guili公益")，写进
 *  X-AI-Gateway-Channel 会让 res.writeHead() 抛 ERR_INVALID_CHAR；这里原本用
 *  `catch (_) { return; }` 把异常吞了 → 请求既不回客户端也不读上游，永久悬挂
 *  (2026-09-18 在 ai-gateway-core 上实测复现)。统一百分号编码，decodeURIComponent 可还原。 */
function hdrName(s) {
  const t = String(s == null ? '' : s);
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) { out += ch; continue; }
    let b;
    if (cp < 0x800) b = [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    else if (cp < 0x10000) b = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    else b = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    for (const x of b) out += '%' + x.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function randId(prefix) { return prefix + crypto.randomBytes(10).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

/* ---- 文本替换(用户自定义正则规则, config.replace = {out:[{re,to,ci}],inc:[...]}) ---- */
function rpCompile(rules) {
  const out = [];
  for (const r of (rules || [])) {
    if (!r || !r.re) continue;
    try { out.push({ re: new RegExp(r.re, (r.ci ? 'i' : '') + 'g'), to: String(r.to == null ? '' : r.to) }); } catch (_) {}
  }
  return out;
}
function rpApplyText(s, rules) {
  for (const r of rules) s = s.replace(r.re, r.to);
  return s;
}
function rpWalk(v, rules, depth, skipModel) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules); // data:URL 不动(护图片)
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue; // 不动 model 字段, 保护路由
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}

/* ---- 内置 DSML 工具调用标记清洗(2026-10-15) ----
 * 现象: 部分模型(DeepSeek 与 NVIDIA NIM 上的衍生版等)会在正文里**额外**打印一份工具调用标记文本
 *   <｜DSML｜tool_calls> / <｜DSML｜invoke name="..."> / <｜DSML｜parameter name="...">…</…>
 *   上游同时也给出结构化 tool_calls → 客户端把这段内部标记当正文显示, 思考链与工具调用看着不连贯。
 * 做法: 正文/思考各自独立的极小状态机(按字段隔离 —— 一个字段里没闭合的标记绝不吃掉另一个字段的内容):
 *   ① 未吞吃: 只盯"最后一个还没闭合的 '<'"; 它可能是标记开头 → 暂缓发出(最多 DSML_TAG_MAX 字符),
 *      标签一旦闭合且不含 DSML 就原样吐出 → 普通文本逐字节透传, 无额外缓冲;
 *   ② 见到 DSML 起始标记(…calls> / …invoke …) → 进入吞吃态, 直到配对结束标记(…calls> 优先, …invoke> 兜底);
 *   ③ 吞吃态攒满 DSML_BLOCK_MAX 仍未见结束标记 → 判定"用户就是在讨论这个标记", **原样放回**(fail-open), 绝不吞正文;
 *   ④ 流结束时仍在吞吃态(标记被上游截断) → 丢弃: 内部标记绝不透给用户。
 * 代价: 无标记的普通响应只多一次 indexOf('<'), 零缓冲零延迟。
 */
function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
  }
  return '';
}
function normStop(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.length ? v.map(String) : undefined;
  return [String(v)];
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, VERSION, ts, log, logErr, utf8, hdrName, randId, nowSec, safeParse, rpCompile, rpApplyText, rpWalk, toText, normStop };
