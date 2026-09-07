// ai-gateway 连接错误同渠道重试 + HTML 冒充成功重试 E2E 测试 (纯 Node, 无 curl)
const http = require('http');
const gw = require('./gw-gateway.js');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? String(extra).slice(0, 300) : ''); }
}

function startUpstream(handler) {
  const s = http.createServer(handler);
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port })));
}

function openaiJson(text) {
  return JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
}

function clientReq(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message, body: '' }));
    r.write(data); r.end();
  });
}

const CHAT = (stream) => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...(stream ? { stream: true } : {}) });

(async () => {
  // U1: 前2次毁 socket(模拟 socket hang up), 第3次正常
  let u1n = 0;
  const u1 = await startUpstream((req, res) => {
    u1n++;
    req.resume();
    if (u1n <= 2) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(openaiJson('U1-重试后成功'));
  });

  // U2: 第1次返回 200 text/html, 之后正常 JSON
  let u2n = 0;
  const u2 = await startUpstream((req, res) => {
    u2n++;
    req.resume();
    req.on('end', () => {
      if (u2n === 1) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!DOCTYPE html><html><body>Just a moment...</body></html>'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(openaiJson('U2-HTML后成功'));
    });
  });

  // U3: 永远 HTML
  let u3n = 0;
  const u3 = await startUpstream((req, res) => {
    u3n++;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope</html>'); });
  });

  // U4: 永远 hang up
  let u4n = 0;
  const u4 = await startUpstream((req, res) => { u4n++; req.resume(); req.socket.destroy(); });

  // U5: 流式: 第1次 hang up, 之后正常 SSE
  let u5n = 0;
  const u5 = await startUpstream((req, res) => {
    u5n++;
    req.resume();
    req.on('end', () => {
      if (u5n === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"流式OK"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });

  const mkCfg = (channels, extra) => ({
    listen: { host: '127.0.0.1', port: 0 }, gatewayKey: '', proxies: {},
    modelSync: { enable: false }, redact: { enable: false }, record: { enable: false },
    channels, ...(extra || {}),
  });
  const ch = (name, port) => ({ name, type: 'openai', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', models: ['m'] });

  console.log('== T1: socket hang up x2 后第3次成功(同渠道重试) ==');
  const g1 = await gw.startServer(mkCfg([ch('u1', u1.port)]), { port: 0, host: '127.0.0.1' });
  const r1 = await clientReq(g1.port, CHAT());
  t('T1 status 200', r1.status === 200, r1.status + ' ' + r1.body.slice(0, 200));
  t('T1 内容正确', r1.body.includes('U1-重试后成功'), r1.body.slice(0, 200));
  t('T1 上游被打3次', u1n === 3, u1n);
  g1.server.close();

  console.log('== T2: HTML 冒充成功 → 同渠道重试后拿到 JSON ==');
  const g2 = await gw.startServer(mkCfg([ch('u2', u2.port)]), { port: 0, host: '127.0.0.1' });
  const r2 = await clientReq(g2.port, CHAT());
  t('T2 status 200', r2.status === 200, r2.status + ' ' + r2.body.slice(0, 200));
  t('T2 内容正确', r2.body.includes('U2-HTML后成功'), r2.body.slice(0, 200));
  t('T2 上游被打2次', u2n === 2, u2n);
  g2.server.close();

  console.log('== T3: 永远 HTML + 单渠道 → 最终 502, 尝试 3 次(1+2重试) ==');
  const g3 = await gw.startServer(mkCfg([ch('u3', u3.port)]), { port: 0, host: '127.0.0.1' });
  const r3 = await clientReq(g3.port, CHAT());
  t('T3 status 502', r3.status === 502, r3.status + ' ' + r3.body.slice(0, 200));
  t('T3 报错含 HTML 说明', r3.body.includes('HTML'), r3.body.slice(0, 200));
  t('T3 上游被打3次', u3n === 3, u3n);
  g3.server.close();

  console.log('== T4: A渠道永远 hang up, B渠道正常 → 轮到 A 时重试 2 次后切 B ==');
  const g4 = await gw.startServer(mkCfg([ch('u4', u4.port), ch('u1b', u1.port)]), { port: 0, host: '127.0.0.1' });
  // 轮询: 第1个请求打到 u1b(原有 rr 语义), 第2个才轮到 u4
  const r4a = await clientReq(g4.port, CHAT());
  const r4b = await clientReq(g4.port, CHAT());
  t('T4 两个请求都 200', r4a.status === 200 && r4b.status === 200, r4a.status + '/' + r4b.status);
  t('T4 u4 被打3次(1+2重试后才切)', u4n === 3, u4n);
  g4.server.close();

  console.log('== T5: connRetry=0 → hang up 立即失败(只打1次) ==');
  let u4nBefore = u4n;
  const g5 = await gw.startServer(mkCfg([ch('u4', u4.port)], { connRetry: 0 }), { port: 0, host: '127.0.0.1' });
  const r5 = await clientReq(g5.port, CHAT());
  t('T5 status 502', r5.status === 502, r5.status + ' ' + r5.body.slice(0, 200));
  t('T5 上游只被打1次', u4n - u4nBefore === 1, u4n - u4nBefore);
  g5.server.close();

  console.log('== T6: 流式请求 hang up 后重试成功 ==');
  const g6 = await gw.startServer(mkCfg([ch('u5', u5.port)]), { port: 0, host: '127.0.0.1' });
  const r6 = await clientReq(g6.port, CHAT(true));
  t('T6 status 200', r6.status === 200, r6.status + ' ' + r6.body.slice(0, 200));
  t('T6 SSE 含内容', r6.body.includes('流式OK'), r6.body.slice(0, 300));
  t('T6 SSE 含 [DONE]', r6.body.includes('[DONE]'));
  t('T6 上游被打2次', u5n === 2, u5n);
  g6.server.close();

  console.log('== T7: 正常请求不受影响(回归) ==');
  const g7 = await gw.startServer(mkCfg([ch('u2b', u2.port)]), { port: 0, host: '127.0.0.1' });
  const r7 = await clientReq(g7.port, CHAT());
  t('T7 status 200', r7.status === 200, r7.status);
  t('T7 内容正确', r7.body.includes('U2-HTML后成功'), r7.body.slice(0, 200));
  g7.server.close();

  for (const u of [u1, u2, u3, u4, u5]) u.server.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
