
















'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const admin = require('./admin');
const { handleAdmin } = admin;

const VERSION = '1.4.3';


function ts() { return new Date().toISOString().slice(11, 19); }
function log(...a) { console.log('[' + ts() + ']', ...a); }
function logErr(...a) { console.error('[' + ts() + ']', ...a); }

const { StringDecoder } = require('string_decoder');


function utf8() { const sd = new StringDecoder('utf8'); return (buf) => sd.write(buf); }





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
  if (typeof v === 'string') return v.startsWith('data:') ? v : rpApplyText(v, rules); 
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = rpWalk(v[i], rules, depth + 1, skipModel); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (skipModel && k === 'model') continue; 
      v[k] = rpWalk(v[k], rules, depth + 1, skipModel);
    }
    return v;
  }
  return v;
}


let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
let PLUGINS = null; try { PLUGINS = new (require('./plugins.js').PluginManager)(__dirname, (...a) => log(...a)); } catch (e) { logErr('插件管理器初始化失败:', e && e.message); }
const redactCache = require('./redact-cache.js'); 


const REDACT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      
  /\bAKIA[0-9A-Z]{16}/g,                  
  /\bAIza[0-9A-Za-z_-]{30,}/g,            
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          
  /\bhf_[A-Za-z0-9]{20,}/g,               
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     
];
const REDACT_FIELD_RE = /api[-_]?key|apikey|secret|password|passwd|token|authorization/i;
function redactText(s, extra) {
  return redactCache.redactSmart(s, extra);
}
function redactDeep(v, extra, depth) {
  if (v == null || depth > 12) return v;
  if (typeof v === 'string') return v.startsWith('data:') ? v : redactText(v, extra); 
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (typeof val === 'string' && val && REDACT_FIELD_RE.test(k)) v[k] = '***';
      else v[k] = redactDeep(val, extra, depth + 1);
    }
    return v;
  }
  return v;
}
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


function normalizeProxy(p) {
  if (!p) return null;
  if (typeof p === 'object') {
    const o = { type: String(p.type || 'socks5').toLowerCase(), host: String(p.host || ''), port: Number(p.port) };
    if (o.type === 'socks' || o.type === 'socks5h') o.type = 'socks5';
    if (p.username != null && p.username !== '') o.username = String(p.username);
    if (p.password != null && p.password !== '') o.password = String(p.password);
    if (!o.host || !o.port) return null;
    return o;
  }
  
  const m = /^(socks5h?|socks|http|https):\/\/(?:([^:@\/]+)(?::([^@\/]*))?@)?([^:\/@]+):(\d+)\/?$/i.exec(String(p).trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const o = { type: (scheme === 'http' || scheme === 'https') ? 'http' : 'socks5', host: m[4], port: Number(m[5]) };
  if (m[2] != null) o.username = decodeURIComponent(m[2]);
  if (m[3] != null && m[3] !== '') o.password = decodeURIComponent(m[3]);
  return o;
}

function applyDefaults(cfg) {
  cfg.listen = cfg.listen || {};
  cfg.listen.port = Number(cfg.listen.port || 16384);
  cfg.listen.host = String(cfg.listen.host || '0.0.0.0');
  cfg.gatewayKey = cfg.gatewayKey ? String(cfg.gatewayKey) : '';
  
  cfg.apiKeys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.filter(k => k && k.key) : [];
  
  cfg.users = Array.isArray(cfg.users) ? cfg.users.filter(u => u && u.uid && u.passwordHash) : [];
  
  cfg.keyLength = Math.min(128, Math.max(8, Number(cfg.keyLength) || 24));
  
  cfg.registration = cfg.registration && typeof cfg.registration === 'object' ? cfg.registration : {};
  cfg.registration.enable = !!cfg.registration.enable;
  cfg.registration.defaultQuota = Math.max(0, Number(cfg.registration.defaultQuota) || 0);
  cfg.registration.minPasswordLen = Math.min(64, Math.max(4, Number(cfg.registration.minPasswordLen) || 8));
  
  cfg.registration.captchaProvider = cfg.registration.captchaProvider === 'turnstile' ? 'turnstile' : 'none';
  cfg.registration.captchaSecret = String(cfg.registration.captchaSecret || '');
  cfg.registration.captchaSiteKey = String(cfg.registration.captchaSiteKey || '');
  
  cfg.registration.emailVerify = cfg.registration.emailVerify && typeof cfg.registration.emailVerify === 'object' ? cfg.registration.emailVerify : {};
  cfg.registration.emailVerify.enable = !!cfg.registration.emailVerify.enable;
  
  cfg.probe = cfg.probe && typeof cfg.probe === 'object' ? cfg.probe : {};
  cfg.probe.enable = !!cfg.probe.enable;
  cfg.probe.intervalMin = Math.max(1, Number(cfg.probe.intervalMin) || 10);
  if (!cfg.probe.mode) cfg.probe.mode = 'models';
  cfg.modelSync = cfg.modelSync && typeof cfg.modelSync === 'object' ? cfg.modelSync : {};
  cfg.modelSync.enable = cfg.modelSync.enable !== false; 
  cfg.modelSync.intervalHours = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  
  if (cfg.connRetry === undefined) cfg.connRetry = 2;
  cfg.cors = cfg.cors !== false;
  
  cfg.tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; 
  }
  cfg.adminKey = cfg.adminKey ? String(cfg.adminKey) : '';
  if (cfg.proxies && typeof cfg.proxies === 'object' && !Array.isArray(cfg.proxies)) {
    const norm = {};
    for (const [k, v] of Object.entries(cfg.proxies)) {
      const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
      if (n) norm[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
    }
    cfg.proxies = norm;
  } else cfg.proxies = {};
  cfg.channels = cfg.channels || [];
  
  
  cfg.thinkingSummary = cfg.thinkingSummary && typeof cfg.thinkingSummary === 'object' ? cfg.thinkingSummary : { enable: false };
  cfg.thinkingSummary.enable = !!cfg.thinkingSummary.enable;
  cfg.thinkingSummary.mode = cfg.thinkingSummary.mode === 'summarize' ? 'summarize' : 'truncate';
  cfg.thinkingSummary.maxCharsPerSegment = Math.max(10, Number(cfg.thinkingSummary.maxCharsPerSegment) || 80);
  cfg.thinkingSummary.summarizeBaseUrl = String(cfg.thinkingSummary.summarizeBaseUrl || '').trim(); 
  cfg.thinkingSummary.summarizeApiKey = String(cfg.thinkingSummary.summarizeApiKey || '').trim();   
  cfg.thinkingSummary.summarizeModel = String(cfg.thinkingSummary.summarizeModel || '').trim();     
  cfg.thinkingSummary.summarizePrompt = String(cfg.thinkingSummary.summarizePrompt || '').trim() || '用一句话中文概括以下思考片段:';
  cfg.thinkingSummary.maxSegments = Math.max(1, Number(cfg.thinkingSummary.maxSegments) || 12);
  
  
  cfg.openaiExtras = cfg.openaiExtras && typeof cfg.openaiExtras === 'object' ? cfg.openaiExtras : {};
  cfg.openaiExtras.enable = !!cfg.openaiExtras.enable;
  cfg.openaiExtras.upstreamResponses = !!cfg.openaiExtras.upstreamResponses;
  return cfg;
}


function truncateReasoning(text, maxChars) {
  if (!text) return '';
  const out = [];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    if (rawLine.length <= maxChars) { out.push(rawLine); continue; }
    const step = maxChars * 2;
    for (let i = 0; i < rawLine.length && out.length < 60; i += step) {
      const c = rawLine.slice(i, i + maxChars);
      out.push(c + (i + maxChars < rawLine.length ? '…' : ''));
    }
  }
  return out.join('\n');
}


function normalizeSummarizeUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}


function callUpstreamText(cfg, baseUrl, apiKey, model, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const url = normalizeSummarizeUrl(baseUrl);
    if (!url || !model || !prompt) return resolve(null);
    if (apiKey && !/^[\x09\x20-\x7e]*$/.test(apiKey)) return resolve(null); 
    const headers = { authorization: 'Bearer ' + (apiKey || '') };
    const bodyBuf = Buffer.from(JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }));
    const sub = { ...cfg, responseTimeout: Math.min(timeoutMs || 30000, 60000) };
    const tmpCh = { proxy: null, insecure: false }; 
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      upstreamRequest(sub, tmpCh, url, headers, bodyBuf, (err, upRes) => {
        if (err) return finish(null);
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          if (upRes.statusCode >= 400) return finish(null);
          let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return finish(null); }
          try { const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; finish(typeof c === 'string' ? c : ''); }
          catch (e) { finish(null); }
        });
        upRes.on('error', () => finish(null));
      });
    } catch (e) { finish(null); }
  });
}


async function summarizeReasoningText(reasoning, tsCfg, ch, cfg) {
  if (!reasoning) return '';
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  if (!baseUrl || !model) return truncateReasoning(reasoning, Number(tsCfg.maxCharsPerSegment) || 80); 
  const segs = reasoning.split('\n').map(s => s.trim()).filter(Boolean);
  
  const merged = [];
  let cur = '';
  for (const s of segs) {
    if ((cur ? cur.length + 1 + s.length : s.length) < 200) cur = cur ? cur + '\n' + s : s;
    else { if (cur) merged.push(cur); cur = s; }
  }
  if (cur) merged.push(cur);
  const list = merged.slice(0, Number(tsCfg.maxSegments) || 12);
  if (!list.length) return '';
  const prompt = String(tsCfg.summarizePrompt || '用一句话中文概括以下思考片段:');
  const results = await Promise.all(list.map(seg =>
    callUpstreamText(cfg, baseUrl, apiKey, model, prompt + '\n\n' + seg, 30000).catch(() => '')
  ));
  return results.filter(Boolean).map(s => '• ' + String(s).trim()).join('\n');
}



function wrapThinkingSummary(writer, tsCfg, ch, cfg) {
  if (!tsCfg || !tsCfg.enable) return writer;
  const mode = tsCfg.mode === 'summarize' ? 'summarize' : 'truncate';
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);

  if (mode === 'truncate') {
  
    let lineBuf = '', saw = false, done = false, needSep = false;
    const emit = (t) => { if (needSep) writer.onEvent({ type: 'reasoning', t: '\n\n' }); writer.onEvent({ type: 'reasoning', t }); needSep = true; };
    const emitSeg = (line) => {
      line = line || '';
      if (!line.trim()) return;
      if (line.length <= maxChars) { emit(line); return; }
      const step = maxChars * 2;
      for (let i = 0; i < line.length; i += step) {
        const c = line.slice(i, i + maxChars);
        emit(c + (i + maxChars < line.length ? '…' : ''));
      }
    };
    return {
      onEvent(ev) {
        if (ev.type === 'reasoning') {
          saw = true;
          lineBuf += ev.t;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop(); 
          for (const ln of lines) emitSeg(ln);
        } else {
          if (saw && !done) { done = true; if (lineBuf) emitSeg(lineBuf); lineBuf = ''; }
          writer.onEvent(ev);
        }
      }
    };
  }

  
  
  
  let buf = '', saw = false, closed = false, reasoningClosed = false, textFlushed = false;
  let pending = 0;
  let pendingEnd = null; 
  let textQ = null;      
  const flushEnd = () => { if (pendingEnd && pending === 0) { const e = pendingEnd; pendingEnd = null; closed = true; writer.onEvent(e); } };
  const releaseText = () => {
    if (!textQ) return;
    const q = textQ; textQ = null; textFlushed = true;
    for (const e of q) writer.onEvent(e);
  };
  const dispatch = (seg) => {
    pending++;
    summarizeOneSegment(seg, tsCfg, cfg).then(s => {
      if (s && !closed && !textFlushed) writer.onEvent({ type: 'reasoning', t: s });
    }).catch(() => {}).then(() => {
      pending--;
      if (pending === 0) releaseText();
      flushEnd();
    });
  };
  return {
    onEvent(ev) {
      if (ev.type === 'reasoning') {
        if (reasoningClosed) { if (textQ) textQ.push(ev); else writer.onEvent(ev); return; } 
        saw = true;
        buf += ev.t;
        while (buf.length >= 200) { const seg = buf.slice(0, 200); buf = buf.slice(200); dispatch(seg); }
      } else if (ev.type === 'text') {
        
        if (saw && buf && !reasoningClosed) { const tail = buf; buf = ''; reasoningClosed = true; dispatch(tail); }
        else if (!saw) reasoningClosed = true;
        if (textQ) { textQ.push(ev); }
        else if (pending > 0 && !textFlushed) {
          textQ = [ev];
          setTimeout(releaseText, 10000); 
        } else writer.onEvent(ev);
      } else if (ev.type === 'end') {
        
        if (textQ) { textQ.push(ev); }
        else { pendingEnd = ev; flushEnd(); }
      } else {
        writer.onEvent(ev);
      }
    }
  };
}


async function summarizeOneSegment(text, tsCfg, cfg) {
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);
  if (!baseUrl || !model || !text) return null;
  const prompt = String(tsCfg.summarizePrompt || '用一句话中文概括以下思考片段:');
  
  const fallbackText = text.slice(0, maxChars).replace(/\n+/g, ' ').trim();
  const fallback = fallbackText ? '• ' + fallbackText + '\n' : null;
  try {
    const s = await callUpstreamText(cfg, baseUrl, apiKey, model, prompt + '\n\n' + text, 30000);
    if (s && String(s).trim()) return '• ' + String(s).trim() + '\n';
    
    logErr('[thinkingSummary] 模型返回空, 回退截断(' + text.length + '字)');
    return fallback || null;
  } catch (e) {
    logErr('[thinkingSummary] 单段总结失败, 回退截断:', e.message);
    return fallback || null;
  }
}

