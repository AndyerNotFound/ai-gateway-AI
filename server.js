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
const { poolRoute, BILLING_PATHS, GENERIC_BALANCE_PATHS, createInstancePool, poolLoadAll, setupModelSync, statsFlushFile, setupStatsFlush } = require('./pool');
const { sendError, corsHeaders, jsonErr, checkAuth, keyCreditsJSON, verifyPassword, hashPassword, genApiKey, persistRuntimeCfg, availableBranches, collectJson, modelsResponse, sendJson, loadKeyUsage, makeGatewayApi } = require('./router');
const { VERSION, utf8, log, logErr } = require('./util');
const { balanceAggregate, pickBalanceChannel, fetchBalanceCached, fetchChannelBalance, setupProbe } = require('./upstream');
const { openaiExtrasOn, fetchUpstreamModels, syncModels } = require('./sync');
const { handleExtraEndpoint } = require('./passthrough');
const { handleChat } = require('./record');
const { applyDefaults } = require('./config');
const rt = require('./runtime');
const admin = require('./admin');
const { handleAdmin } = admin;
const state = require('./state');

// ================= HTTP 服务 =================
/* ================= HTTP 服务 ================= */
const GEMINI_RE = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/;
// 注: 旧的 EXTRA_OPENAI_ENDPOINTS 固定白名单(9 个端点)已废弃。
//     2026-10-16 起改为「/v1/* 兜底透传」: 任意未命中转换入口的 /v1/* 路径都原样转发到 openai 渠道
//     (覆盖 files/batches/vector_stores/fine_tuning/images/embeddings/audio/completions/moderations 等),
//     由 handleHttp 中的 isPassthru 判定 + handleExtraEndpoint 执行。

