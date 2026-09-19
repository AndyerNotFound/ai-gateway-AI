'use strict';

const gw = require('/workspace/ai-gateway/gateway.js');

const cfg = {
  _name: 'default',
  _configFile: '/workspace/ai-gateway/config.json',
  listen: { host: '127.0.0.1', port: 18999 },
  channels: [],
  apiKeys: [],
  plugins: [{ id: 'hello', enable: true }],
  cors: false,
};

const http = require('http');
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d.slice(0, 200) }));
  }).on('error', rej);
});

gw.startServer(cfg, { port: 18999 }).then(async () => {
  const port = 18999;
  console.log('启动成功');
  console.log('--- GET /plugins/hello/ping ---');
  console.log(JSON.stringify(await get(port, '/plugins/hello/ping')));
  console.log('--- GET /plugins/hello/ping (again, 计数应+1) ---');
  console.log(JSON.stringify(await get(port, '/plugins/hello/ping')));
  console.log('--- GET /plugins (用户可见插件列表) ---');
  console.log(JSON.stringify(await get(port, '/plugins')));
  console.log('--- GET /plugins/hello/count ---');
  console.log(JSON.stringify(await get(port, '/plugins/hello/count')));
  console.log('--- GET /plugins/hello/pages/user.html (静态页) ---');
  console.log('HTTP', (await get(port, '/plugins/hello/pages/user.html')).code);
  console.log('--- GET /plugins/nonexistent/ping (未启用插件) ---');
  console.log(JSON.stringify(await get(port, '/plugins/nonexistent/ping')));
  console.log('=== 测试完成, 退出 ===');
  process.exit(0);
}).catch(e => { console.error('启动失败', e); process.exit(1); });