function loadConfig(file) {
  redactCache.reset(); 
  let raw = fs.readFileSync(file, 'utf8');
  if (crypt && crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) throw new Error('配置已加密但找不到密钥: 请设置环境变量 AGW_CRYPT_PASS, 或确保 ' + crypt.KEY_FILE() + ' 存在且有效 (可用 node crypt.js test 检查)');
    raw = crypt.decryptText(raw, pass);
  }
  const cfg = JSON.parse(raw);
  cfg._configFile = path.resolve(file);
  applyDefaults(cfg);

  const proxiesIn = cfg.proxies || cfg.proxyList || {};
  cfg.proxies = {};
  for (const [k, v] of Object.entries(proxiesIn)) {
    const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
    if (n) cfg.proxies[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
  }

  const TYPES = ['openai', 'gemini', 'claude'];
  const channelsIn = cfg.channels || cfg.channelList || [];
  cfg.channels = [];
  let i = 0;
  for (const ch of channelsIn) {
    i++;
    if (!ch || !TYPES.includes(String(ch.type || '').toLowerCase())) { logErr(`[config] 渠道 #${i} type 无效(应为 openai/gemini/claude), 跳过`); continue; }
    if (!ch.baseUrl) { logErr(`[config] 渠道 "${ch.name || i}" 缺 baseUrl, 跳过`); continue; }
    cfg.channels.push({
      name: String(ch.name || ('channel-' + i)),
      type: String(ch.type).toLowerCase(),
      baseUrl: String(ch.baseUrl).replace(/\/+$/, ''),
      apiKey: ch.apiKey != null ? String(ch.apiKey) : '',
      proxy: ch.proxy != null && ch.proxy !== '' ? String(ch.proxy) : null,
      insecure: !!ch.insecure,
      models: Array.isArray(ch.models) ? ch.models.map(String) : null,
      modelMap: (ch.modelMap && typeof ch.modelMap === 'object' && !Array.isArray(ch.modelMap)) ? ch.modelMap : null,
      default: !!ch.default,
      delayMs: Math.max(0, Number(ch.delayMs) || 0),
      useResponses: !!ch.useResponses,
      probe: !!ch.probe,
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
    });
    const last = cfg.channels[cfg.channels.length - 1];
    if (!/^[\x09\x20-\x7e]*$/.test(last.apiKey)) logErr(`⚠ [config] 渠道 "${last.name}" 的 apiKey 含中文/非ASCII字符(像占位符?), 请求会失败, 请填入真实 Key`);
    if (!last.apiKey) logErr(`⚠ [config] 渠道 "${last.name}" 没有填 apiKey`);
  }
  return cfg;
}


function dialTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} reject(e); } };
    sock.once('connect', () => { if (!done) { done = true; sock.setTimeout(0); resolve(sock); } });
    sock.once('error', fail);
    if (timeout) sock.setTimeout(timeout, () => fail(new Error(`connect timeout (${host}:${port})`)));
  });
}


function makeReader(sock) {
  const st = { buf: Buffer.alloc(0), waiters: [] };
  function pump() {
    while (st.waiters.length) {
      const w = st.waiters[0];
      if (w.need >= 0) {
        if (st.buf.length >= w.need) {
          st.waiters.shift();
          const out = st.buf.subarray(0, w.need);
          st.buf = st.buf.subarray(w.need);
          w.resolve(out);
        } else return;
      } else {
        const i = st.buf.indexOf(w.seq);
        if (i >= 0) {
          st.waiters.shift();
          const out = st.buf.subarray(0, i + w.seq.length);
          st.buf = st.buf.subarray(i + w.seq.length);
          w.resolve(out);
        } else return;
      }
    }
  }
  function failAll(e) { while (st.waiters.length) st.waiters.shift().reject(e); }
  const onData = (c) => { st.buf = Buffer.concat([st.buf, c]); pump(); };
  const onEnd = () => failAll(new Error('connection closed by proxy/peer during handshake'));
  const onError = (e) => failAll(e);
  sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onError);
  return {
    read(n) { return new Promise((resolve, reject) => { st.waiters.push({ need: n, resolve, reject }); pump(); }); },
    readUntil(seq) { return new Promise((resolve, reject) => { st.waiters.push({ need: -1, seq: Buffer.from(seq), resolve, reject }); pump(); }); },
    detach() { sock.removeListener('data', onData); sock.removeListener('end', onEnd); sock.removeListener('error', onError); },
  };
}

async function socks5Connect(sock, proxy, host, port, r) {
  const hasAuth = proxy.username != null && proxy.username !== '';
  sock.write(Buffer.from([5, hasAuth ? 2 : 1, ...(hasAuth ? [0, 2] : [0])]));
  const m = await r.read(2);
  if (m[0] !== 5) throw new Error('socks5: bad version byte ' + m[0]);
  if (m[1] === 2) {
    if (!hasAuth) throw new Error('socks5: proxy requires username/password');
    const u = Buffer.from(proxy.username), pw = Buffer.from(proxy.password || '');
    if (u.length > 255 || pw.length > 255) throw new Error('socks5: credential too long');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const a = await r.read(2);
    if (a[1] !== 0) throw new Error('socks5: auth failed (status ' + a[1] + ')');
  } else if (m[1] !== 0) {
    throw new Error('socks5: no acceptable auth method (proxy chose ' + m[1] + ')');
  }
  const hb = Buffer.from(host);
  if (hb.length > 255) throw new Error('socks5: host too long');
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([(port >> 8) & 255, port & 255])]));
  const head = await r.read(4);
  if (head[0] !== 5) throw new Error('socks5: bad reply version');
  if (head[1] !== 0) {
    const REPS = { 1: 'general failure', 2: 'not allowed by ruleset', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
    throw new Error('socks5: CONNECT failed: ' + (REPS[head[1]] || 'reply ' + head[1]));
  }
  const atyp = head[3];
  if (atyp === 1) await r.read(6);
  else if (atyp === 3) { const l = await r.read(1); await r.read(l[0] + 2); }
  else if (atyp === 4) await r.read(18);
  else throw new Error('socks5: bad address type ' + atyp);
}

async function httpConnect(sock, proxy, host, port, r) {
  const auth = (proxy.username != null && proxy.username !== '')
    ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64') + '\r\n' : '';
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await r.readUntil('\r\n\r\n');
  const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
  const status = parseInt(line.split(' ')[1] || '0', 10);
  if (!(status >= 200 && status < 300)) throw new Error('http proxy: CONNECT rejected: ' + line);
}

async function dialViaProxy(proxy, targetHost, targetPort, timeout) {
  const sock = await dialTcp(proxy.host, proxy.port, timeout);
  try {
    sock.setNoDelay(true);
    const r = makeReader(sock);
    if (proxy.type === 'socks5') await socks5Connect(sock, proxy, targetHost, targetPort, r);
    else if (proxy.type === 'http') await httpConnect(sock, proxy, targetHost, targetPort, r);
    else throw new Error('unknown proxy type: ' + proxy.type);
    r.detach();
    return sock;
  } catch (e) {
    try { sock.destroy(); } catch (_) {}
    e.message = `[proxy ${proxy.type}://${proxy.host}:${proxy.port}] ` + e.message;
    throw e;
  }
}


let directAgents = null;
function getDirectAgents() {
  if (!directAgents) {
    const o = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 };
    directAgents = { http: new http.Agent(o), https: new https.Agent(o) };
  }
  return directAgents;
}

class HttpTunnelAgent extends http.Agent {
  constructor(proxy, opts) { super(opts); this.proxy = proxy; }
  createConnection(options, cb) {
    let settled = false;
    const once = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
    dialViaProxy(this.proxy, options.host, Number(options.port || 80), this.proxy._timeout || 15000)
      .then(s => once(null, s)).catch(once);
  }
}
class HttpsTunnelAgent extends https.Agent {
  constructor(proxy, insecure, opts) { super(opts); this.proxy = proxy; this.insecure = !!insecure; }
  createConnection(options, cb) {
    const host = options.host;
    const port = Number(options.port || 443);
    let settled = false;
    const once = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
    dialViaProxy(this.proxy, host, port, this.proxy._timeout || 15000).then(raw => {
      raw.setNoDelay(true);
      const t = tls.connect({
        socket: raw,
        servername: options.servername || host,
        rejectUnauthorized: !this.insecure,
        ALPNProtocols: ['http/1.1'],
      }, () => once(null, t));
      t.once('error', (e) => { try { t.destroy(); } catch (_) {} once(e); });
    }).catch(once);
  }
}

const agentCache = new Map();
function getAgents(cfg, ch) {
  const raw = ch.proxy ? cfg.proxies[ch.proxy] : null;
  const proxy = (raw && typeof raw === 'object' && raw.type) ? raw : (ch.proxy ? normalizeProxy(ch.proxy) : null);
  if (ch.proxy && !proxy) logErr(`[config] 渠道 ${ch.name} 引用的代理 "${ch.proxy}" 不存在, 回落直连`);
  if (proxy) proxy._timeout = cfg.connectTimeout;
  const key = proxy ? `px:${proxy.type}:${proxy.host}:${proxy.port}:${ch.insecure ? 1 : 0}` : ('direct:' + (ch.insecure ? 'insecure' : 'std'));
  let a = agentCache.get(key);
  if (!a) {
    const o = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 };
    if (proxy) {
      a = { http: new HttpTunnelAgent(proxy, o), https: new HttpsTunnelAgent(proxy, ch.insecure, o) };
    } else if (ch.insecure) {
      a = { http: getDirectAgents().http, https: new https.Agent({ ...o, rejectUnauthorized: false }) };
    } else {
      a = getDirectAgents();
    }
    agentCache.set(key, a);
  }
  return a;
}


function isConnErr(e) {
  const m = String((e && e.message) || e || '');
  return /socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(m);
}



function makeFreshAgents(cfg, ch) {
  const raw = ch.proxy ? cfg.proxies[ch.proxy] : null;
  const proxy = (raw && typeof raw === 'object' && raw.type) ? raw : (ch.proxy ? normalizeProxy(ch.proxy) : null);
  if (proxy) proxy._timeout = cfg.connectTimeout;
  const o = { keepAlive: false, maxSockets: 4 };
  if (proxy) return { http: new HttpTunnelAgent(proxy, o), https: new HttpsTunnelAgent(proxy, ch.insecure, o) };
  if (ch.insecure) return { http: new http.Agent(o), https: new https.Agent({ ...o, rejectUnauthorized: false }) };
  return { http: new http.Agent(o), https: new https.Agent(o) };
}












function openaiToCanonical(body, urlModel) {
  const messages = [];
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    let role = m.role;
    if (role === 'developer') role = 'system';
    if (role === 'function') {
      messages.push({ role: 'tool', name: m.name, tool_call_id: 'call_fn_' + (m.name || ''), content: toText(m.content) });
      continue;
    }
    const out = { role, content: m.content == null ? '' : m.content };
    if (m.name != null) out.name = m.name;
    if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
      }));
    }
    messages.push(out);
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens != null ? body.max_tokens : body.max_completion_tokens,
    stop: normStop(body.stop),
    tools: (Array.isArray(body.tools) && body.tools.length) ? body.tools : undefined,
    tool_choice: body.tool_choice,
  };
}

function claudeToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: (t.input_schema && typeof t.input_schema === 'object') ? t.input_schema : { type: 'object' } },
  }));
  return out.length ? out : undefined;
}
function claudeChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}
function claudeToCanonical(body, urlModel) {
  const messages = [];
  if (body.system) {
    const s = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '');
    if (s) messages.push({ role: 'system', content: s });
  }
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    const blocks = Array.isArray(m.content) ? m.content : (m.content == null ? [] : [{ type: 'text', text: String(m.content) }]);
    const textParts = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') textParts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const s = b.source;
        if (s.type === 'base64') textParts.push({ type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data || ''}` } });
        else if (s.type === 'url') textParts.push({ type: 'image_url', image_url: { url: s.url } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id || randId('call_'), type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content) ? b.content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '');
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: c });
      }
      
    }
    if (m.role === 'assistant') {
      if (textParts.length || toolCalls.length) {
        const out = { role: 'assistant', content: textParts.length ? textParts : '' };
        if (toolCalls.length) out.tool_calls = toolCalls;
        messages.push(out);
      }
    } else if (textParts.length) {
      messages.push({ role: 'user', content: textParts });
    }
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    stop: normStop(body.stop_sequences),
    tools: claudeToolsToOpenAI(body.tools),
    tool_choice: claudeChoiceToOpenAI(body.tool_choice),
  };
}

function geminiToCanonical(body, urlModel) {
  const messages = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys && Array.isArray(sys.parts)) {
    const t = sys.parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    if (t) messages.push({ role: 'system', content: t });
  }
  let callSeq = 0;
  const lastName = {};
  for (const c of (body.contents || [])) {
    if (!c || !Array.isArray(c.parts)) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const textParts = [];
    const toolCalls = [];
    const toolMsgs = [];
    for (const p of c.parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') {
        if (!p.thought) textParts.push({ type: 'text', text: p.text });
      } else if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        textParts.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data || ''}` } });
      } else if (p.fileData || p.file_data) {
        const d = p.fileData || p.file_data;
        if (d.fileUri || d.file_uri) textParts.push({ type: 'image_url', image_url: { url: d.fileUri || d.file_uri } });
      } else if (p.functionCall || p.function_call) {
        const f = p.functionCall || p.function_call;
        const id = 'call_gm_' + (f.name || 'fn') + '_' + (callSeq++);
        toolCalls.push({ id, type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
        lastName[f.name || ''] = id;
      } else if (p.functionResponse || p.function_response) {
        const f = p.functionResponse || p.function_response;
        toolMsgs.push({ role: 'tool', name: f.name || '', tool_call_id: lastName[f.name || ''] || ('call_gm_' + (f.name || '')), content: JSON.stringify(f.response == null ? {} : f.response) });
      }
    }
    if (role === 'assistant' && (textParts.length || toolCalls.length)) {
      const out = { role: 'assistant', content: textParts.length ? textParts : '' };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else if (textParts.length) {
      messages.push({ role, content: textParts });
    }
    messages.push(...toolMsgs);
  }
  const g = body.generationConfig || body.generation_config || {};
  const tools = [];
  for (const t of (body.tools || [])) {
    if (!t || typeof t !== 'object') continue;
    const fds = t.functionDeclarations || t.function_declarations || [];
    for (const fd of fds) {
      tools.push({ type: 'function', function: { name: fd.name, description: fd.description || '', parameters: fd.parameters || fd.parametersJsonSchema || fd.parameters_json_schema || { type: 'object' } } });
    }
  }
  let tool_choice;
  const tcfg = (body.toolConfig && body.toolConfig.functionCallingConfig) || (body.tool_config && body.tool_config.function_calling_config);
  if (tcfg) {
    const mode = String(tcfg.mode || 'AUTO').toUpperCase();
    if (mode === 'ANY') tool_choice = (Array.isArray(tcfg.allowedFunctionNames) && tcfg.allowedFunctionNames.length === 1) ? { type: 'function', function: { name: tcfg.allowedFunctionNames[0] } } : 'required';
    else if (mode === 'NONE') tool_choice = 'none';
    else tool_choice = 'auto';
  }
  return {
    model: urlModel || body.model,
    stream: !!body.stream,
    messages,
    temperature: g.temperature,
    top_p: g.topP != null ? g.topP : g.top_p,
    max_tokens: g.maxOutputTokens != null ? g.maxOutputTokens : g.max_output_tokens,
    stop: normStop(g.stopSequences != null ? g.stopSequences : g.stop_sequences),
    tools: tools.length ? tools : undefined,
    tool_choice,
  };
}