async function handleHttp(cfg, req, res) {
  const u = new URL(req.url, 'http://localhost');
  let p = u.pathname;

  // ===== 多实例路由(单进程模式): 兼容端口直达 / 主端口 /实例名/ 前缀 / default =====
  if (state.CUR_POOL) {
    const r = poolRoute(state.CUR_POOL, req, p);
    if (r.error) { sendError('openai', res, r.status || 404, r.error); return; }
    cfg = r.cfg;
    p = r.path;
    if (r.name) req._branchName = r.name;
    // 全局分支白名单: 卡在任何实例注册过且 branches 非空, 只能访问白名单内的实例
    // (在目标实例认证前拦截, 防止目标实例免密时绕过)
    if (req._branchName) {
      const h = req.headers;
      const auth = h.authorization || '';
      const presented = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '') || h['x-api-key'] || h['x-goog-api-key'] || u.searchParams.get('key') || '';
      if (presented) {
        for (const [, c] of state.CUR_POOL.instances) {
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
      openaiExtras: cfg.openaiExtras || { enable: true, upstreamResponses: false },
      channels: cfg.channels.map(c => ({ name: c.name, type: c.type, baseUrl: c.baseUrl, proxy: c.proxy || null, models: c.models, modelMap: c.modelMap, default: c.default, delayMs: c.delayMs || 0, useResponses: c.useResponses === undefined ? undefined : !!c.useResponses })),
      proxies: Object.entries(cfg.proxies).map(([k, v]) => ({ name: k, type: v.type, host: v.host, port: v.port })),
      stats: { requests: cfg._stats.requests, errors: cfg._stats.errors, retries: cfg._stats.retries || 0, byChannel: cfg._stats.byChannel, byKey: cfg._stats.byKey || {} },
      forceChannel: cfg.forceChannel || null,
      onceChannel: cfg._onceChannel || null,
      context: cfg._lastCtx ? Object.assign({}, cfg._lastCtx, { soft: (cfg.contextLimit||{}).soft || 80, hard: (cfg.contextLimit||{}).hard || 0, history: (cfg._ctxHist || []).slice(-24) }) : null,
      probe: Object.fromEntries(Object.entries(cfg._stats.probe || {}).map(([k, v]) => [k, { rate: v.total ? Math.round(v.ok / v.total * 100) : null, total: v.total, lastOk: v.lastOk, lastErr: v.lastErr }])),
    }));
  }

  // ===== Web 管理面板 (/admin + /admin/api/*) =====
  if (p === '/admin' || p === '/admin/' || p === '/admin/ball' || p.startsWith('/admin/api/') || p === '/auth' || p === '/auth/' || p === '/auth/app.js' || p === '/auth/v2' || p === '/auth/v2/' || p.startsWith('/auth/vendor/')
      || /^\/auth\/[A-Za-z0-9_-]{16,128}\/[A-Za-z0-9_-]{8,256}\/?$/.test(p)) {
    // 管理页面不需要收集 body 前置处理, handleAdmin 内部自行处理
    // 但 POST/DELETE 的 body 需要先收集
    if (req.method === 'POST' || req.method === 'DELETE') {
      let adminBody = '';
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      req.on('data', c => { adminBody += u8(c); if (adminBody.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { handleAdmin(cfg, req, res, u, p, adminBody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    } else {
      return handleAdmin(cfg, req, res, u, p, '');
    }
    return;
  }
  // ===== 用户端网页: GET /user (不需鉴权, 登录在页面内完成) =====
  if (req.method === 'GET' && (p === '/user' || p === '/user/')) {
    const f = path.join(__dirname, 'user.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      return jsonErr(res, { error: '用户端页面未找到, 请把 user.html 放到网关目录: ' + f }, 404);
    }
  }
  // ===== 插件端点: /plugins[/<id>[/<path...>]] =====
  if (rt.PLUGINS && (p === '/plugins' || p.startsWith('/plugins/'))) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      rt.PLUGINS.handle(cfg, req, res, u, p, '').catch(e => jsonErr(res, e));
    } else {
      let pbody = '';
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      req.on('data', c => { pbody += u8(c); if (pbody.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { rt.PLUGINS.handle(cfg, req, res, u, p, pbody).catch(e => jsonErr(res, e)); });
      req.on('error', () => {});
    }
    return;
  }

  // ===== 卡密余额查询(用户端): GET /credits, 带卡密认证 =====
  if (req.method === 'GET' && p === '/credits') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    if (authR.userKey) return res.end(JSON.stringify(keyCreditsJSON(authR.userKey)));
    return res.end(JSON.stringify({ admin: true, unlimited: true })); // 管理员主key
  }

  // ===== 账密登录(用户端): POST /auth/login {uid, password} → 返回该用户卡密+余额 =====
  if (req.method === 'POST' && p === '/auth/login') {
    let body = '';
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
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

  // ===== 注册(用户端, 管理端可开关): POST /auth/register {uid, password, captchaToken?, email?} =====
  if (req.method === 'POST' && p === '/auth/register') {
    let body = '';
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
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
        // 人机验证(turnstile)
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
        // 邮箱字段(验证逻辑: 开 emailVerify 时先存 unverified, 简化版先只记录)
        const email = String(j.email || '').trim();
        if (reg.emailVerify && reg.emailVerify.enable && !email) return sendError('openai', res, 400, '需要邮箱');
        // 创建用户
        cfg.users = cfg.users || [];
        cfg.users.push({
          uid, name: uid, passwordHash: hashPassword(pw),
          note: email ? ('email:' + email) : '', createdAt: new Date().toISOString(),
        });
        // 自动发一张默认卡
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

  // ===== 用户端自助(主卡认证): /auth/me /auth/profile /auth/mykeys =====
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
      // 卡的显示名也可改
      if (j.cardName !== undefined) { uk.name = String(j.cardName).slice(0, 64); persistRuntimeCfg(cfg); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  // 我的卡密: GET列表 / POST新建子卡 / DELETE删子卡 / POST update改子卡
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
        // 子卡: 父卡的子集(模型/分支白名单不能超过父卡; 额度不能超过父卡剩余)
        const parentModels = uk.models || [], parentBranches = uk.branches || [];
        const models = Array.isArray(j.models) ? j.models.map(String).filter(m => !parentModels.length || parentModels.includes(m)) : [];
        const branches = Array.isArray(j.branches) ? j.branches.map(String).filter(b => !parentBranches.length || parentBranches.includes(b)) : [];
        let quota = Math.max(0, Number(j.quotaTokens) || 0);
        if (uk.quotaTokens > 0) {
          const remaining = uk.quotaTokens - (uk.usedTokens || 0);
          if (quota <= 0 || quota > remaining) quota = remaining; // 不超过父卡剩余
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

  // ===== 可访问分支列表(卡密认证, 按 branches 过滤) =====
  if (p === '/v1/branches' && req.method === 'GET') {
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ branches: availableBranches(cfg, authR.userKey) }));
  }

  // ===== 注册开关状态(用户端查询, 决定是否显示注册入口) =====
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

  // ===== 上游余额透传(OpenAI 语义, 第三方客户端可直接识别) =====
  //   GET /v1/dashboard/billing/credit_grants → credit_summary(total_available=上游余额)
  //   GET /v1/dashboard/billing/subscription  → billing_subscription(hard/soft_limit_usd=上游余额)
  //   ?ch=<渠道名> 指定渠道(不传=默认渠道); 卡密只能用自己 channels 白名单里的渠道指定
  if (req.method === 'GET' && BILLING_PATHS.has(p)) {
    const t0 = Date.now();
    const authR = checkAuth(cfg, req, u.searchParams);
    if (!authR.ok) return sendError('openai', res, authR.status || 401, authR.error || 'invalid key');
    const isGrants = p.endsWith('credit_grants');
    const uk = authR.userKey || null;
    const want = String(u.searchParams.get('ch') || u.searchParams.get('channel') || '').trim();
    let ch = null;
    if (want) {
      ch = (cfg.channels || []).find(c => c.name === want) || null;
      if (!ch) return sendError('openai', res, 404, '渠道不存在: ' + want);
      const cardWl = uk && Array.isArray(uk.channels) && uk.channels.length ? uk.channels : null;
      const allowed = !!authR.admin || !cardWl || cardWl.includes(want);
      if (!allowed) return sendError('openai', res, 403, '此卡密不允许查询渠道余额: ' + want);
    } else if (GENERIC_BALANCE_PATHS.has(p)) {
      // 多渠道聚合(通用余额别名): 全部「可见且有余额目标」渠道并发查 → 按汇率折算到 base 币种求和
      return balanceAggregate(cfg, uk, (agg) => {
        if (!agg.ok) return sendError('openai', res, agg.status || 503, agg.error);
        return sendJson(res, 200, {
          ...agg,
          data: { total_remain: agg.total_remain, unit: agg.unit, channels: agg.channels, partial: agg.partial, ok_count: agg.ok_count },
        });
      });
    } else {
      ch = pickBalanceChannel(cfg, uk);
      if (!ch) return sendError('openai', res, 503, '本实例没有可查询余额的渠道(可在渠道配置里填 balanceUrl + balancePath)');
    }
    const finish = (r, cached) => {
      if (!r.ok) {
        log('UPERR', '[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'status=' + (r.status || 502), r.error || '');
        return sendError('openai', res, r.status || 502, r.error || 'balance query failed');
      }
      log('[balance]', ch.name, (isGrants ? 'credit_grants' : 'subscription'), 'channel=' + ch.name, 'unit=' + (r.unit || '-'), 'ms=' + (Date.now() - t0) + (cached ? ' (cached)' : ''));
      const num = Number(r.balance);
      const avail = isFinite(num) ? num : null;
      const common = { channel: ch.name, balance: r.balance, unit: r.unit || '', upstream_url: r.url };
      // 通用余额形态: 兼容各家客户端「余额获取路径 + JSON 键」配置(键名 total_remain / balance / remaining / total_available 都给)
      if (GENERIC_BALANCE_PATHS.has(p)) {
        const generic = { total_remain: avail, balance: r.balance, total_available: avail, total_granted: avail, total_used: 0, remaining: avail, unit: r.unit || '', channel: ch.name };
        return sendJson(res, 200, { ...generic, data: { ...generic, upstream_url: r.url } });
      }
      if (isGrants) return sendJson(res, 200, { object: 'credit_summary', total_granted: avail, total_used: 0, total_available: avail, grants: { object: 'list', data: [] }, ...common });
      return sendJson(res, 200, {
        object: 'billing_subscription', has_payment_method: true, canceled: false, canceled_at: null, delinquent: null,
        access_until: Math.floor(Date.now() / 1000) + 31536000,
        soft_limit_usd: avail, hard_limit_usd: avail, system_hard_limit_usd: avail,
        plan: { title: 'ai-gateway', id: 'ai-gateway' }, account_name: ch.name, ...common,
      });
    };
    try {
      fetchBalanceCached(cfg, ch, finish);
    } catch (e) {
      logErr('[balance] 查询异常:', e.message);
      sendError('openai', res, 500, 'balance query failed: ' + e.message);
    }
    return;
  }

  // 兜底透传路径判定: 任意 /v1/* 且不属于转换中枢接管的入口 → 原样转发到 openai 渠道
  // (2026-10-16 新增: 默认开启, 覆盖 files/batches/vector_stores/images/embeddings/audio/completions/moderations 等)
  const isConvEndpoint = (q) => (
    q === '/v1/chat/completions' || q === '/chat/completions' ||
    q === '/v1/messages' || q === '/messages' ||
    q === '/v1/responses' || GEMINI_RE.test(q)
  );
  const isPassthru = openaiExtrasOn(cfg) && p.startsWith('/v1/') && !isConvEndpoint(p);

  // 未知非 POST 端点: 若是「看起来像查余额/用量」的路径, 记一行日志(方便将来补齐别名); 透传路径放行
  if (req.method !== 'POST' && !isPassthru) {
    if (/balance|quota|credit|billing|usage|wallet|cost|spend|money/i.test(p)) {
      log('[balance] 未命中的余额系路径:', req.method, p, '(可补进 BILLING_PATHS 别名)');
    }
    return sendError('openai', res, 404, 'not found: ' + req.method + ' ' + p);
  }

  let clientFormat = null;
  let clientApi = 'chat';
  const urlInfo = { model: null, altSse: false };
  if (p === '/v1/chat/completions' || p === '/chat/completions') clientFormat = 'openai';
  else if (p === '/v1/messages' || p === '/messages') clientFormat = 'claude';
  else if (p === '/v1/responses') {
    if (!openaiExtrasOn(cfg)) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (OpenAI 扩展端点已关闭: openaiExtras.enable=false)');
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
  // OpenAI 兜底透传: 任意 /v1/* (未命中上面的转换入口) 原样转发到 openai 渠道
  // 保留方法(GET/POST/PUT/PATCH/DELETE)、query、multipart、二进制/流式
  if (!clientFormat && isPassthru) {
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
    req.on('end', () => { if (!aborted) handleExtraEndpoint(cfg, req, res, p + (u.search || ''), Buffer.concat(chunks), ct, req.method); });
    req.on('error', () => {});
    return;
  }
  if (!clientFormat) return sendError('openai', res, 404, 'unknown endpoint: ' + p + ' (支持: /v1/chat/completions | /v1/messages | /v1beta/models/{model}:generateContent|:streamGenerateContent; 其余 /v1/* 原样透传到 openai 渠道)');

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
  state.CUR_CFG = cfg;
  applyDefaults(cfg);
  const cfgDir = cfg._configFile ? path.dirname(cfg._configFile) : path.join(os.homedir(), 'ai-gateway');
  admin.setDir(cfgDir);
  if (rt.PLUGINS) admin.setPlugins(rt.PLUGINS);

  // ===== 多实例模式: 单进程托管目录下全部 config*.json, 主端口路径路由 + 实例原端口兼容监听 =====
  if (opts.multi) {
    const pool = createInstancePool(cfgDir);
    state.CUR_POOL = pool;
    pool.mainHost = opts.host || cfg.listen.host;
    admin.setPool(pool);
    admin.setUpstreamModels((ch, inst) => fetchUpstreamModels((inst && pool.instances.get(inst)) || cfg, ch));
    admin.setSyncFn((inst) => syncModels((inst && pool.instances.get(inst)) || cfg));
    admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
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

  // ===== 单实例模式(独立运行/测试) =====
  admin.setUpstreamModels(ch => fetchUpstreamModels(cfg, ch));
  admin.setSyncFn(() => syncModels(cfg));
  admin.setBalanceFn((c, ch, cb) => fetchChannelBalance(c, ch, cb));
  setupModelSync(cfg);
  loadKeyUsage(cfg);
  setupProbe(cfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance(cfg._name || 'default', cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败: ' + e.message); } }
  cfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, retries: 0, byChannel: {}, recent: [] };
  try { // 冷启动恢复(单实例模式)
    const sf = statsFlushFile(cfg);
    if (fs.existsSync(sf)) {
      const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
      cfg._stats.requests = j.requests || 0; cfg._stats.errors = j.errors || 0; cfg._stats.retries = j.retries || 0;
      cfg._stats.byChannel = j.byChannel || {}; cfg._stats.byKey = j.byKey || {};
      cfg._stats.byModel = j.byModel || {}; cfg._stats.daily = j.daily || {};
      cfg._stats.startedAt = j.since || cfg._stats.startedAt;
    }
  } catch (_) {}
  setupStatsFlush(cfg);
  const handler = (req, res) => {
    handleHttp(cfg, req, res).catch(e => {
      logErr('handler crash:', e);
      sendError('openai', res, 500, 'internal: ' + (e && e.message));
    });
  };
  const host = opts.host || cfg.listen.host;
  const port = opts.port != null ? opts.port : cfg.listen.port;

  // 检查 TLS 证书是否可用
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
    // 纯 HTTP 模式
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

  // TLS 模式: 如果 tls.port 独立指定 → HTTP + HTTPS 双开; 否则纯 HTTPS
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

    // HTTPS 服务器
    const httpsServer = https.createServer({ cert: tlsCfg.cert, key: tlsCfg.key }, handler);
    httpsServer.once('error', onErr);
    httpsServer.on('tlsClientError', (err) => log('[tls] 握手失败 :' + httpsPort + ' ' + (err.code || err.reason || '') + ' ' + String(err.message || '').slice(0, 120)));
    httpsServer.listen(httpsPort, host, () => {
      httpsServer.removeAllListeners('error');
      onReady(httpsServer, httpsServer.address().port, 'https');
    });

    // HTTP 服务器(双开模式)
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


module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, rt, admin, state, GEMINI_RE, handleHttp, startServer };
