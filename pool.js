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
const { syncModels } = require('./sync');
const { logErr, log } = require('./util');
const { instName } = require('./record');
const { sendError, loadKeyUsage, makeGatewayApi } = require('./router');
const { loadConfig } = require('./config');
const { setupProbe } = require('./upstream');
const state = require('./state');
const rt = require('./runtime');

// ================= 多实例池 =================
/* ================= 多实例池 (单进程托管全部实例) ================= */
// 一个进程加载目录下所有 config*.json:
//   - 主端口(default 实例 listen.port)按 /实例名/ 路径前缀路由到对应实例, 无前缀路径归 default
//   - 各实例原有 listen.port / tls.port 继续监听(兼容旧客户端, 直达该实例无需路径前缀)
//   - 配置保存 / 实例增删改 / 启停 全部热生效, 无需重启进程
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 路径第一段保留字: 永不按实例名路由(避免与 API/管理端点打架)
const RESERVED_PATHS = new Set(['v1', 'v1beta', 'v1alpha', 'admin', 'health', 'status', 'favicon.ico', 'robots.txt', 'credits', 'auth', 'plugins', 'user', 'dashboard']);
// 上游余额透传(OpenAI 语义计费端点): 带/不带 /v1 前缀都认(部分老客户端把 base 配成不带 /v1 的域名)
// 别名尽量覆盖常见客户端/中转工具的「查余额」路径; 命中即走 fetchBalanceCached 查上游账户余额
const BILLING_PATHS = new Set([
  // OpenAI 官方 dashboard billing(第三方客户端/中转面板常见)
  '/v1/dashboard/billing/credit_grants', '/dashboard/billing/credit_grants',
  '/v1/dashboard/billing/subscription', '/dashboard/billing/subscription',
  // 通用别名(one-api/new-api/中转面板/各 AI 客户端 的「余额获取路径」变体)
  '/v1/credits', '/credits',
  '/v1/balance', '/balance',
  '/v1/user/balance', '/user/balance',
  '/v1/user/remain', '/user/remain',
  '/v1/user/remain/points', '/user/remain/points',
  '/v1/quota', '/quota',
  '/v1/billing/usage', '/billing/usage',
  '/v1/usage', '/usage',
  '/v1/wallet', '/wallet',
  '/v1/dashboard/billing/usage', '/dashboard/billing/usage',
]);
// 这些路径返回「通用余额形态」(带 total_remain / balance / data.*, 兼容各家「JSON 键」配置);
// 其余(OpenAI dashboard 两个)保持官方形状
const GENERIC_BALANCE_PATHS = new Set([
  '/v1/credits', '/credits',
  '/v1/balance', '/balance',
  '/v1/user/balance', '/user/balance',
  '/v1/user/remain', '/user/remain',
  '/v1/user/remain/points', '/user/remain/points',
  '/v1/quota', '/quota',
  '/v1/billing/usage', '/billing/usage',
  '/v1/usage', '/usage',
  '/v1/wallet', '/wallet',
  '/v1/dashboard/billing/usage', '/dashboard/billing/usage',
]);

function setupModelSync(cfg) {
  teardownModelSync(cfg);
  if (!(cfg.modelSync && cfg.modelSync.enable !== false)) return;
  const hrs = Math.max(1, Number(cfg.modelSync.intervalHours) || 24);
  const run = () => syncModels(cfg).catch(e => logErr('[sync:' + instName(cfg) + '] 定时任务出错:', e.message));
  cfg._syncTimer0 = setTimeout(run, 30000); // 启动 30 秒后首次同步, 不阻塞启动
  cfg._syncTimer = setInterval(run, hrs * 3600 * 1000);
}
function teardownModelSync(cfg) {
  if (cfg._syncTimer0) { clearTimeout(cfg._syncTimer0); cfg._syncTimer0 = null; }
  if (cfg._syncTimer) { clearInterval(cfg._syncTimer); cfg._syncTimer = null; }
}

