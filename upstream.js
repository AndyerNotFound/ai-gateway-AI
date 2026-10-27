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
const { logErr, VERSION, log } = require('./util');
const { getAgents } = require('./proxy');

// ================= 上游请求 / 思考链精简 / 余额透传 =================
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

// 规整 summarize 端点 URL 为完整 chat completions 路径(支持填 base / 带 /v1 / 完整路径)
function normalizeSummarizeUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

// 调用一个 OpenAI 兼容端点做单轮文本生成(供 summarize 用); 返回文本或 null
function callUpstreamText(cfg, baseUrl, apiKey, model, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const url = normalizeSummarizeUrl(baseUrl);
    if (!url || !model || !prompt) return resolve(null);
    if (apiKey && !/^[\x09\x20-\x7e]*$/.test(apiKey)) return resolve(null); // 非 ASCII key 拒绝
    const headers = { authorization: 'Bearer ' + (apiKey || '') };
    const bodyBuf = Buffer.from(JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }));
    const sub = { ...cfg, responseTimeout: Math.min(timeoutMs || 30000, 60000) };
    const tmpCh = { proxy: null, insecure: false }; // 直连, 不走渠道代理
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

// 思考链总结(异步): 按段拆分后用配置的 OpenAI 兼容端点逐段总结成一句, 拼成精简链
async function summarizeReasoningText(reasoning, tsCfg, ch, cfg) {
  if (!reasoning) return '';
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  if (!baseUrl || !model) return truncateReasoning(reasoning, Number(tsCfg.maxCharsPerSegment) || 80); // 未配端点则降级截断
  const segs = reasoning.split('\n').map(s => s.trim()).filter(Boolean);
  // 合并过短的相邻段, 减少调用次数(累计约 200 字一段)
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

// 思考链精简中间件: 包在 makeWriter 产出的 writer 外, 拦截 reasoning 事件
// truncate=实时行缓冲截取(零延迟); summarize=缓冲整段后异步总结(promise chain 串行, end 事件会等总结完)
function wrapThinkingSummary(writer, tsCfg, ch, cfg) {
  if (!tsCfg || !tsCfg.enable) return writer;
  const mode = tsCfg.mode === 'summarize' ? 'summarize' : 'truncate';
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);

  if (mode === 'truncate') {
  // truncate 模式: 实时行缓冲截取(零延迟), 每个输出块之间用双换行分隔
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
          lineBuf = lines.pop(); // 末行可能不完整, 留缓冲
          for (const ln of lines) emitSeg(ln);
        } else {
          if (saw && !done) { done = true; if (lineBuf) emitSeg(lineBuf); lineBuf = ''; }
          writer.onEvent(ev);
        }
      }
    };
  }

  // summarize 模式: 边收思考边分段总结边流式输出(每段独立 promise, 谁回来谁先 flush)
  // 顺序保证: 所有 reasoning 必须在第一个 text 前 flush——正文到达时若还有总结在飞, hold 住正文等完成(超时10s兜底强制放行, 迟到总结丢弃)
  // 防护: 思考阶段结束后再有 reasoning 不再当思考喂给总结(防正文混入)
  let buf = '', saw = false, closed = false, reasoningClosed = false, textFlushed = false;
  let pending = 0;
  let pendingEnd = null; // pending 为 0 时需发出的 end 事件
  let textQ = null;      // 正文 hold 队列(非 null = 正在等总结)
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
        if (reasoningClosed) { if (textQ) textQ.push(ev); else writer.onEvent(ev); return; } // 思考已结束, 后续 reasoning 当正文透传(正文在 hold 则排队保持顺序)
        saw = true;
        buf += ev.t;
        while (buf.length >= 200) { const seg = buf.slice(0, 200); buf = buf.slice(200); dispatch(seg); }
      } else if (ev.type === 'text') {
        // 第一个 text: 思考阶段结束, 剩余尾巴派最后一段总结, 然后 hold 正文等总结齐
        if (saw && buf && !reasoningClosed) { const tail = buf; buf = ''; reasoningClosed = true; dispatch(tail); }
        else if (!saw) reasoningClosed = true;
        if (textQ) { textQ.push(ev); }
        else if (pending > 0 && !textFlushed) {
          textQ = [ev];
          setTimeout(releaseText, 10000); // 超时兜底: 总结模型挂了也最多等 10s
        } else writer.onEvent(ev);
      } else if (ev.type === 'end') {
        // end 可能早于总结到达: 若正文在 hold, end 也排队(必须排在正文后)
        if (textQ) { textQ.push(ev); }
        else { pendingEnd = ev; flushEnd(); }
      } else {
        writer.onEvent(ev);
      }
    }
  };
}