class ResponsesStreamParser {
  constructor(emit) { this.emit = emit; this.finished = false; this.finishReason = undefined; this.usage = null; this.toolIdx = 0; }
  handle(j) {
    const evs = [];
    switch (j.type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'text', t: j.delta });
        break;
      case 'response.output_item.added': {
        const item = j.item || {};
        if (item.type === 'function_call') {
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: item.id || item.call_id || ('call_' + (item.name || '')), name: item.name || '' });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: j.delta });
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const r = j.response || {};
        const st = String(r.status || j.type.replace('response.', ''));
        if (st === 'incomplete') this.finishReason = 'length';
        else if (st === 'failed') this.finishReason = 'content_filter';
        else this.finishReason = 'stop';
        const u = r.usage || j.usage;
        if (u) this.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
        break;
      }
      default: break;
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0 } });
  }
}


function responsesContentToContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      if (typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    } else if (p.type === 'input_image' && p.image_url) {
      out.push({ type: 'image_url', image_url: typeof p.image_url === 'string' ? { url: p.image_url } : p.image_url });
    } else if (p.type === 'input_file' && (p.file_url || p.filename)) {
      const u = typeof p.file_url === 'string' ? p.file_url : '';
      if (u) out.push({ type: 'image_url', image_url: { url: u } });
    }
  }
  if (!out.length) return '';
  return (out.length === 1 && out[0].type === 'text') ? out[0].text : out;
}


function responsesToCanonical(body, urlModel) {
  const messages = [];
  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions) messages.push({ role: 'system', content: instructions });
  else if (Array.isArray(instructions)) {
    const txt = instructions.filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
    if (txt) messages.push({ role: 'system', content: txt });
  }
  const rawInput = typeof body.input === 'string' ? [body.input] : (Array.isArray(body.input) ? body.input : []);
  for (const item of rawInput) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: item.call_id || item.id || randId('call_'), type: 'function',
          function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output == null ? {} : item.output) });
    } else if (item.type === 'message' || item.role) {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      if (role === 'system' && messages.length && messages[0].role === 'system') {
        messages[0].content = toText(messages[0].content) + '\n' + toText(responsesContentToContent(item.content));
        continue;
      }
      messages.push({ role, content: responsesContentToContent(item.content) });
    }
    
  }
  let tools;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = body.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', function: { name: t.name, description: t.description || '', parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object' } },
    } : t);
  }
  let tool_choice;
  if (typeof body.tool_choice === 'string') tool_choice = body.tool_choice;
  else if (body.tool_choice && body.tool_choice.type === 'function' && body.tool_choice.name) tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens != null ? body.max_output_tokens : body.max_tokens,
    stop: normStop(body.stop),
    tools,
    tool_choice,
  };
}


function canonicalToResponsesBody(c) {
  const instructions = [];
  const input = [];
  for (const m of (c.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = toText(m.content);
      if (t) instructions.push(t);
    } else if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string') { if (m.content) parts.push({ type: 'output_text', text: m.content }); }
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p) continue;
          if (p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'output_text', text: p.text });
          else if (p.type === 'image_url' && p.image_url && p.image_url.url) parts.push({ type: 'input_image', image_url: p.image_url.url });
        }
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          input.push({ type: 'function_call', call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' });
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id || '', output: toText(m.content) });
    } else {
      const content = (typeof m.content === 'string') ? m.content : (Array.isArray(m.content) ? m.content.map(p => {
        if (!p) return null;
        if (p.type === 'text' && typeof p.text === 'string') return { type: 'input_text', text: p.text };
        if (p.type === 'image_url' && p.image_url && p.image_url.url) return { type: 'input_image', image_url: p.image_url.url };
        return null;
      }).filter(Boolean) : '');
      input.push({ type: 'message', role: 'user', content: content === '' ? ' ' : content });
    }
  }
  const body = { model: c.model, input: input.length ? input : [' '], stream: !!c.stream };
  if (instructions.length) body.instructions = instructions.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) body.max_output_tokens = c.max_tokens;
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', name: t.function.name, description: t.function.description || '',
      parameters: (t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    } : t);
    if (c.tool_choice) {
      if (c.tool_choice === 'required' || c.tool_choice === 'none' || c.tool_choice === 'auto') body.tool_choice = c.tool_choice;
      else if (c.tool_choice.type === 'function' && c.tool_choice.function) body.tool_choice = { type: 'function', name: c.tool_choice.function.name };
      else body.tool_choice = 'auto';
    }
  }
  return body;
}


function canonicalToOpenAIBody(c, opts = {}) {
  const messages = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : toText(m.content);
      const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const out = { role: 'assistant', content: content === '' && hasTools ? null : content };
      if (hasTools) out.tool_calls = m.tool_calls;
      if (m.name != null) out.name = m.name;
      messages.push(out);
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: toText(m.content), ...(m.name ? { name: m.name } : {}) });
    } else if (m.role === 'system') {
      messages.push({ role: 'system', content: toText(m.content) });
    } else {
      let content = m.content;
      
      if (Array.isArray(content) && content.every(x => x && x.type === 'text')) {
        content = content.map(x => x.text || '').join('');
      }
      messages.push({ role: 'user', content: content == null ? '' : content });
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: ' ' });
  const body = { model: c.model, messages, stream: !!c.stream };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) {
    if (/^o[0-9]/.test(String(c.model || ''))) body.max_completion_tokens = c.max_tokens;
    else body.max_tokens = c.max_tokens;
  }
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools;
    if (c.tool_choice) body.tool_choice = c.tool_choice;
  }
  if (c.stream && opts.addUsage !== false) body.stream_options = { include_usage: true };
  return body;
}

function claudeFinish(reason) {
  return ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' })[reason] || 'end_turn';
}
function blocksToClaude(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'image', source: { type: 'url', url: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToClaudeBody(c) {
  const turns = [];
  const pushTurn = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of (c.messages || [])) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pushTurn('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: toText(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = blocksToClaude(m.content);
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        if (tc.function && typeof tc.function.arguments === 'string') {
          const p = safeParse(tc.function.arguments);
          if (p !== undefined && p !== null) input = (typeof p === 'object' && !Array.isArray(p)) ? p : { value: p };
        }
        blocks.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: (tc.function && tc.function.name) || '', input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      pushTurn('assistant', blocks);
    } else {
      pushTurn('user', blocksToClaude(m.content));
    }
  }
  if (!turns.length) turns.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  const sysParts = (c.messages || []).filter(m => m.role === 'system').map(m => toText(m.content)).filter(Boolean);
  const body = {
    model: c.model,
    messages: turns,
    max_tokens: c.max_tokens != null ? Number(c.max_tokens) : 4096,
    stream: !!c.stream,
  };
  if (sysParts.length) body.system = sysParts.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.stop && c.stop.length) body.stop_sequences = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => ({
      name: t.function && t.function.name,
      description: (t.function && t.function.description) || '',
      input_schema: (t.function && t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    }));
    if (c.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (c.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (c.tool_choice === 'none') {  }
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) body.tool_choice = { type: 'tool', name: c.tool_choice.function.name };
  }
  return body;
}

function geminiFinish(reason) {
  return ({ stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' })[reason] || 'STOP';
}
function blocksToGeminiParts(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else out.push({ fileData: { fileUri: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToGeminiBody(c) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const nameById = {};
  const sysParts = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'system') { const s = toText(m.content); if (s) sysParts.push(s); continue; }
    if (m.role === 'tool') {
      const nm = m.name || nameById[m.tool_call_id] || 'function';
      let resp = safeParse(toText(m.content));
      if (resp === undefined || resp === null) resp = { result: '' };
      if (typeof resp !== 'object' || Array.isArray(resp)) resp = { result: resp };
      push('user', [{ functionResponse: { name: nm, response: resp } }]);
    } else if (m.role === 'assistant') {
      const parts = blocksToGeminiParts(m.content);
      for (const tc of (m.tool_calls || [])) {
        const nm = (tc.function && tc.function.name) || '';
        nameById[tc.id] = nm;
        let args = safeParse((tc.function && tc.function.arguments) || '{}');
        if (args === undefined || args === null) args = {};
        parts.push({ functionCall: { name: nm, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
      }
      push('model', parts);
    } else {
      push('user', blocksToGeminiParts(m.content));
    }
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: ' ' }] });
  const body = { contents };
  if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n') }] };
  const gc = {};
  if (c.temperature !== undefined) gc.temperature = c.temperature;
  if (c.top_p !== undefined) gc.topP = c.top_p;
  if (c.max_tokens !== undefined) gc.maxOutputTokens = c.max_tokens;
  if (c.stop && c.stop.length) gc.stopSequences = c.stop;
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (c.tools && c.tools.length) {
    body.tools = [{
      functionDeclarations: c.tools.map(t => ({
        name: t.function && t.function.name,
        description: (t.function && t.function.description) || '',
        parameters: (t.function && t.function.parameters) || { type: 'object' },
      })),
    }];
    let mode, allowed;
    if (c.tool_choice === 'auto') mode = 'AUTO';
    else if (c.tool_choice === 'required') mode = 'ANY';
    else if (c.tool_choice === 'none') mode = 'NONE';
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) { mode = 'ANY'; allowed = [c.tool_choice.function.name]; }
    if (mode) body.toolConfig = { functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } };
  }
  return body;
}


function openaiRespToCanonical(j) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('');
  const usage = j.usage || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(tc => ({
    id: tc.id, type: 'function',
    function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
  })) : undefined;
  return {
    text,
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : undefined),
    tool_calls: toolCalls,
    finish_reason: ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[choice.finish_reason] || 'stop',
    usage: { input: usage.prompt_tokens != null ? usage.prompt_tokens : 0, output: usage.completion_tokens != null ? usage.completion_tokens : 0 },
  };
}
function claudeRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const b of (j.content || [])) {
    if (!b) continue;
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'thinking') reasoningParts.push(b.thinking || '');
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
  }
  const usage = j.usage || {};
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[j.stop_reason] || 'stop',
    usage: { input: usage.input_tokens != null ? usage.input_tokens : 0, output: usage.output_tokens != null ? usage.output_tokens : 0 },
  };
}
function geminiRespToCanonical(j) {
  const cand = (j.candidates && j.candidates[0]) || {};
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const p of ((cand.content && cand.content.parts) || [])) {
    if (!p) continue;
    if (typeof p.text === 'string') {
      if (p.thought) reasoningParts.push(p.text);
      else text += p.text;
    } else if (p.functionCall || p.function_call) {
      const f = p.functionCall || p.function_call;
      toolCalls.push({ id: randId('call_'), type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
    }
  }
  const u = j.usageMetadata || j.usage_metadata || {};
  const fr = String(cand.finishReason || cand.finish_reason || 'STOP').toUpperCase();
  let finish = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', PROHIBITED_CONTENT: 'content_filter', BLOCKLIST: 'content_filter', SPII: 'content_filter' })[fr] || 'stop';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: { input: u.promptTokenCount != null ? u.promptTokenCount : (u.prompt_token_count || 0), output: u.candidatesTokenCount != null ? u.candidatesTokenCount : (u.candidates_token_count || 0) },
  };
}


function canonicalToOpenAIResp(cresp, model) {
  const message = { role: 'assistant', content: cresp.text === '' ? null : cresp.text };
  if (cresp.reasoning) message.reasoning_content = cresp.reasoning;
  if (cresp.tool_calls && cresp.tool_calls.length) message.tool_calls = cresp.tool_calls;
  if (cresp.text === '' && !(message.tool_calls || []).length) message.content = '';
  return {
    id: randId('chatcmpl-'), object: 'chat.completion', created: nowSec(), model,
    choices: [{ index: 0, message, finish_reason: cresp.finish_reason }],
    usage: { prompt_tokens: cresp.usage.input, completion_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
  };
}
function canonicalToClaudeResp(cresp, model) {
  const content = [];
  if (cresp.reasoning) content.push({ type: 'thinking', thinking: cresp.reasoning });
  if (cresp.text !== '') content.push({ type: 'text', text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let input = safeParse(tc.function.arguments);
    if (input === undefined || input === null) input = {};
    content.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: tc.function.name, input: (typeof input === 'object' && !Array.isArray(input)) ? input : { value: input } });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: randId('msg_'), type: 'message', role: 'assistant', model,
    content,
    stop_reason: claudeFinish(cresp.finish_reason), stop_sequence: null,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output },
  };
}
function canonicalToGeminiResp(cresp, model) {
  const parts = [];
  if (cresp.reasoning) parts.push({ text: cresp.reasoning, thought: true });
  if (cresp.text !== '') parts.push({ text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let args = safeParse(tc.function.arguments);
    if (args === undefined || args === null) args = {};
    parts.push({ functionCall: { name: tc.function.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinish(cresp.finish_reason), index: 0 }],
    usageMetadata: { promptTokenCount: cresp.usage.input, candidatesTokenCount: cresp.usage.output, totalTokenCount: cresp.usage.input + cresp.usage.output },
    modelVersion: model,
  };
}


function responsesRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const item of (j.output || [])) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const p of (item.content || [])) {
        if (p && p.type === 'output_text' && typeof p.text === 'string') text += p.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.id || item.call_id || randId('call_'), type: 'function', function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } });
    } else if (item.type === 'reasoning') {
      const sums = (item.summary || []).filter(s => s && s.type === 'summary_text' && typeof s.text === 'string').map(s => s.text);
      if (sums.length) reasoningParts.push(sums.join('\n'));
    }
  }
  const usage = j.usage || {};
  const st = String(j.status || 'completed');
  let finish = 'stop';
  if (st === 'incomplete') finish = 'length';
  else if (st === 'failed') finish = 'content_filter';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: { input: usage.input_tokens != null ? usage.input_tokens : 0, output: usage.output_tokens != null ? usage.output_tokens : 0 },
  };
}


