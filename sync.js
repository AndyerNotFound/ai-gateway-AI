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
const { openaiToCanonical, claudeToCanonical, geminiToCanonical, openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical, canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody, canonicalToResponsesBody } = require('./convert');
const { joinUrl, upstreamRequest } = require('./upstream');
const { redactText, respRedactOn } = require('./redact');
const { logErr, log } = require('./util');
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}
const admin = require('./admin');

// ================= 模型同步(自动) =================
/* ================= 模型同步(自动) ================= */
const TO_CANON = { openai: openaiToCanonical, claude: claudeToCanonical, gemini: geminiToCanonical };

// 拉取渠道上游的模型列表(供管理面板"获取模型列表"用; 服务端发起, 用真实 apiKey, 走渠道代理)
function fetchUpstreamModels(cfg, ch) {
  return new Promise((resolve, reject) => {
    const base = String(ch.baseUrl || '').replace(/\/+$/, '');
    let url; const headers = {};
    try {
      if (ch.type === 'openai') {
        url = joinUrl(base, '/v1/models');   // 与网关聊天路径同约定: baseUrl 不含 /v1, 由这里补
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
// 自动同步本实例各渠道的模型列表(定期/手动): 拉上游 /models, 合并进 ch.models(只增不减), 内存+磁盘都更新
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

// 可重试的上游错误: 鉴权失败(换 key 重试)/限流/服务端错误/超时
const RETRYABLE = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);
// 这些状态属于「过一会儿可能就好」, 先在同一个渠道重试(退避), 用完次数再切渠道
const SAME_RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

// OpenAI 扩展端点/透传是否启用 (默认开启; 仅显式 enable:false 关闭) — 2026-10-16
function openaiExtrasOn(cfg) {
  const oe = (cfg && cfg.openaiExtras) || {};
  return oe.enable !== false;
}

// OpenAI 渠道是否用 Responses API 上游
//  - 渠道级 useResponses 显式设置优先
//  - Responses 客户端(/v1/responses) 默认直通上游 /v1/responses (2026-10-16)
//  - 其余(chat 客户端) 跟随全局 upstreamResponses(默认 false)
function chUsesResponses(cfg, ch, clientApi) {
  if (ch.type !== 'openai') return false;
  if (!openaiExtrasOn(cfg)) return false;
  const oe = cfg.openaiExtras || {};
  if (ch.useResponses !== undefined) return !!ch.useResponses;
  if (clientApi === 'responses') return true;
  return !!oe.upstreamResponses;
}

// 为指定渠道构建上游请求的 url / headers / body
function buildRequestForChannel(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req) {
  // 思考链精简开启时, 即使同格式也走 canonical 转换路径(否则直通管道会绕过精简);
  // 客户端 API(chat/responses) 与上游 API(chat/responses) 不一致时也必须走转换中枢
  const upApi = chUsesResponses(cfg, ch, clientApi) ? 'responses' : 'chat';
  const direct = clientFormat === ch.type && clientApi === upApi && !(cfg.thinkingSummary && cfg.thinkingSummary.enable) && !respRedactOn(cfg, urlInfo);
  const stream = canonical.stream;
  const upstreamModel = canonical.model; // 已被调用方改写为该渠道的上游模型名
  let url, headers = {}, bodyBuf;
  if (direct) {
    if (ch.type === 'openai') {
      url = joinUrl(ch.baseUrl, upApi === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      body.model = upstreamModel;
      if (body && typeof body === 'object' && ch.maxTokens && body.max_tokens == null && body.max_completion_tokens == null) {
        body.max_tokens = Number(ch.maxTokens);   // ★渠道级输出上限(缺省时注入): 思考型模型默认上限小, 思考耗尽预算会在标记中途被截断(2026-10-16 实测)
      }
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
      if (ch.maxTokens && uc.max_tokens == null && uc.max_completion_tokens == null) uc.max_tokens = Number(ch.maxTokens);   // ★同上: 转换路径也注入
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

// 处理上游成功响应(2xx): 直通或跨格式转换. 提取自原 handleChat.
module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, crypt, admin, TO_CANON, fetchUpstreamModels, _syncing, syncModels, UP_RESP, BUILD_BODY, RETRYABLE, SAME_RETRYABLE, openaiExtrasOn, chUsesResponses, buildRequestForChannel };
