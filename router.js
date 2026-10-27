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
const { logErr, log, toText, utf8 } = require('./util');
const ctxp = require('./ctxp');
const state = require('./state');
const admin = require('./admin');

// ================= 渠道路由 / 鉴权 / 错误 / 模型列表 =================
/* ================= 渠道路由 / 鉴权 / 错误 / 模型列表 ================= */

// 收集所有匹配该 model 的候选渠道, 按 round-robin 计数器旋转起始位置
// 返回 [{ ch, upstreamModel }, ...] (已旋转, 第一个该本轮使用)
function pickChannels(cfg, model, forceName) {
  const chs = cfg.channels || [];
  const candidates = [];
  // 手动路由: 请求头 x-agw-channel > 实例级 forceChannel > 自动匹配。命中即单渠道, 不参与轮转
  const forced = forceName ? String(forceName).trim() : '';
  if (forced) {
    const hit = chs.find(c => c.name === forced);
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      return [{ ch: hit, upstreamModel: um, forced: true }];
    }
    logErr('[route] 手动路由的渠道不存在, 退回自动匹配: ' + forced);
  }
  // 一次性路由: 悬浮球里点选的渠道, 用一次就清掉, 不落盘
  if (cfg._onceChannel) {
    const onceName = String(cfg._onceChannel);
    const hit = chs.find(c => c.name === onceName);
    cfg._onceChannel = null;
    if (hit) {
      const um = (hit.modelMap && model && Object.prototype.hasOwnProperty.call(hit.modelMap, model))
        ? String(hit.modelMap[model]) : (model || '');
      log('[route] 一次性路由命中: ' + onceName);
      return [{ ch: hit, upstreamModel: um, once: true }];
    }
    logErr('[route] 一次性路由的渠道已不存在, 走自动匹配: ' + onceName);
  }
  if (model) {
    // 1) modelMap 精确命中
    for (const ch of chs) {
      if (ch.modelMap && Object.prototype.hasOwnProperty.call(ch.modelMap, model)) {
        candidates.push({ ch, upstreamModel: String(ch.modelMap[model]) });
      }
    }
    // 2) models 列表命中 (避免和 modelMap 重复加入同一渠道)
    if (!candidates.length) {
      for (const ch of chs) {
        if (ch.models && ch.models.includes(model)) candidates.push({ ch, upstreamModel: model });
      }
    }
  }
  // 3) 没有任何精确命中 → 用 default 渠道 (可多个) 或全部渠道兜底
  if (!candidates.length) {
    const defs = chs.filter(c => c.default);
    const pool = defs.length ? defs : chs;
    for (const ch of pool) candidates.push({ ch, upstreamModel: model || '' });
  }
  if (!candidates.length) return [];
  // round-robin: 用 model 做 key 的计数器决定起始偏移
  if (!cfg._rr) cfg._rr = {};
  const key = model || '__nomodel__';
  cfg._rr[key] = ((cfg._rr[key] || 0) + 1) % candidates.length;
  const rot = cfg._rr[key];
  return candidates.slice(rot).concat(candidates.slice(0, rot));
}

// 请求级/实例级强制渠道: 请求头优先(只影响本次), 其次实例配置
function forcedChannelName(cfg, req) {
  const h = (req && req.headers) ? String(req.headers['x-agw-channel'] || '').trim() : '';
  if (h) return h;
  return cfg.forceChannel ? String(cfg.forceChannel) : '';
}

// 模型名通配匹配(* 任意), 不区分大小写
function globMatch(pat, str) {
  const esc = String(pat).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + esc + '$', 'i').test(String(str)); } catch (_) { return false; }
}

// 按 contextWindows 表(有序, 支持通配, 兜底 *)取模型窗口大小; 取不到返回 0 = 不显示占用
function matchContextWindow(cfg, model) {
  const list = Array.isArray(cfg.contextWindows) ? cfg.contextWindows : [];
  const m = String(model || '');
  for (const it of list) {
    if (!it || it.window == null) continue;
    const pat = String(it.match || '').trim();
    if (!pat) continue;
    if (pat === m || globMatch(pat, m)) return Math.max(0, Number(it.window) || 0);
  }
  return 0;
}

// 粗估 prompt token 数: 只用于硬上限的前置拦截, 不是精确分词
// 中文/日文/韩文按 1 字 ≈ 1 token, 其余按 charsPerToken(默认 4) 字符 ≈ 1 token
const CJK_RE = /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/g;
// 零分配 CJK 计数(与旧 CJK_RE 正则等价的范围判断): 大上下文时省掉 match 数组分配
function countCjk(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) n++;
  }
  return n;
}
// 粗估 token 数(不是精确分词): CJK 1字 ≈ 1 token, 其余 cpt 字符 ≈ 1 token
function tokOf(str, cpt) {
  str = String(str || '');
  if (!str) return 0;
  const cjk = countCjk(str);
  return Math.ceil(cjk + (str.length - cjk) / cpt);
}