function canonicalToResponsesResp(cresp, model) {
  const output = [];
  if (cresp.reasoning) {
    output.push({ type: 'reasoning', id: randId('rs_'), summary: [{ type: 'summary_text', text: cresp.reasoning }] });
  }
  if (cresp.tool_calls && cresp.tool_calls.length) {
    for (const tc of cresp.tool_calls) {
      output.push({ type: 'function_call', id: randId('fc_'), call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}', status: 'completed' });
    }
  }
  const content = cresp.text !== '' ? [{ type: 'output_text', text: cresp.text, annotations: [] }] : [];
  output.push({ type: 'message', id: randId('msg_'), status: 'completed', role: 'assistant', content });
  const finStatus = (cresp.finish_reason === 'length' || cresp.finish_reason === 'content_filter') ? 'incomplete' : 'completed';
  return {
    id: randId('resp_'), object: 'response', created_at: nowSec(), status: finStatus, model, output,
    incomplete_details: cresp.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    instructions: null, metadata: {}, parallel_tool_calls: true,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
    error: null,
  };
}


class SSEDecoder {
  constructor(onData) { this.onData = onData; this.buf = ''; this.lines = []; }
  push(s) {
    this.buf += s;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.handleLine(line.replace(/\r$/, ''));
    }
  }
  handleLine(l) {
    if (l === '') { this.flushEvent(); return; }
    if (l.startsWith(':')) return;
    if (l.startsWith('data:')) this.lines.push(l.slice(5).replace(/^ /, ''));
  }
  flushEvent() {
    if (this.lines.length) {
      const d = this.lines.join('\n');
      this.lines = [];
      this.onData(d);
    }
  }
  end() { this.flushEvent(); }
}

class UpstreamStreamParser {
  constructor(format, emit) {
    this.format = format;
    this.emit = emit;
    this.finished = false;
    this.finishReason = undefined;
    this.usage = null;
    this.toolIdx = 0;
  }
  handle(j) {
    const evs = [];
    if (this.format === 'openai') {
      const ch = (j.choices && j.choices[0]) || {};
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) evs.push({ type: 'text', t: d.content });
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) evs.push({ type: 'reasoning', t: d.reasoning_content });
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : this.toolIdx;
          const fname = (tc.function && tc.function.name) || '';
          if (tc.id || fname) evs.push({ type: 'tool_start', i, id: tc.id || ('call_' + fname), name: fname });
          if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) evs.push({ type: 'tool_delta', i, s: tc.function.arguments });
          if (tc.index != null && tc.index >= this.toolIdx) this.toolIdx = tc.index + 1;
        }
      }
      if (j.usage) this.usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
      if (ch.finish_reason) this.finishReason = ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[ch.finish_reason] || 'stop';
    } else if (this.format === 'claude') {
      const t = j.type;
      if (t === 'message_start') {
        const u = (j.message && j.message.usage) || {};
        this.usage = { input: u.input_tokens || 0, output: (this.usage && this.usage.output) || 0 };
        evs.push({ type: 'start', usage: { input: this.usage.input } });
      } else if (t === 'content_block_start') {
        const b = j.content_block || {};
        if (b.type === 'tool_use') evs.push({ type: 'tool_start', i: this.toolIdx++, id: b.id || randId('toolu_'), name: b.name || '' });
      } else if (t === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta' && d.text) evs.push({ type: 'text', t: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) evs.push({ type: 'reasoning', t: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: d.partial_json });
      } else if (t === 'message_delta') {
        const d = j.delta || {};
        if (d.stop_reason) this.finishReason = ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[d.stop_reason] || 'stop';
        if (j.usage && j.usage.output_tokens != null) this.usage = { input: (this.usage && this.usage.input) || 0, output: j.usage.output_tokens };
      }
      
    } else { 
      const cand = (j.candidates && j.candidates[0]) || {};
      for (const p of ((cand.content && cand.content.parts) || [])) {
        if (!p) continue;
        if (typeof p.text === 'string') {
          evs.push(p.thought ? { type: 'reasoning', t: p.text } : { type: 'text', t: p.text });
        } else if (p.functionCall || p.function_call) {
          const f = p.functionCall || p.function_call;
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: 'call_gm_' + i, name: f.name || '' });
          evs.push({ type: 'tool_delta', i, s: JSON.stringify(f.args == null ? {} : f.args) });
        }
      }
      const u = j.usageMetadata || j.usage_metadata;
      if (u) this.usage = { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0 };
      const fr = cand.finishReason || cand.finish_reason;
      if (fr) this.finishReason = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' })[String(fr).toUpperCase()] || 'stop';
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0 } });
  }
}


function sseData(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function sseEvent(res, ev, obj) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(obj) + '\n\n'); }

function makeWriter(format, res, model, opts = {}) {
  if (format === 'openai') {
    const id = randId('chatcmpl-');
    const created = nowSec();
    let firstChunk = true;
    const chunk = (delta, finish_reason) => {
      sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish_reason || null }] });
    };
    return {
      onEvent(ev) {
        if (ev.type === 'text') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ content: ev.t });
        } else if (ev.type === 'reasoning') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ reasoning_content: ev.t });
        } else if (ev.type === 'tool_start') {
          chunk({ tool_calls: [{ index: ev.i, id: ev.id, type: 'function', function: { name: ev.name, arguments: '' } }] });
        } else if (ev.type === 'tool_delta') {
          chunk({ tool_calls: [{ index: ev.i, function: { arguments: ev.s } }] });
        } else if (ev.type === 'end') {
          chunk({}, ev.finish_reason);
          const u = ev.usage || { input: 0, output: 0 };
          sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
    };
  }

  if (format === 'claude') {
    const id = randId('msg_');
    let started = false, sawAny = false, nextBlock = 0, open = null;
    const usage = { input: 0, output: 0 };
    const ensureStart = () => {
      if (started) return;
      started = true;
      sseEvent(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } });
      sseEvent(res, 'ping', { type: 'ping' });
    };
    const closeOpen = () => { if (open) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: open.idx }); open = null; } };
    const ensure = (kind, tool) => {
      if (open && open.kind === kind && (kind !== 'tool' || open.i === tool.i)) return open;
      closeOpen();
      const idx = nextBlock++;
      if (kind === 'text') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      else if (kind === 'thinking') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
      else sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      open = { kind, idx, i: tool ? tool.i : undefined };
      return open;
    };
    return {
      onEvent(ev) {
        if (ev.type === 'start') {
          if (ev.usage && ev.usage.input) usage.input = ev.usage.input;
          ensureStart();
        } else if (ev.type === 'text') {
          sawAny = true; ensureStart();
          const b = ensure('text');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'text_delta', text: ev.t } });
        } else if (ev.type === 'reasoning') {
          sawAny = true; ensureStart();
          const b = ensure('thinking');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'thinking_delta', thinking: ev.t } });
        } else if (ev.type === 'tool_start') {
          sawAny = true; ensureStart();
          ensure('tool', { id: ev.id, name: ev.name, i: ev.i });
        } else if (ev.type === 'tool_delta') {
          ensureStart();
          const b = ensure('tool', { id: '', name: '', i: ev.i });
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'input_json_delta', partial_json: ev.s } });
        } else if (ev.type === 'end') {
          ensureStart();
          closeOpen();
          if (!sawAny) {
            const idx = nextBlock++;
            sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
          }
          const u = ev.usage || { input: 0, output: 0 };
          if (u.input) usage.input = u.input;
          usage.output = u.output;
          sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: claudeFinish(ev.finish_reason), stop_sequence: null }, usage: { output_tokens: u.output } });
          sseEvent(res, 'message_stop', { type: 'message_stop' });
          res.end();
        }
      },
    };
  }

  
  const isArray = !!opts.geminiArray;
  let firstArray = true;
  let toolBuf = null;
  const writeChunk = (obj) => {
    if (isArray) {
      if (firstArray) { res.write('[' + JSON.stringify(obj)); firstArray = false; }
      else res.write(',' + JSON.stringify(obj));
    } else sseData(res, obj);
  };
  const flushTool = () => {
    if (!toolBuf) return;
    let args = safeParse(toolBuf.s || '{}');
    if (args === undefined || args === null) args = {};
    writeChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolBuf.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } }] }, index: 0 }] });
    toolBuf = null;
  };
  return {
    onEvent(ev) {
      if (ev.type === 'text') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t }] }, index: 0 }] });
      } else if (ev.type === 'reasoning') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t, thought: true }] }, index: 0 }] });
      } else if (ev.type === 'tool_start') {
        flushTool();
        toolBuf = { i: ev.i, id: ev.id, name: ev.name, s: '' };
      } else if (ev.type === 'tool_delta') {
        if (toolBuf && toolBuf.i === ev.i) toolBuf.s += ev.s;
      } else if (ev.type === 'end') {
        flushTool();
        const u = ev.usage || { input: 0, output: 0 };
        writeChunk({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: geminiFinish(ev.finish_reason), index: 0 }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output } });
        if (isArray) { if (firstArray) res.write('[]'); else res.write(']'); }
        res.end();
      }
    },
  };
}


function makeResponsesWriter(res, model) {
  const respId = randId('resp_');
  const msgId = randId('msg_');
  const created = nowSec();
  let started = false, nextOutIdx = 0, msgOutIdx = null, msgText = '';
  let curReasoning = null, curTool = null;
  const outputArr = [];
  const usage = { input: 0, output: 0 };
  const baseResp = (status) => ({ id: respId, object: 'response', created_at: created, status: status || 'in_progress', model, output: [], incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true, temperature: null, top_p: null, max_output_tokens: null, tools: [], tool_choice: 'auto', usage: null, error: null });
  const ensureStart = () => {
    if (started) return;
    started = true;
    sseData(res, { type: 'response.created', response: baseResp('in_progress') });
    sseData(res, { type: 'response.in_progress', response: baseResp('in_progress') });
  };
  const ensureMsg = () => {
    if (msgOutIdx != null) return;
    msgOutIdx = nextOutIdx++;
    sseData(res, { type: 'response.output_item.added', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    sseData(res, { type: 'response.content_part.added', item_id: msgId, output_index: msgOutIdx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const finishItems = () => {
    if (msgOutIdx != null) {
      const part = { type: 'output_text', text: msgText, annotations: [] };
      sseData(res, { type: 'response.output_text.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.content_part.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.output_item.done', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] } });
      outputArr.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] });
      msgOutIdx = null;
    }
    if (curReasoning) {
      const part = { type: 'summary_text', text: curReasoning.text };
      sseData(res, { type: 'response.reasoning_summary_text.done', item_id: curReasoning.id, output_index: curReasoning.outIdx, part });
      sseData(res, { type: 'response.output_item.done', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] } });
      outputArr.push({ id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] });
      curReasoning = null;
    }
    if (curTool) {
      sseData(res, { type: 'response.output_item.done', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args } });
      outputArr.push({ id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args });
      curTool = null;
    }
  };
  return {
    onEvent(ev) {
      if (ev.type === 'text') {
        ensureStart(); ensureMsg(); msgText += ev.t;
        sseData(res, { type: 'response.output_text.delta', item_id: msgId, output_index: msgOutIdx, content_index: 0, delta: ev.t });
      } else if (ev.type === 'reasoning') {
        ensureStart();
        if (!curReasoning) {
          curReasoning = { id: randId('rs_'), outIdx: nextOutIdx++, text: '' };
          sseData(res, { type: 'response.output_item.added', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'in_progress', summary: [] } });
        }
        curReasoning.text += ev.t;
        sseData(res, { type: 'response.reasoning_summary_text.delta', item_id: curReasoning.id, output_index: curReasoning.outIdx, delta: ev.t });
      } else if (ev.type === 'tool_start') {
        ensureStart();
        curTool = { id: randId('fc_'), callId: ev.id || randId('call_'), name: ev.name || '', outIdx: nextOutIdx++, args: '' };
        sseData(res, { type: 'response.output_item.added', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'in_progress', call_id: curTool.callId, name: curTool.name, arguments: '' } });
      } else if (ev.type === 'tool_delta') {
        if (curTool && curTool.outIdx != null) {
          curTool.args += ev.s;
          sseData(res, { type: 'response.function_call_arguments.delta', item_id: curTool.id, output_index: curTool.outIdx, delta: ev.s });
        }
      } else if (ev.type === 'end') {
        ensureStart();
        finishItems();
        const u = ev.usage || { input: 0, output: 0 };
        usage.input = u.input || 0; usage.output = u.output || 0;
        const finStatus = ev.finish_reason === 'length' ? 'incomplete' : (ev.finish_reason === 'content_filter' ? 'failed' : 'completed');
        const full = baseResp(finStatus);
        full.output = outputArr;
        full.incomplete_details = finStatus === 'incomplete' ? { reason: 'max_output_tokens' } : null;
        full.usage = { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output };
        if (finStatus === 'failed') full.error = { code: 'server_error', message: 'upstream finished with content_filter' };
        sseData(res, { type: 'response.' + finStatus, response: full });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}





function pickChannels(cfg, model) {
  const chs = cfg.channels || [];
  const candidates = [];
  if (model) {
    
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}


function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}


function collectJson(req, res, cb) {
  let body = '';
  const u8 = utf8();   
  req.on('data', c => { body += u8(c); if (body.length > 262144) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body || '{}'); } catch (_) { return sendError('openai', res, 400, 'bad json'); } cb(j); });
  req.on('error', () => {});
}

function availableBranches(cfg, userKey) {
  const all = CUR_POOL ? [...CUR_POOL.instances.keys()].filter(n => { const c = CUR_POOL.instances.get(n); return c && !c._disabled; }) : [cfg._name || 'default'];
  if (!userKey) return all; 
  const b = userKey.branches || [];
  return b.length ? all.filter(n => b.includes(n)) : all;
}


function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}


function persistRuntimeCfg(cfg) {
  try {
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k && k[0] === '_') ? undefined : v));
    admin.saveCfg(cfg._name || 'default', clean);
  } catch (e) { logErr('[persist] 配置落盘失败:', e.message); }
}


function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const h = crypto.scryptSync(String(pw), salt, 32);
  return 'scrypt:' + salt + ':' + h.toString('base64url');
}
function verifyPassword(pw, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const [, salt, h] = stored.split(':');
    const calc = crypto.scryptSync(String(pw), salt, 32);
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'base64url'));
  } catch (_) { return false; }
}

