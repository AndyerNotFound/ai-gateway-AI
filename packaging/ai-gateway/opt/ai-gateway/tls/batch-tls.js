#!/usr/bin/env node
'use strict';
/*
 * 批量给所有实例开/关 TLS。两种形态：
 *   双开(默认)  tls.port = http + 10000，HTTP 原端口保留
 *   单端口      tls.port 留空 → 该实例只在原端口说 HTTPS（HTTP 入口消失）
 *
 * 用法:
 *   node tls/batch-tls.js --dry-run          只看方案
 *   node tls/batch-tls.js                    双开（全部实例）
 *   node tls/batch-tls.js --pure             单端口纯 HTTPS（全部实例）
 *   node tls/batch-tls.js --off              全部关闭
 *   node tls/batch-tls.js --only A,B         只处理指定实例
 *   node tls/batch-tls.js --offset 20000     双开时改端口偏移
 *   node tls/batch-tls.js --no-restart       只写配置，不重启
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const crypt = require(path.join(ROOT, 'crypt.js'));
const CA = path.join(ROOT, 'tls', 'ca.pem');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const OFFSET = Number(opt('offset', 10000));
const OFF = flag('off');
const PURE = flag('pure');
const DRY = flag('dry-run');
const ONLY = opt('only', '') ? String(opt('only', '')).split(',').map(s => s.trim()).filter(Boolean) : null;

const instName = (f) => f === 'config.json' ? 'default' : f.slice('config.'.length, -'.json'.length);
const cfgPath = (name) => path.join(ROOT, 'data', name === 'default' ? 'config.json' : `config.${name}.json`);

function readCfg(name) {
  const f = cfgPath(name);
  const raw = fs.readFileSync(f, 'utf8');
  const enc = crypt.isEncText(raw);
  const pass = enc ? crypt.loadPass() : null;
  if (enc && !pass) throw new Error('配置已加密但取不到口令');
  return { cfg: JSON.parse(enc ? crypt.decryptText(raw, pass) : raw), enc, pass, file: f };
}

function writeCfg(cfg, enc, pass, file) {
  const text = JSON.stringify(cfg, null, 2) + '\n';
  const payload = enc ? crypt.encryptText(text, pass) : text;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  const back = fs.readFileSync(tmp, 'utf8');
  if ((enc ? crypt.decryptText(back, pass) : back) !== text) { fs.unlinkSync(tmp); throw new Error('回读校验失败'); }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

function httpsHealth(port) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 6000, ca: fs.readFileSync(CA), servername: 'localhost' },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

const isPure = (t, hp) => !!(t && t.enable && (t.port == null || Number(t.port) === Number(hp)));
const isDual = (t) => !!(t && t.enable && t.port != null);

(async () => {
  const names = fs.readdirSync(path.join(ROOT, 'data')).filter(f => /^config(\..+)?\.json$/.test(f)).map(instName).sort();
  const targets = ONLY ? names.filter(n => ONLY.includes(n)) : names;

  const used = new Set();
  for (const n of names) {
    const { cfg } = readCfg(n);
    const hp = Number((cfg.listen || {}).port || 0);
    if (hp) used.add(hp);
    const t = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
    if (t.enable && t.port) used.add(Number(t.port));
  }

  const rows = [];
  for (const n of targets) {
    const { cfg } = readCfg(n);
    const hp = Number((cfg.listen || {}).port || 0);
    const t = cfg.tls || {};

    if (OFF) { rows.push({ n, hp, tp: '-', state: isPure(t, hp) || isDual(t) ? '关闭' : '本来就关' }); continue; }

    if (PURE) {
      if (isPure(t, hp)) { rows.push({ n, hp, tp: hp, state: '已是单端口(跳过)' }); continue; }
      rows.push({ n, hp, tp: hp, state: isDual(t) ? '双开→单端口' : '新开(单端口)' });
      continue;
    }

    if (isDual(t)) { rows.push({ n, hp, tp: Number(t.port), state: '已双开(跳过)' }); continue; }

    const ok = async (p) => p >= 1024 && p <= 65535 && !used.has(p) && await portFree(p);
    let cand = hp + OFFSET;
    if (!(await ok(cand))) { cand = 20000; while (cand < 65535 && !(await ok(cand))) cand++; }
    if (cand >= 65535) { rows.push({ n, hp, error: '没端口了' }); continue; }
    used.add(cand);
    rows.push({ n, hp, tp: cand, state: isPure(t, hp) ? '单端口→双开' : '新开(双开)' });
  }

  const W = Math.max(...rows.map(r => r.n.length), 8);
  console.log(`${OFF ? '关闭' : PURE ? '单端口纯 HTTPS' : '双开(HTTP+HTTPS)'} 方案${DRY ? '（dry-run，不写入）' : ''}`);
  console.log('实例'.padEnd(W) + '  端口      https    状态');
  for (const r of rows) {
    console.log(r.n.padEnd(W) + '  ' + String(r.hp).padEnd(9) + ' ' + String(r.tp || '-').padEnd(9) + ' ' + (r.error || r.state));
  }
  if (rows.some(r => r.error)) { console.error('✗ 有实例无法分配端口，未做任何修改'); process.exit(1); }
  if (DRY) return;

  let changed = 0;
  for (const r of rows) {
    if (r.state.includes('跳过')) continue;
    const { cfg, enc, pass, file } = readCfg(r.n);
    cfg.tls = OFF ? { enable: false }
      : PURE ? { enable: true, cert: 'cert.pem', key: 'key.pem' }
        : { enable: true, cert: 'cert.pem', key: 'key.pem', port: r.tp };
    writeCfg(cfg, enc, pass, file);
    changed++;
  }
  console.log(`✓ 已更新 ${changed} 个实例配置（加密配置仍保持加密）`);
  if (PURE) console.log('  ⚠ 这些实例的 HTTP 入口已消失：客户端必须改用 https://同一端口');

  if (flag('no-restart')) { console.log('  未重启，执行：agw.sh restart'); return; }

  const { execSync } = require('child_process');
  console.log('• 重启网关…');
  try { execSync(`bash ${path.join(ROOT, 'agw.sh')} restart`, { stdio: 'ignore', timeout: 120000 }); } catch (e) {}
  await new Promise(r => setTimeout(r, 5000));

  if (OFF) { console.log('✓ 已全部关闭'); return; }
  let ok = 0; const fail = [];
  for (const r of rows) {
    const code = await httpsHealth(r.tp);
    if (code === 200) ok++; else fail.push(`${r.n}:${r.tp}(${code})`);
  }
  console.log(`✓ HTTPS 自检: ${ok}/${rows.length} 通过`);
  if (fail.length) { console.log('✗ 失败: ' + fail.join(', ')); process.exitCode = 1; }
})();
