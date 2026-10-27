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
const { redactCache } = require('./redact');
let crypt = null; try { crypt = require('./crypt.js'); } catch (_) {}

// ================= 配置加载 =================
/* ================= 配置加载 ================= */
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
  // 字符串: socks5://user:pass@host:port 或 http://host:port
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
  // 卡密列表规整
  cfg.apiKeys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.filter(k => k && k.key) : [];
  // 用户表规整(账密登录: uid+密码 → 返回该用户的卡密)
  cfg.users = Array.isArray(cfg.users) ? cfg.users.filter(u => u && u.uid && u.passwordHash) : [];
  // 隐私过滤: enable 实例总开关; response 响应方向过滤; extra 自定义正则(字符串数组)
  cfg.redact = (cfg.redact && typeof cfg.redact === 'object') ? cfg.redact : {};
  cfg.redact.enable = cfg.redact.enable !== false;
  cfg.redact.response = !!cfg.redact.response;
  cfg.redact.extra = Array.isArray(cfg.redact.extra) ? cfg.redact.extra.filter(p => typeof p === 'string' && p) : [];
  // 卡密长度(8-128, 默认24; 不含 sk- 前缀)
  cfg.keyLength = Math.min(128, Math.max(8, Number(cfg.keyLength) || 24));
  // 注册开关(默认关; 公网中转站才开)
  cfg.registration = cfg.registration && typeof cfg.registration === 'object' ? cfg.registration : {};
  cfg.registration.enable = !!cfg.registration.enable;
  cfg.registration.defaultQuota = Math.max(0, Number(cfg.registration.defaultQuota) || 0);
  cfg.registration.minPasswordLen = Math.min(64, Math.max(4, Number(cfg.registration.minPasswordLen) || 8));
  // 人机验证: none(默认) | turnstile(Cloudflare免费)
  cfg.registration.captchaProvider = cfg.registration.captchaProvider === 'turnstile' ? 'turnstile' : 'none';
  cfg.registration.captchaSecret = String(cfg.registration.captchaSecret || '');
  cfg.registration.captchaSiteKey = String(cfg.registration.captchaSiteKey || '');
  // 邮箱验证(可选, 默认关): {enable, smtp:{host,port,user,pass,from}}
  cfg.registration.emailVerify = cfg.registration.emailVerify && typeof cfg.registration.emailVerify === 'object' ? cfg.registration.emailVerify : {};
  cfg.registration.emailVerify.enable = !!cfg.registration.emailVerify.enable;
  // 成功率探测规整(默认关闭, 减少token消耗)
  cfg.probe = cfg.probe && typeof cfg.probe === 'object' ? cfg.probe : {};
  cfg.probe.enable = !!cfg.probe.enable;
  cfg.probe.intervalMin = Math.max(1, Number(cfg.probe.intervalMin) || 10);
  if (!cfg.probe.mode) cfg.probe.mode = 'models';
  cfg.modelSync = cfg.modelSync && typeof cfg.modelSync === 'object' ? cfg.modelSync : {};
  cfg.modelSync.enable = cfg.modelSync.enable !== false; // 默认开
  cfg.modelSync.intervalHours = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  cfg.modelSync.intervalMin = Number(cfg.modelSync.intervalMin) > 0 ? Number(cfg.modelSync.intervalMin) : null; // loop: fetch=<分钟>
  // 管理端资料(agw admin profile) 与全局 ctxp 执行模式(agw inst edit ctxp=)
  const __ap = (cfg.adminProfile && typeof cfg.adminProfile === "object") ? cfg.adminProfile : {};
  cfg.adminProfile = { name: String(__ap.name || ""), avatar: String(__ap.avatar || ""), profile: String(__ap.profile || ""), other: String(__ap.other || "") };
  cfg.ctxpMode = ["force", "warn", "none"].includes(String(cfg.ctxpMode || "")) ? String(cfg.ctxpMode) : "force";
  cfg.adminExpireAt = Number(cfg.adminExpireAt) > 0 ? Number(cfg.adminExpireAt) : 0; // 面板会话到期时间(agw admin expire)
  cfg.maxBodyBytes = Number(cfg.maxBodyBytes || 64 * 1024 * 1024);
  cfg.connectTimeout = Number(cfg.connectTimeout || 15000);
  cfg.responseTimeout = Number(cfg.responseTimeout || 180000);
  // 连接级错误(socket hang up 等)的同渠道重试次数, 默认 2; 0 = 关闭
  if (cfg.connRetry === undefined) cfg.connRetry = 2;
  cfg.cors = cfg.cors !== false;
  // 内置 DSML 工具调用标记清洗(默认开; dsmlClean:false 关闭; dsmlClean.reasoning:false 只清正文不清思考)
  const __dc = (cfg.dsmlClean && typeof cfg.dsmlClean === 'object') ? cfg.dsmlClean : {};
  cfg.dsmlClean = { enable: cfg.dsmlClean === false ? false : __dc.enable !== false, reasoning: __dc.reasoning !== false, backfill: __dc.backfill !== false };
  // 上下文软/硬上限(占窗口百分比): soft 只影响提示色, hard>0 时超过直接 400; charsPerToken 仅用于硬上限预估算
  const __cl = (cfg.contextLimit && typeof cfg.contextLimit === 'object') ? cfg.contextLimit : {};
  const clSoft = Number(__cl.soft), clHard = Number(__cl.hard);
  cfg.contextLimit = {
    soft: clSoft > 0 ? Math.min(100, clSoft) : 80,
    hard: clHard > 0 ? Math.min(100, clHard) : 0,
    charsPerToken: Math.max(1, Number(__cl.charsPerToken) || 4),
  };
  // TLS 配置解析
  cfg.tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
  if (cfg.tls.enable) {
    cfg.tls.cert = String(cfg.tls.cert || 'cert.pem');
    cfg.tls.key = String(cfg.tls.key || 'key.pem');
    cfg.tls.port = cfg.tls.port != null ? Number(cfg.tls.port) : null; // null=与HTTP同端口(纯HTTPS)
  }
  // 迁移: adminKey 已废弃, 自动并入 webToken(唯一管理凭据)
  if (cfg.adminKey && !cfg.webToken) { cfg.webToken = String(cfg.adminKey); }
  delete cfg.adminKey;
  cfg.webToken = cfg.webToken ? String(cfg.webToken) : '';
  if (cfg.proxies && typeof cfg.proxies === 'object' && !Array.isArray(cfg.proxies)) {
    const norm = {};
    for (const [k, v] of Object.entries(cfg.proxies)) {
      const n = (v && typeof v === 'object') ? v : normalizeProxy(v);
      if (n) norm[k] = n; else logErr(`[config] 跳过无效代理 "${k}"`);
    }
    cfg.proxies = norm;
  } else cfg.proxies = {};
  cfg.channels = cfg.channels || [];
  // 思考链精简: enable 时拦截推理模型的 reasoning 内容, 精简后再发给客户端(不展示完整思维链)
  // mode: truncate=按段截取开头(零延迟实时) / summarize=用便宜模型逐段总结(有延迟)
  cfg.thinkingSummary = cfg.thinkingSummary && typeof cfg.thinkingSummary === 'object' ? cfg.thinkingSummary : { enable: false };
  cfg.thinkingSummary.enable = !!cfg.thinkingSummary.enable;
  cfg.thinkingSummary.mode = cfg.thinkingSummary.mode === 'summarize' ? 'summarize' : 'truncate';
  cfg.thinkingSummary.maxCharsPerSegment = Math.max(10, Number(cfg.thinkingSummary.maxCharsPerSegment) || 80);
  cfg.thinkingSummary.summarizeBaseUrl = String(cfg.thinkingSummary.summarizeBaseUrl || '').trim(); // OpenAI 兼容端点, 如 https://api.deepseek.com 或 http://127.0.0.1:16392
  cfg.thinkingSummary.summarizeApiKey = String(cfg.thinkingSummary.summarizeApiKey || '').trim();   // 对应 apiKey(指向另一 gateway 实例时填该实例 gatewayKey)
  cfg.thinkingSummary.summarizeModel = String(cfg.thinkingSummary.summarizeModel || '').trim();     // 模型名
  cfg.thinkingSummary.summarizePrompt = String(cfg.thinkingSummary.summarizePrompt || '').trim() || '用一句话中文概括以下思考片段:';
  cfg.thinkingSummary.maxSegments = Math.max(1, Number(cfg.thinkingSummary.maxSegments) || 12);
  // OpenAI 扩展端点: enable=对外启用 /v1/responses 与 /v1/* 兜底透传端点(含 images/embeddings/audio/files/batches/vector_stores 等),
  // 并允许 OpenAI 渠道上游走 Responses API; upstreamResponses=全局默认上游用 /v1/responses(渠道级 useResponses 可覆盖)
  // 2026-10-16: 默认开启(不再需要手动配开关); 显式设 enable:false 可整体关闭
  cfg.openaiExtras = cfg.openaiExtras && typeof cfg.openaiExtras === 'object' ? cfg.openaiExtras : {};
  cfg.openaiExtras.enable = cfg.openaiExtras.enable === undefined ? true : !!cfg.openaiExtras.enable;
  cfg.openaiExtras.upstreamResponses = !!cfg.openaiExtras.upstreamResponses;
  // 余额聚合的汇率口径: cfg.balanceFx = { base:'CNY', rates:{ CNY:1, USD:7.2 } }  (1 <币种> = X <base>)
  // ⚠️ 不内置任何汇率(写死会过期出错数), 未配置 rates[unit] 的币种不计入合计、单独标注 no_rate
  cfg.balanceFx = (cfg.balanceFx && typeof cfg.balanceFx === 'object') ? cfg.balanceFx : {};
  cfg.balanceFx.base = String(cfg.balanceFx.base || 'CNY').trim() || 'CNY';
  cfg.balanceFx.rates = (cfg.balanceFx.rates && typeof cfg.balanceFx.rates === 'object') ? cfg.balanceFx.rates : {};
  if (!(Number(cfg.balanceFx.rates[cfg.balanceFx.base]) > 0)) cfg.balanceFx.rates[cfg.balanceFx.base] = 1;
  return cfg;
}

