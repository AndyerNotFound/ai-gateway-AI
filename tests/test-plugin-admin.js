'use strict';

const fs = require('fs');
const http = require('http');
const gw = require('/workspace/ai-gateway/gateway.js');
const DIR = '/tmp/agw-ptest';
const PORT = 18998;
const KEY = 'test123';
const SHA = 'f4296f043267d5085650e3c6806504c0cec9b901a9886c4c76296627ee2043ba';

function req(method, path, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { 'x-admin-key': KEY, 'Content-Type': 'application/json' } }, rr => {
      let d = ''; rr.on('data', c => d += c); rr.on('end', () => resolve({ code: rr.statusCode, body: raw ? d : (() => { try { return JSON.parse(d); } catch { return d; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}
const log = (name, ok, extra) => console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? '  ' + extra : ''));

(async () => {
  const cfg = gw.loadConfig(DIR + '/config.json');
  await gw.startServer(cfg, { multi: true, port: PORT });
  let pass = 0, fail = 0;
  const t = (name, cond, extra) => { cond ? pass++ : fail++; log(name, cond, extra); };

  
  let r = await req('GET', '/admin/api/plugins/default');
  t('初始插件列表为空', r.code === 200 && r.body.plugins.length === 0, JSON.stringify(r.body.plugins));

  
  let r401 = await new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: '/admin/api/plugins/default' }, rr => res({ code: rr.statusCode })); });
  t('无 adminKey 返回 401', r401.code === 401);

  
  r = await req('POST', '/admin/api/plugins-install/default', { localPath: '/tmp/hello-1.0.0.tar.gz', sha256: SHA });
  t('安装 hello 成功', r.code === 200 && r.body.ok, JSON.stringify(r.body));

  
  r = await req('GET', '/admin/api/plugins/default');
  const h = (r.body.plugins || []).find(p => p.id === 'hello');
  t('列表含 hello 且运行中', !!(h && h.running), h ? `enable=${h.enable} running=${h.running}` : 'not found');

  
  r = await req('GET', '/plugins/hello/ping');
  t('ping 返回 pong', r.code === 200 && r.body.msg === 'pong', JSON.stringify(r.body));

  
  r = await req('GET', '/plugins');
  t('/plugins 用户列表含 hello', r.code === 200 && (r.body.plugins || []).some(p => p.id === 'hello'));

  
  const badSha = '0'.repeat(64);
  r = await req('POST', '/admin/api/plugins-install/default', { localPath: '/tmp/hello-1.0.0.tar.gz', sha256: badSha });
  t('SHA256 不匹配拒装', r.code === 400 && /SHA256 不匹配/.test(r.body.error || ''), (r.body.error || '').slice(0, 40));

  
  r = await req('POST', '/admin/api/plugins-install/default', { localPath: '/tmp/hello-1.0.0.tar.gz', sha256: SHA });
  t('重复安装报错', r.code === 400 && /已存在/.test(r.body.error || ''), (r.body.error || '').slice(0, 30));

  
  r = await req('GET', '/admin/api/plugins-config/default/hello');
  t('读插件配置', r.code === 200, JSON.stringify(r.body).slice(0, 60));

  
  r = await req('POST', '/admin/api/plugins-config/default/hello', { config: { foo: 'bar' } });
  t('写插件配置', r.code === 200 && r.body.ok);

  
  r = await req('POST', '/admin/api/plugins-enable/default', { id: 'hello', enable: false });
  t('停用 hello', r.code === 200 && r.body.ok);
  r = await req('GET', '/plugins/hello/ping');
  t('停用后 ping 404', r.code === 404, JSON.stringify(r.body).slice(0, 60));

  
  r = await req('POST', '/admin/api/plugins-enable/default', { id: 'hello', enable: true });
  r = await req('GET', '/plugins/hello/ping');
  t('启用后 ping 恢复', r.code === 200 && r.body.msg === 'pong');

  
  r = await req('POST', '/admin/api/plugins-required/default', { requiredPlugins: [{ id: 'hello', name: 'Hello' }] });
  t('设置推荐插件', r.code === 200 && r.body.ok);
  r = await req('GET', '/plugins/required');
  t('GET /plugins/required 返回', r.code === 200 && (r.body.required || []).length === 1, JSON.stringify(r.body));

  
  r = await req('POST', '/admin/api/plugins-remove/default', { id: 'hello' });
  t('卸载 hello', r.code === 200 && r.body.ok);
  r = await req('GET', '/plugins/hello/ping');
  t('卸载后 ping 404', r.code === 404);

  console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