// 流式总结: 单段异步调模型总结, 返回 "• 总结结果\n"; 模型失败/返回空时回退截断(保底不丢思考内容, 不带省略号保持格式统一)
async function summarizeOneSegment(text, tsCfg, cfg) {
  const baseUrl = String(tsCfg.summarizeBaseUrl || '').trim();
  const apiKey = String(tsCfg.summarizeApiKey || '').trim();
  const model = String(tsCfg.summarizeModel || '').trim();
  const maxChars = Math.max(10, Number(tsCfg.maxCharsPerSegment) || 80);
  if (!baseUrl || !model || !text) return null;
  const prompt = String(tsCfg.summarizePrompt || '用一句话中文概括以下思考片段:');
  // 回退: 简单截取开头(单块, 无省略号), 保持 "• " 格式与正常总结一致
  const fallbackText = text.slice(0, maxChars).replace(/\n+/g, ' ').trim();
  const fallback = fallbackText ? '• ' + fallbackText + '\n' : null;
  try {
    const s = await callUpstreamText(cfg, baseUrl, apiKey, model, prompt + '\n\n' + text, 30000);
    if (s && String(s).trim()) return '• ' + String(s).trim() + '\n';
    // 模型返回空 → 回退截断, 不吞思考(记日志方便排查哪些段没总结成功)
    logErr('[thinkingSummary] 模型返回空, 回退截断(' + text.length + '字)');
    return fallback || null;
  } catch (e) {
    logErr('[thinkingSummary] 单段总结失败, 回退截断:', e.message);
    return fallback || null;
  }
}

/* ================= 上游请求 ================= */
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

/* ================= 上游余额透传(balance) =================
 * 目标解析(渠道级覆盖优先): ch.balanceUrl(相对路径按 baseUrl 拼接) + ch.balancePath(点路径) + ch.balanceUnit
 *                          未配则按 baseUrl/渠道名 命中内置预设
 * 查询实现: 复用 upstreamRequest → 走渠道 proxy / insecure / 超时; 认证头按渠道类型(claude/gemini/openai)
 * 使用方: ① 管理端 GET /admin/api/balance/:inst/:ch (admin.js 注入调用, 见 setBalanceFn)
 *         ② 客户端 GET /v1/dashboard/billing/{credit_grants,subscription} (OpenAI 语义)
 */