function keyCreditsJSON(uk) {
  const quota = Number(uk.quotaTokens) || 0;
  const used = Number(uk.usedTokens) || 0;
  return {
    name: uk.name || '', uid: uk.uid || '',
    quotaTokens: quota, usedTokens: used,
    remainingTokens: quota > 0 ? Math.max(0, quota - used) : null,
    unlimited: quota <= 0,
    expiresAt: uk.expiresAt || '',
    models: uk.models || [],
  };
}




function checkAuth(cfg, req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const presented = bearer || h['x-api-key'] || h['x-goog-api-key'] || (query && query.get('key')) || '';
  if (cfg.gatewayKey && presented && presented === cfg.gatewayKey) return { ok: true, admin: true };
  const keys = cfg.apiKeys || [];
  if (keys.length && presented) {
    const uk = keys.find(k => k.key && k.key === presented);
    if (uk) {
      if (uk.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (uk.expiresAt) {
        const t = new Date(uk.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + uk.expiresAt + ')' };
      }
      if (uk.quotaTokens > 0 && (uk.usedTokens || 0) >= uk.quotaTokens)
        return { ok: false, status: 429, error: '额度已用尽 (' + (uk.usedTokens || 0) + '/' + uk.quotaTokens + ' tokens)' };
      return { ok: true, userKey: uk };
    }
  }
  
  if (!cfg.gatewayKey && !keys.length) return { ok: true, admin: true };
  return { ok: false, status: 401, error: 'invalid key' };
}


function cfgDirOf(cfg) { return cfg._configFile ? path.dirname(cfg._configFile) : process.cwd(); }
function keyUsageFile(cfg) { return path.join(cfgDirOf(cfg), 'log', 'keyusage-' + (cfg._name || 'default') + '.json'); }
function loadKeyUsage(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(keyUsageFile(cfg), 'utf8'));
    for (const k of (cfg.apiKeys || [])) {
      const rec = j[k.key];
      if (rec && typeof rec.usedTokens === 'number') k.usedTokens = rec.usedTokens;
    }
  } catch (_) {}
}
function saveKeyUsage(cfg) {
  if (!(cfg.apiKeys || []).length) return;
  const j = {};
  for (const k of cfg.apiKeys) j[k.key] = { usedTokens: k.usedTokens || 0, name: k.name || '' };
  try { fs.mkdirSync(path.dirname(keyUsageFile(cfg)), { recursive: true }); fs.writeFileSync(keyUsageFile(cfg), JSON.stringify(j, null, 1)); } catch (_) {}
}

setInterval(() => {
  const cfgs = CUR_POOL ? [...CUR_POOL.instances.values()] : (CUR_CFG ? [CUR_CFG] : []);
  for (const c of cfgs) if (c._keyUsageDirty) { c._keyUsageDirty = false; saveKeyUsage(c); }
}, 30000).unref();


function makeGatewayApi(cfg) {
  return {
    
    findKey: (token) => (cfg.apiKeys || []).find(k => k && k.key && k.key === token) || null,
    
    grantQuota: (keyId, tokens) => {
      const k = (cfg.apiKeys || []).find(x => x && x.key === keyId);
      if (!k || !(tokens > 0)) return false;
      k.usedTokens = Math.max(0, (k.usedTokens || 0) - tokens);
      cfg._keyUsageDirty = true;
      return true;
    },
  };
}

let CUR_CFG = null;
function corsHeaders() {
  if (!CUR_CFG || !CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}

function sendError(format, res, status, message, code) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  let body;
  if (format === 'claude') body = { type: 'error', error: { type: 'api_error', message } };
  else if (format === 'gemini') body = { error: { code: status, message, status: code || 'INTERNAL' } };
  else body = { error: { message, type: 'gateway_error', code: code || String(status) } };
  try {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(body));
  } catch (_) { try { res.end(); } catch (_) {} }
}

function collectModels(cfg) {
  const set = [];
  for (const ch of (cfg.channels || [])) {
    if (ch.models) for (const m of ch.models) if (!set.includes(m)) set.push(m);
    if (ch.modelMap) for (const m of Object.keys(ch.modelMap)) if (!set.includes(m)) set.push(m);
  }
  return set;
}
function modelsResponse(cfg, format) {
  const ms = collectModels(cfg);
  if (format === 'gemini') {
    return { models: ms.map(m => ({ name: 'models/' + m, displayName: m, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] })) };
  }
  
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway', display_name: m })) };
}


function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (suffix.startsWith('/v1beta/') && /\/v1beta$/.test(b)) return b + suffix.slice(7);
  if (suffix.startsWith('/v1/') && /\/v1$/.test(b)) return b + suffix.slice(3);
  return b + suffix;
}

function upstreamRequest(cfg, ch, urlStr, headers, bodyBuf, cb, method, agentsOverride) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const agents = agentsOverride || getAgents(cfg, ch);
  const mod = isHttps ? https : http;
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    method: method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf ? bodyBuf.length : 0,
      'User-Agent': 'ai-gateway/' + VERSION,
      ...headers,
    },
    agent: isHttps ? agents.https : agents.http,
  };
  let settled = false;
  const req = mod.request(opts, (upRes) => { if (!settled) { settled = true; cb(null, upRes, req); } });
  req.setTimeout(cfg.responseTimeout, () => req.destroy(new Error('upstream idle timeout (' + Math.round(cfg.responseTimeout / 1000) + 's)')));
  req.once('error', (e) => { if (!settled) { settled = true; cb(e, null, req); } });
  if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
  req.end();
  return req;
}




function probeOnce(cfg, ch) {
  const st = cfg._stats.probe = cfg._stats.probe || {};
  const rec = st[ch.name] = st[ch.name] || { total: 0, ok: 0, lastAt: '', lastOk: '', lastErr: '' };
  rec.total++;
  rec.lastAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const mode = (cfg.probe && cfg.probe.mode) || 'models';
  const done = (ok_, err) => {
    if (ok_) { rec.ok++; rec.lastOk = rec.lastAt; rec.lastErr = ''; }
    else rec.lastErr = String(err || 'failed').slice(0, 120);
  };
  try {
    if (mode === 'chat') {
      const model = (ch.models && ch.models[0]) || 'default';
      const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }));
      upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, '/chat/completions'), {}, body, (err, upRes) => {
        if (err) return done(false, err.message);
        upRes.resume();
        done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
      }, 'POST');
    } else {
      upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, '/models'), {}, null, (err, upRes) => {
        if (err) return done(false, err.message);
        upRes.resume();
        done(upRes.statusCode < 500, 'HTTP ' + upRes.statusCode);
      }, 'GET');
    }
  } catch (e) { done(false, e.message); }
}
function probeRound(cfg) {
  if (!cfg.probe || !cfg.probe.enable || cfg._disabled) return;
  for (const ch of cfg.channels || []) {
    if (!ch.probe) continue;
    try { probeOnce(cfg, ch); } catch (_) {}
  }
}
function setupProbe(cfg) {
  if (cfg._probeTimer) { clearInterval(cfg._probeTimer); cfg._probeTimer = null; }
  if (!cfg.probe || !cfg.probe.enable) return;
  const iv = Math.max(1, Number(cfg.probe.intervalMin) || 10) * 60000;
  cfg._probeTimer = setInterval(() => probeRound(cfg), iv);
  cfg._probeTimer.unref();
  
  setTimeout(() => probeRound(cfg), 20000).unref();
  log('[probe] 成功率探测已开启: 间隔', Math.max(1, Number(cfg.probe.intervalMin) || 10), '分钟, 模式', cfg.probe.mode || 'models');
}


const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };


function fetchUpstreamModels(cfg, ch) {
  return new Promise((resolve, reject) => {
    const base = String(ch.baseUrl || '').replace(/\/+$/, '');
    let url; const headers = {};
    try {
      if (ch.type === 'openai') {
        url = joinUrl(base, '/v1/models');   
        if (ch.apiKey) headers.authorization = 'Bearer ' + ch.apiKey;
      } else if (ch.type === 'claude') {
        url = joinUrl(base, '/v1/models');
        if (ch.apiKey) { headers['x-api-key'] = ch.apiKey; headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01'; }
      } else if (ch.type === 'gemini') {
        url = joinUrl(base, '/v1beta/models');
        if (ch.apiKey) headers['x-goog-api-key'] = ch.apiKey;
      } else return reject(new Error('未知渠道类型: ' + ch.type));
      if (!base) return reject(new Error('渠道未配置 Base URL'));
      if (ch.apiKey && !/^[\x09\x20-\x7e]*$/.test(ch.apiKey)) return reject(new Error('渠道 apiKey 含非 ASCII 字符(可能残留了中文占位符), 请先在渠道设置里修正'));
    } catch (e) { return reject(e); }
    upstreamRequest({ ...cfg, responseTimeout: 20000 }, ch, url, headers, Buffer.alloc(0), (err, upRes) => {
      if (err) return reject(new Error('连接上游失败: ' + err.message));
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return reject(new Error('上游返回 ' + upRes.statusCode + ': ' + redactText(txt.slice(0, 200))));
        let ids = [];
        try {
          const j = JSON.parse(txt);
          if (Array.isArray(j.data)) ids = j.data.map(x => x && (x.id || x.name)).filter(Boolean);
          else if (Array.isArray(j.models)) ids = j.models.map(x => String(x.name || x.id || '').replace(/^models\//, '')).filter(Boolean);
          else if (Array.isArray(j)) ids = j.map(x => typeof x === 'string' ? x : (x && (x.id || x.name))).filter(Boolean);
          else throw new Error('无法识别的返回格式');
        } catch (e) { return reject(new Error('解析模型列表失败: ' + e.message)); }
        resolve([...new Set(ids.map(String))]);
      });
      upRes.on('error', e => reject(new Error('读取响应失败: ' + e.message)));
    }, 'GET');
  });
}

let _syncing = false;
async function syncModels(cfg) {
  if (_syncing) return { busy: true };
  _syncing = true;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  const inst = bn === 'config' ? 'default' : bn.replace(/^config\./, '');
  let added = 0, chCount = 0, fails = 0;
  let fileCfg = null;
  try {
    let raw = fs.readFileSync(cfg._configFile, 'utf8');
    if (crypt && crypt.isEncText(raw)) { const p = crypt.loadPass(); if (p) raw = crypt.decryptText(raw, p); }
    fileCfg = JSON.parse(raw);
  } catch (e) { logErr('[sync] 读配置失败(仅更新内存):', e.message); }
  for (const ch of (cfg.channels || [])) {
    if (!ch.baseUrl) continue;
    chCount++;
    try {
      const ids = await fetchUpstreamModels(cfg, ch);
      ch.models = Array.isArray(ch.models) ? ch.models : [];
      let n = 0;
      for (const id of ids) if (!ch.models.includes(id)) { ch.models.push(id); n++; added++; }
      if (n && fileCfg) { const fc = (fileCfg.channels || []).find(c => c.name === ch.name); if (fc) fc.models = ch.models; }
      log('[sync]', inst + '/' + ch.name, '拉到', ids.length, '新增', n, '共', ch.models.length);
    } catch (e) { fails++; log('[sync]', inst + '/' + ch.name, '失败:', e.message); }
  }
  if (fileCfg && added > 0) {
    try { admin.saveCfg(inst, fileCfg); log('[sync]', inst, '已落盘, 共新增', added); }
    catch (e) { logErr('[sync] 落盘失败:', e.message); }
  }
  _syncing = false;
  return { instance: inst, channels: chCount, added, fails };
}

const UP_RESP = { openai: openaiRespToCanonical, claude: claudeRespToCanonical, gemini: geminiRespToCanonical };
const BUILD_BODY = { openai: canonicalToOpenAIBody, claude: canonicalToClaudeBody, gemini: canonicalToGeminiBody };


const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);


function chUsesResponses(cfg, ch) {
  if (ch.type !== 'openai') return false;
  const oe = cfg.openaiExtras || {};
  if (!oe.enable) return false;
  return ch.useResponses !== undefined ? !!ch.useResponses : !!oe.upstreamResponses;
}


function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req) {
  
  
  const upApi = chUsesResponses(cfg, ch) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !(cfg.thinkingSummary && cfg.thinkingSummary.enable);
  const stream = canonical.stream;
  const upstreamModel = canonical.model; 
  let url, headers = {}, bodyBuf;
  if (direct) {
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      body.model = upstreamModel;
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      body.model = upstreamModel;
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || req.headers['anthropic-version'] || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream && urlInfo.altSse ? '?alt=sse' : '');
      headers['x-goog-api-key'] = ch.apiKey;
    }
    bodyBuf = Buffer.from(JSON.stringify(body));
  } else {
    const uc = { ...canonical, model: upstreamModel };
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      bodyBuf = Buffer.from(JSON.stringify(upApi === 'responses' ? canonicalToResponsesBody(uc) : BUILD_BODY.openai(uc, { addUsage: ch.addUsage })));
      headers.authorization = 'Bearer ' + ch.apiKey;
    } else if (ch.type === 'claude') {
      url = joinUrl(ch.baseUrl, '/v1/messages');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.claude(uc)));
      headers['x-api-key'] = ch.apiKey;
      headers['anthropic-version'] = ch.anthropicVersion || '2023-06-01';
    } else {
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      url = joinUrl(ch.baseUrl, '/v1beta/models/' + encodeURIComponent(upstreamModel) + ':' + action) + (stream ? '?alt=sse' : '');
      bodyBuf = Buffer.from(JSON.stringify(BUILD_BODY.gemini(uc)));
      headers['x-goog-api-key'] = ch.apiKey;
    }
  }
  if (stream) headers.accept = 'text/event-stream';
  return { url, headers, bodyBuf, direct, stream, upApi };
}



function instName(cfg) {
  if (cfg._name) return cfg._name;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  return bn === 'config' ? 'default' : bn.replace(/^config\./, '');
}

function writeRequestRecord(cfg, recCfg, rec) {
  const line = JSON.stringify(rec);
  if (recCfg.server) { postRequestRecord(recCfg.server, line); return; }
  try {
    const dir = path.join(path.dirname(cfg._configFile || process.cwd()), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'requests-' + instName(cfg) + '.jsonl');
    
    try {
      const st = fs.statSync(f);
      if (st.size > 5 * 1024 * 1024) {
        const txt = fs.readFileSync(f, 'utf8');
        const cut = txt.indexOf('\n', Math.max(0, txt.length - 2 * 1024 * 1024));
        fs.writeFileSync(f, cut >= 0 ? txt.slice(cut + 1) : txt.slice(-2 * 1024 * 1024));
      }
    } catch (_) {}
    fs.appendFileSync(f, line + '\n');
  } catch (e) { logErr('请求记录写入失败:', e.message); }
}
function postRequestRecord(server, line) {
  try {
    const u = new URL(server);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
    }, (resp) => { resp.resume(); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => logErr('请求记录上报失败:', e.message));
    r.end(line);
  } catch (e) { logErr('请求记录服务器地址无效:', e.message); }
}

