
'use strict';




const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CN = process.argv[2] || 'localhost';
const DIR = __dirname;
const certFile = path.join(DIR, 'cert.pem');
const keyFile = path.join(DIR, 'key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  console.log('• 证书已存在, 跳过 (删除 cert.pem + key.pem 可重新生成)');
  process.exit(0);
}


function Len(n) {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 255, n & 255]);
}
function TLV(t, v) { v = Buffer.isBuffer(v) ? v : Buffer.from(v); return Buffer.concat([Buffer.from([t]), Len(v.length), v]); }
function Seq(...a) { return TLV(0x30, Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : TLV(...x)))); }
function Set(...a) { return TLV(0x31, Buffer.concat(a.map(x => Buffer.isBuffer(x) ? x : TLV(...x)))); }
function Int(n) {
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return TLV(0x02, b);
}
function Bytes(b) { return TLV(0x04, b); }
function BitStr(b) { return TLV(0x03, Buffer.concat([Buffer.from([0]), b])); }
function Null() { return Buffer.from([0x05, 0x00]); }
function OID(s) {
  const p = s.split('.').map(Number);
  const body = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i], t = [];
    t.unshift(v & 0x7f); v >>= 7;
    while (v > 0) { t.unshift(0x80 | (v & 0x7f)); v >>= 7; }
    body.push(...t);
  }
  return TLV(0x06, Buffer.from(body));
}
function UTF8(s) { return TLV(0x0c, Buffer.from(s, 'utf8')); }
function UTCTime(d) {
  const s = d.toISOString().slice(2, 17).replace(/[-:]/g, '') + 'Z';
  return TLV(0x17, Buffer.from(s, 'ascii'));
}
function Explicit(tag, content) { return TLV(0xa0 | tag, content); }
function IA5Str(s) { return TLV(0x16, Buffer.from(s, 'ascii')); }
function Octets(b) { return TLV(0x04, b); }


const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' }, 
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});


const serial = crypto.randomBytes(16);
const serialInt = serial.readBigUInt64BE(8); 

const sigAlg = Seq(OID('1.2.840.113549.1.1.11'), Null()); 
const rsaEncAlg = Seq(OID('1.2.840.113549.1.1.1'), Null()); 

const cnName = Set(Seq(OID('2.5.4.3'), UTF8(CN)));
const subject = Seq(cnName);
const issuer = subject;

const notBefore = new Date(Date.now() - 86400000);
const notAfter = new Date(Date.now() + 365 * 86400000);
const validity = Seq(UTCTime(notBefore), UTCTime(notAfter));


const sanEntries = [];
sanEntries.push(TLV(0x82, Buffer.from('127.0.0.1')));  
sanEntries.push(TLV(0x82, Buffer.from('localhost')));
if (/^[\d.]+$/.test(CN)) {
  
  const ipBytes = Buffer.from(CN.split('.').map(Number));
  sanEntries.push(TLV(0x87, ipBytes));
} else {
  sanEntries.push(TLV(0x82, Buffer.from(CN)));
}
const sanValue = Seq(...sanEntries);
const sanExt = Seq(OID('2.5.29.17'), Octets(sanValue));
const extensions = Explicit(3, Seq(sanExt));


const spki = Seq(rsaEncAlg, BitStr(publicKey));

const tbs = Seq(
  Explicit(0, Int(2)),     
  Int(serialInt),           
  sigAlg,                   
  issuer,                   
  validity,                 
  subject,                  
  spki,                     
  extensions,               
);


const signer = crypto.createSign('SHA256');
signer.update(tbs);
const signature = signer.sign(privateKey);


const certDer = Seq(tbs, sigAlg, BitStr(signature));

const certPem = '-----BEGIN CERTIFICATE-----\n' +
  certDer.toString('base64').match(/.{1,64}/g).join('\n') +
  '\n-----END CERTIFICATE-----\n';

fs.writeFileSync(certFile, certPem);
fs.writeFileSync(keyFile, privateKey);
try { fs.chmodSync(keyFile, 0o600); } catch (_) {}

console.log('✓ 证书已生成 (纯 node crypto, 零依赖):');
console.log('  ' + certFile + ' (公钥)');
console.log('  ' + keyFile + '  (私钥, 权限 600)');
console.log('  CN=' + CN + '  有效期 365 天');
console.log('');
console.log('下一步: agw.sh config <实例名> enable-tls [HTTPS端口]');
console.log('⚠ 自签证书, 客户端需跳过验证: curl -k / SDK 设 verify=false');