const BALANCE_PRESETS = [
  { keys: ['api.deepseek.com', 'deepseek'], url: '/user/balance', path: 'balance_infos.0.total_balance', unit: 'CNY' },
  { keys: ['api.siliconflow.cn', 'siliconflow.cn'], url: '/v1/user/info', path: 'data.balance', unit: 'CNY' },
  { keys: ['api.siliconflow.com', 'siliconflow.com'], url: '/v1/user/info', path: 'data.balance', unit: 'USD' },
  { keys: ['api.openai.com', 'openai.com'], url: '/dashboard/billing/credit_grants', path: 'total_available', unit: 'USD' },
  { keys: ['open.bigmodel.cn', 'bigmodel'], url: '/api/paas/v4/user/info', path: 'data.balance', unit: 'CNY' },
];
function presetForChannel(ch) {
  const base = String(ch.baseUrl || '').toLowerCase();
  const name = String(ch.name || '').toLowerCase();
  return BALANCE_PRESETS.find(p => p.keys.some(k => base.includes(k) || name.includes(k))) || null;
}
// 渠道的余额目标: {url, path, unit} — 无(未配且无预设) 返回 null
function balanceTarget(ch) {
  const p = presetForChannel(ch);
  const url = ch.balanceUrl || (p && p.url);
  const path = ch.balancePath || (p && p.path);
  if (!url || !path) return null;
  return { url: String(url), path: String(path), unit: String(ch.balanceUnit || (p && p.unit) || '') };
}
function balanceAuthHeaders(ch) {
  const t = String(ch.type || '').toLowerCase();
  if (t === 'claude') return { 'x-api-key': ch.apiKey || '', 'anthropic-version': '2023-06-01' };
  if (t === 'gemini') return { 'x-goog-api-key': ch.apiKey || '' };
  return { authorization: 'Bearer ' + (ch.apiKey || '') };
}
function digPath(obj, dotPath) {
  let cur = obj;
  /* 兼容 balance_infos[1].total_balance 这种带下标写法 */
  const keys = String(dotPath || '').replace(/\[(\d+)\]/g, '.$1').split('.');
  for (const k of keys) {
    if (cur == null) return undefined;
    if (k === '') continue;
    cur = cur[/^\d+$/.test(k) ? Number(k) : k];
  }
  return cur;
}
function resolveBalanceUrl(ch, t) {
  const raw = String(t.url || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(ch.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('渠道 ' + ch.name + ' 未配置 baseUrl, 无法拼接相对余额接口地址: ' + raw);
  return base + (raw.startsWith('/') ? raw : '/' + raw);
}
// 查渠道余额 → cb({ok, balance, unit, url, status, error, raw?}); 永不抛(内部异常转 500 结果)
function fetchChannelBalance(cfg, ch, cb) {
  let done = false;
  const fin = (o) => { if (!done) { done = true; cb(o); } };
  try {
    const t = balanceTarget(ch);
    if (!t) return fin({ ok: false, status: 400, error: '该渠道无余额接口预设, 请在渠道配置填 balanceUrl + balancePath(点路径)' });
    let url;
    try { url = resolveBalanceUrl(ch, t); } catch (e) { return fin({ ok: false, status: 400, error: e.message }); }
    try { new URL(url); } catch (e) { return fin({ ok: false, status: 400, error: '余额接口地址无效: ' + url }); }
    const sub = { ...cfg, responseTimeout: Math.max(1000, (Number(cfg.balanceTimeoutSec) || 15) * 1000) };
    upstreamRequest(sub, ch, url, balanceAuthHeaders(ch), null, (err, upRes) => {
      if (err) return fin({ ok: false, status: /timeout/i.test(err.message) ? 504 : 502, error: '余额查询失败: ' + err.message });
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 400) return fin({ ok: false, status: 502, upstream: upRes.statusCode, error: '上游返回 ' + upRes.statusCode + ': ' + txt.slice(0, 200) });
        let j; try { j = JSON.parse(txt); } catch (e) { return fin({ ok: false, status: 502, error: '上游响应非 JSON', raw: txt.slice(0, 300) }); }
        const v = digPath(j, t.path);
        /* 多币种: 上游返回 balance_infos 时一并带出(DeepSeek 同时有 CNY/USD) */
        let amounts;
        if (Array.isArray(j.balance_infos)) {
          const list = j.balance_infos
            .map(b => ({ unit: String((b && b.currency) || ''), value: String((b && b.total_balance) == null ? '' : b.total_balance) }))
            .filter(x => x.value !== '');
          if (list.length > 1) amounts = list;
        }
        /* 取值路径没命中但上游带 balance_infos 时兜底, 不至于直接失败 */
        if (v === undefined && !amounts) return fin({ ok: false, status: 502, error: '余额路径 ' + t.path + ' 在上游响应中不存在', raw: txt.slice(0, 300) });
        fin({
          ok: true,
          balance: v === undefined ? amounts[0].value : v,
          unit: v === undefined ? amounts[0].unit : t.unit,
          url, upstream: upRes.statusCode,
          ...(amounts ? { amounts } : {})
        });
      });
      upRes.on('error', e => fin({ ok: false, status: 502, error: '读取上游响应失败: ' + e.message }));
    }, 'GET');
  } catch (e) {
    fin({ ok: false, status: 500, error: '余额查询异常: ' + e.message });
  }
}
// 客户端端点用: 短缓存(默认 30s) 抵消客户端轮询; 只缓存成功结果
const _balanceCache = new Map();
function balanceCacheTtl(cfg) {
  const v = Number(cfg.balanceCacheSec);
  return isFinite(v) && v >= 0 ? v : 30;
}
function balanceCacheKey(cfg, ch) {
  const sig = crypto.createHash('sha256').update(String(ch.apiKey || '') + '|' + String(ch.baseUrl || '') + '|' + String(ch.balanceUrl || '')).digest('hex').slice(0, 12);
  return (cfg._name || 'default') + '|' + ch.name + '|' + sig;
}
function fetchBalanceCached(cfg, ch, cb) {
  const ttl = balanceCacheTtl(cfg);
  const key = balanceCacheKey(cfg, ch);
  if (ttl > 0) {
    const hit = _balanceCache.get(key);
    if (hit && Date.now() - hit.at < ttl * 1000) return cb(hit.res, true);
  }
  fetchChannelBalance(cfg, ch, (r) => {
    if (ttl > 0 && r.ok) {
      _balanceCache.set(key, { at: Date.now(), res: r });
      if (_balanceCache.size > 256) { const it = _balanceCache.keys(); for (let i = 0; i < 64; i++) { const k = it.next(); if (k.done) break; _balanceCache.delete(k.value); } }
    }
    cb(r, false);
  });
}
// 客户端端点选渠道: 卡密 channels 白名单(有才过滤) → 有余额目标的优先 → default 优先
function balanceChannelList(cfg, uk) {
  const wl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
  const list = (cfg.channels || []).filter(c => !c._disabled && (!wl || wl.includes(c.name)));
  return { all: list, usable: list.filter(c => !!balanceTarget(c)) };
}
function pickBalanceChannel(cfg, uk) {
  const { all, usable } = balanceChannelList(cfg, uk);
  const pool2 = usable.length ? usable : all;
  return pool2.find(c => c.default) || pool2[0] || null;
}
// 汇率: 1 <unit> = ? <base>; 基准币种恒为 1; 未配置 → null(不计入合计)
function balanceFxRate(cfg, unit) {
  const fx = cfg.balanceFx || {};
  const base = fx.base || 'CNY';
  const u = String(unit || '').trim() || base;
  if (u === base) return 1;
  const r = Number((fx.rates || {})[u]);
  return isFinite(r) && r > 0 ? r : null;
}
// 多渠道聚合: 并发查全部「可见」渠道(没配余额接口的标 ok:false 不发请求) → 按汇率折算到 base 币种求和
//   channels: [{channel, total_remain, unit, ok, error?, remain_base?, no_rate?}]
//   total_remain = Σ remain_base(只计有汇率的); partial=有渠道失败/未配; unit=fx.base
function balanceAggregate(cfg, uk, cb) {
  const { all, usable } = balanceChannelList(cfg, uk);
  if (!usable.length) return cb({ ok: false, status: 503, error: '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)' });
  const fx = cfg.balanceFx || {};
  const base = fx.base || 'CNY';
  const results = [];
  let left = all.length;
  const done = () => {
    let sum = 0, anyRate = false, partial = false, okCount = 0;
    const noRateUnits = [];
    const channels = all.map((c, i) => {
      const r = results[i];
      if (!r || !r.ok) {
        partial = true;
        return { channel: c.name, ok: false, error: (r && r.error) || '查询失败' };
      }
      okCount++;
      const n = Number(r.balance);
      const v = isFinite(n) ? n : null;
      const unit = r.unit || '';
      const rate = balanceFxRate(cfg, unit);
      const item = { channel: c.name, ok: true, total_remain: v, unit };
      if (v != null && rate != null) {
        const conv = Math.round(v * rate * 10000) / 10000;
        item.remain_base = conv;
        sum += conv; anyRate = true;
      } else if (rate == null) {
        item.no_rate = true; partial = true;
        if (!noRateUnits.includes(unit)) noRateUnits.push(unit);
      }
      return item;
    });
    const total = anyRate ? Math.round(sum * 10000) / 10000 : null;
    log('[balance] 聚合', '渠道=' + all.length, 'ok=' + okCount, 'base=' + base, 'total=' + total, partial ? '(partial)' : '');
    cb({ ok: true, aggregate: true, total_remain: total, unit: base, channels, partial, ok_count: okCount, ...(noRateUnits.length ? { unconverted_units: noRateUnits } : {}) });
  };
  all.forEach((c, i) => {
    if (!balanceTarget(c)) {
      results[i] = { ok: false, error: '该渠道无余额接口预设, 请在渠道配置填 balanceUrl + balancePath(点路径)' };
      if (--left === 0) done();
      return;
    }
    try {
      fetchBalanceCached(cfg, c, (r) => { results[i] = r; if (--left === 0) done(); });
    } catch (e) { results[i] = { ok: false, error: e.message }; if (--left === 0) done(); }
  });
}

/* ================= 成功率探测(probe) =================
 * cfg.probe = { enable:false, intervalMin:10, mode:'models'|'chat' }; 渠道级: ch.probe=true
 * mode=models 免费探活; mode=chat 花token; 结果在 cfg._stats.probe */
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
  // 启动后 20 秒先探一轮(不等首个周期)
  setTimeout(() => probeRound(cfg), 20000).unref();
  log('[probe] 成功率探测已开启: 间隔', Math.max(1, Number(cfg.probe.intervalMin) || 10), '分钟, 模式', cfg.probe.mode || 'models');
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, truncateReasoning, normalizeSummarizeUrl, callUpstreamText, summarizeReasoningText, wrapThinkingSummary, summarizeOneSegment, joinUrl, upstreamRequest, BALANCE_PRESETS, presetForChannel, balanceTarget, balanceAuthHeaders, digPath, resolveBalanceUrl, fetchChannelBalance, _balanceCache, balanceCacheTtl, balanceCacheKey, fetchBalanceCached, balanceChannelList, pickBalanceChannel, balanceFxRate, balanceAggregate, probeOnce, probeRound, setupProbe };