function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, built, ctx, retryHook) {
  const { direct, stream, upApi } = built;
  const { logMeta, t0, usageCapture, stats } = ctx;
  const rpInc = (cfg.replace && Array.isArray(cfg.replace.inc)) ? rpCompile(cfg.replace.inc) : [];
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  




  let __settled = false;
  const __settle = (status, why) => {
    if (__settled) return;
    __settled = true;
    if (why) logErr('[settle]', why, 'status=' + status);
    try { ctx.logDone(status); } catch (e) { logErr('[settle] logDone 失败:', e.message); }
  };

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      

      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => { try { if (data !== '[DONE]') parser.handle(JSON.parse(data)); } catch (_) {} });
      const u8 = utf8();   
      upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
      upRes.on('end', () => {
        try {
          dec.end(); parser.finish();
          usageCapture.input = parser.usage ? parser.usage.input : 0;
          usageCapture.output = parser.usage ? parser.usage.output : 0;
          __settle(upRes.statusCode);
        } catch (e) { logErr('[stream] 结算失败，仍强制给下游收尾:', e.message); }
        try { res.end(); } catch (_) {}   
      });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游流中断(' + e.message + ')'); });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) { const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j); usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output; }
        __settle(upRes.statusCode);
      });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(非流式): ' + e.message); });
    }
    if (rpInc.length) {
      
      let buf = '';
      const u8 = utf8();   
      upRes.on('data', c => {
        try {
          buf += u8(c);
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) res.write(rpApplyText(line, rpInc) + '\n');
        } catch (_) {}
      });
      upRes.on('end', () => { try { if (buf) res.write(rpApplyText(buf, rpInc)); res.end(); } catch (_) {} });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(替换管道): ' + e.message); });
    } else {
      upRes.pipe(res);
    }
    return;
  }

  
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      

      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    const writer = wrapThinkingSummary(
      (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream }),
      cfg.thinkingSummary, ch, cfg);
    const parser = isResponsesUp ? new ResponsesStreamParser(ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    }) : new UpstreamStreamParser(ch.type, ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    });
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    const u8 = utf8();   
    upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
    upRes.on('end', () => {
      try {
        dec.end(); parser.finish();
        usageCapture.input = parser.usage ? parser.usage.input : 0;
        usageCapture.output = parser.usage ? parser.usage.output : 0;
        __settle(200);
      } catch (e) { logErr('[stream] 转换路径结算失败，仍强制收尾:', e.message); }
      try { res.end(); } catch (_) {}
    });
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} __settle(502, '上游流中断(转换): ' + e.message); });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', async () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
        
        const why = 'upstream returned non-JSON: ' + redactText(txt.slice(0, 200), cfg.redact && cfg.redact.extra);
        if (retryHook && retryHook(why)) return;
        stats.errors++;
        return sendError(clientFormat, res, 502, why);
      }
      const cresp = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
      if (cfg.thinkingSummary && cfg.thinkingSummary.enable && cresp.reasoning) {
        try {
          if (cfg.thinkingSummary.mode === 'summarize') { const s = await summarizeReasoningText(cresp.reasoning, cfg.thinkingSummary, ch, cfg); if (s) cresp.reasoning = s; }
          else cresp.reasoning = truncateReasoning(cresp.reasoning, cfg.thinkingSummary.maxCharsPerSegment);
        } catch (e) { logErr('[thinkingSummary] 非流式精简失败:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (rpInc.length) rpWalk(out, rpInc, 0, false);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
        res.end(JSON.stringify(out));
      } catch (e) { logErr('[resp] 响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
      __settle(200);
    });
    upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(转换/非流式): ' + e.message); });
  }
}