// 请求侧单次扫描(2026-10-27 重构): 总量 + 分布(tools/system/user/history) 一趟算完
// history = assistant/tool 历史轮次, 与 system(系统提示) 分开, 才能看出"是提示膨胀还是历史膨胀"
function analyzePrompt(canonical, charsPerToken) {
  const cpt = Math.max(1, Number(charsPerToken) || 4);
  const dist = { tools: 0, system: 0, user: 0, history: 0 };
  const msgs = Array.isArray(canonical && canonical.messages) ? canonical.messages : [];
  if (Array.isArray(canonical && canonical.tools)) dist.tools = tokOf(JSON.stringify(canonical.tools), cpt);
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { dist.system += tokOf(toText(m.content), cpt) + 4; continue; }
    if (m.role === 'user') { dist.user += tokOf(toText(m.content), cpt) + 4; continue; }
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { const fn = (tc && tc.function) || {}; dist.history += tokOf(fn.name, cpt) + tokOf(fn.arguments, cpt); }
    dist.history += tokOf(toText(m.content), cpt) + 4;
  }
  dist.history += Math.ceil(msgs.length * 0.5);
  return { total: dist.tools + dist.system + dist.user + dist.history, dist };
}
// 兼容旧调用
function estimatePromptTokens(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).total; }
function estimatePromptDist(canonical, charsPerToken) { return analyzePrompt(canonical, charsPerToken).dist; }

// ---- 自校准(2026-10-27): 每模型 EMA(真实 input / 本地估算), 存 byModel[n].estRatio 随统计落盘 ----
const EST_RATIO_MIN = 0.1, EST_RATIO_MAX = 10, EST_EMA_A = 0.2;
function calibRatio(cfg, model) {
  const bm = cfg && cfg._stats && cfg._stats.byModel && cfg._stats.byModel[model];
  const r = bm && Number(bm.estRatio);
  return (r >= EST_RATIO_MIN && r <= EST_RATIO_MAX) ? r : 1;
}
function calibUpdate(cfg, model, actual, rawEst) {
  if (!(actual > 0) || !(rawEst > 0)) return;
  const stats = cfg._stats = cfg._stats || {};
  stats.byModel = stats.byModel || {};
  const bm = stats.byModel[model] = stats.byModel[model] || { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
  const r = Math.min(EST_RATIO_MAX, Math.max(EST_RATIO_MIN, actual / rawEst));
  bm.estRatio = bm.estRatio ? bm.estRatio * (1 - EST_EMA_A) + r * EST_EMA_A : r;
}
// 应用校准系数后的估算(硬上限/ctxp 拦截用, 误杀更少)
function estPromptAdj(cfg, model, canonical) {
  const raw = analyzePrompt(canonical, ((cfg.contextLimit || {}).charsPerToken) || 4);
  const ratio = calibRatio(cfg, model);
  if (ratio === 1) return raw;
  const dist = {}; for (const k in raw.dist) dist[k] = Math.round(raw.dist[k] * ratio);
  return { total: Math.round(raw.total * ratio), dist };
}
// 有真实 usage 时把分布归一到真实 input, 三段加总 = 真实 input(口径一致)
function scaleDist(dist, rawTotal, actualInput) {
  if (!(actualInput > 0) || !(rawTotal > 0)) return dist;
  const f = actualInput / rawTotal, out = {};
  for (const k in dist) out[k] = Math.round(dist[k] * f);
  return out;
}

// 记录最近一次请求的上下文占用(仅内存, 供悬浮球/面板读) + 最近占用序列(趋势/触顶预测)
function recordContext(cfg, model, prompt, completion, channel, estimated, extra) {
  const p = Number(prompt) || 0;
  if (p <= 0) return;
  const win = matchContextWindow(cfg, model);
  const percent = win > 0 ? Math.round(p / win * 1000) / 10 : null;
  cfg._lastCtx = {
    model: String(model || ''), channel: String(channel || ''), est: !!estimated,
    prompt: p, completion: Number(completion) || 0, window: win, percent, at: Date.now(),
    cached: (extra && extra.cached) || 0, dist: (extra && extra.dist) || null,
  };
  if (percent != null) {
    const h = cfg._ctxHist = cfg._ctxHist || [];
    h.push({ at: cfg._lastCtx.at, percent, model: cfg._lastCtx.model });
    if (h.length > 50) h.splice(0, h.length - 50);
  }
}

// 向后兼容: 返回第一个候选
function pickChannel(cfg, model) {
  const cs = pickChannels(cfg, model);
  return cs.length ? cs[0] : null;
}

/* ---- 小工具: 收集 JSON body ---- */
function collectJson(req, res, cb) {
  let body = '';
  const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
  req.on('data', c => { body += u8(c); if (body.length > 262144) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(body || '{}'); } catch (_) { return sendError('openai', res, 400, 'bad json'); } cb(j); });
  req.on('error', () => {});
}
// 卡密可访问的实例分支列表(空=全部)
function availableBranches(cfg, userKey) {
  const all = state.CUR_POOL ? [...state.CUR_POOL.instances.keys()].filter(n => { const c = state.CUR_POOL.instances.get(n); return c && !c._disabled; }) : [cfg._name || 'default'];
  if (!userKey) return all; // 管理员/免密: 全部
  const b = userKey.branches || [];
  return b.length ? all.filter(n => b.includes(n)) : all;
}

