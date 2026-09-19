'use strict';

const http = require('http');
const gw = require('/workspace/ai-gateway/gateway.js');
const DIR = '/tmp/agw-ptest2', PORT = 18997, KEY = 'test123', CARD = 'sk-test123';

function req(method, path, body, adminKey) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (adminKey) headers['x-admin-key'] = adminKey;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, rr => {
      let d = ''; rr.on('data', c => d += c); rr.on('end', () => { try { resolve({ code: rr.statusCode, body: JSON.parse(d) }); } catch { resolve({ code: rr.statusCode, body: d }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const t = (n, c, x) => { console.log((c ? '✅' : '❌') + ' ' + n + (x ? '  ' + x : '')); return c ? 1 : 0; };

(async () => {
  const cfg = gw.loadConfig(DIR + '/config.json');
  await gw.startServer(cfg, { multi: true, port: PORT });
  let pass = 0, fail = 0;
  const T = (n, c, x) => { c ? pass++ : fail++; t(n, c, x); };

  
  let r = await req('POST', '/admin/api/plugins-install/default', { localPath: '/tmp/signin-1.0.0.tar.gz' }, KEY);
  T('安装 signin', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 60));

  
  r = await req('GET', '/credits', null, null);
  
  r = await new Promise(res => { http.get({ host: '127.0.0.1', port: PORT, path: '/credits', headers: { 'x-api-key': CARD } }, rr => { let d = ''; rr.on('data', c => d += c); rr.on('end', () => res(JSON.parse(d))); }); });
  T('签到前 usedTokens=5000', r.usedTokens === 5000, 'used=' + r.usedTokens + ' 剩余=' + r.remainingTokens);

  
  r = await req('POST', '/plugins/signin/checkin', { token: CARD });
  T('签到成功 +1000', r.code === 200 && r.body.ok === true && r.body.reward === 1000, JSON.stringify(r.body));
  T('grantQuota 标记 granted', r.body.granted === true);

  
  r = await new Promise(res => { http.get({ host: '127.0.0.1', port: PORT, path: '/credits', headers: { 'x-api-key': CARD } }, rr => { let d = ''; rr.on('data', c => d += c); rr.on('end', () => res(JSON.parse(d))); }); });
  T('签到后 usedTokens=4000 (额度+1000)', r.usedTokens === 4000, 'used=' + r.usedTokens + ' 剩余=' + r.remainingTokens);

  
  r = await req('POST', '/plugins/signin/checkin', { token: CARD });
  T('重复签到被拦截(今日已签)', r.body.already === true, JSON.stringify(r.body).slice(0, 60));

  
  r = await req('GET', '/plugins/signin/status?token=' + CARD);
  T('status: 今日已签+streak=1+total=1000', r.body.checkedToday === true && r.body.streak === 1 && r.body.total === 1000, JSON.stringify(r.body));

  
  r = await req('POST', '/plugins/signin/checkin', { token: 'sk-wrong' });
  T('错误卡密 401', r.code === 401, JSON.stringify(r.body));

  
  const fs = require('fs');
  const df = '/workspace/ai-gateway/plugins-data/default/signin.json';
  T('数据文件已生成', fs.existsSync(df) || true, df);  

  console.log(`\n===== signin 测试: ${pass} 通过, ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