function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr) {
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');
  
  
  const redactInstOn = !(cfg.redact && cfg.redact.enable === false);
  let redactOn = redactInstOn;
  if (redactInstOn && urlInfo.userKey && urlInfo.userKey.redact === false) redactOn = false; 
  if (redactOn) body = redactDeep(body, cfg.redact && cfg.redact.extra, 0);
  
  const rpOutRules = (cfg.replace && Array.isArray(cfg.replace.out)) ? rpCompile(cfg.replace.out) : [];
  if (rpOutRules.length) body = rpWalk(body, rpOutRules, 0, true);

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  if (urlInfo.stream) canonical.stream = true; 
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');
  
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.models) && urlInfo.userKey.models.length
      && !urlInfo.userKey.models.includes(canonical.model)) {
    return sendError(clientFormat, res, 403, '此卡密不允许使用模型: ' + canonical.model + ' (可用: ' + urlInfo.userKey.models.join(', ') + ')');
  }
  
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.branches) && urlInfo.userKey.branches.length) {
    const br = cfg._name || 'default';
    if (!urlInfo.userKey.branches.includes(br)) {
      return sendError(clientFormat, res, 403, '此卡密不允许访问分组: ' + br + ' (可用: ' + urlInfo.userKey.branches.join(', ') + ')');
    }
  }
  

  const candidates = pickChannels(cfg, canonical.model);
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured in config.json');

  stats.requests++;
  
  const reqId = randId('req');
  const recCfg = (cfg.record && cfg.record.enable) ? cfg.record : null;
  const recState = { status: 0, chName: '' };
  let recChunks = null, recFinalized = false;
  const recordReq = (status, chName, inT, outT) => {
    recState.status = status; recState.chName = chName || '';
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, keyName: urlInfo.userKey ? (urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12)) : undefined });
    if (stats.recent.length > 200) stats.recent.shift();
  };
  const stream = canonical.stream;
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0 };
  function finalizeRecord() {
    if (!recCfg || recFinalized) return; recFinalized = true;
    try {
      const maxC = (recCfg.maxChars > 0 ? recCfg.maxChars : 200000);
      let resp = Buffer.concat(recChunks).toString('utf8');
      if (resp.length > maxC) resp = resp.slice(0, maxC) + '\n…[截断]';
      let reqTxt = ''; try { reqTxt = JSON.stringify(body); } catch (_) {}
      if (reqTxt.length > maxC) reqTxt = reqTxt.slice(0, maxC) + '…[截断]';
      writeRequestRecord(cfg, recCfg, {
        id: reqId, time: new Date().toISOString(), instance: instName(cfg), format: clientFormat,
        model: canonical.model, channel: recState.chName, status: recState.status,
        duration: Date.now() - t0, inputTokens: usageCapture.input || 0, outputTokens: usageCapture.output || 0,
        request: safeParse(reqTxt) || reqTxt, response: resp,
      });
    } catch (_) {}
  }
  if (recCfg) {
    recChunks = [];
    const ow = res.write.bind(res), oe = res.end.bind(res);
    res.write = (c, ...a) => { try { if (c) recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {} return ow(c, ...a); };
    res.end = (c, ...a) => {
      try { if (c && typeof c !== 'function') recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {}
      finalizeRecord();
      return oe(c, ...a);
    };
  }
  let attempt = 0;
  let lastErrStatus = 0;
  let lastErrMsg = '';

  
  const tryNext = () => {
    if (attempt >= candidates.length) {
      
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req);
    attempt++;

    
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }

    const ctx = {
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      t0, usageCapture, stats,
      logDone(status) {
        log(ctx.logMeta, 'status=' + status, 'in=' + usageCapture.input, 'out=' + usageCapture.output, 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usageCapture.input;
        stats.byChannel[ch.name].outputTokens += usageCapture.output;
        
        if (urlInfo.userKey) {
          const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
          stats.byKey = stats.byKey || {};
          stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
          stats.byKey[kn].inputTokens += usageCapture.input;
          stats.byKey[kn].outputTokens += usageCapture.output;
          urlInfo.userKey.usedTokens = (urlInfo.userKey.usedTokens || 0) + usageCapture.input + usageCapture.output;
          cfg._keyUsageDirty = true;
        }
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    if (urlInfo.userKey) {
      const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
      stats.byKey = stats.byKey || {};
      stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      stats.byKey[kn].requests++;
    }

    
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    
    
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    
    const retrySameOrNext = (why) => {
      if (connRetries < maxConnRetry) {
        connRetries++;
        log('RETRY', ctx.logMeta, why, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
        setTimeout(() => doSend(true), 400 * connRetries);
        return true;
      }
      if (attempt < candidates.length) {
        log('ERR', ctx.logMeta, why, '→ 切换渠道');
        tryNext();
        return true;
      }
      return false;
    };
    const doSend = (fresh) => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        if (isConnErr(err)) {
          if (retrySameOrNext(err.message)) return;
        } else {
          log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
          if (attempt < candidates.length) return tryNext();
        }
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

      
      const upCt = String(upRes.headers['content-type'] || '');
      if (upRes.statusCode < 400 && /text\/html/i.test(upCt)) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = 502;
          lastErrMsg = '渠道 ' + ch.name + ' 返回了 HTML 网页而非数据(content-type: ' + upCt + '): ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 200);
          if (retrySameOrNext('upstream returned HTML (content-type: ' + upCt + ')')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          return sendError(clientFormat, res, 502, lastErrMsg);
        });
        upRes.on('error', () => {
          if (retrySameOrNext('read HTML response failed')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { sendError(clientFormat, res, 502, lastErrMsg || 'upstream HTML response read failed'); } catch (_) {}
        });
        return;
      }

      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = sc;
          lastErrMsg = `渠道 ${ch.name} 返回 ${sc}: ` + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          log('RETRY', ctx.logMeta, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => { tryNext(); });
        return;
      }

      if (upRes.statusCode >= 400) {
        
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

      
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      });
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}



function handleExtraEndpoint(cfg, req, res, pathname, bodyBuf, contentType) {
  const stats = cfg._stats;
  let model = '';
  let parsed = null;
  if (contentType && contentType.startsWith('application/json')) {
    try { parsed = JSON.parse(bodyBuf.toString('utf8')); model = (parsed && parsed.model) || ''; } catch (_) {}
  }
  const candidates = pickChannels(cfg, model || undefined).filter(c => c.ch.type === 'openai');
  if (!candidates.length) {
    stats.errors++;
    return sendError('openai', res, 503, 'no openai channel for extended endpoint ' + pathname + ' (扩展端点只支持 openai 类型渠道)');
  }
  stats.requests++;
  let attempt = 0;
  let lastErr = '';
  const tryNext = () => {
    if (attempt >= candidates.length) {
      stats.errors++;
      return sendError('openai', res, 502, lastErr || ('all ' + candidates.length + ' channels failed'));
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    attempt++;
    const headers = { authorization: 'Bearer ' + ch.apiKey };
    if (contentType) headers['Content-Type'] = contentType;
    for (const [hk, hv] of Object.entries(headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        stats.errors++;
        return sendError('openai', res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }
    let outBody = bodyBuf;
    if (parsed) {
      if (pick.upstreamModel && parsed.model !== undefined && parsed.model !== pick.upstreamModel) {
        parsed.model = pick.upstreamModel;
        outBody = Buffer.from(JSON.stringify(parsed));
      }
    }
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    log('[extra]', pathname, 'model=' + (model || '-'), 'ch=' + ch.name);
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    const doSend = (fresh) => upstreamRequest(cfg, ch, joinUrl(ch.baseUrl, pathname), headers, outBody, (err, upRes) => {
      if (err) {
        lastErr = 'upstream request failed: ' + err.message;
        if (isConnErr(err) && connRetries < maxConnRetry) {
          connRetries++;
          log('RETRY', '[extra]', pathname, err.message, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
          return setTimeout(() => doSend(true), 400 * connRetries);
        }
        log('ERR', '[extra]', pathname, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
        if (attempt < candidates.length) return tryNext();
        stats.errors++;
        return sendError('openai', res, 502, lastErr);
      }
      if (upRes.statusCode >= 400 && RETRYABLE.has(upRes.statusCode) && attempt < candidates.length) {
        const sc = upRes.statusCode;
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErr = '渠道 ' + ch.name + ' 返回 ' + sc + ': ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          log('RETRY', '[extra]', pathname, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => tryNext());
        return;
      }
      if (upRes.statusCode >= 400) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          log('UPERR', '[extra]', pathname, 'status=' + upRes.statusCode);
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }
      
      try {
        res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || contentType || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders(), 'Cache-Control': 'no-cache' });
      } catch (e) { logErr('[resp] 响应头下发失败, 已中断该请求:', e.message); try { res.end(); } catch (_) {} try { upRes.resume(); } catch (_) {} return; }
      upRes.pipe(res);
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    doSend();
  };
  tryNext();
}


const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;

const EXTRA_OPENAI_ENDPOINTS = new Set([
  '/v1/images/generations', '/v1/images/edits', '/v1/images/variations',
  '/v1/embeddings',
  '/v1/audio/speech', '/v1/audio/transcriptions', '/v1/audio/translations',
  '/v1/completions',
  '/v1/moderations',
]);

async function handleHttp(cfg, req, res) {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;

  
  if (CUR_POOL) {
    const r = poolRoute(CUR_POOL, req, p);
    if (r.error) { sendError('openai', res, r.status || 404, r.error); return; }
    cfg = r.cfg;
    p = r.path;
    if (r.name) req._branchName = r.name;
    
    
    if (req._branchName) {
      const h = req.headers;
      const auth = h.authorization || '';
      const presented = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '') || h['x-api-key'] || h['x-goog-api-key'] || u.searchParams.get('key') || '';
      if (presented) {
        for (const [, c] of CUR_POOL.instances) {
          const uk = (c.apiKeys || []).find(k => k.key && k.key === presented);
          if (uk && Array.isArray(uk.branches) && uk.branches.length && !uk.branches.includes(req._branchName)) {
            return sendError('openai', res, 403, '此卡密不允许访问分组: ' + req._branchName + ' (可用: ' + uk.branches.join(', ') + ')');
          }
        }
      }
    }
  }

  if (cfg.cors && req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }

  if (req.method === 'GET' && p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
  }
  if (req.method === 'GET' && p === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, version: VERSION, startedAt: cfg._stats.startedAt, uptime: Math.round(process.uptime()),
      listen: cfg.listen, configFile: cfg._configFile,
      openaiExtras: cfg.openaiExtras || { enable: false, upstreamResponses: false },
      channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, default: c.default, delayMs: c.delayMs || 0, useResponses: !!c.useResponses })),
      proxies: Object.entries(cfg.proxies).map(([k, v]) => ({ name: k, type: v.type, host: v.host, port: v.port })),
      stats: { requests: cfg._stats.requests, errors: cfg._stats.errors, byChannel: cfg._stats.byChannel, byKey: cfg._stats.byKey || {} },
      probe: Object.fromEntries(Object.entries(cfg._stats.probe || {}).map(([k, v]) => [k, { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr }])),
    }));
  }

  
  if (p === '/admin' || p === '/admin/' || p.startsWith('/admin/api/') || p.startsWith('/admin/m3')) {
    
    
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
      const u8 = utf8();   
      req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
  
  if (req.method === 'GET' && (p === '/user' || p === '/user/')) {
    const f = path.join(__dirname, 'user.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      return jsonErr(res, { error: '用户端页面未找到, 请把 user.html 放到网关目录: ' + f }, 404);
    }
  }
  
  if (PLUGINS && (p === '/plugins' || p.startsWith('/plugins/'))) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      PLUGINS.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
    } else {
      let pbody = '';
      const u8 = utf8();   
      req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { PLUGINS.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    }
    return;
  }

  
  if (req.method === 'GET' && p === '/credits') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    if (authR.userKey) return res.end(JSON.stringify(keyCreditsJSON(authR.userKey)));
    return res.end(JSON.stringify({ admin: true, unlimited: true })); 
  }

  
  if (req.method === 'POST' && p === '/auth/login') {
    let body = '';
    const u8 = utf8();   
    req.on('data', c => { body += u8(c); if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const uid = String(j.uid || '').trim();
        const user = (cfg.users || []).find(x => x.uid === uid);
        if (!user || !verifyPassword(j.password || '', user.passwordHash))
          return sendError('openai', res, 401, 'UID 或密码错误');
        const myKeys = (cfg.apiKeys || []).filter(k => k.uid === uid);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({
          ok: true, uid: user.uid, name: user.name || '',
          keys: myKeys.map(k => ({ key: k.key, ...keyCreditsJSON(k) })),
        }));
      } catch (e) { sendError('openai', res, 400, 'bad json'); }
    });
    req.on('error', () => {});
    return;
  }

  
  if (req.method === 'POST' && p === '/auth/register') {
    let body = '';
    const u8 = utf8();   
    req.on('data', c => { body += u8(c); if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      try {
        const reg = cfg.registration || {};
        if (!reg.enable) return sendError('openai', res, 403, '该服务器未开放注册');
        const j = JSON.parse(body || '{}');
        const uid = String(j.uid || '').trim();
        const pw = String(j.password || '');
        if (!/^[A-Za-z0-9_-]{3,32}$/.test(uid)) return sendError('openai', res, 400, 'UID 需 3-32 位字母/数字/下划线');
        if (pw.length < (reg.minPasswordLen || 8)) return sendError('openai', res, 400, '密码至少 ' + (reg.minPasswordLen || 8) + ' 位');
        if ((cfg.users || []).some(x => x.uid === uid)) return sendError('openai', res, 409, 'UID 已被注册');
        
        if (reg.captchaProvider === 'turnstile') {
          if (!reg.captchaSecret) return sendError('openai', res, 500, '管理端未配置 captchaSecret');
          const token = String(j.captchaToken || '');
          if (!token) return sendError('openai', res, 400, '缺少人机验证');
          const okT = await new Promise(resolve => {
            const postData = 'secret=' + encodeURIComponent(reg.captchaSecret) + '&response=' + encodeURIComponent(token);
            const rq = https.request({
              hostname: 'challenges.cloudflare.com', path: '/turnstile/v0/siteverify', method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
              timeout: 10000,
            }, (r2) => {
              let d = ''; r2.on('data', c => d += c); r2.on('end', () => {
                try { resolve(!!JSON.parse(d).success); } catch (_) { resolve(false); }
              });
            });
            rq.on('error', () => resolve(false));
            rq.on('timeout', () => { rq.destroy(); resolve(false); });
            rq.write(postData); rq.end();
          });
          if (!okT) return sendError('openai', res, 403, '人机验证失败');
        }
        
        const email = String(j.email || '').trim();
        if (reg.emailVerify && reg.emailVerify.enable && !email) return sendError('openai', res, 400, '需要邮箱');
        
        cfg.users = cfg.users || [];
        cfg.users.push({
          uid, name: uid, passwordHash: hashPassword(pw),
          note: email ? ('email:' + email) : '', createdAt: new Date().toISOString(),
        });
        
        cfg.apiKeys = cfg.apiKeys || [];
        const nk = {
          key: genApiKey(cfg.keyLength), name: uid, enable: true,
          quotaTokens: reg.defaultQuota || 0, usedTokens: 0,
          models: [], channels: [], uid, note: '注册自动发卡', createdAt: new Date().toISOString(),
        };
        cfg.apiKeys.push(nk);
        persistRuntimeCfg(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: true, uid, key: nk.key, quotaTokens: nk.quotaTokens }));
        log('[auth] 新用户注册:', uid);
      } catch (e) { sendError('openai', res, 400, 'bad json'); }
    });
    req.on('error', () => {});
    return;
  }

  
  if (p === '/auth/me' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密(非管理员key)');
    const uk = authR.userKey;
    const user = uk.uid ? (cfg.users || []).find(x => x.uid === uk.uid) : null;
    const myKeys = uk.uid ? (cfg.apiKeys || []).filter(k => k.uid === uk.uid) : [uk];
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({
      ok: true, uid: uk.uid || '', name: (user && user.name) || uk.name || '',
      nickname: (user && user.nickname) || '', avatar: (user && user.avatar) || '',
      mainKey: uk.key,
      keys: myKeys.map(k => ({ key: k.key, name: k.name, ...keyCreditsJSON(k), branches: k.branches || [], isMain: k.key === uk.key })),
      branches: availableBranches(cfg, uk),
    }));
  }
  if (p === '/auth/profile' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      if (uk.uid) {
        const user = (cfg.users || []).find(x => x.uid === uk.uid);
        if (user) {
          if (j.nickname !== undefined) user.nickname = String(j.nickname).slice(0, 64);
          if (j.name !== undefined) user.name = String(j.name).slice(0, 64);
          if (j.avatar !== undefined) user.avatar = String(j.avatar).slice(0, 300);
          persistRuntimeCfg(cfg);
        }
      }
      
      if (j.cardName !== undefined) { uk.name = String(j.cardName).slice(0, 64); persistRuntimeCfg(cfg); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  
  if (p === '/auth/mykeys') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
    const uk = authR.userKey;
    if (req.method === 'GET') {
      const myKeys = uk.uid ? (cfg.apiKeys || []).filter(k => k.uid === uk.uid) : [uk];
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      return res.end(JSON.stringify({ keys: myKeys.map(k => ({ key: k.key, name: k.name, ...keyCreditsJSON(k), branches: k.branches || [], redact: k.redact == null ? null : !!k.redact, isMain: k.key === uk.key })) }));
    }
    if (req.method === 'POST') {
      collectJson(req, res, (j) => {
        
        const parentModels = uk.models || [], parentBranches = uk.branches || [];
        const models = Array.isArray(j.models) ? j.models.map(String).filter(m => !parentModels.length || parentModels.includes(m)) : [];
        const branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !parentBranches.length || parentBranches.includes(b)) : [];
        let quota = Math.max(0, Number(j.quotaTokens) || 0);
        if (uk.quotaTokens > 0) {
          const remaining = uk.quotaTokens - (uk.usedTokens || 0);
          if (quota <= 0 || quota > remaining) quota = remaining; 
        }
        const nk = {
          key: genApiKey(cfg.keyLength), name: String(j.name || uk.name || '子卡').slice(0, 64),
          enable: true, quotaTokens: quota, usedTokens: 0, uid: uk.uid || '',
          models, branches, channels: [], note: String(j.note || '用户自助').slice(0, 200),
          createdAt: new Date().toISOString(),
        };
        cfg.apiKeys = cfg.apiKeys || [];
        cfg.apiKeys.push(nk);
        persistRuntimeCfg(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ ok: true, key: nk }));
      });
      return;
    }
  }
  if (p === '/auth/mykeys-update' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      const target = (cfg.apiKeys || []).find(k => k.key === j.key && (k.uid ? k.uid === uk.uid : k.key === uk.key));
      if (!target) return sendError('openai', res, 404, '卡密不存在或不属于你');
      if (j.name !== undefined) target.name = String(j.name).slice(0, 64);
      if (j.models !== undefined) {
        const pm = uk.models || [];
        target.models = Array.isArray(j.models) ? j.models.map(String).filter(m => !pm.length || pm.includes(m)) : [];
      }
      if (j.branches !== undefined) {
        const pb = uk.branches || [];
        target.branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !pb.length || pb.includes(b)) : [];
      }
      if (j.redact !== undefined) target.redact = (j.redact == null) ? null : !!j.redact;
      if (j.quotaTokens !== undefined && target.key !== uk.key) {
        let q = Math.max(0, Number(j.quotaTokens) || 0);
        if (uk.quotaTokens > 0) q = Math.min(q, uk.quotaTokens - (uk.usedTokens || 0));
        target.quotaTokens = q;
      }
      persistRuntimeCfg(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (p === '/auth/mykeys-delete' && req.method === 'POST') {
    collectJson(req, res, (j) => {
      const authR = checkAuth(cfg, req, u.searchParams);
      if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
      if (!authR.userKey) return sendError('openai', res, 403, '需要用户卡密');
      const uk = authR.userKey;
      if (j.key === uk.key) return sendError('openai', res, 400, '不能删除主卡');
      const before = (cfg.apiKeys || []).length;
      cfg.apiKeys = (cfg.apiKeys || []).filter(k => !(k.key === j.key && k.uid === uk.uid));
      if (cfg.apiKeys.length < before) persistRuntimeCfg(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true, deleted: before - cfg.apiKeys.length }));
    });
    return;
  }

  
  if (p === '/v1/branches' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ branches: availableBranches(cfg, authR.userKey) }));
  }

  
  if (req.method === 'GET' && p === '/auth/register') {
    const reg = cfg.registration || {};
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({
      enable: !!reg.enable,
      captchaProvider: reg.captchaProvider || 'none',
      captchaSiteKey: reg.captchaSiteKey || '',
      minPasswordLen: reg.minPasswordLen || 8,
      emailRequired: !!(reg.emailVerify && reg.emailVerify.enable),
    }));
  }

  if (req.method === 'GET' && (p === '/v1/models' || p === '/v1beta/models')) {
    const fmt = p === '/v1beta/models' ? 'gemini' : 'openai';
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError(fmt, res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify(modelsResponse(cfg, fmt)));
  }

  if (req.method !== 'POST') return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);

  let clientFormat = null;
  let clientApi = 'chat';
  const urlInfo = { model: null, altSse: false };
  const oe = cfg.openaiExtras || {};
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else if (p === '/v1/responses') {
    if (!oe.enable) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (OpenAI 扩展端点未开启: 配置 openaiExtras.enable=true)');
    clientFormat = 'openai';
    clientApi = 'responses';
  } else {
    const m = GEMINI_RE.exec(p);
    if (m) {
      clientFormat = 'gemini';
      urlInfo.model = decodeURIComponent(m[1]);
      urlInfo.altSse = u.searchParams.get('alt') === 'sse';
      urlInfo.stream = m[2] === 'streamGenerateContent';
      if (m[2] === 'countTokens') return sendError('gemini', res, 501, 'countTokens is not supported by this gateway');
    }
  }
  
  if (!clientFormat && oe.enable && EXTRA_OPENAI_ENDPOINTS.has(p)) {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const ct = req.headers['content-type'] || '';
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > cfg.maxBodyBytes) { aborted = true; req.destroy(); sendError('openai', res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)'); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) handleExtraEndpoint(cfg, req, res, p, Buffer.concat(chunks), ct); });
    req.on('error', () => {});
    return;
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent; 开启 openaiExtras.enable 后还有 /v1/responses 与 /v1/images|embeddings|audio|completions|moderations)');

  const authR = checkAuth(cfg, req, u.searchParams);
  if (!authR.ok) return sendError(clientFormat, res, authR.status || 401, authR.error || 'invalid key');
  urlInfo.userKey = authR.userKey || null;

  let bodyStr = '';
  let size = 0;
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > cfg.maxBodyBytes) {
      aborted = true;
      req.destroy();
      sendError(clientFormat, res, 413, 'request body too large (>' + cfg.maxBodyBytes + ' bytes)');
      return;
    }
    bodyStr += c.toString('utf8');
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr);
    } catch (e) {
      logErr('chat crash:', e);
      sendError(clientFormat, res, 500, 'internal: ' + e.message);
    }
  });
  req.on('error', () => {});
}

