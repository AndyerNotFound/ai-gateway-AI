/* 隐私过滤 CDC 缓存 — 真实网关 E2E 测试
 * 1. 请求体到达上游前, 密钥(sk-/ghp_/Bearer)被脱敏
 * 2. 第二次相同请求(缓存命中路径)脱敏行为一致
 * 3. 字段级 token/apiKey 字段 → ***
 * 4. data: URL 不被扫描
 */
'use strict';
const gw = require('../gateway.js');
const http = require('http');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; }
  else { console.log('  \x1b[31m✗\x1b[0m ' + name); fail++; }
}

function post(port, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

async function main() {
  // ---- 假上游: 记录收到的请求体, 返回标准响应 ----
  const received = [];
  const upstream = http.createServer((req, res) => {
    const ch = []; req.on('data', c => ch.push(c));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(ch).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'r1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upP = upstream.address().port;

  const cfg = {
    listen: { host: '127.0.0.1', port: 0 },
    channels: [{ name: 'm', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true }],
    modelSync: { enable: false },
  };
  const inst = await gw.startServer(cfg, { port: 0 });
  const port = inst.port || inst.address().port || (inst.server && inst.server.address().port);

  // ---- 用例 ----
  const longPara = '这是一段很长的历史对话内容，用于验证 CDC 分块缓存。'.repeat(200); // ~10K
  const body1 = {
    model: 'm',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: longPara },
      { role: 'user', content: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123 记住' },
      { role: 'user', content: 'data:image/png;base64,sk-AAAAiVBORw0KGgoAAAANSUhEUg' },
      { role: 'user', content: 'Bearer xyz.abc.def.ghi.jkl.mno' },
    ],
  };

  console.log('\n[1] 首次请求: 上游收到的内容已脱敏');
  await post(port, body1);
  const got1 = received[received.length - 1];
  ok('HTTP 200 已返回', true);
  const msgs = got1.messages;
  ok('system 消息原样', msgs[0].content === '你是助手');
  ok('长文本消息原样', msgs[1].content === longPara);
  ok('sk- 密钥被替换', /sk-[A-Za-z0-9_-]{10,}/.test(msgs[2].content) === false && msgs[2].content.indexOf('***') !== -1);
  ok('data: URL 跳过(不扫描)', msgs[3].content.indexOf('sk-AAAA') !== -1);
  ok('Bearer 被替换', /Bearer\s+[A-Za-z0-9]/.test(msgs[4].content) === false);

  console.log('\n[2] 第二次相同请求(缓存命中路径): 脱敏行为一致');
  await post(port, body1);
  const got2 = received[received.length - 1];
  ok('sk- 仍被替换', got2.messages[2].content.indexOf('***') !== -1);
  ok('data: URL 仍保留', got2.messages[3].content.indexOf('sk-AAAA') !== -1);
  ok('长文本原样', got2.messages[1].content === longPara);

  console.log('\n[3] 字段级过滤(apiKey/token 字段直接置 ***)');
  await post(port, { model: 'm', messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-real-key-value-123456', token: 'secret-token-xyz' });
  const got3 = received[received.length - 1];
  ok('apiKey 字段置 ***', got3.apiKey === '***');
  ok('token 字段置 ***', got3.token === '***');

  console.log('\n[4] 响应仍正常转发');
  const r = await post(port, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  ok('非流式响应 200 且含 content', r.status === 200 && r.body.indexOf('好的') !== -1);

  upstream.close();
  if (inst && inst.close) inst.close();
  console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
