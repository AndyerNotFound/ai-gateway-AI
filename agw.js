#!/usr/bin/env node
'use strict';
/* agw — ai-gateway unified CLI (计划通.md spec)
 * 入口: ~/bin/agw -> ~/ai-gateway/agw.js
 * 读配置: 直接文件 + crypt.js 解密(AGWENC1); 写配置: 改后走 admin API 热生效(实例在跑时)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const crypt = require(path.join(__dirname, 'crypt.js'));
const ctxp = require(path.join(__dirname, 'ctxp.js'));

const DIR = __dirname; // 代码根
const DATA_DIR = path.join(__dirname, 'data'); // 数据根: config*/ball*/.agwkey/log 等
const HOME = os.homedir();
/* ===== i18n: zh-CN 为键, lang/<code>.json 查表; 无条目原样回退 ===== */
const LANG_FILE = path.join(HOME, '.agwlang');
const LANGS = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko', 'ru', 'es', 'fr', 'eo'];
function currentLang() {
  if (process.env.GW_LANG && LANGS.includes(process.env.GW_LANG)) return process.env.GW_LANG;
  try { const v = fs.readFileSync(LANG_FILE, 'utf8').trim(); if (LANGS.includes(v)) return v; } catch (_) {}
  return 'zh-CN';
}
let _t = null, _tn = null;
try {
  if (currentLang() !== 'zh-CN') {
    _t = JSON.parse(fs.readFileSync(path.join(__dirname, 'lang', currentLang() + '.json'), 'utf8'));
    _tn = {}; // 归一化键(去首尾空白+压内部空白): 帮助块逐行匹配用
    for (const k of Object.keys(_t)) _tn[k.trim().replace(/\s+/g, ' ')] = _t[k];
  }
} catch (_) { _t = null; }
function t(s) {
  if (!_t) return s;
  if (!s.includes('\n')) { const h = _t[s]; return h === undefined ? s : h; }
  return s.split('\n').map(line => {
    if (!line.trim()) return line;
    const h = _t[line];
    if (h !== undefined) return h;
    const n = line.trim().replace(/\s+/g, ' ');
    if (_tn[n] === undefined) return line;
    const indent = line.match(/^\s*/)[0];
    return indent + _tn[n];
  }).join('\n');
}
const BIN = path.join(HOME, 'bin');

/* ---------- tiny utils ---------- */
const C = process.stdout.isTTY ? {
  dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`,
  yel: s => `\x1b[33m${s}\x1b[0m`, cyn: s => `\x1b[36m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
} : { dim: s => s, red: s => s, grn: s => s, yel: s => s, cyn: s => s, bold: s => s };
const die = m => { console.error(C.red('✗ ' + t(m))); process.exit(1); };
const ok = m => console.log(C.grn('✓ ' + t(m)));
function parseNum(v) { // "200k" | "50%" 等宽松数字(ctxp 同款)
  if (v == null) return NaN;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^([\d.]+)\s*(ki|mi|k|m|%)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1e3, m: 1e6, ki: 1024, mi: 1048576, '%': 1 }[m[2] || ''];
  return n * mult;
}
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'k' : String(n);
function fmtTok(n) { n = Number(n) || 0; return n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n); }
function fmtDur(ms) { return ms >= 60000 ? (ms / 60000).toFixed(1) + 'min' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }
function humanTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 864e5) return fmtDur(diff) + '前';
  return iso.slice(0, 16).replace('T', ' ');
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function ask(q) {
  return new Promise(res => {
    process.stdout.write(q);
    let buf = ''; process.stdin.setRawMode && process.stdin.setRawMode(false);
    const onData = d => { const s = d.toString(); if (s.includes('\n') || s === '\r' || s === '\n') { process.stdin.removeListener('data', onData); res(buf.trim()); } else buf += s; };
    process.stdin.on('data', onData);
  });
}
function confirm(q) { return ask(C.yel(q + ' (y/N) ')).then(a => /^y(es)?$/i.test(a)); }

/* ---------- config layer (encrypted-aware) ---------- */
const cfgRe = /^config(\..+)?\.json$/;
function listInsts() {
  try { return fs.readdirSync(DATA_DIR).filter(f => cfgRe.test(f)).sort()
    .map(f => f === 'config.json' ? 'default' : f.replace(/^config\./, '').replace(/\.json$/, '')); }
  catch (e) { return []; }
}
function cfgPathOf(name) { return name === 'default' ? path.join(DATA_DIR, 'config.json') : path.join(DATA_DIR, `config.${name}.json`); }
function loadCfg(name) {
  const f = cfgPathOf(name);
  if (!fs.existsSync(f)) die(`实例不存在: ${name} (已有: ${listInsts().join(', ') || '无'})`);
  const raw = fs.readFileSync(f, 'utf8');
  if (crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) die(`${f} 已加密但找不到口令(.agwkey / AGW_CRYPT_PASS)`);
    try { return JSON.parse(crypt.decryptText(raw, pass)); }
    catch (e) { die(`解密失败: ${e.message}`); }
  }
  try { return JSON.parse(raw); } catch (e) { die(`${f} JSON 损坏: ${e.message}`); }
}
function saveCfg(name, cfg) { // 保持文件原加密状态(原密文则回写密文)
  const f = cfgPathOf(name);
  const raw = fs.readFileSync(f, 'utf8');
  const bak = f + '.agwbak';
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
  let out = JSON.stringify(cfg, null, 2) + '\n';
  if (crypt.isEncText(raw)) {
    const pass = crypt.loadPass();
    if (!pass) die(`无法保持加密状态(找不到口令): ${f}`);
    out = crypt.encryptText(out, pass);
  }
  fs.writeFileSync(f, out);
}
function needLive() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(DATA_DIR, '.run', 'main.pid'), 'utf8').trim()); } catch (_) {}
  if (pid) { try { process.kill(pid, 0); } catch (_) { die(`网关未在运行(pid ${pid} 已失效), 请先 agw.sh start`); } }
  else die('网关未在运行(无 .run/main.pid), 请先 agw.sh start');
  const c = loadCfg('default');
  const port = (c.listen || {}).port || 16384;
  const tls = !!(c.tls && c.tls.enable);
  return { port, tls, pid };
}
function instLive(name) { // 实例是否在池里跑着(读 pool 端口表退化: 尝试 /health/<name>? 无此路由, 改用 admin instances)
  return api('GET', '/admin/api/instances').then(d => {
    const it = (d.instances || []).find(x => x.name === name);
    return it ? it : null;
  }).catch(() => null);
}
async function hotRestart(name) { // 在跑的实例改完配置后重启生效
  const it = await instLive(name);
  if (it && it.running) { await api('POST', `/admin/api/action/${name}/restart`); ok(t('实例 %s 已热重启生效').replace('%s', name)); }
  else console.log(C.dim('实例未在运行, 下次启动生效'));
}