// 思考链截断(同步, 零延迟): 按行分段, 每段保留开头 maxChars 字; 长行按步长切成多块各取开头
function loadConfig(file) {
  redactCache.reset(); // 配置可能变了 extra 正则, 隐私过滤缓存必须作废
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
      // 渠道锁定(loop: chan lock/unlock) 与 DSML 清洗覆盖(loop: chan edit transcreet)
      lockAt: Number(ch.lockAt) > 0 ? Number(ch.lockAt) : null,   // 何时开始锁(ms epoch)
      lockUntil: Number(ch.lockUntil) > 0 ? Number(ch.lockUntil) : null, // 何时自动解锁(ms epoch, 空=手动解锁)
      transcreet: ['on', 'off', 'res-only'].includes(String(ch.transcreet || '').toLowerCase()) ? String(ch.transcreet).toLowerCase() : null,
      // 渠道级上下文策略(loop: chan ctxp): models=生效的模型通配, mode=force/warn/none
      ctxp: (ch.ctxp && typeof ch.ctxp === 'object') ? {
        models: Array.isArray(ch.ctxp.models) ? ch.ctxp.models.map(String) : [],
        mode: ['force', 'warn', 'none'].includes(String(ch.ctxp.mode || '').toLowerCase()) ? String(ch.ctxp.mode).toLowerCase() : 'force',
      } : null,
      useResponses: ch.useResponses === undefined ? undefined : !!ch.useResponses,
      probe: !!ch.probe,
      addUsage: ch.addUsage !== false,
      anthropicVersion: ch.anthropicVersion ? String(ch.anthropicVersion) : null,
      // 余额透传(渠道级覆盖内置预设) —— 必须进白名单, 否则运行态拿不到, persistRuntimeCfg 落盘时还会把配置文件里的值抹掉
      balanceUrl: ch.balanceUrl ? String(ch.balanceUrl) : null,
      balancePath: ch.balancePath ? String(ch.balancePath) : null,
      balanceUnit: ch.balanceUnit ? String(ch.balanceUnit) : null,
      // 余额预警阈值(渠道级, 纯展示用, 网关不解释): "5" 或 "CNY=5,USD=1"
      warnBelow: ch.warnBelow == null || ch.warnBelow === '' ? null
        : (typeof ch.warnBelow === 'string' ? String(ch.warnBelow) : JSON.stringify(ch.warnBelow)),
    });
    const last = cfg.channels[cfg.channels.length - 1];
    if (!/^[\x09\x20-\x7e]*$/.test(last.apiKey)) logErr(`⚠ [config] 渠道 "${last.name}" 的 apiKey 含中文/非ASCII字符(像占位符?), 请求会失败, 请填入真实 Key`);
    if (!last.apiKey) logErr(`⚠ [config] 渠道 "${last.name}" 没有填 apiKey`);
  }
  return cfg;
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, crypt, normalizeProxy, applyDefaults, loadConfig };
