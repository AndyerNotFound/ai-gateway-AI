'use strict';
const http = require('http');
const gw = require('/workspace/ai-gateway/gateway.js');
const PORT = 18996;
const cfg = { _name: 'default', _configFile: '/workspace/ai-gateway/config.json', listen: { host: '127.0.0.1', port: PORT }, channels: [], plugins: [{ id: 'hello', enable: true }, { id: 'signin', enable: true }], cors: false };

function get(path, accept) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { Accept: accept } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, ct: r.headers['content-type'], body: d }));
    }).on('error', rej);
  });
}

gw.startServer(cfg, { port: PORT }).then(async () => {
  const html = await get('/plugins', 'text/html');
  console.log('=== Accept: text/html ===');
  console.log('HTTP', html.code, html.ct);
  const hasCard = html.body.includes('插件中心') && html.body.includes('/plugins/signin/pages/user.html') && html.body.includes('/plugins/hello/pages/user.html');
  console.log('含卡片+正确跳转链接:', hasCard ? '✅' : '❌');
  console.log('链接示例:', (html.body.match(/href="([^"]*signin[^"]*)"/) || [])[1]);

  const js = await get('/plugins', 'application/json');
  console.log('=== Accept: application/json ===');
  console.log('HTTP', js.code, js.ct, '| JSON 模式:', js.body.slice(0, 80));

  const noAccept = await get('/plugins', '*/*');
  console.log('=== Accept: */* (API客户端) ===', noAccept.ct, noAccept.body.slice(0, 60));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
