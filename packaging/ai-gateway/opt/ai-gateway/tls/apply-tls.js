#!/usr/bin/env node
'use strict';
/* 加解密感知的 TLS 开关。cfg-cli.js 的 loadCfg 直接 JSON.parse，
   遇到 AGWENC1 加密配置会崩，并会把配置写成明文 —— 故单独提供本脚本。
   用法:
     node tls/apply-tls.js [实例名] [HTTPS端口]   # 默认 default、HTTP端口+9
     node tls/apply-tls.js [实例名] --off         # 关闭 TLS
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const crypt = require(path.join(ROOT, 'crypt.js'));
const argv = process.argv.slice(2);
const off = argv.includes('--off');
const pos = argv.filter(a => !a.startsWith('--'));
const inst = pos[0] || 'default';
const file = path.join(ROOT, 'data', inst === 'default' ? 'config.json' : `config.${inst}.json`);

if (!fs.existsSync(file)) { console.error(`✗ 配置不存在: ${file}`); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8');
const encrypted = crypt.isEncText(raw);
const pass = crypt.loadPass();
let text = raw;
if (encrypted) {
  if (!pass) { console.error('✗ 配置已加密但取不到口令（.agwkey 或 AGW_CRYPT_PASS）'); process.exit(1); }
  text = crypt.decryptText(raw, pass);
}

let cfg;
try { cfg = JSON.parse(text); } catch (e) { console.error(`✗ 解析配置失败: ${e.message}`); process.exit(1); }

const httpPort = Number((cfg.listen && cfg.listen.port) || 16384);

if (off) {
  cfg.tls = { enable: false };
  console.log('• 已关闭 TLS（HTTP 继续服务）');
} else {
  const certFile = path.join(ROOT, 'data', 'cert.pem');
  const keyFile = path.join(ROOT, 'key.pem');
  for (const f of [certFile, keyFile]) {
    if (!fs.existsSync(f)) { console.error(`✗ 缺少 ${f}，先运行: bash tls/gen-server.sh`); process.exit(1); }
  }
  const tlsPort = pos[1] ? Number(pos[1]) : httpPort + 9;
  if (!Number.isInteger(tlsPort) || tlsPort < 1024 || tlsPort > 65535) {
    console.error('✗ HTTPS 端口无效（非 root 只能 1024-65535）'); process.exit(1);
  }
  if (tlsPort === httpPort) { console.error('✗ HTTPS 端口不能与 HTTP 相同（会让该端口变纯 HTTPS）'); process.exit(1); }
  cfg.tls = { enable: true, cert: 'cert.pem', key: 'key.pem', port: tlsPort };
  console.log(`• 已启用 TLS: HTTP ${httpPort} 保留, HTTPS ${tlsPort}`);
}

const out = JSON.stringify(cfg, null, 2) + '\n';
const payload = encrypted ? crypt.encryptText(out, pass) : out;
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, payload, { mode: 0o600 });

const back = fs.readFileSync(tmp, 'utf8');
const check = encrypted ? crypt.decryptText(back, pass) : back;
if (check !== out) { fs.unlinkSync(tmp); throw new Error('回读校验失败，已中止写入'); }

fs.renameSync(tmp, file);
fs.chmodSync(file, 0o600);
console.log(`✓ 已写回 ${path.basename(file)}（${encrypted ? '保持加密' : '明文'}）`);
console.log(`  重启生效: ~/ai-gateway/agw.sh restart`);