function createInstancePool(dir) {
  const pool = {
    dir,
    instances: new Map(),  // name → cfg
    servers: new Map(),    // "http:16384" → { server, port, tls, name }
    portOwner: new Map(),  // port → name
    mainPort: 0,
    mainTlsPort: 0,
    mainHost: '0.0.0.0',
  };
  pool.reload = (name) => poolLoadInstance(pool, name);
  pool.removeInst = (name) => poolRemoveInstance(pool, name);
  pool.renameInst = (a, b) => poolRenameInstance(pool, a, b);
  return pool;
}

// 读取实例 TLS 证书(带缓存; 失败返回 null 并警告)
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

// 计算当前应该监听的端口集合: 主端口(default) + 各启用实例的兼容端口
function poolDesiredPorts(pool) {
  const d = new Map(); // key → { name, port, tls, tlsCfg, main }
  const def = pool.instances.get('default');
  if (!def) return d;
  const mainPort = def.listen.port;
  pool.mainPort = mainPort;
  pool.mainTlsPort = 0;
  const defTls = readTlsCfg(def);
  if (defTls && (defTls.port == null || Number(defTls.port) === Number(mainPort))) {
    // 主端口纯 HTTPS（tls.port 留空或与主端口相同）
    d.set('https:' + mainPort, { name: 'default', port: mainPort, tls: true, tlsCfg: defTls, main: true });
    pool.mainTlsPort = mainPort;
  } else {
    d.set('http:' + mainPort, { name: 'default', port: mainPort, tls: false, main: true });
    if (defTls && defTls.port != null && defTls.port !== mainPort) {
      d.set('https:' + defTls.port, { name: 'default', port: defTls.port, tls: true, tlsCfg: defTls, main: true });
      pool.mainTlsPort = defTls.port;
    }
  }
  // 各启用实例的兼容端口(禁用实例不开)
  for (const [name, cfg] of pool.instances) {
    if (name === 'default' || cfg._disabled) continue;
    const p = cfg.listen.port;
    const tc = readTlsCfg(cfg);
    // 同端口纯 HTTPS: tls.port 留空, 或显式等于 listen.port
    const pureHttps = !!(tc && (tc.port == null || Number(tc.port) === Number(p)));
    if (p && p !== mainPort && !d.has('http:' + p) && !d.has('https:' + p)) {
      if (pureHttps) d.set('https:' + p, { name, port: p, tls: true, tlsCfg: tc });
      else d.set('http:' + p, { name, port: p, tls: false });
    }
    if (!pureHttps && tc && tc.port != null && tc.port !== mainPort && !d.has('http:' + tc.port) && !d.has('https:' + tc.port))
      d.set('https:' + tc.port, { name, port: tc.port, tls: true, tlsCfg: tc });
  }
  return d;
}

// 对比目标端口与实际监听, 增删 server (热加载时端口变化即时生效)
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
    if (dd.tls) server.on('tlsClientError', (err) => log('[tls] 握手失败 :' + dd.port + ' (' + dd.name + ') ' + (err.code || err.reason || '') + ' ' + String(err.message || '').slice(0, 120)));
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
  require('./server').handleHttp(state.CUR_CFG, req, res).catch(e => {
    logErr('handler crash:', e);
    sendError('openai', res, 500, 'internal: ' + (e && e.message));
  });
}

