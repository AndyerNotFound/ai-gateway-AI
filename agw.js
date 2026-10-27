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
let LOOPING = false; // loop 内 die 改为抛错(不退出进程), 由 REPL 捕获后打印
const die = m => { if (LOOPING) throw new Error(t(m)); console.error(C.red('✗ ' + t(m))); process.exit(1); };
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
function instLive(name, tok) { // 实例是否在池里跑着(读 pool 端口表退化: 尝试 /health/<name>? 无此路由, 改用 admin instances)
  return api('GET', '/admin/api/instances', null, tok).then(d => {
    const it = (d.instances || []).find(x => x.name === name);
    return it ? it : null;
  }).catch(() => null);
}
async function hotRestart(name, tok) { // 在跑的实例改完配置后重启生效; tok=显式令牌(令牌轮换时网关内存里还是旧令牌, 须用旧的调 API)
  const it = await instLive(name, tok);
  if (it && it.running) { await api('POST', `/admin/api/action/${name}/restart`, null, tok); ok(t('实例 %s 已热重启生效').replace('%s', name)); }
  else console.log(C.dim('实例未在运行, 下次启动生效'));
}

/* ---------- admin api (loopback, adminKey from default cfg) ---------- */
let _adminKeyCache;
function adminKey() {
  if (_adminKeyCache !== undefined) return _adminKeyCache;
  try { const c = loadCfg('default'); _adminKeyCache = c.webToken || ''; } catch (_) { _adminKeyCache = ''; }
  return _adminKeyCache;
}
function api(method, p, body, tok) {
  return new Promise((resolve, reject) => {
    const st = needLive();
    const tls = !!st.tls;
    const opts = {
      host: '127.0.0.1', port: st.port, method,
      path: p, timeout: 30000,
      headers: { 'x-agw-token': tok || adminKey(), 'Content-Type': 'application/json' },
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
    if (body != null) req.write(JSON.stringify(body)); // null/undefined 都不发 body(GET 带 body 会被服务端提前断连)
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
  if (canLoop() && a && !a.startsWith('-') && !['help', '--help', 'list', 'delete'].includes(a) && argv.length === 1 && listInsts().includes(a)) return loopInst(a);
  if (!a) return cmdInst(['list']);
  if (!a || a === 'help' || a === '--help') {
    console.log(t(`用法:
  agw inst list                     列出全部实例(端口/运行态/TLS)
  agw inst delete <name> [-y]       删除实例(配置/日志/pid, default 不可删)
  agw inst <name> [start|stop]      启动/停止(缺省=进入实例 loop)
  agw inst <name> --status <kind>   日志/统计: all|requests|error|debug (默认 all, 50 行)
  agw inst <name> --apikey <key>    设置 Gateway-Key(空串=清除)
  agw inst <name> --adminkey <key>  设置管理令牌(= --webtoken 面板令牌)
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
    console.log(`  ${pad(n, 22)} :${pad(port, 6)} ${tls ? 'HTTPS' : 'HTTP '}  key:${c.gatewayKey ? 'set' : '-'}  web:${c.webToken ? 'set' : '-'}`);
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
  const wtv = get('--webtoken') !== undefined ? get('--webtoken') : get('--adminkey'); // 计划通: --adminkey 即面板管理令牌
  if (has('--webtoken') || has('--adminkey')) touch.push(() => { const c = loadCfg(name); c.webToken = wtv || ''; saveCfg(name, c); ok(`webToken ${c.webToken ? '已设置' : '已清除'}`); });
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
    if (kind === 'usage') {
      try {
        const d = await api('GET', `/admin/api/stats?instance=${encodeURIComponent(name)}`);
        const s2 = d.stats || d;
        const rows = Object.entries(s2.byChannel || {}).sort((x, y) => (y[1].requests || 0) - (x[1].requests || 0));
        if (rows.length) {
          console.log(C.dim('  渠道用量(请求 / 输入 / 输出)'));
          for (const [cn, v] of rows) console.log(`    ${pad(cn, 20)} ${pad(String(v.requests || 0), 7)} ${pad(fmtTok(v.inputTokens || 0), 9)} ${pad(fmtTok(v.outputTokens || 0), 9)}`);
        }
        const ks = Object.entries(s2.byKey || {}).sort((x, y) => (y[1].requests || 0) - (x[1].requests || 0));
        if (ks.length) {
          console.log(C.dim('  卡密用量'));
          for (const [kn, v] of ks.slice(0, 20)) console.log(`    ${pad(kn, 20)} ${pad(String(v.requests || 0), 7)}次`);
        }
        if (!rows.length && !ks.length) console.log(C.dim('  暂无用量'));
      } catch (e) { die(e.message); }
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
  if (has('--status')) return Promise.all(touch.map(t => t())).then(showStatus); // --status 原先只被 onlyStatus 分支使用, 显式传参时无输出
  const valFlags = ['--apikey', '--webtoken', '--adminkey', '--tls', '--cold', '--filter', '--filter-resp', '--transcreet', '--status'];
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
  if (canLoop() && name && !name.startsWith('-') && name !== 'help' && argv.length === 1 && listInsts().includes(name)) return loopChan(name);
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
      const lk = chanLockInfo(ch);
      console.log(`  ${C.cyn(pad(ch.name, 18))} ${pad(ch.type || 'openai', 8)} ${trunc(ch.baseUrl, 46)}${ch.default ? C.grn(' [默认]') : ''}${lk.locked ? C.red(' [锁定]') + C.dim(' 至 ' + fmtWhen(lk.until || 0)) : lk.scheduled ? C.yel(' [待锁定 ' + fmtWhen(lk.at) + ']') : ''}
      models:${(ch.models || []).length || '-'} map:${Object.keys(ch.modelMap || {}).length} proxy:${ch.proxy || '-'} delay:${ch.delayMs || 0}ms dsml:${ch.transcreet || 'inherit'} bal:${ch.balanceUrl ? 'custom' : ''}${ch.balanceWarn ? C.yel(' warn<' + ch.balanceWarn + '>') : ''}`);
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
    saveCfg(name, c); ok(`渠道 ${chName} 已删除`); return hotRestart(name);
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
  return hotRestart(name);
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
  if (!pat && canLoop()) return loopCtxp();
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


/* ---------- 上下文上限 loop ---------- */
const HELP_CTXP = t(`上下文上限 loop 命令:
  stat <模型|*>                查看规则(*=全部)
  edit                         编辑 loop(models= / max= / warn=, apply 生效)
  delete <模型|*>              删除规则(*=清空全部)
  空行                          查看全部规则`);
function loopCtxp() {
  let mode = null;
  const view = () => {
    const rules = ctxp.loadRules(), ks = Object.keys(rules);
    if (!ks.length) return console.log('  (无规则)');
    ks.forEach(k => {
      const r = rules[k] || {};
      console.log(`  ${pad(k, 24)} max=${r.max ? fmtN(r.max) : C.dim('-')}  warn=${r.warn ? fmtN(r.warn) : C.dim('-')}`);
    });
  };
  const editView = () => {
    console.log(C.bold('■ 编辑 ctxp 规则') + C.dim('  (key=value, apply 生效, exit 返回)'));
    console.log(`  models=${mode.pattern || C.dim('(未设)')}  max=${mode.max || '-'}  warn=${mode.warn || '-'}`);
  };
  const apply = () => {
    if (!mode.pattern) return console.log(C.yel('先设 models=<模型通配>'));
    const body = { model: mode.pattern };
    if (mode.max !== undefined) body.max = mode.max;
    if (mode.warn !== undefined) body.warn = mode.warn;
    return api('POST', '/admin/api/ctxp', body)
      .then(() => { ok('规则已保存: ' + mode.pattern); mode = null; view(); })
      .catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  const before = raw => {
    if (!mode) return;
    const line = raw.trim();
    if (/^(exit|done|q|:q|back)$/i.test(line)) { mode = null; console.log(C.dim('已返回 ctxp loop')); view(); return true; }
    if (!line) { editView(); return true; }
    if (/^(apply|save)$/i.test(line)) return apply() || true;
    const eq = line.indexOf('=');
    if (eq < 0) { console.log(C.yel('edit: models=… / max=… / warn=… / apply / exit')); return true; }
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    if (k === 'models') mode.pattern = v;
    else if (k === 'max' || k === 'warn') {
      const n = parseNum(v);
      if (!(n > 0)) return console.log(C.yel(k + ' 需要正数(支持 200k/2m)')), true;
      mode[k] = Math.round(n);
    }
    else console.log(C.yel('未知字段: ' + k));
    editView(); return true;
  };
  const commands = {
    stat: a => {
      const rules = ctxp.loadRules(), pat = a[0] || '*';
      const ks = Object.keys(rules).filter(k => pat === '*' || k === pat || ctxp.globMatch(pat, k));
      if (!ks.length) return console.log(pat === '*' ? '  (无规则)' : '  无匹配规则: ' + pat);
      ks.forEach(k => { const r = rules[k] || {}; console.log(`  ${pad(k, 24)} max=${r.max ? fmtN(r.max) : '-'}  warn=${r.warn ? fmtN(r.warn) : '-'}`); });
    },
    edit: () => { mode = { pattern: '', max: undefined, warn: undefined }; editView(); },
    delete: a => {
      if (!a[0]) return console.log('用法: delete <模型|*>');
      if (a[0] === '*') return api('POST', '/admin/api/ctxp', { rules: {} }).then(() => { ok('已清空全部规则'); view(); }).catch(e => console.log(C.yel('删除失败: ' + e.message)));
      return api('POST', '/admin/api/ctxp', { model: a[0], max: 0, warn: 0 }).then(() => { ok('已删除: ' + a[0]); view(); }).catch(e => console.log(C.yel('删除失败: ' + e.message)));
    },
  };
  return startRepl({
    title: 'agw 上下文上限 loop',
    prompt: () => mode ? 'agw·ctxp [edit]> ' : 'agw·ctxp> ',
    help: HELP_CTXP,
    refresh: view,
    commands,
    before: before,
    unknown: parts => console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)')),
  });
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
    const c = load(); c.registration = Object.assign({}, c.registration || {}, { enable: v === 'on' }); saveCfg(inst, c);
    ok(`自助注册 ${v === 'on' ? C.grn('开启') : C.dim('关闭')}`); return hotRestart(inst);
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
  if (!argv.length && canLoop()) return loopCf();
  const a = (argv[0] || '').toLowerCase();
  if (!['start', 'stop', 'restart', 'clear'].includes(a)) { console.log(t('用法: agw cloudflared <start|stop|restart|clear>')); return; }
  const get = () => api('GET', '/admin/api/tunnel');
  if (a === 'clear') return get().then(() => api('POST', '/admin/api/tunnel', { action: 'stop' })).then(() => ok('隧道已停止并清理状态'));
  if (a === 'restart') return api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => new Promise(r => setTimeout(r, 800))).then(() => api('POST', '/admin/api/tunnel', { action: 'start' })).then(() => new Promise(r => setTimeout(r, 2500))).then(get).then(d => ok('隧道已重启: ' + (d.url || '(域名获取中, 稍后 agw cloudflared status)')));
  const act = a;
  return api('POST', '/admin/api/tunnel', { action: act }).then(() => {
    if (act === 'start') return new Promise(r => setTimeout(r, 2500)).then(get).then(d => ok('隧道启动: ' + (d.url || '(域名获取中, 稍后 status 查看)')));
    ok('隧道已停止');
  }).catch(e => die(e.message));
}

/* ---------- 隧道 loop ---------- */
const HELP_CF = t(`隧道管理 loop 命令:
  log [silence|log|warn|error|debug]   日志尾部(可按级别过滤)
  grep <time|line|content|other> <值>  日志过滤
  kill                                 立即停止隧道
  start | stop                         启动/停止
  空行                                 刷新状态`);
function loopCf() {
  const get = () => api('GET', '/admin/api/tunnel');
  const view = () => get().then(d => {
    console.log(`  隧道 running=${d.running ? C.grn('on') : C.dim('off')}  url=${d.url || '-'}`);
    (d.log || []).slice(-8).forEach(l => console.log('  ' + trunc(l, 160)));
  }).catch(e => console.log(C.yel('隧道状态读取失败: ' + e.message)));
  const grep = a => {
    const mode = (a[0] || '').toLowerCase(), val = a.slice(1).join(' ');
    return get().then(d => {
      let lines = (d.log || []).slice();
      if (mode === 'line') lines = lines.slice(-(Math.max(1, Number(val) || 50)));
      else if (mode === 'content') lines = val ? lines.filter(l => l.toLowerCase().includes(val.toLowerCase())) : lines;
      else if (mode === 'other') {
        let re; try { re = new RegExp(val || '.', 'i'); } catch (e) { return console.log(C.yel('正则无效: ' + e.message)); }
        lines = lines.filter(l => re.test(l));
      } else if (mode === 'time') {
        const win = parseWhen(val || '10m'), nowT = Date.now();
        const from = win > nowT ? nowT - (win - nowT) : win;
        lines = lines.filter(l => {
          const m = l.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
          if (!m) return false;
          const t = new Date(); t.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
          return t.getTime() >= from;
        });
      } else return console.log('用法: grep <time|line|content|other> <值>');
      if (!lines.length) return console.log(C.dim('  无匹配日志'));
      lines.slice(-200).forEach(l => console.log('  ' + trunc(l, 180)));
    }).catch(e => console.log(C.yel('日志读取失败: ' + e.message)));
  };
  const commands = {
    log: a => {
      const lv = (a[0] || 'log').toLowerCase();
      if (lv === 'silence') return console.log(C.dim('  (静默)'));
      return get().then(d => {
        let lines = (d.log || []).slice(-40);
        if (lv !== 'log') lines = lines.filter(l => new RegExp(lv, 'i').test(l));
        if (!lines.length) return console.log(C.dim('  无日志'));
        lines.forEach(l => console.log('  ' + trunc(l, 180)));
      }).catch(e => console.log(C.yel('日志读取失败: ' + e.message)));
    },
    grep: grep,
    kill: () => api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => { ok('隧道已停止'); view(); }).catch(e => console.log(C.yel('停止失败: ' + e.message))),
    start: a => {
      if (a.includes('-t') || a.includes('--time') || a.includes('-w') || a.includes('--wait')) return console.log(C.yel('定时启停需要网关常驻调度, 暂不支持'));
      return api('POST', '/admin/api/tunnel', { action: 'start' }).then(() => new Promise(r => setTimeout(r, 2500))).then(get).then(d => { ok('隧道启动: ' + (d.url || '(域名获取中)')); }).catch(e => console.log(C.yel('启动失败: ' + e.message)));
    },
    stop: a => {
      if (a.includes('-t') || a.includes('--time') || a.includes('-w') || a.includes('--wait')) return console.log(C.yel('定时启停需要网关常驻调度, 暂不支持'));
      return api('POST', '/admin/api/tunnel', { action: 'stop' }).then(() => { ok('隧道已停止'); view(); }).catch(e => console.log(C.yel('停止失败: ' + e.message)));
    },
  };
  return startRepl({
    title: 'agw 隧道管理 loop',
    prompt: () => 'agw·cloudflared> ',
    help: HELP_CF,
    refresh: view,
    commands,
    unknown: parts => console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)')),
  });
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
  agw decrypr <all|inst> [password]     解密
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
 *  webToken: 面板入口与 /admin/api/* 唯一的管理访问令牌
 * ================================================================ */
function webBases(cfg) { // 面板基础地址(不含凭据)
  const port = (cfg.listen || {}).port || 16384;
  const scheme = (cfg.tls && cfg.tls.enable) ? 'https' : 'http';
  const bases = [`${scheme}://127.0.0.1:${port}`];
  try {
    const priv = i => i && i.family === 'IPv4' && !i.internal
      && (/^10\./.test(i.address) || /^192\.168\./.test(i.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(i.address));
    const lan = Object.values(os.networkInterfaces()).flat().find(priv);
    if (lan) bases.push(`${scheme}://${lan.address}:${port}`);
  } catch (_) {}
  return bases;
}
function openBrowser(url) {
  if (process.env.AGW_NO_OPEN) return null; // 脚本化/测试场景: 不弹浏览器
  const q = `'` + String(url).replace(/'/g, `'\\''`) + `'`;
  for (const c of ['termux-open', 'termux-open-url', 'xdg-open']) {
    try { execSync(`${c} ${q}`, { stdio: 'ignore' }); return c; } catch (_) {}
  }
  return null;
}
async function makeLoginLink(inst, cfg, apiTok) { // 一次性登录链接: 随机会话UID + 令牌, 全走路径
  const sid = crypto.randomBytes(24).toString('base64url');
  const bases = webBases(cfg);
  const tok = encodeURIComponent(cfg.webToken || '');
  try {
    await api('POST', '/admin/api/web-session', { sid }, apiTok); // 预注册一次性会话UID(15分钟内有效, 用一次即废)
    return { sid, urls: bases.map(b => `${b}/auth/${sid}/${tok}`) };
  } catch (e) {
    return { sid, urls: bases.map(b => `${b}/auth?key=${tok}`), fallback: true, err: e.message };
  }
}
function printLinks(label, urls) {
  console.log(t(label));
  urls.forEach(u => console.log('  ' + C.cyn(u)));
}
function webHelp() {
  console.log(t(`用法:
  agw web login [--inst <实例>]          生成随机访问令牌+一次性会话UID, 打印登录链接并尝试打开浏览器
  agw web --key <token> [--inst <实例>]  设定固定访问令牌(URL 安全字符 [A-Za-z0-9_-], 固定后 login 不再轮换)
  agw web --key clear [--inst <实例>]    清除固定访问令牌
  agw web --expired [--inst <实例>]      清除面板认证状态(注销全部会话与待用链接)
  agw web [--inst <实例>]                查看当前令牌状态与面板地址`));
}
async function cmdWeb(argv) {
  const has = f => argv.includes(f);
  if (has('help') || has('--help')) return webHelp();
  const inst = (() => { const i = argv.indexOf('--inst'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'default'; })();
  const cfg = loadCfg(inst);

  if (!argv.length || (argv.length === 2 && argv[0] === '--inst')) { // 状态视图
    console.log(cfg.webToken
      ? t('访问令牌: ') + C.grn('已设 ' + maskKey(cfg.webToken)) + (cfg.webTokenFixed ? C.dim('(固定, --key clear 可清除)') : C.dim('(自动生成, login 会轮换)'))
      : C.yel('访问令牌: 未设') + C.dim(' (agw web login 生成)'));
    if (!cfg.webToken) console.log(C.yel('webToken 未设: 面板当前免密访问, 公网部署前务必 agw web login'));
    console.log(t('面板地址(完整登录链接用 agw web login 生成):'));
    webBases(cfg).forEach(b => console.log('  ' + C.cyn(b + '/auth')));
    return;
  }

  if (has('--key')) {
    const v = argv[argv.indexOf('--key') + 1];
    if (v === undefined || v === 'help') return webHelp();
    if (v === 'clear') {
      if (!cfg.webToken && !cfg.webTokenFixed) return console.log(t('未设置访问令牌, 无需清除'));
      delete cfg.webToken; delete cfg.webTokenFixed; saveCfg(inst, cfg);
      ok('已清除访问令牌(旧链接全部失效)');
      return hotRestart(inst);
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(v)) die('令牌需为 8~128 位 URL 安全字符([A-Za-z0-9_-]); 建议直接 agw web login 随机生成');
    cfg.webToken = v; cfg.webTokenFixed = true; saveCfg(inst, cfg);
    const r = await makeLoginLink(inst, cfg);
    printLinks('固定访问令牌已保存, 一次性登录链接:', r.urls);
    if (r.fallback) console.log(C.dim('网关未在运行, 已退回 ?key= 形式(重启后仍有效)'));
    const opened = openBrowser(r.urls[0]);
    if (opened) console.log(C.dim(`已尝试用 ${opened} 打开浏览器`));
    return hotRestart(inst);
  }
  if (has('--expired')) {
    return api('POST', '/admin/api/web-expired')
      .then(() => ok('已清除面板认证状态(全部会话与待用登录链接已注销)'))
      .catch(e => die('清除失败(网关未在运行?): ' + e.message));
  }
  if (argv.length && !has('login')) return webHelp();

  // login: 固定令牌 → 直接用; 自动令牌 → 每次轮换(旧令牌+旧链接失效)
  let rotated = false, prevTok = cfg.webToken || '';
  if (!cfg.webTokenFixed) {
    cfg.webToken = crypto.randomBytes(24).toString('base64url');
    delete cfg.webTokenFixed; saveCfg(inst, cfg); rotated = true;
    ok('已生成随机访问令牌(webToken)');
  } else {
    console.log(C.dim('使用固定访问令牌(--key 设定, login 不轮换)'));
  }
  if (rotated) await hotRestart(inst, prevTok); // 用旧令牌调重启(网关内存里还是旧令牌); 重启后新令牌生效, 待用链接/会话一并清空
  const r = await makeLoginLink(inst, cfg, rotated ? undefined : prevTok);
  printLinks('登录链接(一次性: 打开即绑定会话, 链接作废; 勿外传):', r.urls);
  if (r.fallback) console.log(C.dim('一次性链接注册失败(网关未在运行?), 已退回 ?key= 形式: ' + r.err));
  if (rotated) console.log(C.dim('旧令牌/旧链接已失效'));
  const opened = openBrowser(r.urls[0]);
  console.log(opened ? C.dim(`已尝试用 ${opened} 打开浏览器`) : C.dim('未找到可用的开浏览器命令, 请手动复制链接'));

}

/* ==================== 分域 loop — agw inst/chan/router/stat/register/admin ==================== */
const LOOP_HINT = '空行刷新 | help 看命令 | exit 退出';
function canLoop() { return !process.env.AGW_NO_LOOP && !!(process.stdin.isTTY && process.stdout.isTTY); } // loop 内再调用 cmdXxx 时不再嵌套进 loop
function tailLog(name, n) {
  const k = Math.max(1, Number(n) || 30);
  return api('GET', `/admin/api/logs/${encodeURIComponent(name)}?lines=${k}`)
    .then(d => {
      const txt = typeof d === 'string' ? d : ((d && (d.logs || d.text)) || '');
      console.log(String(txt || '(空)').split('\n').slice(-k).join('\n'));
    }).catch(e => console.log(C.yel('日志读取失败: ' + e.message)));
}
function splitArgs(raw) { // 按空白分词, 但尊重 "…" / '…' (渠道 url=…, key=… 这类值含逗号空格)
  const out = []; let cur = '', q = null;
  for (const ch of String(raw || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
/* 通用 REPL: 空行=刷新; help/exit; 其余交给各域 commands 表 */
function startRepl(o) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  let closing = false;
  LOOPING = true;
  process.env.AGW_NO_LOOP = '1'; // 防止 loop 内部委派 cmdChan/cmdRouter 等再次开 loop
  const P = () => { if (!closing) { try { rl.setPrompt(C.cyn(typeof o.prompt === 'function' ? o.prompt() : o.prompt)); rl.prompt(); } catch (_) {} } };
  const done = r => { if (r && r.then) r.then(P).catch(e => { console.log(C.red('✗ ' + e.message)); P(); }); else P(); };
  const run = raw => {
    if (o.before) { const h = o.before(raw); if (h) return h; } // 子 loop(edit/scope/models) 优先接管输入
    const parts = splitArgs(raw);
    if (!parts.length) return o.refresh && o.refresh();
    const c = parts[0].toLowerCase();
    if (['exit', 'quit', 'q', ':q'].includes(c)) { rl.close(); return; }
    if (c === 'help' || c === '?') { console.log(o.help); return; }
    const fn = o.commands[c];
    if (fn) return fn(parts.slice(1), parts);
    if (o.unknown) return o.unknown(parts);
    console.log(C.yel('未知命令: ' + c + '  (help 查看)'));
  };
  console.log(C.dim(o.title + ' — ' + LOOP_HINT));
  try { done(o.refresh && o.refresh()); } catch (e) { console.log(C.red('✗ ' + e.message)); P(); }
  rl.on('line', l => { try { done(run(l)); } catch (e) { console.log(C.red('✗ ' + e.message)); P(); } });
  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => {
    closing = true; LOOPING = false;
    if (o.onClose) { try { o.onClose(); } catch (_) {} }
    console.log(C.dim('bye'));
    setTimeout(() => process.exit(0), 300); // 留点时间让在途输出落地
  });
}

/* ---------- 实例管理 ---------- */
const HELP_INST = t(`实例管理 loop 命令:
  status [all|requests|error|debug|usage]   状态 / 日志 / 用量
  grep <time|line|content|other> <值>       日志过滤
       time 10m        最近 10 分钟
       line 100        最后 100 行
       content timeout 包含文本
       other <正则>     正则匹配
  dist [--export -p <路径>] [--export-type -t image|table|html]
       上下文 Token 六分类分布; 导出缺省 ./dist-<实例>-<时间>.<svg|txt|html>
  edit                                     进入编辑 loop
       name=<实例名>   port=<端口|r=随机>   tls=<on/off>
       apikey=<key|0=随机|none>   fetch=<分钟|0=关>
       filter=<on/off>   ctxp=<force|warn|none>
  空行刷新当前实例状态`);
function distData(inst) {
  const sf = path.join(DATA_DIR, 'stats-' + inst + '.json');
  if (!fs.existsSync(sf)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (_) { return null; }
  const D = { tools: 0, system: 0, history: 0, user: 0, reasoning: 0, text: 0, tool: 0 };
  for (const v of Object.values(j.daily || {})) for (const k of Object.keys(D)) D[k] += (v.dist && v.dist[k]) || 0;
  const tot = Object.values(D).reduce((a, b) => a + b, 0);
  return { since: j.since || j.savedAt, D, tot };
}
const DIST_NAMES = { tools: '工具定义', system: '系统提示', history: '对话历史', user: '用户输入', reasoning: '思考内容', text: '正文', tool: 'ToolCall' };
function distExport(inst, opt) {
  const d = distData(inst);
  if (!d || !d.tot) return console.log(C.dim('  无 Token 分布数据(先 stat --refresh <分钟> 开启落盘)'));
  const type = (opt.type || 'table').toLowerCase();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const def = path.join(process.cwd(), 'dist-' + inst + '-' + stamp + (type === 'image' ? '.svg' : type === 'html' ? '.html' : '.txt'));
  const out = path.resolve(opt.path || def);
  const rows = Object.keys(DIST_NAMES).map(k => ({ k, name: DIST_NAMES[k], v: d.D[k], pct: d.tot ? d.D[k] / d.tot * 100 : 0 }));
  let body;
  if (type === 'html') {
    body = '<!doctype html><meta charset="utf-8"><title>Token 分布 ' + inst + '</title><style>body{font:14px system-ui;background:#111;color:#ddd;padding:24px}table{border-collapse:collapse}td,th{padding:6px 14px;border-bottom:1px solid #333;text-align:left}.bar{background:#2b6cb0;height:10px}</style>'
      + '<h2>' + inst + ' Token 分布</h2><p>since ' + (d.since || '-') + ' · 合计 ' + d.tot + ' tok</p><table><tr><th>分类</th><th>Token</th><th>占比</th><th></th></tr>'
      + rows.map(r => '<tr><td>' + r.name + '</td><td>' + r.v + '</td><td>' + r.pct.toFixed(1) + '%</td><td><div class="bar" style="width:' + Math.max(1, Math.round(r.pct * 4)) + 'px"></div></td></tr>').join('')
      + '</table>';
  } else if (type === 'image') {
    const W = 640, rowH = 34, H = 60 + rows.length * rowH;
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" font-family="sans-serif">'
      + '<rect width="100%" height="100%" fill="#111"/><text x="24" y="34" fill="#eee" font-size="18">' + inst + ' Token 分布 (since ' + (d.since || '-') + ')</text>'
      + rows.map((r, i) => {
        const y = 60 + i * rowH, w = Math.max(1, Math.round(r.pct / 100 * 380));
        return '<text x="24" y="' + (y + 14) + '" fill="#bbb" font-size="13">' + r.name + '</text>'
          + '<rect x="120" y="' + y + '" width="' + w + '" height="18" fill="#2b6cb0"/>'
          + '<text x="' + (128 + w) + '" y="' + (y + 14) + '" fill="#ddd" font-size="12">' + r.v + ' tok ' + r.pct.toFixed(1) + '%</text>';
      }).join('') + '</svg>';
  } else {
    body = [inst + ' Token 分布 (since ' + (d.since || '-') + ', 合计 ' + d.tot + ' tok)', ...rows.map(r => pad(r.name, 10) + '\t' + String(r.v).padStart(10) + '\t' + r.pct.toFixed(1) + '%')].join('\n');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  fs.chmodSync(out, 0o600);
  ok('已导出 ' + type + ': ' + out);
}
function instGrep(cur, a) {
  const mode = (a[0] || '').toLowerCase();
  const val = a.slice(1).join(' ');
  if (!mode) return console.log('用法: grep <time|line|content|other> <值>');
  return api('GET', `/admin/api/logs/${encodeURIComponent(cur)}?lines=400`).then(d => {
    const txt = typeof d === 'string' ? d : ((d && (d.logs || d.text)) || '');
    let lines = String(txt).split('\n').filter(Boolean);
    if (mode === 'line') {
      const n = Math.max(1, Number(val) || 50);
      lines = lines.slice(-n);
    } else if (mode === 'content') {
      if (!val) return console.log('用法: grep content <文本>');
      lines = lines.filter(l => l.toLowerCase().includes(val.toLowerCase()));
    } else if (mode === 'other') {
      if (!val) return console.log('用法: grep other <正则>');
      let re; try { re = new RegExp(val, 'i'); } catch (e) { return console.log(C.yel('正则无效: ' + e.message)); }
      lines = lines.filter(l => re.test(l));
    } else if (mode === 'time') {
      const win = parseWhen(val || '10m');
      if (!win) return console.log('用法: grep time <10m|2h|HH:MM>');
      const nowT = Date.now();
      const from = win > nowT ? nowT - (win - nowT) : win; // 相对窗口 → now-时长; 绝对时间 → 直接比较
      lines = lines.filter(l => {
        const m = l.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
        if (!m) return false;
        const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
        return d.getTime() >= from;
      });
    } else return console.log('用法: grep <time|line|content|other> <值>');
    if (!lines.length) return console.log(C.dim('  无匹配日志'));
    lines.slice(-200).forEach(l => console.log('  ' + trunc(l, 200)));
  }).catch(e => console.log(C.yel('日志读取失败: ' + e.message)));
}
function loopInst(startName) {
  let cur = startName || 'default', mode = null;
  const show = () => cmdInst([cur, '--status', 'all']);
  const editView = () => {
    const c = loadCfg(cur);
    const port = (c.listen || {}).port || 16384;
    const ms = c.modelSync || {};
    const fetchMin = ms.enable === false ? 0 : (ms.intervalMin || Math.round((ms.intervalHours || 24) * 60));
    console.log(C.bold('■ 编辑实例 ' + cur) + C.dim('  (key=value 逐项生效, exit 返回)'));
    console.log(`  name=${cur}  port=${port}  tls=${(c.tls && c.tls.enable) ? 'on' : 'off'}  apikey=${c.gatewayKey ? maskKey(c.gatewayKey) : C.dim('(空)')}`);
    console.log(`  fetch=${fetchMin ? fetchMin + 'min' : 'off'}  filter=${(c.redact && c.redact.enable) ? 'on' : 'off'}  ctxp=${c.ctxpMode || 'force'}`);
  };
  const editPost = body => api('POST', `/admin/api/config/${encodeURIComponent(cur)}`, body);
  const applyEdit = line => {
    const eq = line.indexOf('=');
    if (eq < 0) return console.log(C.yel('格式: key=value (name/port/tls/apikey/fetch/filter/ctxp)'));
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    if (k === 'name') {
      if (!v) return console.log(C.yel('name 不能为空'));
      if (cur === 'default') return console.log(C.yel('default 实例不能改名'));
      const old = cur;
      return api('POST', `/admin/api/instance-rename/${encodeURIComponent(old)}`, { newName: v })
        .then(d => { cur = (d && d.name) || v; ok('实例已改名: ' + cur); editView(); })
        .catch(e => console.log(C.yel('改名失败: ' + e.message)));
    }
    if (k === 'port') {
      const port = /^r(andom)?$/i.test(v) ? 20000 + Math.floor(Math.random() * 20000) : Number(v);
      if (!(port >= 1024 && port <= 65535)) return console.log(C.yel('port: 1024-65535 或 r=随机'));
      return editPost({ port }).then(() => { ok('端口已改为 ' + port); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'tls') {
      const c = loadCfg(cur), on = !/^(off|0|no|false)$/i.test(v);
      const tls = Object.assign({}, c.tls || {}, { enable: on });
      if (on && !tls.port) tls.port = (c.listen || {}).port || 16384;
      return editPost({ tls }).then(() => { ok('TLS ' + (on ? '已开启' : '已关闭')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'apikey') {
      const key = /^0$/.test(v) ? crypto.randomBytes(24).toString('base64url') : /^(none|clear|-|空)$/i.test(v) ? '' : v;
      if (!key && v && !/^(none|clear|-|空)$/i.test(v)) return console.log(C.yel('apikey: 填 key / 0=随机 / none=清除'));
      return editPost({ gatewayKey: key }).then(() => { ok('Gateway-Key ' + (key ? '已设置' : '已清除')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'fetch') {
      const n = Math.max(0, Math.round(Number(v) || 0));
      const body = { modelSync: { enable: n > 0, intervalMin: n, intervalHours: Math.max(1, Math.round(n / 60) || 24) } };
      return editPost(body).then(() => { ok('模型同步 ' + (n ? n + ' 分钟' : '已关闭')); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'filter' || k === 'fliter') {
      return editPost({ redact: { enable: !/^(off|0|no|false)$/i.test(v) } }).then(() => { ok('隐私过滤已更新'); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    if (k === 'ctxp') {
      const m = v.toLowerCase();
      if (!['force', 'warn', 'none'].includes(m)) return console.log(C.yel('ctxp: force(拦截) / warn(只告警) / none(关闭)'));
      return editPost({ ctxpMode: m }).then(() => { ok('ctxp 模式: ' + m); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    console.log(C.yel('未知字段: ' + k));
  };
  const before = raw => {
    if (!mode) return;
    const line = raw.trim();
    if (/^(exit|done|q|:q|back)$/i.test(line)) { mode = null; console.log(C.dim('已返回实例 loop')); show(); return true; }
    if (!line) { editView(); return true; }
    return applyEdit(line) || true;
  };
  const commands = {
    status: a => cmdInst([cur, '--status', (a[0] || 'all').toLowerCase()]),
    grep: a => instGrep(cur, a),
    dist: a => {
      const pi = a.findIndex(x => x === '-p' || x === '--output' || x === '--export-path');
      const ti = a.findIndex(x => x === '-t' || x === '--export-type');
      const outPath = pi >= 0 ? a[pi + 1] : undefined;
      const type = ti >= 0 ? a[ti + 1] : (outPath ? (/\.svg$/i.test(outPath) ? 'image' : /\.html?$/i.test(outPath) ? 'html' : 'table') : 'table');
      const d = distData(cur);
      if (d && d.tot) {
        console.log(`  ${cur} Token 分布 (since ${d.since || '-'}, 合计 ${fmtTok(d.tot)} tok):`);
        for (const k of Object.keys(DIST_NAMES)) {
          const pct = d.D[k] / d.tot * 100;
          console.log(`    ${pad(DIST_NAMES[k], 20)} ${fmtTok(d.D[k]).padStart(9)} tok  ${'█'.repeat(Math.max(1, Math.round(pct / 4)))} ${pct.toFixed(1)}%`);
        }
      } else console.log(C.dim('  无 Token 分布数据(先 stat --refresh <分钟> 开启落盘)'));
      if (pi >= 0 || a.includes('--export')) return distExport(cur, { path: outPath, type });
    },
    edit: () => { mode = { type: 'edit' }; editView(); },
  };
  return startRepl({
    title: 'agw 实例管理 loop',
    prompt: () => mode ? 'agw·inst ' + cur + ' [edit]> ' : 'agw·inst ' + cur + '> ',
    help: HELP_INST,
    refresh: show,
    commands,
    before: before,
    unknown: parts => {
      if (parts[0].startsWith('-')) return console.log(C.yel('未知参数: ' + parts[0] + '  (help 查看)'));
      console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)'));
    },
  });
}


const HELP_CHAN = t(`渠道管理 loop 命令:
  fetch <渠道|all>              拉取上游模型列表
  edit <渠道>                   进入编辑 loop
       name=<渠道名>  url=<BaseURL>  sdk=<0=openai/1=claude/2=google>
       key=<API-Key>  balance=<URL>  balance-key=<JSON-Key>
       delay=<毫秒/2s>  transcreet=<on/off/res-only/inherit>
  default <渠道>                设为默认渠道(其余默认自动取消)
  lock <渠道> [-t 时长/时间] [-w 时长/时间] [--cancel]   锁定(路由跳过)
  unlock <渠道> [-t 时长/时间] [-w 时长/时间] [--cancel] 解锁/定时解锁
  delete <渠道>                 删除渠道(输入 y 二次确认)
  models <渠道>                 模型清单 loop(add <模型> / delete <模型|*> / list)
  scope <渠道> "请求模型=真实模型, …"   一次写入映射
  scope <渠道>                  映射/白名单 loop(models= / name= / override= / apply)
  空行                          刷新渠道列表`);

/* 渠道锁定判定(与 router.js channelLocked 同口径, 供列表/提示用) */
function chanLockInfo(ch, now) {
  const t = now || Date.now();
  const at = Number(ch && ch.lockAt) || 0, until = Number(ch && ch.lockUntil) || 0;
  const scheduled = at > t;
  const expired = until && until <= t;
  return { locked: !!(at || until) && !scheduled && !expired, scheduled, at, until };
}
function fmtWhen(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms)), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parseWhen(v) { // "30"=秒 / 30s 10m 2h 1h30m / 22:30 / 10-28 09:00 / 2026-10-28 09:00
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  const now = Date.now();
  if (/^\d+(\.\d+)?$/.test(s)) return now + Math.round(Number(s) * 1000);
  let ms = 0, hit = false;
  s.replace(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi, (m, n, u) => { hit = true; ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[u.toLowerCase()]; return m; });
  if (hit && !s.replace(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi, '').trim()) return now + Math.round(ms);
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) { const d = new Date(); d.setHours(Number(hm[1]), Number(hm[2]), 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); }
  const md = s.match(/^(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (md) {
    const d = new Date(); d.setMonth(Number(md[1]) - 1, Number(md[2]));
    if (md[3] != null) d.setHours(Number(md[3]), Number(md[4]), 0, 0); else d.setHours(23, 59, 59, 0);
    if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(23, 59, 59, 0);
  return d.getTime();
}
function loopChan(startName) {
  let cur = startName, mode = null; // null | {type:'edit'|'scope'|'models', name, ...}
  const show = () => cmdChan([cur]);
  const chOf = name => (loadCfg(cur).channels || []).find(x => x.name === name);
  const post = ch => api('POST', `/admin/api/channel/${encodeURIComponent(cur)}`, ch)
    .then(d => { if (d && d.hotReload === false) console.log(C.yel('已保存但热重载失败: ' + (d.warn || ''))); return d; });
  const pv = (a, rest) => { // <渠道名> + 其余参数 → cmdChan --provider
    if (!a[0]) return console.log(C.yel('缺少渠道名'));
    return cmdChan([cur, '--provider', a[0]].concat(rest));
  };
  /* ---- edit 子 loop ---- */
  const editView = () => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出编辑')); }
    const lk = chanLockInfo(ch);
    console.log(C.bold('■ 编辑渠道 ' + ch.name) + C.dim('  (key=value 逐项生效, exit 返回)'));
    console.log(`  name=${ch.name}  url=${ch.baseUrl}  sdk=${ch.type}`);
    console.log(`  key=${ch.apiKey ? maskKey(ch.apiKey) : C.dim('(空)')}  default=${ch.default ? 'on' : 'off'}  delay=${ch.delayMs || 0}ms  transcreet=${ch.transcreet || 'inherit'}`);
    console.log(`  balance=${ch.balanceUrl || '-'}  balance-key=${ch.balancePath || '-'}` + (lk.locked ? C.red('  [已锁定]') : lk.scheduled ? C.yel('  [待锁定 ' + fmtWhen(lk.at) + ']') : ''));
  };
  const applyEdit = line => {
    const eq = line.indexOf('=');
    if (eq < 0) return console.log(C.yel('格式: key=value (name/url/sdk/key/balance/balance-key/delay/transcreet)'));
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道已不存在, 退出编辑')); }
    const next = Object.assign({}, ch);
    const none = /^(none|clear|-|空)$/i.test(v);
    if (k === 'name') {
      if (!v || none) return console.log(C.yel('name 不能为空'));
      if (v === ch.name) return console.log(C.dim('渠道名未变'));
      if (chOf(v)) return console.log(C.yel('渠道名已被占用: ' + v));
      return post(Object.assign(next, { name: v, oldName: ch.name }))
        .then(() => { mode.name = v; ok('渠道已改名: ' + v); editView(); })
        .catch(e => console.log(C.yel('改名失败: ' + e.message)));
    }
    if (k === 'url') { if (!/^https?:\/\//i.test(v)) return console.log(C.yel('url 需要 http(s):// 开头')); next.baseUrl = v.replace(/\/+$/, ''); }
    else if (k === 'sdk') {
      const t = { '0': 'openai', '1': 'claude', '2': 'gemini', openai: 'openai', claude: 'claude', gemini: 'gemini', google: 'gemini' }[v.toLowerCase()];
      if (!t) return console.log(C.yel('sdk: 0=openai / 1=claude / 2=google(gemini)'));
      next.type = t;
    }
    else if (k === 'key') next.apiKey = none ? '' : v;
    else if (k === 'balance') next.balanceUrl = none ? null : v;
    else if (k === 'balance-key') next.balancePath = none ? null : v;
    else if (k === 'delay') {
      const ms = /^\d+(\.\d+)?$/.test(v) ? Number(v) : /^\d+(\.\d+)?s$/i.test(v) ? Number(v.slice(0, -1)) * 1000 : /^\d+(\.\d+)?ms$/i.test(v) ? Number(v.slice(0, -2)) : NaN;
      if (!(ms >= 0)) return console.log(C.yel('delay 需要毫秒数: delay=200 / delay=2s'));
      next.delayMs = Math.min(120000, Math.round(ms));
    }
    else if (k === 'transcreet') {
      const x = v.toLowerCase();
      if (!['on', 'off', 'res-only', 'inherit', 'none'].includes(x)) return console.log(C.yel('transcreet: on / off / res-only / inherit'));
      next.transcreet = (x === 'inherit' || x === 'none') ? '' : x;
    }
    else return console.log(C.yel('未知字段: ' + k));
    return post(next).then(() => { ok(k + ' 已生效'); editView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- scope 子 loop ---- */
  const scopeView = () => {
    console.log(C.bold('■ 模型映射/白名单 ' + mode.name) + C.dim('  (字段逐项设置, apply 生效, exit 返回)'));
    console.log(`  models=${mode.models || C.dim('(未设)')}  name=${mode.real || C.dim('(未设)')}  override=${mode.override}`);
    console.log(C.dim('  models=<请求模型[*], …>  name=<真实模型>  override=true|false  apply'));
  };
  const applyScope = () => {
    if (!mode.models) return console.log(C.yel('先设 models=<请求模型>'));
    if (mode.override && !mode.real) return console.log(C.yel('override=true 需要 name=<真实模型>'));
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道已不存在, 退出编辑')); }
    const next = Object.assign({}, ch);
    const map = Object.assign({}, ch.modelMap || {});
    const pats = mode.models.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    if (!mode.override) {
      const ms = Array.isArray(ch.models) ? ch.models.slice() : [];
      for (const p of pats) { delete map[p]; if (!ms.includes(p)) ms.push(p); }
      next.models = ms;
    } else for (const p of pats) map[p] = mode.real;
    next.modelMap = Object.keys(map).length ? map : null;
    return post(next).then(() => { ok('映射已保存'); mode = null; show(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- models 子 loop ---- */
  const modelsView = () => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出')); }
    const ms = ch.models || [];
    console.log(C.bold('■ 模型清单 ' + ch.name) + `  (${ms.length})` + C.dim('  add <模型> / delete <模型|*> / list / exit'));
    ms.slice(0, 60).forEach(m => console.log('  ' + m));
    if (ms.length > 60) console.log(C.dim(`  … 共 ${ms.length} 个`));
  };
  const modelsSave = (ms, label) => {
    const ch = chOf(mode.name);
    if (!ch) { mode = null; return console.log(C.yel('渠道不存在, 已退出')); }
    return post(Object.assign({}, ch, { models: ms })).then(() => { ok(label); modelsView(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- lock / unlock ---- */
  const lockView = ch => {
    const lk = chanLockInfo(ch);
    if (lk.locked) console.log(C.red('  已锁定') + (lk.until ? ' 至 ' + fmtWhen(lk.until) : ' (手动解锁)'));
    else if (lk.scheduled) console.log(C.yel('  待锁定 ') + fmtWhen(lk.at) + (lk.until ? ' 至 ' + fmtWhen(lk.until) : ''));
    else console.log(C.dim('  未锁定'));
  };
  const setLock = (a, want) => {
    const name = a[0];
    if (!name) return console.log('用法: ' + (want ? 'lock' : 'unlock') + ' <渠道> [-t 时长/时间] [-w 时长/时间] [--cancel]');
    const ch = chOf(name);
    if (!ch) return console.log(C.yel('渠道不存在: ' + name));
    const getV = (...fl) => { for (let i = 0; i < a.length; i++) if (fl.includes(a[i])) return a[i + 1]; return undefined; };
    const now = Date.now(), next = Object.assign({}, ch);
    const tRaw = getV('-t', '--time'), wRaw = getV('-w', '--wait');
    if (a.includes('--cancel')) {
      if (want) {
        if (!(Number(ch.lockAt) > now)) return console.log(C.yel('没有待生效的锁定'));
        delete next.lockAt; delete next.lockUntil;
      } else {
        if (!(Number(ch.lockUntil) > now)) return console.log(C.yel('没有待生效的解锁'));
        delete next.lockUntil;
      }
      return post(next).then(() => { ok('已取消'); lockView(chOf(name)); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    }
    const tMs = tRaw === undefined ? 0 : parseWhen(tRaw);
    if (tRaw !== undefined && !tMs) return console.log(C.yel('时间格式: 30(秒) / 10m / 2h / 22:30 / 10-28 09:00 / 2026-10-28 09:00'));
    const wMs = wRaw === undefined ? 0 : parseWhen(wRaw);
    if (wRaw !== undefined && !wMs) return console.log(C.yel('时间格式: 30(秒) / 10m / 2h / 22:30 / 10-28 09:00 / 2026-10-28 09:00'));
    if (want) {
      const start = wMs || now;
      const end = tMs || 0;
      if (end && end <= start) return console.log(C.yel('锁定结束时间必须晚于开始时间'));
      next.lockAt = start;
      if (end) next.lockUntil = end; else delete next.lockUntil;
    } else {
      const until = wMs || tMs || 0;
      if (!until) { delete next.lockAt; delete next.lockUntil; }
      else {
        if (until <= now) return console.log(C.yel('解锁时间必须晚于当前时间'));
        if (!(Number(ch.lockAt) > now)) next.lockAt = now; // 未锁则立即锁, 到点自动解
        next.lockUntil = until;
      }
    }
    return post(next).then(() => { ok(want ? '锁定已生效' : '解锁已设置'); lockView(chOf(name)); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
  };
  /* ---- 子 loop 输入分发 ---- */
  const before = raw => {
    if (!mode) return;
    const line = raw.trim();
    if (/^(exit|done|q|:q|back)$/i.test(line)) { mode = null; console.log(C.dim('已返回渠道 loop')); show(); return true; }
    if (mode.type === 'del') {
      if (!/^y(es)?$/i.test(line)) { mode = null; console.log(C.dim('已取消')); return true; }
      const name = mode.name; mode = null;
      return Promise.resolve(cmdChan([cur, '--provider', name, '--remove'])).then(() => show()) || true;
    }
    if (mode.type === 'edit') { if (!line) { editView(); return true; } return applyEdit(line) || true; }
    if (mode.type === 'scope') {
      if (!line) { scopeView(); return true; }
      if (/^(apply|save)$/i.test(line)) return applyScope() || true;
      const eq = line.indexOf('=');
      if (eq < 0) { console.log(C.yel('scope 编辑: models=… / name=… / override=true|false / apply / exit')); return true; }
      const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
      if (k === 'models') mode.models = v;
      else if (k === 'name') mode.real = v;
      else if (k === 'override') mode.override = !/^(false|0|off|no)$/i.test(v);
      else console.log(C.yel('未知字段: ' + k));
      scopeView(); return true;
    }
    if (mode.type === 'models') {
      const p = splitArgs(line), c = (p[0] || '').toLowerCase(), arg = p.slice(1).join(' ');
      if ((c === 'add') && arg) return modelsSave([].concat((chOf(mode.name) || {}).models || [], arg), '已添加模型: ' + arg) || true;
      if ((c === 'delete' || c === 'del') && arg) {
        const ms = ((chOf(mode.name) || {}).models || []).filter(m => arg !== '*' && m !== arg);
        return modelsSave(ms, arg === '*' ? '已清空模型清单' : '已删除模型: ' + arg) || true;
      }
      if (c === 'list' || !line) { modelsView(); return true; }
      console.log(C.yel('models 编辑: add <模型> / delete <模型|*> / list / exit'));
      return true;
    }
  };
  const commands = {
    edit: a => {
      if (!a[0]) return console.log('用法: edit <渠道>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'edit', name: ch.name };
      editView();
    },
    default: a => {
      if (!a[0]) return console.log('用法: default <渠道>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      return post(Object.assign({}, ch, { default: true })).then(() => { ok('默认渠道: ' + a[0]); show(); }).catch(e => console.log(C.yel('保存失败: ' + e.message)));
    },
    delete: a => {
      if (!a[0]) return console.log('用法: delete <渠道>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'del', name: ch.name };
      console.log(C.yel('删除渠道 ' + ch.name + ' 不可恢复, 输入 y 确认(其它=取消)'));
    },
    lock: a => setLock(a, true),
    unlock: a => setLock(a, false),
    models: a => {
      if (!a[0]) return console.log('用法: models <渠道>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'models', name: ch.name };
      modelsView();
    },
    scope: a => {
      if (a.length > 1) return pv(a, ['--scope', a.slice(1).join(' ')]);
      if (!a[0]) return console.log('用法: scope <渠道> "a=b" | scope <渠道>');
      const ch = chOf(a[0]);
      if (!ch) return console.log(C.yel('渠道不存在: ' + a[0]));
      mode = { type: 'scope', name: ch.name, models: '', real: '', override: true };
      scopeView();
    },
    fetch: a => {
      if (!a[0]) return console.log('用法: fetch <渠道|all>');
      if (a[0] !== 'all') return cmdFetch(['chan', a[0], cur]);
      const chs = loadCfg(cur).channels || [];
      if (!chs.length) return console.log(C.dim('  (无渠道)'));
      return chs.reduce((p, ch) => p.then(() => Promise.resolve(cmdFetch(['chan', ch.name, cur])).catch(e => console.log(C.yel(ch.name + ': ' + e.message)))), Promise.resolve());
    },
  };
  return startRepl({
    title: 'agw 渠道管理 loop (' + cur + ')',
    prompt: () => mode ? 'agw·chan ' + cur + ' [' + mode.type + ' ' + mode.name + ']> ' : 'agw·chan ' + cur + '> ',
    help: HELP_CHAN,
    refresh: show,
    commands,
    before: before,
    unknown: parts => {
      if (parts[0].startsWith('-')) return console.log(C.yel('未知参数: ' + parts[0] + '  (help 查看 -- 子命令)'));
      console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)'));
    },
  });
}

/* ---------- 用户注册 ---------- */
const HELP_REGISTER = t(`用户注册 loop:
  name=<UID>         3-32 位字母/数字/下划线
  password=<密码>    不小于实例要求的最小长度
  recomfirm=<密码>   再输一次确认
  email=<邮箱>       实例要求邮箱时必填
  other=<备注>       额外信息(写入用户 note)
  空行               信息齐全则提交注册, 否则显示已填内容
  exit               退出`);
function plainPost(inst, p, body) { // 直接打实例端口(不经 admin API)
  return new Promise((resolve, reject) => {
    const c = loadCfg(inst);
    const port = (c.listen || {}).port || 16384, useTls = !!(c.tls && c.tls.enable);
    const payload = JSON.stringify(body || {});
    const rq = (useTls ? https : http).request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      ...(useTls ? { rejectUnauthorized: false } : {}) }, r => {
      let buf = ''; r.on('data', d => buf += d);
      r.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (_) {}
        if (r.statusCode >= 400) return reject(new Error((j && (j.error && (j.error.message || j.error))) || trunc(buf, 200)));
        resolve(j || buf);
      });
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('请求超时')));
    rq.end(payload);
  });
}
function loopRegister(startName) {
  let cur = startName || 'default';
  const form = { name: '', password: '', confirm: '', email: '', other: '' };
  const view = () => {
    const c = loadCfg(cur), reg = c.registration || {};
    console.log(C.bold('■ 用户注册 (' + cur + ')') + '  ' + (reg.enable ? C.grn('已开放') : C.yel('未开放')));
    console.log(`  name=${form.name || C.dim('(未填)')}  password=${form.password ? '●'.repeat(Math.min(12, form.password.length)) : C.dim('(未填)')}  recomfirm=${form.confirm ? '●'.repeat(Math.min(12, form.confirm.length)) : C.dim('(未填)')}`);
    console.log(`  email=${form.email || C.dim('(未填)')}  other=${form.other || C.dim('(未填)')}` + (reg.captchaProvider === 'turnstile' ? C.yel('  人机验证已开启(CLI 无法完成)') : ''));
    console.log(C.dim('  逐项 key=value; 空行提交; exit 退出'));
  };
  const submit = () => {
    const c = loadCfg(cur), reg = c.registration || {};
    if (!reg.enable) return console.log(C.yel('该实例未开放注册'));
    if (reg.captchaProvider === 'turnstile') return console.log(C.yel('该实例开启 turnstile 人机验证, 请用网页注册'));
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(form.name)) return console.log(C.yel('name 需 3-32 位字母/数字/下划线'));
    if (form.password.length < (reg.minPasswordLen || 8)) return console.log(C.yel('password 至少 ' + (reg.minPasswordLen || 8) + ' 位'));
    if (form.password !== form.confirm) return console.log(C.yel('两次密码不一致'));
    if (reg.emailVerify && reg.emailVerify.enable && !form.email) return console.log(C.yel('该实例要求填写 email'));
    const body = { uid: form.name, password: form.password };
    if (form.email) body.email = form.email;
    if (form.other) body.note = form.other;
    return plainPost(cur, '/auth/register', body).then(d => {
      ok('注册成功: ' + d.uid);
      if (d.key) console.log('  卡密: ' + C.grn(d.key) + C.dim(' (仅显示一次, 请妥善保存)'));
      if (d.quotaTokens) console.log('  额度: ' + fmtTok(d.quotaTokens) + ' tokens');
    }).catch(e => console.log(C.red('注册失败: ' + e.message)));
  };
  const before = raw => {
    const line = raw.trim();
    if (/^(exit|quit|q|:q)$/i.test(line) || /^(help|\?)$/i.test(line)) return; // 交给 REPL: 退出/帮助
    if (!line) { submit(); return true; }
    const eq = line.indexOf('=');
    if (eq < 0) { view(); return true; }
    const k = line.slice(0, eq).trim().toLowerCase(), v = line.slice(eq + 1).trim();
    if (k === 'name') form.name = v;
    else if (k === 'password') form.password = v;
    else if (k === 'reconfirm' || k === 'confirm') form.confirm = v;
    else if (k === 'email') form.email = v;
    else if (k === 'other') form.other = v;
    else console.log(C.yel('未知字段: ' + k));
    view(); return true;
  };
  return startRepl({
    title: 'agw 用户注册 loop (' + cur + ')',
    prompt: () => 'agw·register ' + cur + '> ',
    help: HELP_REGISTER,
    refresh: view,
    commands: {},
    before: before,
  });
}


/* ---------- 管理体系 ---------- */
const HELP_ADMIN = t(`管理体系 loop 命令:
  login [token=<令牌|random>]   生成/设置面板令牌并打印登录链接
  expire [--time -t <时长/时间>] [--wait -w <时长/时间>] [--device -d <id|all>]
                                注销面板会话(当前仅立即执行)
  profile change [--avatar <URL/路径>] [--name <名>] [--profile <内容>] [--other <内容>]
                                管理端资料
  logout [--device -d <id|all>] 退出面板登录
  空行                          显示当前状态`);
function loopAdmin(startName) {
  let cur = startName || 'default';
  const show = () => {
    const c = loadCfg(cur), pf = c.adminProfile || {};
    console.log(C.bold(`■ 管理体系 (${cur})`));
    console.log('  面板令牌 ' + (c.webToken ? C.grn(maskKey(c.webToken)) + (c.webTokenFixed ? C.dim(' 固定') : C.dim(' 自动轮换')) : C.yel('未设')));
    console.log('  入口 ' + webBases(c).map(b => b + '/auth').join('  '));
    console.log('  资料 ' + (pf.name || C.dim('-')) + '  avatar=' + (pf.avatar || C.dim('-')) + '  profile=' + (pf.profile ? trunc(pf.profile, 40) : C.dim('-')) + '  other=' + (pf.other || C.dim('-')));
  };
  const opt = (a, ...fl) => { for (let i = 0; i < a.length; i++) if (fl.includes(a[i])) return a[i + 1]; return undefined; };
  const commands = {
    login: a => {
      const tv = (a[0] || '').toLowerCase().startsWith('token=') ? a[0].slice(6) : (a[0] === 'token' ? a[1] : undefined);
      if (tv && !/^random$/i.test(tv)) return cmdWeb(['--inst', cur, '--key', tv]);
      return cmdWeb(['--inst', cur, 'login']);
    },
    expire: a => {
      if (opt(a, '-t', '--time') !== undefined || opt(a, '-w', '--wait') !== undefined) return console.log(C.yel('定时注销需要网关常驻调度, 暂不支持; 去掉 -t/-w 可立即注销'));
      const dev = opt(a, '-d', '--device') || 'all';
      if (dev !== 'all') return console.log(C.yel('仅支持 --device all'));
      return api('POST', '/admin/api/web-expired').then(() => ok('面板会话已全部注销')).catch(e => console.log(C.yel('注销失败: ' + e.message)));
    },
    logout: a => {
      const dev = opt(a, '-d', '--device') || 'all';
      if (dev !== 'all') return console.log(C.yel('仅支持 --device all'));
      return api('POST', '/admin/api/web-expired').then(() => ok('已退出面板登录')).catch(e => console.log(C.yel('退出失败: ' + e.message)));
    },
    profile: a => {
      const sub = (a[0] || '').toLowerCase();
      if (sub !== 'change') return show();
      const c = loadCfg(cur), pf = Object.assign({}, c.adminProfile || {});
      const av = opt(a, '--avatar'), nm = opt(a, '--name'), pr = opt(a, '--profile'), ot = opt(a, '--other');
      if (av === undefined && nm === undefined && pr === undefined && ot === undefined) return console.log(C.yel('用法: profile change --avatar <URL/路径> --name <名> --profile <内容> --other <内容>'));
      if (av !== undefined) pf.avatar = av;
      if (nm !== undefined) pf.name = nm;
      if (pr !== undefined) pf.profile = pr;
      if (ot !== undefined) pf.other = ot;
      c.adminProfile = pf; saveCfg(cur, c);
      ok('资料已保存'); show();
    },
  };
  return startRepl({
    title: 'agw 管理体系 loop (' + cur + ')',
    prompt: () => 'agw·admin ' + cur + '> ',
    help: HELP_ADMIN,
    refresh: show,
    commands,
    unknown: parts => console.log(C.yel('未知命令: ' + parts[0] + '  (help 查看)')),
  });
}


/* ---------- 命令入口(非 TTY 时打印一次性摘要, 交互终端进 loop) ---------- */
function cmdRegister(argv) {
  if (argv.includes('help') || argv.includes('--help')) { console.log(HELP_REGISTER); return; }
  const inst = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'default';
  if (!listInsts().includes(inst)) die(`实例不存在: ${inst} (已有: ${listInsts().join(', ') || '无'})`);
  if (canLoop()) return loopRegister(inst);
  const c = loadCfg(inst); const r = c.registration || {};
  console.log(`  ${inst}: 注册 ${onoff(r.enable)}  captcha ${r.captchaProvider || 'none'}  密码≥${r.minPasswordLen || 8}  用户 ${(c.users || []).length}`);
  console.log(C.dim('  交互终端执行 agw register 进入注册 loop'));
}
function cmdAdmin(argv) {
  if (argv.includes('help') || argv.includes('--help')) { console.log(HELP_ADMIN); return; }
  const inst = (argv[0] && !argv[0].startsWith('-')) ? argv[0] : 'default';
  if (!listInsts().includes(inst)) die(`实例不存在: ${inst} (已有: ${listInsts().join(', ') || '无'})`);
  if (canLoop()) return loopAdmin(inst);
  const c = loadCfg(inst);
  console.log(`  ${inst}: 面板令牌 ${c.webToken ? '已设 ' + maskKey(c.webToken) : '未设'}  second-key ${(c.adminAuth || {}).secondKey ? '已设' : '未设'}  TOTP ${(c.adminAuth || {}).totpSecret ? '开' : '关'}`);
  console.log(C.dim('  交互终端执行 agw admin 进入管理 loop'));
}

/* ---------- agw config / agw crypt ---------- */
function cmdConfig(argv) {
  const sub = (argv[0] || '').toLowerCase();
  const opt = (...fl) => { for (let i = 0; i < argv.length; i++) if (fl.includes(argv[i])) return argv[i + 1]; return undefined; };
  const usage = () => console.log(t(`用法:
  agw config export <config|all|实例> [--output -p <路径>] [--type -t <0=JSON/1=QRcode>] [--encrypt <true/false>]
  agw config import <文件> [--decrypt <password|none>] [--repair <true/false>]`));
  if (sub === 'export') {
    const scope = argv[1];
    if (!scope) return usage();
    const targets = (scope === 'config' || scope === 'all') ? listInsts() : [scope];
    if (!targets.length) return die('没有实例可导出');
    if (scope !== 'config' && scope !== 'all' && !listInsts().includes(scope)) return die('实例不存在: ' + scope);
    const qr = opt('-t', '--type') === '1';
    const enc = /^(true|1|on|yes)$/i.test(opt('--encrypt') || '');
    const out = opt('-p', '--output');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const pass = enc ? crypt.loadPass() : null;
    if (enc && !pass) return die('加密导出需要 .agwkey / AGW_CRYPT_PASS');
    let dir = null;
    if (out && !qr) {
      try { dir = fs.statSync(out).isDirectory() ? out : null; } catch (_) {}
      if (!dir && targets.length > 1) return die('多实例导出时 --output 必须是已存在的目录');
    }
    for (const name of targets) {
      const c = loadCfg(name);
      let text = JSON.stringify(c, null, 2);
      if (enc) text = crypt.encryptText(text, pass);
      if (qr) {
        const dest = path.resolve(out && targets.length === 1 ? out : path.join(out || process.cwd(), 'config-' + name + '-' + stamp + '.png'));
        const r = require('child_process').spawnSync('qrencode', ['-t', 'PNG', '-o', dest], { input: text });
        if (r.error || r.status !== 0) { console.log(C.yel('  ' + name + ': qrencode 失败 ' + (r.error ? r.error.message : 'exit ' + r.status))); continue; }
        console.log('  ' + dest + (text.length > 2200 ? C.dim('  (内容较大, 扫码可能不完整)') : ''));
      } else {
        let dest;
        if (out) dest = path.resolve(dir ? path.join(out, 'config.' + name + '.json') : (targets.length === 1 ? out : path.join(out, 'config.' + name + '.json')));
        else dest = path.join(process.cwd(), 'config-' + name + '-' + stamp + '.json');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
        fs.chmodSync(dest, 0o600);
        console.log('  ' + dest);
      }
    }
    if (enc) console.log(C.dim('已用 .agwkey 加密导出'));
    return ok('导出完成');
  }
  if (sub === 'import') {
    const src = argv[1];
    if (!src) return usage();
    if (src === 'camera') return console.log(C.yel('摄像头扫码导入暂不支持, 请先保存二维码内容为文件'));
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) return die('文件不存在: ' + abs);
    let raw = fs.readFileSync(abs, 'utf8');
    const dec = opt('--decrypt');
    if (dec && dec !== 'none') {
      try { raw = crypt.decryptText(raw, dec); } catch (e) { return die('解密失败: ' + e.message); }
    } else if (crypt.isEncText(raw)) {
      const p = crypt.loadPass();
      if (!p) return die('源文件已加密: 用 --decrypt <口令> 或配置 .agwkey');
      try { raw = crypt.decryptText(raw, p); } catch (e) { return die('解密失败: ' + e.message); }
    }
    let c; try { c = JSON.parse(raw); } catch (e) { return die('JSON 无效: ' + e.message); }
    if (/^(true|1|on|yes)$/i.test(opt('--repair') || '')) {
      c.listen = c.listen || {};
      if (!c.listen.port) c.listen.port = 16384;
      c.channels = c.channels || [];
      c.users = c.users || [];
      c.apiKeys = c.apiKeys || [];
      console.log(C.dim('已修补缺失字段(listen/channels/users/apiKeys)'));
    }
    const base = path.basename(abs).replace(/^config\./, '').replace(/\.json$/i, '');
    const name = listInsts().includes(base) ? base + '-' + Date.now().toString(36) : (base || 'imported');
    fs.writeFileSync(cfgPathOf(name), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
    return ok('已导入为实例 ' + name + '; agw.sh restart 生效');
  }
  usage();
}
function cmdCrypt(argv) {
  const scope = argv[0], op = (argv[1] || '').toLowerCase(), pass = argv[2];
  if (!scope || !['en', 'de', 're'].includes(op)) return console.log(t(`用法:
  agw crypt <all|config|实例> en <password>        加密
  agw crypt <all|config|实例> de <password|none>   解密
  agw crypt <all|config|实例> re <new-password>    换口令重加密`));
  const sc = scope === 'config' ? 'all' : scope;
  if (op === 'en') return cmdEncrypt([sc, pass]);
  if (op === 'de') return cmdDecrypt([sc, pass === 'none' ? '' : pass]);
  return cmdRecrypt([sc, pass]);
}


/* ==================== main dispatch ==================== */
function help(sub) {
  if (sub && CMDS[sub]) { console.log('agw ' + sub + ' —'); CMDS[sub](['help']); return; }
  console.log(t(`agw — ai-gateway 统一 CLI (计划通规范)    []=可选  <>=值

实例
  agw inst list                                 列出全部实例
  agw inst <inst> [start|stop]                  启动/停止/看状态(无参数=进入实例管理 loop)
  agw inst delete <inst> [-y]                   删除实例(default 不可删)
  agw inst <inst> --status <all|requests|error|debug>
  agw inst <inst> --apikey <key> --webtoken <key> --tls <port|0=关>
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

交互 loop (空行刷新, help 看命令, exit 退出; 非 TTY 时打印一次性摘要)
  agw inst <inst>                       实例管理 loop(status/grep/dist/edit)
  agw chan <inst>                       渠道管理 loop(fetch/edit/default/lock/unlock/delete/models/scope)
  agw ctxp                              上下文上限 loop(stat/edit/delete)
  agw register [<inst>]                 用户注册 loop(name/password/reconfirm/email/other)
  agw admin [<inst>]                    管理体系 loop(login/expire/profile/logout)
  agw cloudflared                       隧道管理 loop(log/grep/kill/start/stop)

运维
  agw <start|stop|restart|status>               网关进程启停(agw.sh 同款)
  agw refresh ca                                重签 TLS 证书并重启
  agw record <on|off> [--server "user:pass@host:port"] [--max-length <n>] [实例]
  agw cloudflared <start|stop|restart|clear>
  agw notice                                    告警汇总(空key/卡到期/余额/证书)
  agw stat <all|daily|weekly|monthly> [实例]
  agw stat --refresh <分钟> [实例]       统计落盘间隔(0=关; 写 config.statsFlushMin)
  agw stat models|dist [实例]            按模型 / Token 分布(读落盘统计)

配置
  agw encrypt|decrypr|recrypt <all|实例> [口令]
  agw export <all|实例> [--QRcode <true|false>]
  agw inport <文件> [口令]
  agw config export|import ...               配置导出/导入(见 agw config)
  agw crypt <all|config|实例> <en|de|re> [口令]
  agw lang <zh>

细节: agw help <命令>    例: agw help chan`));
}
const CMDS = {
  inst: cmdInst, router: cmdRouter, chan: cmdChan, fetch: cmdFetch, ctxp: cmdCtxp,
  card: cmdCard, refresh: cmdRefresh, record: cmdRecord, cloudflared: cmdCloudflared,
  lang: cmdLang, notice: cmdNotice, stat: cmdStat, register: cmdRegister, admin: cmdAdmin,
  encrypt: cmdEncrypt, decrypr: cmdDecrypt, recrypt: cmdRecrypt,
  export: cmdExport, inport: cmdInport, config: cmdConfig, crypt: cmdCrypt,
};

/* agw restart / agw stop / agw start — 网关进程级操作(计划通未列, 保留 agw.sh 肌肉记忆) */
function cmdProc(argv) {
  const a = (argv[0] || 'status').toLowerCase();
  if (!['start', 'stop', 'restart', 'status'].includes(a)) { console.log(t('用法: agw <start|stop|restart|status>  (网关进程级; 实例启停用 agw inst <inst> [start|stop])')); return; }
  const argsh = path.join(DIR, 'agw.sh');
  try { execSync(`bash '${argsh}' ${a}`, { stdio: 'inherit' }); }
  catch (e) { die(`agw.sh ${a} 失败: ` + (e.status || e.message)); }
}
CMDS.start = cmdProc; CMDS.stop = cmdProc; CMDS.restart = cmdProc;
const cmd = process.argv[2];
if (['start', 'stop', 'restart', 'gw', 'status'].includes(cmd)) return cmdProc([cmd]);
if (!cmd || cmd === 'help' || cmd === '--help') return help(process.argv[3]);
const fn = CMDS[cmd];
if (!fn) die(`未知命令: ${cmd} (agw help)`);
try { const r = fn(process.argv.slice(3)); if (r && r.catch) r.catch(e => die(e.message)); }
catch (e) { die(e.message); }