/* ---------- admin api (loopback, adminKey from default cfg) ---------- */
let _adminKeyCache;
function adminKey() {
  if (_adminKeyCache !== undefined) return _adminKeyCache;
  try { const c = loadCfg('default'); _adminKeyCache = c.adminKey || c.webToken || ''; } catch (_) { _adminKeyCache = ''; }
  return _adminKeyCache;
}
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const st = needLive();
    const tls = !!st.tls;
    const opts = {
      host: '127.0.0.1', port: st.port, method,
      path: p, timeout: 30000,
      headers: { 'x-admin-key': adminKey(), 'Content-Type': 'application/json' },
      ...(tls ? { rejectUnauthorized: false } : {}), // 自签 CA: 本机回环
    };
    const mod = tls ? https : http;
    const req = mod.request(opts, res => {
      let buf = ''; res.on('data', d => buf += d);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${p}: ${(j && j.error) || trunc(buf, 200)}`));
        resolve(j !== null ? j : buf);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时(30s)')); });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/* ---------- value formatters ---------- */
function onoff(v) { return v ? C.grn('on') : C.dim('off'); }
function msStr(ms) { return ms >= 1000 ? (ms / 1000) + 's' : ms + 'ms'; }
function maskKey(k) { return k ? k.slice(0, 6) + '…' + k.slice(-4) : '-'; }
function parseHostPort(s, defPort) {
  let host = s, port = defPort, tls = false;
  const m = String(s).match(/^(https?:\/\/)?\[?([^\]\/]+)\]?:(\d+)$/);
  if (m) { if (m[1] === 'https:') tls = true; host = m[2]; port = Number(m[3]); }
  else if (/^https:\/\//.test(s)) { tls = true; host = s.replace(/^https:\/\//, ''); }
  else if (/^http:\/\//.test(s)) host = s.replace(/^http:\/\//, '');
  return { host, port, tls };
}
function parseUserPass(s) { // user[:pass]@host[:port]
  let cred = '', hostPart = s;
  const at = s.lastIndexOf('@');
  if (at >= 0) { cred = s.slice(0, at); hostPart = s.slice(at + 1); }
  let user = cred, pass = '';
  const co = cred.indexOf(':');
  if (co >= 0) { user = cred.slice(0, co); pass = cred.slice(co + 1); }
  let host = hostPart, port;
  const hp = hostPart.split(':');
  if (hp.length >= 2) { host = hp.slice(0, -1).join(':'); port = Number(hp[hp.length - 1]); }
  return { user, pass, host, port };
}

/* ================================================================
 *  agw inst
 * ================================================================ */
function cmdInst(argv) {
  const a = argv[0];
  if (!a || a === 'help' || a === '--help') {
    console.log(t(`用法:
  agw inst list                     列出全部实例(端口/运行态/TLS)
  agw inst delete <name> [-y]       删除实例(配置/日志/pid, default 不可删)
  agw inst <name> [start|stop]      启动/停止(缺省=显示状态)
  agw inst <name> --status <kind>   日志/统计: all|requests|error|debug (默认 all, 50 行)
  agw inst <name> --apikey <key>    设置 Gateway-Key(空串=清除)
  agw inst <name> --adminkey <key>  设置 Admin-Key(空串=清除)
  agw inst <name> --tls <port>      启用 TLS(<port>=主端口=纯 HTTPS); 0=关闭 TLS
  agw inst <name> --cold <sec>      上游连接超时秒数
  agw inst <name> --filter <on/off> 隐私过滤(密钥/敏感信息打码)
  agw inst <name> --filter-resp <on/off>  响应方向也打码
  agw inst <name> --transcreet <on/off/res-only>  DSML 清洗范围`));
    return;
  }
  if (a === 'list') return listInsts().forEach(n => {
    let c; try { c = loadCfg(n); } catch (e) { return console.log(`  ${pad(n, 22)} ${C.red('(配置读取失败)')}`); }
    const port = (c.listen || {}).port || 16384;
    const tls = !!(c.tls && c.tls.enable);
    console.log(`  ${pad(n, 22)} :${pad(port, 6)} ${tls ? 'HTTPS' : 'HTTP '}  key:${c.gatewayKey ? 'set' : '-'}  admin:${c.adminKey ? 'set' : '-'}`);
  });
  if (a === 'delete') {
    const name = argv[1]; if (!name) die('用法: agw inst delete <name> [-y]');
    if (name === 'default') die('default 实例不可删除');
    const doDel = async () => {
      try { await api('POST', `/admin/api/shutdown-all`); } catch (_) {} // 关全池(pool 模式无法单停)
      try { fs.renameSync(cfgPathOf(name), cfgPathOf(name) + '.deleted.' + Date.now()); ok(`配置已移除(备份为 .deleted.*)`); } catch (e) { die(e.message); }
      for (const f of [path.join(DATA_DIR, 'log', `requests-${name}.jsonl`), path.join(DATA_DIR, 'log', `${name}.log`)])
        if (fs.existsSync(f)) fs.renameSync(f, f + '.deleted.' + Date.now());
      ok(`实例 ${name} 已删除; agw.sh start 重新拉起剩余实例`);
    };
    if (/^-y|^--yes/.test(argv[2] || '')) return doDel();
    return confirm(`删除实例 ${name}? (配置文件会备份后移除) `).then(y => y ? doDel() : console.log('已取消'));
  }
  const name = a;
  const flags = argv.slice(1);
  const get = (fl) => { const i = flags.indexOf(fl); return i >= 0 ? flags[i + 1] : undefined; };
  const has = (fl) => flags.includes(fl);
  if (has('help')) return cmdInst(['help']);
  const onlyStatus = flags.length === 0;
  const touch = [];
  if (has('--apikey')) touch.push(() => { const c = loadCfg(name); c.gatewayKey = get('--apikey') || ''; saveCfg(name, c); ok(`gatewayKey ${c.gatewayKey ? '已设置(' + c.gatewayKey.length + ' 字符)' : '已清除'}`); });
  if (has('--adminkey')) touch.push(() => { const c = loadCfg(name); c.adminKey = get('--adminkey') || ''; saveCfg(name, c); ok(`adminKey ${c.adminKey ? '已设置' : '已清除'}`); });
  if (has('--tls')) touch.push(() => {
    const c = loadCfg(name); const pv = get('--tls');
    if (!pv || pv === '0' || pv === 'off') { c.tls = { enable: false }; ok('TLS 已关闭'); }
    else { const port = Number(pv) || die('--tls 需要端口号, 0=关闭'); c.listen = c.listen || {}; c.listen.port = c.listen.port || 16384; c.tls = { enable: true, port }; ok(`TLS 已启用(端口 ${port})`); }
    saveCfg(name, c);
  });
  if (has('--cold')) touch.push(() => { const c = loadCfg(name); c.connectTimeout = Math.round(parseNum(get('--cold')) * 1000); saveCfg(name, c); ok(`connectTimeout = ${msStr(c.connectTimeout)}`); });
  if (has('--filter')) touch.push(() => {
    const c = loadCfg(name); const v = get('--filter');
    c.redact = c.redact || {}; c.redact.enable = !/^off$/i.test(v || 'on');
    saveCfg(name, c); ok(`隐私过滤 ${onoff(c.redact.enable)}`);
  });
  if (has('--filter-resp')) touch.push(() => {
    const c = loadCfg(name); const v = get('--filter-resp');
    c.redact = c.redact || {}; c.redact.response = !/^off$/i.test(v || 'on');
    saveCfg(name, c); ok(`响应过滤 ${onoff(c.redact.response)}`);
  });
  if (has('--transcreet')) touch.push(() => {
    const c = loadCfg(name); const v = (get('--transcreet') || 'on').toLowerCase();
    c.dsmlClean = { enable: v !== 'off', reasoning: v === 'on' };
    saveCfg(name, c);
    ok(`DSML 清洗 ${v === 'on' ? 'on(含思考链)' : v === 'res-only' ? 'res-only(只清正文)' : 'off'}`);
  });
  const showStatus = async () => {
    const kind = (get('--status') || 'all').toLowerCase();
    const N = 50;
    const c = loadCfg(name);
    const port = (c.listen || {}).port, tls = !!(c.tls && c.tls.enable);
    console.log(C.bold(`■ ${name}  :${port} ${tls ? 'HTTPS' : 'HTTP'}`));
    if (kind === 'requests' || kind === 'all') {
      try {
        const d = await api('GET', `/admin/api/stats?instance=${encodeURIComponent(name)}`);
        const s = d.stats || d;
        console.log('  ' + t('请求 %s 错误 %s 重试 %s 运行 %s').replace('%s', String(s.requests || 0)).replace('%s', String(s.errors || 0)).replace('%s', String(s.retries || 0)).replace('%s', humanTime(s.startedAt)));
        const bc = s.byChannel || {};
        const rows = Object.entries(bc).sort((x, y) => y[1].requests - x[1].requests).slice(0, 10);
        for (const [cn, v] of rows) console.log(`    ${pad(cn, 20)} ${v.requests}次 ${v.errors ? C.red(v.errors + '错') : ''}`);
      } catch (e) { if (kind === 'requests') die(e.message); }
    }
    if (kind === 'error' || kind === 'all') {
      let log = '';
      try { log = await api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=400`); } catch (e) { log = ''; }
      const errLines = String(log).split('\n').filter(l => /error|fail|✗|失败|超时/i.test(l)).slice(-N);
      if (errLines.length) { console.log(C.red('  [近期错误]')); errLines.forEach(l => console.log('  ' + trunc(l, 150))); }
      else if (kind === 'error') console.log('  无错误记录');
    }
    if (kind === 'debug' || kind === 'all') {
      let log = '';
      try { log = await api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=${kind === 'all' ? N : 200}`); } catch (e) { if (kind === 'debug') die(e.message); }
      if (log) { console.log(C.dim('  [日志尾部]')); String(log).split('\n').slice(-N).forEach(l => console.log('  ' + trunc(l, 150))); }
    }
  };
  if (onlyStatus) return showStatus();
  const valFlags = ['--apikey', '--adminkey', '--tls', '--cold', '--filter', '--filter-resp', '--transcreet', '--status'];
  const act = flags.find((f, i) => !f.startsWith('--') && !valFlags.includes(flags[i - 1]));
  if (act === 'start' || act === 'stop') {
    return api('POST', `/admin/api/action/${name}/${act}`).then(d => ok(`${name} ${act}${d && d.restarting ? '' : ''}`)).catch(e => die(e.message + ' (单进程池模式下或需 agw.sh restart)'));
  }
  if (act) die(`未知参数: ${act}`);
  return Promise.all(touch.map(t => t())).then(hotRestart.bind(null, name));
}

/* ================================================================
 *  agw router
 * ================================================================ */
function cmdRouter(argv) {
  const name = argv[0];
  if (!name || name === 'help' || /help/.test(argv[1] || '')) {
    console.log(t(`用法:
  agw router <inst>                          查看路由相关配置
  agw router <inst> --retry <num>            渠道故障重试次数(connRetry)
  agw router <inst> --timeout <sec>          上游响应超时(responseTimeout)
  agw router <inst> --cold <sec>             上游连接超时(connectTimeout)
  agw router <inst> --models-fetch <h>       模型自动同步间隔(0=关)
  agw router <inst> --filter <on/off>        隐私过滤 redact.enable
  agw router <inst> --filter-resp <on/off>   响应方向打码 redact.response
  agw router <inst> --transcreet <on/off/res-only>  DSML 清洗(dsmlClean)`));
    return;
  }
  const c = loadCfg(name);
  if (!argv[1] || !argv[1].startsWith('--')) return showRouter(c);
  const touch = [];
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  if (get('--retry') != null) touch.push(() => { c.connRetry = Math.max(0, Number(get('--retry')) || 0); });
  if (get('--timeout') != null) touch.push(() => { c.responseTimeout = Math.round(parseNum(get('--timeout')) * 1000); });
  if (get('--cold') != null) touch.push(() => { c.connectTimeout = Math.round(parseNum(get('--cold')) * 1000); });
  if (get('--models-fetch') != null) touch.push(() => {
    const h = Number(get('--models-fetch')) || 0;
    c.modelSync = c.modelSync || {}; c.modelSync.enable = h > 0; c.modelSync.intervalHours = Math.max(1, h || 24);
  });
  if (get('--filter') != null) touch.push(() => { c.redact = c.redact || {}; c.redact.enable = !/^off$/i.test(get('--filter')); });
  if (get('--filter-resp') != null) touch.push(() => { c.redact = c.redact || {}; c.redact.response = !/^off$/i.test(get('--filter-resp')); });
  if (get('--transcreet') != null) touch.push(() => {
    const v = get('--transcreet').toLowerCase();
    c.dsmlClean = { enable: v !== 'off', reasoning: v === 'on' };
  });
  if (!touch.length) return showRouter(c);
  touch.forEach(f => f());
  saveCfg(name, c);
  showRouter(loadCfg(name));
  return hotRestart(name);
}
function showRouter(c) {
  console.log(`  connRetry=${c.connRetry ?? 2}  responseTimeout=${msStr(c.responseTimeout || 180000)}  connectTimeout=${msStr(c.connectTimeout || 15000)}
  modelSync=${(c.modelSync && c.modelSync.enable !== false) ? (c.modelSync.intervalHours || 24) + 'h' : C.dim('off')}  redact=${onoff(c.redact && c.redact.enable)}${(c.redact && c.redact.response) ? '+resp' : ''}  dsml=${(c.dsmlClean && c.dsmlClean.enable) ? ((c.dsmlClean.reasoning ? 'on' : 'res-only')) : 'off'}`);
}

/* ================================================================
 *  agw chan
 * ================================================================ */
function cmdChan(argv) {
  const name = argv[0];
  if (!name || name === 'help' || /help/.test(argv[1] || '')) {
    console.log(t(`用法:
  agw chan <inst>                                   列出该实例全部渠道
  agw chan <inst> --sdk <openai|gemini|claude>       设置全局默认上游格式(新增渠道缺省)
  agw chan <inst> --provider <name> "<url=…, key=…>"  新建/更新渠道
  agw chan <inst> --provider <name> --remove          删除渠道
  agw chan <inst> --provider <name> --scope "请求模型=真实模型, …"  模型映射/白名单
  agw chan <inst> --provider <name> --value <BaseURL> <JSON-Key> <Currency>  余额代查覆盖
  agw chan <inst> --provider <name> --proxy "user:pass@host:port"    渠道代理
  agw chan <inst> --provider <name> --warn <num>     余额低于该值发系统通知
  例: agw chan DeepSeek --provider newapi "url=https://api.xx.com, key=sk-xxx" --scope "gpt-4o=deepseek-v3"`));
    return;
  }
  const c = loadCfg(name);
  const pi = argv.indexOf('--provider');
  if (pi < 0) { // list all channels
    if (argv[1] === '--sdk') { c.channels = c.channels || []; const v = argv[2]; if (!['openai', 'gemini', 'claude'].includes(v)) die('--sdk 只接受 openai|gemini|claude'); c.channels.forEach(ch => { if (!ch.type) ch.type = v; }); saveCfg(name, c); return ok(`缺省 type 写入无 type 的渠道=${v}`); }
    if (!c.channels || !c.channels.length) return console.log('  (无渠道)');
    for (const ch of c.channels) {
      console.log(`  ${C.cyn(pad(ch.name, 18))} ${pad(ch.type || 'openai', 8)} ${trunc(ch.baseUrl, 46)}
      models:${(ch.models || []).length || '-'} map:${Object.keys(ch.modelMap || {}).length} proxy:${ch.proxy || '-'} bal:${ch.balanceUrl ? 'custom' : ''}${ch.balanceWarn ? C.yel(' warn<' + ch.balanceWarn + '>') : ''}`);
    }
    return;
  }
  const chName = argv[pi + 1]; if (!chName) die('--provider 需要渠道名');
  const kv = argv[pi + 2];
  let ch = (c.channels || []).find(x => x.name === chName);
  const isNew = !ch;
  if (isNew) { ch = { name: chName, type: 'openai', baseUrl: '', apiKey: '', models: [] }; c.channels = c.channels || []; c.channels.push(ch); }
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  const has = fl => argv.includes(fl);
  let changed = false;
  if (kv && !kv.startsWith('--')) { // "url=…, key=…" 逗号串
    for (const pair of kv.split(/[,，]/)) {
      const m = pair.trim().match(/^(url|key)\s*=\s*(.+)$/);
      if (!m) die(`--provider 值格式: "url=BaseURL, key=APIKey", 收到: ${pair}`);
      if (m[1] === 'url') ch.baseUrl = m[2].trim(); else ch.apiKey = m[2].trim();
      changed = true;
    }
  }
  if (has('--remove')) {
    if (isNew) die(`渠道不存在: ${chName}`);
    c.channels = c.channels.filter(x => x.name !== chName);
    saveCfg(name, c); return ok(`渠道 ${chName} 已删除`) & hotRestart(name);
  }
  if (has('--scope')) {
    const s = get('--scope'); if (!s) die('--scope 需要 "请求模型=真实模型" 串');
    const map = {}; let hasPlain = false;
    for (const pair of s.split(/[,，]/)) {
      const t = pair.trim(); if (!t) continue;
      const m = t.match(/^(.+?)=(.+)$/);
      if (m) map[m[1].trim()] = m[2].trim(); else { hasPlain = true; }
    }
    if (Object.keys(map).length) ch.modelMap = map;
    if (hasPlain) ch.models = s.split(/[,，]/).map(x => x.trim()).filter(x => x && !x.includes('='));
    changed = true;
  }
  if (has('--value')) { // <BaseURL> <JSON-Key> <Currency>
    const vi = argv.indexOf('--value');
    const bu = argv[vi + 1], jk = argv[vi + 2], cur = argv[vi + 3];
    if (!bu || !jk) die('--value 需要 <BaseURL> <JSON-Key> [Currency]');
    ch.balanceUrl = bu; ch.balancePath = jk; if (cur) ch.balanceUnit = cur;
    changed = true;
  }
  if (has('--proxy')) {
    const p = parseUserPass(get('--proxy'));
    const scheme = 'socks5://'; // 计划通 proxy 默认按 socks5; 需要 http 代理时 --proxy "…@host:port?type=http"
    let s = scheme + p.host; if (p.port) s += ':' + p.port;
    if (p.user || p.pass) s += '?' + (p.user ? `username=${encodeURIComponent(p.user)}` : '') + (p.pass ? `${p.user ? '&' : ''}password=${encodeURIComponent(p.pass)}` : '');
    ch.proxy = s;
    changed = true;
    console.log(C.dim('  (代理按 socks5 处理; HTTP 代理请在 agw chan 后手工调整 config)'));
  }
  if (has('--warn')) {
    const w = parseNum(get('--warn')); if (!(w > 0)) die('--warn 需要正数余额阈值');
    ch.balanceWarn = w; changed = true;
  }
  if (!changed && !isNew) return console.log('  (无改动)');
  if (isNew && !ch.baseUrl) die('新渠道需要 url=…');
  saveCfg(name, c);
  ok(t('渠道 %s %s').replace('%s', chName).replace('%s', isNew ? t('新建') : t('已更新')));
  hotRestart(name);
}

/* ================================================================
 *  agw fetch  (model sync)
 * ================================================================ */
function cmdFetch(argv) {
  const a = argv[0];
  if (a === 'chan') {
    const chName = argv[1], inst = argv[2];
    if (!chName) die('用法: agw fetch chan <channel-name> [instance]');
    return api('POST', `/admin/api/channel-models/${encodeURIComponent(inst || 'default')}`, { name: chName })
      .then(d => {
        const ms = d.models || d.list || [];
        console.log(t('渠道 %s 上游模型 %s 个:').replace('%s', chName).replace('%s', String(ms.length)));
        ms.slice(0, 60).forEach(m => console.log('  ' + (typeof m === 'string' ? m : m.id || JSON.stringify(m))));
        if (ms.length > 60) console.log(C.dim(`  … 共 ${ms.length} 个`));
      }).catch(e => die(e.message + ' (channel-models API 以渠道名匹配, 请确认渠道存在)'));
  }
  if (a === 'inst') {
    const inst = argv[1]; if (!inst) die('用法: agw fetch inst <instance> [-y]');
    const yes = argv.includes('-y') || argv.includes('--yes');
    const run = () => api('POST', `/admin/api/sync-models${inst && inst !== 'all' ? '?instance=' + encodeURIComponent(inst) : ''}`)
      .then(d => { const s = d.summary || d; ok('模型同步完成'); console.log(JSON.stringify(s, null, 2).slice(0, 2000)); });
    if (yes) return run();
    return confirm(`从上游拉取模型列表并覆盖本地 models? `).then(y => y ? run() : console.log('已取消'));
  }
  console.log(t(`用法:
  agw fetch chan <channel-name> [instance]   拉取该渠道上游模型列表(只看)
  agw fetch inst <instance> [-y]              同步模型列表覆盖本地(-y 免确认)`));
}

/* ================================================================
 *  agw ctxp
 * ================================================================ */
function cmdCtxp(argv) {
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  const has = fl => argv.includes(fl);
  const show = () => {
    const rules = ctxp.loadRules();
    const ks = Object.keys(rules);
    if (!ks.length) return console.log('  (无规则)');
    ks.forEach(k => {
      const r = rules[k] || {};
      console.log(`  ${pad(k, 24)} max=${r.max ? fmtN(r.max) : C.dim('-')}  warn=${r.warn ? fmtN(r.warn) : C.dim('-')}  kill=${r.kill ? C.red('on') : C.dim('off')}`);
    });
  };
  if (has('help')) { console.log(t(`用法:
  agw ctxp                                    列出全部规则
  agw ctxp <model-pattern> [--max <num>] [--warn <num>] [--kill <on/off>]
  agw ctxp clear                              清空全部规则
  num 支持 200k / 2m / 200000`)); return; }
  if (argv[0] === 'clear') { ctxp.writeRules({}); return ok('已清空全部 ctxp 规则'); }
  const pat = argv[0];
  if (!pat) { show(); return; }
  const maxV = get('--max'), warnV = get('--warn'), killV = get('--kill');
  if (maxV == null && warnV == null && killV == null) { // 查询单条
    const rules = ctxp.loadRules();
    const hit = Object.keys(rules).find(k => k === pat || ctxp.globMatch(pat, k));
    if (!hit) return console.log(`  无匹配规则: ${pat}`);
    const r = rules[hit];
    return console.log(`  ${hit}  max=${r.max ? fmtN(r.max) : '-'}  warn=${r.warn ? fmtN(r.warn) : '-'}  kill=${r.kill ? 'on' : 'off'}`);
  }
  const rules = ctxp.loadRules();
  const r = rules[pat] = rules[pat] || {};
  if (maxV != null) { const n = parseNum(maxV); if (!(n > 0)) die('--max 需要正数(支持 200k/2m)'); r.max = n; }
  if (warnV != null) { const n = parseNum(warnV); if (!(n > 0)) die('--warn 需要正数'); r.warn = n; if (r.max && r.warn > r.max) die('warn 不得高于 max'); }
  if (killV != null) {
    const v = killV.toLowerCase();
    if (v === 'on') r.kill = true; else if (v === 'off') delete r.kill;
    else die('--kill 只接受 on/off');
  }
  ctxp.writeRules(rules);
  ok(t('规则 %s 已保存(热生效)').replace('%s', pat)); show();
}

/* ================================================================
 *  agw card
 * ================================================================ */
function cmdCard(argv) {
  const get = fl => { const i = argv.indexOf(fl); return i >= 0 ? argv[i + 1] : undefined; };
  const has = fl => argv.includes(fl);
  const inst = get('--inst') || 'default';
  if (!argv.length || has('help')) { console.log(t(`用法:
  agw card --generate --name <名> [--balance <tokens>] [--expires <ISO日期>] [--inst <实例>]
  agw card --delete <card-id>        [--inst]
  agw card --charge <card-id> --balance <num>  [--inst]
  agw card --register <on/off>       [--inst]   公网自助注册开关
  agw card --length <8~128>          [--inst]   新卡密钥长度
  agw card ban <card-id>             [--inst]   停用卡
  agw card list                      [--inst]   卡列表
  (无 --inst 时作用于 default)`)); return; }
  const load = () => loadCfg(inst);
  const findKey = (c, id) => (c.apiKeys || []).find(k => k.key === id || k.key.endsWith(id) || k.name === id);
  if (has('--generate')) {
    const c = load();
    const name = get('--name') || ('card-' + new Date().toISOString().slice(0, 10));
    const quota = has('--balance') ? Math.max(0, parseNum(get('--balance')) || 0) : 0;
    const body = { name, quotaTokens: quota, expiresAt: get('--expires') || '' };
    return api('POST', `/admin/api/keys/${encodeURIComponent(inst)}`, body).then(d => {
      ok(t('新卡已生成 (实例 %s)').replace('%s', inst));
      console.log(`  key:   ${C.bold(d.key)}`);
      console.log(`  额度:  ${quota ? fmtTok(quota) + ' tokens' : '无限'}${body.expiresAt ? '  到期: ' + body.expiresAt : ''}`);
      console.log(C.dim('  完整 key 只显示这一次, 请立即保存'));
    }).catch(e => die(e.message));
  }
  if (has('--delete')) {
    const id = get('--delete'); const c = load(); const k = findKey(c, id);
    if (!k) die(`卡不存在: ${id}`);
    return api('DELETE', `/admin/api/keys/${encodeURIComponent(inst)}/${encodeURIComponent(k.key)}`).then(() => ok(`卡 ${trunc(k.key, 10)}… (${k.name || '-'}) 已删除`)).catch(e => die(e.message));
  }
  if (has('--charge')) {
    const id = get('--charge'); const add = parseNum(get('--balance'));
    if (!(add > 0)) die('--charge 需要 --balance <num> (加量值)');
    const c = load(); const k = findKey(c, id);
    if (!k) die(`卡不存在: ${id}`);
    return api('POST', `/admin/api/keys-update/${encodeURIComponent(inst)}`, { key: k.key, addQuota: add }).then(() => ok(`卡 ${trunc(k.key, 10)}… 已充值 ${fmtTok(add)} tokens`)).catch(e => die(e.message));
  }
  if (has('--register')) {
    const v = (get('--register') || '').toLowerCase();
    if (!['on', 'off'].includes(v)) die('--register 需要 on/off');
    const c = load(); c.registration = { enable: v === 'on' }; saveCfg(inst, c);
    return ok(`自助注册 ${v === 'on' ? C.grn('开启') : C.dim('关闭')}`) & hotRestart(inst);
  }
  if (has('--length')) {
    const n = Number(get('--length'));
    if (!(n >= 8 && n <= 128)) die('--length 范围 8~128');
    const c = load(); c.keyLength = Math.round(n); saveCfg(inst, c);
    return ok(`新卡长度 = ${n}`);
  }
  if (argv[0] === 'ban') {
    const id = argv[1]; const c = load(); const k = findKey(c, id);
    if (!k) die(`卡不存在: ${id}`);
    return api('POST', `/admin/api/keys-update/${encodeURIComponent(inst)}`, { key: k.key, enable: false }).then(() => ok(`卡 ${trunc(k.key, 10)}… (${k.name || '-'}) 已停用`)).catch(e => die(e.message));
  }
  if (argv[0] === 'list') {
    const c = load();
    if (!(c.apiKeys || []).length) return console.log('  (无卡)');
    for (const k of c.apiKeys) {
      const used = k.usedTokens || 0, q = k.quotaTokens || 0;
      const bar = q ? '[' + '█'.repeat(Math.round(10 * Math.min(1, used / q))) + '░'.repeat(10 - Math.round(10 * Math.min(1, used / q))) + ']' : '[   ∞   ]';
      console.log(`  ${pad(trunc(k.key, 14), 16)} ${pad(k.name || '-', 14)} ${k.enable === false ? C.red('停用') : C.grn('启用')} ${bar} ${fmtTok(used)}${q ? '/' + fmtTok(q) : ''}${k.expiresAt ? C.yel(' 到' + k.expiresAt.slice(0, 10)) : ''}`);
    }
    return;
  }
  console.log('未知参数, agw card help 看用法');
}

/* ================================================================
 *  agw refresh ca / record / cloudflared
 * ================================================================ */
function cmdRefresh(argv) {
  if (argv[0] !== 'ca') { console.log(t('用法: agw refresh ca  — 检查并按需重签 TLS 证书(过期/换 CA/SAN 缺当前 IP 时), 完成后重启网关并回验')); return; }
  const script = path.join(DIR, 'ops', 'guard.sh');
  if (!fs.existsSync(script)) die('找不到 ops/guard.sh');
  // renew.sh 走 gen-server.sh --ensure(只在该重签时才签); --force 无条件重签
  const renew = path.join(DIR, 'tls', 'renew.sh');
  console.log(C.dim('运行 tls/renew.sh (检查+按需重签+重启+回验)…'));
  try { execSync(`bash '${renew}'`, { stdio: 'inherit' }); ok('证书检查完成'); }
  catch (e) { die('renew 失败(退出码 2=重签失败): ' + (e.status || e.message)); }
}
function cmdRecord(argv) {
  const a = argv[0];
  if (!['on', 'off'].includes((a || '').toLowerCase())) { console.log(t(`用法:
  agw record <on/off> [--server "user:pass@host:port"] [--max-length <num>] [实例名]
  record 落盘位置: log/requests-<inst>.jsonl (5MB 轮转)`)); return; }
  const inst = argv.find((x, i) => i > 0 && !x.startsWith('--') && argv[i - 1] !== '--server' && argv[i - 1] !== '--max-length') || 'default';
  const c = loadCfg(inst);
  c.record = c.record || {};
  c.record.enable = a.toLowerCase() === 'on';
  const gi = argv.indexOf('--server');
  if (gi >= 0) {
    const up = parseUserPass(argv[gi + 1]);
    let url = 'http://' + (up.user ? encodeURIComponent(up.user) + (up.pass ? ':' + encodeURIComponent(up.pass) + '@' : '@') : '') + up.host;
    if (up.port) url += ':' + up.port;
    c.record.server = url;
  }
  const mi = argv.indexOf('--max-length');
  if (mi >= 0) { const n = Number(argv[mi + 1]); if (!(n > 0)) die('--max-length 需要正数'); c.record.maxChars = n; }
  saveCfg(inst, c);
  ok(`请求记录 ${a.toLowerCase() === 'on' ? C.grn('on') : C.dim('off')}${c.record.server ? ' → ' + c.record.server : ''}`);
  hotRestart(inst);
}
function cmdCloudflared(argv) {
  const a = (argv[0] || '').toLowerCase();
  if (!['start', 'stop', 'restart', 'clear', 'status'].includes(a)) { console.log(t('用法: agw cloudflared <start|stop|restart|clear|status>')); return; }
  const get = () => api('GET', '/admin/api/tunnel');
  if (a === 'status') return get().then(d => console.log(`  running=${d.running}  url=${d.url || '-'}${(d.log || []).length ? '\n' + C.dim((d.log || []).slice(-3).join('\n')) : ''}`));
  if (a === 'clear') return get().then(() => api('POST', '/admin/api/tunnel', { action: 'stop' })).then(() => ok('隧道已停止并清理状态'));
  if (a === 'restart') return api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => new Promise(r => setTimeout(r, 800))).then(() => api('POST', '/admin/api/tunnel', { action: 'start' })).then(() => new Promise(r => setTimeout(r, 2500))).then(get).then(d => ok('隧道已重启: ' + (d.url || '(域名获取中, 稍后 agw cloudflared status)')));
  const act = a;
  return api('POST', '/admin/api/tunnel', { action: act }).then(() => {
    if (act === 'start') return new Promise(r => setTimeout(r, 2500)).then(get).then(d => ok('隧道启动: ' + (d.url || '(域名获取中, 稍后 status 查看)')));
    ok('隧道已停止');
  }).catch(e => die(e.message));
}

/* ================================================================
 *  agw encrypt / decrypr / recrypt / export / inport
 * ================================================================ */
function eachCfgDo(nameArg, fn) {
  const targets = (nameArg === 'all') ? listInsts() : [nameArg];
  if (nameArg !== 'all' && !listInsts().includes(nameArg)) die(`实例不存在: ${nameArg}`);
  let done = 0;
  for (const t of targets) {
    const f = cfgPathOf(t);
    try { fn(f, t); done++; } catch (e) { console.error(C.red(`✗ ${t}: ${e.message}`)); }
  }
  if (!done) die('没有实例被处理');
  ok(`${done}/${targets.length} 个实例处理完成`);
}
function cmdEncrypt(argv) {
  const [scope, pass] = argv;
  if (!scope || /help/.test(scope)) { console.log(t(`用法:
  agw encrypt <all|inst> [password]     口令缺省=用 .agwkey(推荐: agw 才能继续编辑; 自定义口令仅作归档)
  agw decrypr <all|inst> [password]     解密(别名 decrypt)
  agw recrypt <all|inst> [new-password] 换口令重加密`)); return; }
  const p = pass || crypt.loadPass();
  if (!p) die('无口令: 传参或设置 AGW_CRYPT_PASS / .agwkey');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    if (crypt.isEncText(raw)) return console.log(C.dim(`  ${path.basename(f)} 已是密文, 跳过`));
    fs.copyFileSync(f, f + '.agwbak');
    fs.writeFileSync(f, crypt.encryptText(raw, p));
    console.log(`  ${C.grn('✓')} ${path.basename(f)} 已加密`);
  });
}
function cmdDecrypt(argv) {
  const [scope, pass] = argv;
  if (!scope || /help/.test(scope)) return cmdEncrypt(['help']);
  const p = pass || crypt.loadPass();
  if (!p) die('无口令: 传参或设置 AGW_CRYPT_PASS / .agwkey');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    if (!crypt.isEncText(raw)) return console.log(C.dim(`  ${path.basename(f)} 本来就是明文`));
    fs.copyFileSync(f, f + '.agwbak');
    let pt; try { pt = crypt.decryptText(raw, p); } catch (e) { throw new Error(`解密失败(口令错?) ${e.message}`); }
    fs.writeFileSync(f, pt);
    console.log(`  ${C.grn('✓')} ${path.basename(f)} 已解密`);
  });
}
function cmdRecrypt(argv) {
  const [scope, np] = argv;
  if (!scope) { console.log(t('用法: agw recrypt <all|inst> <new-password>')); return; }
  const oldP = crypt.loadPass();
  if (!oldP) die('当前口令不可得(.agwkey/AGW_CRYPT_PASS)');
  const newP = np || die('需要新口令');
  eachCfgDo(scope, (f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const pt = crypt.isEncText(raw) ? crypt.decryptText(raw, oldP) : raw;
    fs.copyFileSync(f, f + '.agwbak');
    fs.writeFileSync(f, crypt.encryptText(pt, newP));
    console.log(`  ${C.grn('✓')} ${path.basename(f)} 已换口令重加密`);
  });
}
function cmdExport(argv) {
  const scope = argv[0];
  const qri = argv.indexOf('--QRcode');
  const qr = qri >= 0 ? (argv[qri + 1] !== 'false') : false;
  if (!scope || /help/.test(scope)) { console.log(t(`用法:
  agw export <all|inst> [--QRcode true/false]
  ⚠ 导出为解密后的明文 JSON, 含全部 API Key, 输出后请立即转移到安全位置`)); return; }
  const targets = scope === 'all' ? listInsts() : [scope];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.join(HOME, 'ai-gateway-export-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(C.yel('⚠ 明文导出, 含全部密钥: ' + outDir));
  for (const t of targets) {
    const c = loadCfg(t);
    const f = path.join(outDir, `config.${t}.json`);
    fs.writeFileSync(f, JSON.stringify(c, null, 2));
    console.log(`  ${path.basename(f)}`);
    if (qr) {
      const txt = fs.readFileSync(f, 'utf8');
      if (txt.length > 2000) { console.log(C.dim(`  ${t}: 内容 ${txt.length} 字符, 二维码将分块(扫描后按序拼接)`)); }
      try {
        execSync(`qrencode -t ANSIUTF8 -o - '${f}' > '${path.join(outDir, t + '.qr.txt')}'`, { shell: '/bin/bash' });
        console.log(`  ${t}.qr.txt (终端可扫)`);
      } catch (e) { console.log(C.dim(`  ${t}: qrencode 失败 ${e.message}`)); }
    }
  }
  ok('导出完成(目录权限 700)');
  fs.chmodSync(outDir, 0o700);
}
function cmdInport(argv) {
  const fp = argv[0], pass = argv[1];
  if (!fp || /help/.test(fp)) { console.log(t('用法: agw inport <file-path> [password]')); return; }
  const abs = path.resolve(fp);
  if (!fs.existsSync(abs)) die('文件不存在: ' + abs);
  let raw = fs.readFileSync(abs, 'utf8');
  if (crypt.isEncText(raw)) {
    const dp = pass || crypt.loadPass();
    if (!dp) die('源文件已加密: 需要口令(参数或 .agwkey)');
    try { raw = crypt.decryptText(raw, dp); } catch (e) { die('源文件解密失败(口令错?): ' + e.message); }
  }
  let c;
  try { c = JSON.parse(raw); } catch (e) { die('JSON 无效: ' + e.message); }
  const name = (path.basename(abs).match(/^config\.(.+)\.json$/) || [])[1] || 'imported';
  const finalName = listInsts().includes(name) ? name + '-' + Date.now().toString(36) : name;
  if (!c.channels || !c.channels.length) console.log(C.yel('⚠ 该配置没有任何 channels'));
  const dest = cfgPathOf(finalName);
  fs.copyFileSync(abs, dest);
  if (pass) { fs.writeFileSync(dest, crypt.encryptText(fs.readFileSync(dest, 'utf8'), pass)); console.log('  已用传入口令加密'); }
  ok(`已导入为实例 ${finalName}; agw.sh restart 生效`);
}

/* ================================================================
 *  agw lang / notice / stat
 * ================================================================ */
function cmdLang(argv) {
  const v = (argv[0] || '').toLowerCase();
  if (!v || v === 'help' || v === '--help') {
    console.log(t('用法: agw lang <语言代码> 例: agw lang en'));
    console.log(t('当前语言: %s 可用: %s').replace('%s', currentLang()).replace('%s', LANGS.join(' ')));
    return;
  }
  const norm = v === 'zh' ? 'zh-CN' : (v === 'zh-tw' || v === 'zh-hant') ? 'zh-TW' : v;
  if (!LANGS.includes(norm)) die(`暂未供语言: ${v}`);
  if (norm === 'zh-CN') { try { fs.unlinkSync(LANG_FILE); } catch (_) {} ok('已切回 zh-CN (删除 ~/.agwlang)'); return; }
  fs.writeFileSync(LANG_FILE, norm + '\n');
  const lname = (function(){ try { return JSON.parse(fs.readFileSync(path.join(DIR, 'lang', norm + '.json'), 'utf8'))['meta.lang_name'] || norm; } catch (_) { return norm; } })();
  ok(t('语言 %s = %s').replace('%s', norm).replace('%s', lname));
}
function cmdNotice(argv) {
  console.log(C.bold('■ 告警汇总'));
  let n = 0;
  for (const t of listInsts()) {
    const c = loadCfg(t);
    for (const ch of (c.channels || [])) {
      if (!ch.apiKey) { console.log(C.red(`  [${t}] 渠道 ${ch.name}: apiKey 为空`)); n++; }
      if (ch.balanceWarn) {
        // 余额代查(有配置才查)
        try {
          const gw = require('./gateway.js');
          gw.fetchBalanceCached(c, ch, r => {
            if (!r.ok) return;
            const val = parseFloat(r.balance);
            if (val < ch.balanceWarn) console.log(C.yel(`  [${t}] 渠道 ${ch.name}: 余额 ${val} ${r.unit || ''} 低于 warn ${ch.balanceWarn}`));
          });
        } catch (_) {}
      }
    }
    const exp = (c.apiKeys || []).filter(k => k.expiresAt && new Date(k.expiresAt) < new Date(Date.now() + 7 * 864e5));
    for (const k of exp) { console.log(C.yel(`  [${t}] 卡 ${trunc(k.key, 10)}… 将到期/已到期: ${k.expiresAt}`)); n++; }
  }
  // 证书剩余
  try {
    const cert = path.join(DIR, 'tls', 'ca.pem');
    const certFile = fs.existsSync(path.join(DIR, 'tls', 'cert.pem')) ? path.join(DIR, 'tls', 'cert.pem') : cert;
    const out = execSync(`openssl x509 -enddate -noout -in '${certFile}' 2>/dev/null`).toString();
    const end = new Date(out.match(/notAfter=(.*)/)[1]);
    const days = Math.floor((end - Date.now()) / 864e5);
    if (days < 7) { console.log(C.yel(`  证书剩余 ${days} 天 (${end.toISOString().slice(0, 10)})`)); n++; }
  } catch (_) {}
  setTimeout(() => { if (!n) console.log('  一切正常'); }, 1500);
}
function cmdStat(argv) {
  const ri = argv.indexOf('--refresh');
  if (ri >= 0) {
    const val = Number(argv[ri + 1]);
    if (!(val >= 0)) return die('用法: agw stat --refresh <分钟> [实例]   (0=关闭)');
    const inst = argv[ri + 2] && !argv[ri + 2].startsWith('-') ? argv[ri + 2] : 'default';
    return (async () => {
      const c = loadCfg(inst); c.statsFlushMin = val; saveCfg(inst, c);
      console.log(`  ${inst}: statsFlushMin = ${val} (${val > 0 ? '每 ' + val + ' 分钟落盘 data/stats-' + inst + '.json' : '已关闭定时落盘'})`);
      const { execFile } = require('child_process');
      execFile('bash', [path.join(DIR, 'agw.sh'), 'restart'], { timeout: 60000 }, (err) => {
        if (err) console.log(C.yel('  ⚠ 重启失败(' + (err.message || '?') + '), 下次启动生效'));
        else console.log('  网关已重启生效');
      });
    })();
  }
  const scope = (argv[0] || 'all').toLowerCase();
  const instArg = argv.find(a => !a.startsWith('-') && !['all', 'daily', 'weekly', 'monthly', 'models', 'dist'].includes(a));
  if (scope === 'models' || scope === 'dist') {
    const inst = instArg || 'default';
    const sf = path.join(DATA_DIR, 'stats-' + inst + '.json');
    if (!fs.existsSync(sf)) return console.log(C.dim(`  ${sf} 不存在 (先 agw stat --refresh <分钟> ${inst} 开启落盘)`));
    let j; try { j = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) { return die('统计文件解析失败: ' + e.message); }
    if (scope === 'models') {
      const rows = Object.entries(j.byModel || {}).sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));
      if (!rows.length) return console.log('  无按模型数据');
      const total = rows.reduce((t, [, v]) => t + v.inputTokens + v.outputTokens, 0) || 1;
      console.log(`  ${inst} 按模型 (since ${j.since || j.savedAt}):`);
      for (const [m, v] of rows.slice(0, 15)) {
        const sum = v.inputTokens + v.outputTokens;
        const bar = '█'.repeat(Math.max(1, Math.round(sum / total * 24)));
        console.log(`    ${pad(m.slice(0, 28), 30)} ${pad(String(v.requests), 6)}次  ${fmtTok(sum).padStart(8)} tok  ${bar} ${(sum / total * 100).toFixed(1)}%`);
      }
      return;
    }
    // dist: 聚合全部分日的六分类
    const D = { tools: 0, system: 0, history: 0, user: 0, reasoning: 0, text: 0, tool: 0 };
    for (const v of Object.values(j.daily || {})) { for (const k of Object.keys(D)) D[k] += (v.dist && v.dist[k]) || 0; }
    const tot = Object.values(D).reduce((a, b) => a + b, 0);
    if (!tot) return console.log('  无 Token 分布数据');
    console.log(`  ${inst} Token 分布 (估算, since ${j.since || j.savedAt}):`);
    const names = { tools: '工具定义', system: '系统提示', history: '对话历史', user: '用户输入', reasoning: '思考内容', text: '正文', tool: 'ToolCall' };
    for (const k of Object.keys(names)) {
      const bar = '█'.repeat(Math.max(1, Math.round(D[k] / tot * 24)));
      console.log(`    ${pad(names[k], 20)} ${fmtTok(D[k]).padStart(9)} tok  ${bar} ${(D[k] / tot * 100).toFixed(1)}%`);
    }
    return;
  }
  if (!['all', 'daily', 'weekly', 'monthly'].includes(scope)) { console.log(t('用法: agw stat <all|daily|weekly|monthly|models|dist> [实例名] / agw stat --refresh <分钟> [实例]')); return; }
  const inst = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'default';
  if (scope === 'all') {
    return api('GET', `/admin/api/stats?instance=${encodeURIComponent(inst)}`).then(d => {
      const s = d.stats || d;
      console.log(`  ${inst}: 请求 ${s.requests}  错误 ${s.errors}  重试 ${s.retries || 0}  since ${humanTime(s.startedAt)}`);
      for (const [cn, v] of Object.entries(s.byChannel || {})) console.log(`    ${pad(cn, 18)} ${v.requests}次${v.errors ? ' ' + C.red(v.errors + '错') : ''}`);
    }).catch(e => die(e.message));
  }
  // daily/weekly/monthly: 解析 requests-<inst>.jsonl
  const f = path.join(DATA_DIR, 'log', `requests-${inst}.jsonl`);
  if (!fs.existsSync(f)) return console.log(C.dim(`  ${inst} 未开请求记录(record), 无历史数据可统计`));
  const now = Date.now();
  const span = { daily: 864e5, weekly: 7 * 864e5, monthly: 30 * 864e5 }[scope];
  const buckets = new Map();
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let r; try { r = JSON.parse(ln); } catch (_) { continue; }
    if (!r.time) continue;
    const t = new Date(r.time).getTime(); if (now - t > span) continue;
    const key = scope === 'daily' ? r.time.slice(0, 10) : scope === 'weekly' ? r.time.slice(0, 10) : r.time.slice(0, 7);
    const b = buckets.get(key) || { req: 0, err: 0, tok: 0, dur: 0 };
    b.req++; if (r.status >= 400) b.err++;
    b.tok += (r.inputTokens || 0) + (r.outputTokens || 0);
    b.dur += r.duration || 0;
    buckets.set(key, b);
  }
  if (!buckets.size) return console.log('  范围内无记录');
  console.log(`  ${inst} ${scope} (来自 requests-*.jsonl):`);
  [...buckets.entries()].sort().forEach(([k, b]) => {
    console.log(`    ${k}  ${pad(b.req, 6)}次  错误${pad(b.err, 4)}  ${fmtTok(b.tok)} tok  均时 ${fmtDur(b.dur / b.req)}`);
  });
}

/* ================================================================
 *  agw web — 面板访问令牌(/auth?key=<token>)
 *  webToken: 面板入口与 /admin/api/* 通吃的访问令牌; adminKey 仍然有效(可只留其一)
 * ================================================================ */
function webURLs(cfg) {
  const port = (cfg.listen || {}).port || 16384;
  const scheme = (cfg.tls && cfg.tls.enable) ? 'https' : 'http';
  const mk = (host) => cfg.webToken ? `${scheme}://${host}:${port}/auth?key=${encodeURIComponent(cfg.webToken)}` : `${scheme}://${host}:${port}/auth`;
  const urls = [mk('127.0.0.1')];
  try {
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (lan) urls.push(mk(lan.address));
  } catch (_) {}
  return urls;
}
function openBrowser(url) {
  if (process.env.AGW_NO_OPEN) return null; // 脚本化/测试场景: 不弹浏览器
  const q = `'` + String(url).replace(/'/g, `'\\''`) + `'`;
  for (const c of ['termux-open', 'termux-open-url', 'xdg-open']) {
    try { execSync(`${c} ${q}`, { stdio: 'ignore' }); return c; } catch (_) {}
  }
  return null;
}
function webHelp() {
  console.log(t(`用法:
  agw web login [--inst <实例>]          生成随机访问令牌, 打印带令牌面板链接并尝试打开浏览器
  agw web --key <token> [--inst <实例>]  设定固定访问令牌(URL 安全字符 [A-Za-z0-9_-], 固定后 login 不再轮换)
  agw web --key clear [--inst <实例>]    清除固定访问令牌
  agw web --expired [--inst <实例>]      清除面板认证状态(注销全部已签发会话)
  agw web [--inst <实例>]                查看当前令牌状态与面板地址`));
}
function cmdWeb(argv) {
  const has = f => argv.includes(f);
  if (has('help') || has('--help')) return webHelp();
  const inst = (() => { const i = argv.indexOf('--inst'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'default'; })();
  const cfg = loadCfg(inst);

  if (!argv.length) { // 状态视图
    console.log(cfg.webToken
      ? t('访问令牌: ') + C.grn('已设 ' + maskKey(cfg.webToken)) + (cfg.webTokenFixed ? C.dim('(固定, --key clear 可清除)') : C.dim('(自动生成, login 会轮换)'))
      : C.yel('访问令牌: 未设') + C.dim(' (agw web login 生成)'));
    if (!cfg.adminKey && !cfg.webToken) console.log(C.yel('adminKey 也未设: 面板当前免密访问, 公网部署前务必 agw web login'));
    console.log(t('面板地址:'));
    webURLs(cfg).forEach(u => console.log('  ' + C.cyn(u)));
    return;
  }

  if (has('--key')) {
    const v = argv[argv.indexOf('--key') + 1];
    if (v === undefined || v === 'help') return webHelp();
    if (v === 'clear') {
      if (!cfg.webToken && !cfg.webTokenFixed) return console.log(t('未设置访问令牌, 无需清除'));
      delete cfg.webToken; delete cfg.webTokenFixed; saveCfg(inst, cfg);
      ok('已清除访问令牌(旧链接全部失效; adminKey 未动, 仍可用)');
      return hotRestart(inst);
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(v)) die('令牌需为 8~128 位 URL 安全字符([A-Za-z0-9_-]); 建议直接 agw web login 随机生成');
    cfg.webToken = v; cfg.webTokenFixed = true; saveCfg(inst, cfg);
    ok('固定访问令牌已保存, 面板链接:');
    webURLs(cfg).forEach(u => console.log('  ' + C.cyn(u)));
    return hotRestart(inst);
  }
  if (has('--expired')) {
    return api('POST', '/admin/api/web-expired')
      .then(() => ok('已清除面板认证状态(全部会话已注销, 各浏览器需重新带令牌访问)'))
      .catch(e => die('清除失败(网关未在运行?): ' + e.message));
  }
  if (argv.length && !has('login')) return webHelp();

  // login: 固定令牌 → 直接用; 自动令牌 → 每次轮换(旧链接失效)
  let rotated = false;
  if (!cfg.webTokenFixed) {
    cfg.webToken = crypto.randomBytes(24).toString('base64url');
    delete cfg.webTokenFixed; saveCfg(inst, cfg); rotated = true;
    ok('已生成随机访问令牌(webToken)');
  } else {
    console.log(C.dim('使用固定访问令牌(--key 设定, login 不轮换)'));
  }
  const urls = webURLs(cfg);
  console.log(t('面板链接(含令牌, 勿外传):'));
  urls.forEach(u => console.log('  ' + C.cyn(u)));
  if (rotated) console.log(C.dim('旧令牌/旧链接已失效'));
  const opened = openBrowser(urls[0]);
  console.log(opened ? C.dim(`已尝试用 ${opened} 打开浏览器`) : C.dim('未找到可用的开浏览器命令, 请手动复制链接'));
  if (!cfg.adminKey && !cfg.webTokenFixed) console.log(C.dim('提示: 面板与 /admin/api/* 均已接受 webToken, 可不再使用 adminKey'));
  if (rotated) return hotRestart(inst);
}

/* ==================== main dispatch ==================== */
function help(sub) {
  if (sub && CMDS[sub]) { console.log('agw ' + sub + ' —'); CMDS[sub](['help']); return; }
  console.log(t(`agw — ai-gateway 统一 CLI (计划通规范)    []=可选  <>=值

实例
  agw inst list                                 列出全部实例
  agw inst <inst> [start|stop]                  启动/停止/看状态
  agw inst delete <inst> [-y]                   删除实例(default 不可删)
  agw inst <inst> --status <all|requests|error|debug>
  agw inst <inst> --apikey <key> --adminkey <key> --tls <port|0=关>
  agw inst <inst> --cold <秒> --filter <on|off> --transcreet <on|off|res-only>

路由
  agw router <inst>                             查看当前路由配置
  agw router <inst> --retry <n> --timeout <秒> --cold <秒>
  agw router <inst> --models-fetch <小时|0=关> --filter <on|off>
  agw router <inst> --transcreet <on|off|res-only>

渠道
  agw chan <inst>                               列出渠道
  agw chan <inst> --sdk <openai|gemini|claude>
  agw chan <inst> --provider <名> "<url=…, key=…>"      新建/更新渠道
  agw chan <inst> --provider <名> --scope "请求模型=真实模型, …"
  agw chan <inst> --provider <名> --value <BaseURL> <JSON-Key> [币种]
  agw chan <inst> --provider <名> --proxy "user:pass@host:port" --warn <余额阈值>
  agw chan <inst> --provider <名> --remove      删除渠道
  agw fetch chan <渠道名> [实例]                 看渠道上游模型列表
  agw fetch inst <实例> [-y]                     同步上游模型覆盖本地

上下文
  agw ctxp                                      列出全部规则
  agw ctxp <模型通配> [--max <n>] [--warn <n>] [--kill <on|off>]
  agw ctxp clear                                清空全部规则

卡密
  agw card list [--inst <实例>]
  agw card --generate --name <名> [--balance <n>] [--expires <ISO>] [--inst <实例>]
  agw card --charge <卡> --balance <n> | --delete <卡> | ban <卡>
  agw card --register <on|off> | --length <8~128>

面板
  agw web login [--inst <实例>]                 生成随机访问令牌, 打印面板链接并开浏览器
  agw web --key <token> [--inst <实例>]         设定固定访问令牌(固定后 login 不轮换)
  agw web --key clear [--inst <实例>]           清除固定访问令牌
  agw web --expired [--inst <实例>]             清除面板认证状态(注销全部会话)

运维
  agw <start|stop|restart|status>               网关进程启停(agw.sh 同款)
  agw refresh ca                                重签 TLS 证书并重启
  agw record <on|off> [--server "user:pass@host:port"] [--max-length <n>] [实例]
  agw cloudflared <start|stop|restart|clear|status>
  agw notice                                    告警汇总(空key/卡到期/余额/证书)
  agw stat <all|daily|weekly|monthly> [实例]
  agw stat --refresh <分钟> [实例]       统计落盘间隔(0=关; 写 config.statsFlushMin)
  agw stat models|dist [实例]            按模型 / Token 分布(读落盘统计)

配置
  agw encrypt|decrypr|recrypt <all|实例> [口令]
  agw export <all|实例> [--QRcode <true|false>]
  agw inport <文件> [口令]
  agw lang <zh>

细节: agw help <命令>    例: agw help chan`));
}
const CMDS = {
  inst: cmdInst, router: cmdRouter, chan: cmdChan, fetch: cmdFetch, ctxp: cmdCtxp,
  card: cmdCard, refresh: cmdRefresh, record: cmdRecord, cloudflared: cmdCloudflared, web: cmdWeb,
  lang: cmdLang, notice: cmdNotice, stat: cmdStat,
  encrypt: cmdEncrypt, decrypr: cmdDecrypt, decrypt: cmdDecrypt, recrypt: cmdRecrypt,
  export: cmdExport, inport: cmdInport,
};

/* agw restart / agw stop / agw start — 网关进程级操作(计划通未列, 保留 agw.sh 肌肉记忆) */
function cmdProc(argv) {
  const a = (argv[0] || 'status').toLowerCase();
  if (!['start', 'stop', 'restart', 'status'].includes(a)) { console.log(t('用法: agw <start|stop|restart|status>  (网关进程级; 实例启停用 agw inst <inst> [start|stop])')); return; }
  const argsh = path.join(DIR, 'agw.sh');
  try { execSync(`bash '${argsh}' ${a}`, { stdio: 'inherit' }); }
  catch (e) { die(`agw.sh ${a} 失败: ` + (e.status || e.message)); }
}
CMDS.start = cmdProc; CMDS.stop = cmdProc; CMDS.restart = cmdProc; CMDS['gw'] = cmdProc;
const cmd = process.argv[2];
if (['start', 'stop', 'restart', 'gw', 'status'].includes(cmd)) return cmdProc([cmd]);
if (!cmd || cmd === 'help' || cmd === '--help') return help(process.argv[3]);
const fn = CMDS[cmd];
if (!fn) die(`未知命令: ${cmd} (agw help)`);
try { const r = fn(process.argv.slice(3)); if (r && r.catch) r.catch(e => die(e.message)); }
catch (e) { die(e.message); }