// 加载/热重载一个实例; 返回 cfg 或 null(配置文件不存在)
// ===== 统计定时落盘 (2026-10-27) =====
function statsFlushFile(cfg) {
  const dir = path.join(path.dirname(cfg._configFile || process.cwd()));
  return path.join(dir, 'stats-' + instName(cfg) + '.json');
}
function flushStats(cfg) {
  try {
    const st = cfg._stats; if (!st) return;
    const dir = path.dirname(statsFlushFile(cfg));
    fs.mkdirSync(dir, { recursive: true });
    const snap = {
      savedAt: new Date().toISOString(),
      since: st.startedAt, requests: st.requests || 0, errors: st.errors || 0, retries: st.retries || 0,
      byChannel: st.byChannel || {}, byKey: st.byKey || {}, byModel: st.byModel || {}, daily: st.daily || {},
    };
    const tmp = statsFlushFile(cfg) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 1));
    fs.renameSync(tmp, statsFlushFile(cfg));
  } catch (e) { try { logErr('[stats-flush] 失败:', e.message); } catch (_) {} }
}
function setupStatsFlush(cfg) {
  if (cfg._statsFlushTimer) { clearInterval(cfg._statsFlushTimer); cfg._statsFlushTimer = null; }
  const min = Number(cfg.statsFlushMin);
  if (!min || min <= 0) return; // 0/未设 = 关闭
  const ms = Math.max(0.2, min) * 60 * 1000;
  cfg._statsFlushTimer = setInterval(() => flushStats(cfg), ms);
  if (cfg._statsFlushTimer.unref) cfg._statsFlushTimer.unref();
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
  loadKeyUsage(cfg); // 读回卡密用量
  // 热重载继承旧 cfg 的 usedTokens(取大值, 防清零用户额度)
  if (old && Array.isArray(old.apiKeys)) {
    const oldMap = {}; for (const k of old.apiKeys) oldMap[k.key] = k.usedTokens || 0;
    for (const k of (cfg.apiKeys || [])) k.usedTokens = Math.max(k.usedTokens || 0, oldMap[k.key] || 0);
  }
  cfg._stats = (old && old._stats) || { startedAt: new Date().toISOString(), requests: 0, errors: 0, byChannel: {}, recent: [] }; // 热重载保留统计
  if (!old) { // 冷启动: 从 data/stats-<inst>.json 读回历史(内存统计在重启后丢失的兜底)
    try {
      const sf = statsFlushFile(cfg);
      if (fs.existsSync(sf)) {
        const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
        cfg._stats.requests = j.requests || 0; cfg._stats.errors = j.errors || 0; cfg._stats.retries = j.retries || 0;
        cfg._stats.byChannel = j.byChannel || {}; cfg._stats.byKey = j.byKey || {};
        cfg._stats.byModel = j.byModel || {}; cfg._stats.daily = j.daily || {};
        cfg._stats.startedAt = j.since || cfg._stats.startedAt;
        log('[stats] ' + name + ' 已从磁盘恢复统计: ' + (j.requests || 0) + ' 请求');
      }
    } catch (_) {}
  }
  setupStatsFlush(cfg);
  pool.instances.set(name, cfg);
  setupModelSync(cfg);
  setupProbe(cfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance(name, cfg, makeGatewayApi(cfg)); } catch (e) { logErr('[plugins] 激活失败 ' + name + ': ' + e.message); } }
  poolReconcilePorts(pool);
  return cfg;
}

function poolLoadAll(pool, defaultCfg) {
  defaultCfg._name = 'default';
  defaultCfg._disabled = !!defaultCfg.disabled;
  defaultCfg._stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, retries: 0, byChannel: {}, recent: [] };
  setupStatsFlush(defaultCfg);
  pool.instances.set('default', defaultCfg);
  setupModelSync(defaultCfg);
  if (rt.PLUGINS) { try { rt.PLUGINS.activateInstance('default', defaultCfg, makeGatewayApi(defaultCfg)); } catch (e) { logErr('[plugins] default 激活失败: ' + e.message); } }
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
  if (rt.PLUGINS) { try { rt.PLUGINS.deactivateInstance(name); } catch (_) {} }
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

// 请求路由: 兼容端口按端口绑定直达, 主端口按 /实例名/ 路径前缀, 否则 default
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

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, state, rt, INST_NAME_RE, RESERVED_PATHS, BILLING_PATHS, GENERIC_BALANCE_PATHS, setupModelSync, teardownModelSync, createInstancePool, readTlsCfg, poolDesiredPorts, poolReconcilePorts, poolHandler, statsFlushFile, flushStats, setupStatsFlush, poolLoadInstance, poolLoadAll, poolRemoveInstance, poolRenameInstance, poolRoute };