/* ---- 卡密生成(长度可配 8-128, 字符集 base64url) ---- */
function genApiKey(len) {
  const n = Math.min(128, Math.max(8, Number(len) || 24));
  const bytes = Math.ceil(n * 3 / 4) + 2;
  return 'sk-' + crypto.randomBytes(bytes).toString('base64url').slice(0, n);
}

/* ---- 运行时配置落盘(剔除 _ 开头的运行时字段, 复用 admin.saveCfg) ---- */
function persistRuntimeCfg(cfg) {
  try {
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k && k[0] === '_') ? undefined : v));
    admin.saveCfg(cfg._name || 'default', clean);
  } catch (e) { logErr('[persist] 配置落盘失败:', e.message); }
}

/* ---- 用户密码(scrypt) ---- */
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
// 卡密余额 JSON(/credits 响应 + login 复用)
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

// 认证: 返回 {ok, admin, userKey, status, error}
//  - admin=true: gatewayKey 匹配(或无密钥配置的免密模式)
//  - userKey: 命中 apiKeys 卡密(限额/过期/禁用/模型白名单在此校验)
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
  // 无 gatewayKey 且无卡密 = 免密(向后兼容)
  if (!cfg.gatewayKey && !keys.length) return { ok: true, admin: true };
  return { ok: false, status: 401, error: 'invalid key' };
}

/* ---- 卡密用量持久化(log/keyusage-<实例>.json, 30s 脏检查落盘) ---- */
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
// 30 秒脏检查落盘(所有实例)
setInterval(() => {
  const cfgs = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : (state.CUR_CFG ? [state.CUR_CFG] : []);
  for (const c of cfgs) if (c._keyUsageDirty) { c._keyUsageDirty = false; saveKeyUsage(c); }
}, 30000).unref();

/* ---- 插件 gatewayApi 工厂: 给插件暴露受限的网关能力 ---- */
function makeGatewayApi(cfg) {
  return {
    // 按卡密 token 查 key 记录（插件校验调用者身份用）
    findKey: (token) => (cfg.apiKeys || []).find(k => k && k.key && k.key === token) || null,
    // 给卡密加额度: 用减用量的方式实现(走 keyusage 落盘, 无需动 config)
    grantQuota: (keyId, tokens) => {
      const k = (cfg.apiKeys || []).find(x => x && x.key === keyId);
      if (!k || !(tokens > 0)) return false;
      k.usedTokens = Math.max(0, (k.usedTokens || 0) - tokens);
      cfg._keyUsageDirty = true;
      return true;
    },
  };
}

function corsHeaders() {
  if (!state.CUR_CFG || !state.CUR_CFG.cors) return {};
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}

function jsonErr(res, e) {
  try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e && e.message) || String(e) })); } catch (_) {}
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(obj));
  } catch (_) { try { res.end(); } catch (_) {} }
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
  // openai 与 claude 字段合并, 两边 SDK 都能读
  return { object: 'list', data: ms.map(m => ({ id: m, object: 'model', type: 'model', created: 1700000000, owned_by: 'ai-gateway', display_name: m })) };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, ctxp, state, admin, pickChannels, forcedChannelName, globMatch, matchContextWindow, CJK_RE, countCjk, tokOf, analyzePrompt, estimatePromptTokens, estimatePromptDist, EST_RATIO_MIN, calibRatio, calibUpdate, estPromptAdj, scaleDist, recordContext, pickChannel, collectJson, availableBranches, genApiKey, persistRuntimeCfg, hashPassword, verifyPassword, keyCreditsJSON, checkAuth, cfgDirOf, keyUsageFile, loadKeyUsage, saveKeyUsage, makeGatewayApi, corsHeaders, jsonErr, sendJson, sendError, collectModels, modelsResponse };
