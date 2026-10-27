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
const { logErr } = require('./util');

// ================= 脱敏(redact) =================
const redactCache = require('./redact-cache.js'); // CDC 增量分块缓存: 干净内容只算 hash, 命中跳过正则
const ctxp = require('./ctxp'); // 全局上下文上限(warn/max), 规则由 admin 热推 + 文件变更自检

/* ---- 隐私过滤: 请求体里的密钥/token 替换为 *** ---- */
const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic 风格
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // 文本里粘贴的 Bearer 头
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  return redactCache.redactSmart(s, extra);
}
/* 响应方向过滤开关(实例级 redact.enable 为上限, 再叠加 redact.response;
 * 卡密 redact=false 与请求方向一致, 单卡关闭) */
function respRedactOn(cfg, urlInfo) {
  if (!(cfg && cfg.redact && cfg.redact.enable !== false && cfg.redact.response)) return false;
  return !(urlInfo && urlInfo.userKey && urlInfo.userKey.redact === false);
}
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra); // 跳过 data:URL(图片/音频)
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (depth === 0 && k === 'model') continue;   // 不动模型名, 保护路由
      const val = v[k];
      if (typeof val === 'string' && val && REDACT_FIELD_RE.test(k)) v[k] = '***';
      else v[k] = redactDeep(val, extra, depth + 1);
    }
    return v;
  }
  return v;
}
/* 流式响应过滤: 文本/思考/工具参数各自缓冲, 密钥跨分片也不会漏;
 * 只回压尾部可能继续生长的 token, 其余照常边收边发。 */
function wrapRedactWriter(baseWriter, extra) {
  const textF = redactCache.createStreamFilter(extra);
  const reasF = redactCache.createStreamFilter(extra);
  const toolFs = new Map();
  const send = (ev) => { try { baseWriter.onEvent(ev); } catch (e) { logErr('redact writer error:', e.message); } };
  const flushText = () => { const o = textF.flush(); if (o) send({ type: 'text', t: o }); };
  const flushReas = () => { const o = reasF.flush(); if (o) send({ type: 'reasoning', t: o }); };
  const flushAll = () => {
    flushText(); flushReas();
    for (const [i, f] of toolFs) { const o = f.flush(); if (o) send({ type: 'tool_delta', i, s: o }); }
    toolFs.clear();
  };
  return {
    onEvent(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'text') { const o = textF.push(ev.t); if (o) send({ type: 'text', t: o }); return; }
      if (ev.type === 'reasoning') { const o = reasF.push(ev.t); if (o) send({ type: 'reasoning', t: o }); return; }
      if (ev.type === 'tool_delta') {
        let f = toolFs.get(ev.i);
        if (!f) { f = redactCache.createStreamFilter(extra); toolFs.set(ev.i, f); }
        const o = f.push(ev.s); if (o) send({ type: 'tool_delta', i: ev.i, s: o });
        return;
      }
      if (ev.type === 'end') { flushAll(); send(ev); return; }
      flushText(); flushReas(); send(ev);   // start/tool_start/usage: 先冲暂存, 保事件顺序
    },
  };
}
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, redactCache, ctxp, REDACT_PATTERNS, REDACT_FIELD_RE, redactText, respRedactOn, redactDeep, wrapRedactWriter };