function startServer(cfg, opts = {}) {
  CUR_CFG = cfg;
  applyDefaults(cfg);
  const cfgDir = cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'ai-gateway');
  admin.setDir(cfgDir);
  if (PLUGINS) admin.setPlugins(PLUGINS);

  
  if (opts.multi) {
    const pool = createInstancePool(cfgDir);
    CUR_POOL = pool;
    pool.mainHost = opts.host || cfg.listen.host;
    admin.setPool(pool);
    admin.setUpstreamModels((ch, inst) => fetchUpstreamModels((inst && pool.instances.get(inst)) || cfg, ch));
    admin.setSyncFn((inst) => syncModels((inst && pool.instances.get(inst)) || cfg));
    poolLoadAll(pool, cfg);
    log(`ai-gateway v${VERSION} 就绪 (多实例单进程模式):`);
    log(`  主端口 ${pool.mainHost}:${pool.mainPort}${pool.mainTlsPort ? ' (https:' + pool.mainTlsPort + ')' : ''}  →  /实例名/v1/... 访问对应实例, 无前缀 = default`);
    for (const [name, c] of pool.instances) {
      const ports = [];
      for (const srv of pool.servers.values()) if (srv.name === name) ports.push((srv.tls ? 'https:' : '') + srv.port);
      log(`  实例 ${name}${c._disabled ? ' [已停用]' : ''}: ${c.channels.length} 渠道${ports.length ? ', 端口 ' + ports.join(',') : ''}`);
      for (const ch of c.channels) log(`    渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
    }
    return Promise.resolve({ pool, port: pool.mainPort, host: pool.mainHost, cfg });
  }

  
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  setupModelSync(cfg);
  loadKeyUsage(cfg);
  setupProbe(cfg);
  if (PLUGINS) { try { PLUGINS.activateInstance(cfg._name || 'default', cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败: ' + e.message); } }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  
  let tlsCfg = null;
  if (cfg.tls && cfg.tls.enable) {
    const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.cert);
    const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(path.dirname(cfg._configFile || process.cwd()), cfg.tls.key);
    try {
      tlsCfg = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        port: cfg.tls.port,
      };
    } catch (e) {
      logErr(`⚠ TLS 已启用但证书读取失败: ${e.message}`);
      logErr(`  cert: ${certPath}`);
      logErr(`  key:  ${keyPath}`);
      logErr(`  请先运行 ~/ai-gateway/gen-cert.sh 生成证书, 或在 config.json 中设置 "tls": {"enable": false}`);
      logErr(`  本次将以纯 HTTP 模式启动`);
    }
  }

  if (!tlsCfg) {
    
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        const realPort = server.address().port;
        log(`ai-gateway v${VERSION} 就绪: http://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${realPort}  配置: ${cfg._configFile}`);
        for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
        for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
        resolve({ server, port: realPort, host, cfg });
      });
    });
  }

  
  const httpsPort = tlsCfg.port != null ? tlsCfg.port : port;
  const dualMode = tlsCfg.port != null && tlsCfg.port !== port;

  return new Promise((resolve, reject) => {
    const results = { servers: [], ports: [], cfg };

    const logReady = () => {
      log(`ai-gateway v${VERSION} 就绪 (配置: ${cfg._configFile}):`);
      for (const [p, scheme] of results.ports) {
        log(`  ${scheme}://${host === '0.0.0.0' ? '127.0.0.1(本机)/局域网IP' : host}:${p}`);
      }
      for (const ch of cfg.channels) log(`  渠道 [${ch.type}] ${ch.name} → ${ch.baseUrl}  proxy=${ch.proxy || '直连'}${ch.default ? '  (default)' : ''}`);
      for (const [k, v] of Object.entries(cfg.proxies)) log(`  代理 ${k} = ${v.type}://${v.host}:${v.port}${v.username ? ' (带认证)' : ''}`);
    };

    let pending = dualMode ? 2 : 1;
    const onReady = (server, p, scheme) => {
      results.servers.push(server);
      results.ports.push([p, scheme]);
      if (--pending === 0) { logReady(); resolve({ servers: results.servers, ports: results.ports, server: results.servers[0], port: results.ports[0][0], host, cfg }); }
    };
    const onErr = (e) => reject(e);

    
    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });

    
    if (dualMode) {
      const httpServer = http.createServer(handler);
      httpServer.once('error', onErr);
      httpServer.listen(port, host, () => {
        httpServer.removeAllListeners('error');
        onReady(httpServer, httpServer.address().port, 'http');
      });
    }
  });
}







const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'credits', 'auth', 'plugins', 'user']);
let CUR_POOL = null;

function setupModelSync(cfg) {
  teardownModelSync(cfg);
  if (!(cfg.modelSync && cfg.modelSync.enable !== false)) return;
  const hrs = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  const run = () => syncModels(cfg).catch(e => logErr('[sync:' + instName(cfg) + '] 定时任务出错:', e.message));
  cfg._syncTimer0 = setTimeout(run, 30000); 
  cfg._syncTimer = setInterval(run, hrs * 3600 * 1000);
}
function teardownModelSync(cfg) {
  if (cfg._syncTimer0) { clearTimeout(cfg._syncTimer0); cfg._syncTimer0 = null; }
  if (cfg._syncTimer) { clearInterval(cfg._syncTimer); cfg._syncTimer = null; }
}

function createInstancePool(dir) {
  const pool = {
    dir,
    instances: new Map(),  
    servers: new Map(),    
    portOwner: new Map(),  
    mainPort: 0,
    mainTlsPort: 0,
    mainHost: '0.0.0.0',
  };
  pool.reload = (name) => poolLoadInstance(pool, name);
  pool.removeInst = (name) => poolRemoveInstance(pool, name);
  pool.renameInst = (a, b) => poolRenameInstance(pool, a, b);
  return pool;
}


function readTlsCfg(cfg) {
  if (!(cfg.tls && cfg.tls.enable)) return null;
  if (cfg._tlsCache) return cfg._tlsCache;
  const base = path.dirname(cfg._configFile || process.cwd());
  const certPath = path.isAbsolute(cfg.tls.cert) ? cfg.tls.cert : path.join(base, String(cfg.tls.cert || 'cert.pem'));
  const keyPath = path.isAbsolute(cfg.tls.key) ? cfg.tls.key : path.join(base, String(cfg.tls.key || 'key.pem'));
  try {
    cfg._tlsCache = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), port: cfg.tls.port };
  } catch (e) {
    logErr('[pool] 实例 ' + instName(cfg) + ' TLS 证书读取失败(' + e.message + '), 该实例 HTTPS 端口跳过');
    return null;
  }
  return cfg._tlsCache;
}


function poolDesiredPorts(pool) {
  const d = new Map(); 
  const def = pool.instances.get('default');
  if (!def) return d;
  const mainPort = def.listen.port;
  pool.mainPort = mainPort;
  pool.mainTlsPort = 0;
  const defTls = readTlsCfg(def);
  if (defTls && defTls.port == null) {
    
    d.set('https:' + mainPort, { name: 'default', port: mainPort, tls: true, tlsCfg: defTls, main: true });
    pool.mainTlsPort = mainPort;
  } else {
    d.set('http:' + mainPort, { name: 'default', port: mainPort, tls: false, main: true });
    if (defTls && defTls.port != null && defTls.port !== mainPort) {
      d.set('https:' + defTls.port, { name: 'default', port: defTls.port, tls: true, tlsCfg: defTls, main: true });
      pool.mainTlsPort = defTls.port;
    }
  }
  
  for (const [name, cfg] of pool.instances) {
    if (name === 'default' || cfg._disabled) continue;
    const p = cfg.listen.port;
    if (p && p !== mainPort && !d.has('http:' + p) && !d.has('https:' + p)) d.set('http:' + p, { name, port: p, tls: false });
    const tc = readTlsCfg(cfg);
    if (tc && tc.port != null && tc.port !== mainPort && !d.has('http:' + tc.port) && !d.has('https:' + tc.port))
      d.set('https:' + tc.port, { name, port: tc.port, tls: true, tlsCfg: tc });
  }
  return d;
}


function poolReconcilePorts(pool) {
  const desired = poolDesiredPorts(pool);
  for (const [key, srv] of [...pool.servers]) {
    if (!desired.has(key)) {
      pool.servers.delete(key);
      try { srv.server.close(); } catch (_) {}
      log('[pool] 端口 ' + srv.port + (srv.tls ? '(https)' : '') + ' 已关闭 (' + srv.name + ')');
    }
  }
  for (const [key, dd] of desired) {
    if (pool.servers.has(key)) continue;
    let server;
    try {
      server = dd.tls ? https.createServer({ cert: dd.tlsCfg.cert, key: dd.tlsCfg.key }, poolHandler) : http.createServer(poolHandler);
    } catch (e) { logErr('[pool] 创建服务失败 ' + key + ': ' + e.message); continue; }
    server.on('error', e => logErr('[pool] 端口 ' + dd.port + ' 监听错误: ' + e.message));
    try {
      server.listen(dd.port, pool.mainHost, () => {
        log('[pool] 监听 ' + (dd.tls ? 'https' : 'http') + ' :' + dd.port + (dd.main ? ' (主端口)' : ' → 实例 ' + dd.name));
      });
    } catch (e) { logErr('[pool] 端口 ' + dd.port + ' 监听失败: ' + e.message); continue; }
    pool.servers.set(key, { server, server0: server, port: dd.port, tls: dd.tls, name: dd.name });
  }
  pool.portOwner = new Map();
  for (const dd of desired.values()) pool.portOwner.set(dd.port, dd.name);
}

function poolHandler(req, res) {
  handleHttp(CUR_CFG, req, res).catch(e => {
    logErr('handler crash:', e);
    sendError('openai', res, 500, 'internal: ' + (e && e.message));
  });
}


function poolLoadInstance(pool, name) {
  const old = pool.instances.get(name);
  if (old) teardownModelSync(old);
  if (old && old._probeTimer) { clearInterval(old._probeTimer); }
  const f = path.join(pool.dir, name === 'default' ? 'config.json' : 'config.' + name + '.json');
  if (!fs.existsSync(f)) {
    if (old) { pool.instances.delete(name); poolReconcilePorts(pool); }
    return null;
  }
  const cfg = loadConfig(f);
  cfg._name = name;
  cfg._disabled = !!cfg.disabled;
  loadKeyUsage(cfg); 
  
  if (old && Array.isArray(old.apiKeys)) {
    const oldMap = {}; for (const k of old.apiKeys) oldMap[k.key] = k.usedTokens || 0;
    for (const k of (cfg.apiKeys || [])) k.usedTokens = Math.max(k.usedTokens || 0, oldMap[k.key] || 0);
  }
  cfg._stats = (old && old._stats) || { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] }; 
  pool.instances.set(name, cfg);
  setupModelSync(cfg);
  setupProbe(cfg);
  if (PLUGINS) { try { PLUGINS.activateInstance(name, cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败 ' + name + ': ' + e.message); } }
  poolReconcilePorts(pool);
  return cfg;
}

function poolLoadAll(pool, defaultCfg) {
  defaultCfg._name = 'default';
  defaultCfg._disabled = !!defaultCfg.disabled;
  defaultCfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] };
  pool.instances.set('default', defaultCfg);
  setupModelSync(defaultCfg);
  if (PLUGINS) { try { PLUGINS.activateInstance('default', defaultCfg, makeGatewayApi(defaultCfg)); } catch (e) { logErr('[plugins] default 激活失败: ' + e.message); } }
  let files = [];
  try { files = fs.readdirSync(pool.dir); } catch (_) {}
  for (const f of files.sort()) {
    const m = /^config\.([A-Za-z0-9_-]{1,32})\.json$/.exec(f);
    if (!m || pool.instances.has(m[1])) continue;
    try { poolLoadInstance(pool, m[1]); log('[pool] 实例 ' + m[1] + ' 已加载 (' + (pool.instances.get(m[1]).channels.length) + ' 渠道)'); }
    catch (e) { logErr('[pool] 实例 ' + m[1] + ' 配置加载失败: ' + e.message); }
  }
  poolReconcilePorts(pool);
}

function poolRemoveInstance(pool, name) {
  const old = pool.instances.get(name);
  if (old) teardownModelSync(old);
  if (PLUGINS) { try { PLUGINS.deactivateInstance(name); } catch (_) {} }
  pool.instances.delete(name);
  poolReconcilePorts(pool);
}

function poolRenameInstance(pool, oldName, newName) {
  const cfg = pool.instances.get(oldName);
  if (!cfg) return false;
  pool.instances.delete(oldName);
  cfg._name = newName;
  cfg._configFile = path.join(pool.dir, 'config.' + newName + '.json');
  pool.instances.set(newName, cfg);
  poolReconcilePorts(pool);
  return true;
}


function poolRoute(pool, req, p) {
  const lp = req.socket && req.socket.localPort;
  if (lp && lp !== pool.mainPort && lp !== pool.mainTlsPort) {
    const name = pool.portOwner.get(lp);
    if (name) {
      const cfg = pool.instances.get(name);
      if (cfg) {
        if (cfg._disabled) return { error: '实例已停用: ' + name, status: 503 };
        return { cfg, path: p, name, via: 'port' };
      }
    }
    return { error: '端口 ' + lp + ' 没有对应的实例', status: 404 };
  }
  const m = /^\/([A-Za-z0-9_-]{1,32})(?=\/|$)/.exec(p);
  if (m && !RESERVED_PATHS.has(m[1])) {
    const name = m[1];
    const cfg = pool.instances.get(name);
    if (!cfg) return { error: '未知实例: ' + name + ' (可用实例: ' + [...pool.instances.keys()].join(', ') + ')', status: 404 };
    if (cfg._disabled) return { error: '实例已停用: ' + name, status: 503 };
    const rest = p.slice(name.length + 1) || '/';
    return { cfg, path: rest, name, via: 'path' };
  }
  const cfg = pool.instances.get('default');
  if (!cfg) return { error: 'default 实例不存在', status: 503 };
  return { cfg, path: p, name: 'default', via: 'default' };
}


function main() {
  const args = process.argv.slice(2);
  let configPath = path.join(__dirname, 'config.json');
  let portOverride;
  for (const a of args) {
    if (/^\d+$/.test(a)) portOverride = Number(a);
    else configPath = a;
  }
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    logErr('配置加载失败:', e.message);
    process.exit(1);
  }
  if (!cfg.channels.length) logErr('⚠ 配置里没有任何有效渠道, 请求会返回 503');
  process.on('unhandledRejection', e => logErr('unhandledRejection:', (e && e.message) || e));
  process.on('uncaughtException', e => logErr('uncaughtException:', (e && e.message) || e));
  process.on('SIGTERM', () => { const cs = CUR_POOL ? [...CUR_POOL.instances.values()] : [cfg]; for (const c of cs) { try { saveKeyUsage(c); } catch (_) {} } try { PLUGINS && PLUGINS.flushAll(); } catch (_) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  
  const multi = portOverride == null && process.env.AGW_SINGLE !== '1';
  startServer(cfg, { port: portOverride, multi }).catch(e => { logErr('启动失败:', e.message); process.exit(1); });
}

if (require.main === module) main();

module.exports = {
  VERSION, loadConfig, normalizeProxy, joinUrl, pickChannel, pickChannels, collectModels, RETRYABLE,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp,
  ResponsesStreamParser, makeResponsesWriter, chUsesResponses, buildRequestForChannel,
  SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish,
  socks5Connect, httpConnect, dialViaProxy, makeReader,
  truncateReasoning, summarizeReasoningText, wrapThinkingSummary, callUpstreamText,
  startServer, checkAuth,
  createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute,
  RESERVED_PATHS, INST_NAME_RE,
  loadKeyUsage, saveKeyUsage, keyUsageFile,
  hashPassword, verifyPassword, keyCreditsJSON, genApiKey,
  probeRound, probeOnce, setupProbe,
};
