/* 思考链精简(thinkingSummary)功能测试
 * A. truncateReasoning 纯函数
 * B. wrapThinkingSummary truncate 流式(mock writer)
 * C. summarizeReasoningText 降级(无模型→截断)
 * D. 端到端 truncate(mock上游→gateway→验证reasoning被截断)
 * E. 端到端 summarize(mock主上游+mock总结上游→gateway→验证reasoning是总结版)
 */
const gw = require('../gateway.js');
const http = require('http');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; } catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + ' → ' + e.message); fail++; } }
async function okAsync(name, fn) { try { await fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; } catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + ' → ' + e.message); fail++; } }

function mockWriter() { const ev = []; return { events: ev, onEvent(e) { ev.push(e); } }; }

// 读流式 SSE 响应, 收集 reasoning_content 与 content
function readStream(body) {
  let reasoning = '', content = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = line.slice(6);
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta) { if (delta.reasoning_content) reasoning += delta.reasoning_content; if (delta.content) content += delta.content; }
    } catch (e) {}
  }
  return { reasoning, content };
}

function postStream(port, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

async function main() {
  console.log('\n=== A. truncateReasoning 纯函数 ===');
  ok('空文本返回空', () => assert.strictEqual(gw.truncateReasoning('', 80), ''));
  ok('短行原样保留', () => assert.strictEqual(gw.truncateReasoning('第一段\n第二段', 80), '第一段\n第二段'));
  ok('空行跳过', () => assert.strictEqual(gw.truncateReasoning('行1\n\n\n行2', 80), '行1\n行2'));
  ok('长行按步长切多块', () => {
    const r = gw.truncateReasoning('A'.repeat(500), 80);
    const parts = r.split('\n');
    assert.ok(parts.length >= 3, '应切>=3块, got ' + parts.length);
    assert.ok(parts[0].endsWith('…'), '非末块应有省略号');
  });
  ok('每块长度<=maxChars+1(省略号)', () => {
    const r = gw.truncateReasoning('B'.repeat(300), 50);
    for (const p of r.split('\n')) assert.ok(p.length <= 51, '块长' + p.length + '>51');
  });

  console.log('\n=== B. wrapThinkingSummary truncate 流式 ===');
  ok('未开启返回原 writer', () => {
    const w = mockWriter();
    assert.strictEqual(gw.wrapThinkingSummary(w, { enable: false }, {}, {}), w);
  });
  ok('truncate 实时截断 + text 透传 + 段间双换行', () => {
    const w = mockWriter();
    const wrap = gw.wrapThinkingSummary(w, { enable: true, mode: 'truncate', maxCharsPerSegment: 5 }, {}, {});
    // 真实思考链按行分段(带换行)
    wrap.onEvent({ type: 'reasoning', t: '第一段思考\n' });
    wrap.onEvent({ type: 'reasoning', t: '第二段思考\n' });
    wrap.onEvent({ type: 'reasoning', t: '第三段尾巴' });
    wrap.onEvent({ type: 'text', t: '最终回答' });
    wrap.onEvent({ type: 'end', finish_reason: 'stop' });
    const re = w.events.filter(e => e.type === 'reasoning').map(e => e.t).join('');
    const te = w.events.filter(e => e.type === 'text').map(e => e.t).join('');
    assert.ok(re.includes('第一段思考'), '含第一段');
    assert.ok(re.includes('第二段思考'), '含第二段');
    assert.strictEqual(te, '最终回答', 'text 完整透传');
    assert.ok(w.events.some(e => e.type === 'end'), 'end 透传');
    assert.ok(re.includes('\n\n'), '段间应有双换行分隔, got: ' + JSON.stringify(re));
  });
  ok('无 reasoning 时全部透传', () => {
    const w = mockWriter();
    const wrap = gw.wrapThinkingSummary(w, { enable: true, mode: 'truncate', maxCharsPerSegment: 5 }, {}, {});
    wrap.onEvent({ type: 'text', t: '直接回答' });
    wrap.onEvent({ type: 'end', finish_reason: 'stop' });
    assert.strictEqual(w.events.length, 2);
    assert.strictEqual(w.events[0].type, 'text');
  });

  console.log('\n=== C. summarizeReasoningText 降级路径 ===');
  await okAsync('无可用模型时降级为截断', async () => {
    const ch = { name: 'test', type: 'openai', models: [], baseUrl: 'http://127.0.0.1:1' };
    const r = await gw.summarizeReasoningText('一段思考'.repeat(50), { enable: true, mode: 'summarize', summarizeBaseUrl: '', summarizeApiKey: '', summarizeModel: '', summarizePrompt: '总结:', maxSegments: 5, maxCharsPerSegment: 20 }, ch, { channels: [] });
    assert.ok(r && r.length > 0, '应返回截断结果');
    assert.ok(r.length < '一段思考'.repeat(50).length, '应比原文短');
  });
  await okAsync('空 reasoning 返回空', async () => {
    const r = await gw.summarizeReasoningText('', { enable: true, mode: 'summarize' }, {}, {});
    assert.strictEqual(r, '');
  });

  console.log('\n=== D. 端到端 truncate(mock上游→gateway) ===');
  await okAsync('truncate 集成: reasoning 被精简 + content 完整', async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { reasoning_content: '一二三四五六七八九十'.repeat(5) } }] });
      send({ choices: [{ delta: { reasoning_content: '另一段也很长很长很长'.repeat(3) } }] });
      send({ choices: [{ delta: { content: '最终答案' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n'); res.end();
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upP = upstream.address().port;
    const cfg = { listen: { host: '127.0.0.1', port: 0 }, channels: [{ name: 'm', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true }], thinkingSummary: { enable: true, mode: 'truncate', maxCharsPerSegment: 10 }, modelSync: { enable: false } };
    const inst = await gw.startServer(cfg, { port: 0 });
    try {
      const resp = await postStream(inst.port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(resp.status, 200);
      const { reasoning, content } = readStream(resp.body);
      assert.ok(reasoning.length > 0, '应有 reasoning');
      assert.ok(reasoning.includes('…'), 'reasoning 应含省略号, got: ' + reasoning.slice(0, 40));
      assert.ok(reasoning.length < 100, 'reasoning 应被精简(原100+), got ' + reasoning.length);
      assert.strictEqual(content, '最终答案', 'content 完整');
    } finally { inst.server.close(); upstream.close(); }
  });

  console.log('\n=== E. 端到端 summarize(mock主上游+mock总结上游→gateway) ===');
  await okAsync('summarize 集成: reasoning 被总结 + content 完整', async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { reasoning_content: '需要总结的第一段思考内容,描述了问题的背景和分析过程,内容比较冗长需要精简' } }] });
      send({ choices: [{ delta: { reasoning_content: '第二段思考,探讨了可能的解决方案和权衡,同样很长需要精简处理' } }] });
      send({ choices: [{ delta: { content: '这是最终答案' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n'); res.end();
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upP = upstream.address().port;
    let summerCalls = 0;
    const summer = http.createServer((req, res) => {
      summerCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '第' + summerCalls + '段总结要点' } }] }));
    });
    await new Promise(r => summer.listen(0, '127.0.0.1', r));
    const sumP = summer.address().port;
    const cfg = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'main', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true },
      ],
      thinkingSummary: { enable: true, mode: 'summarize', summarizeBaseUrl: 'http://127.0.0.1:' + sumP, summarizeApiKey: 'k', summarizeModel: 's', summarizePrompt: '总结:', maxSegments: 5, maxCharsPerSegment: 80 },
      modelSync: { enable: false },
    };
    const inst = await gw.startServer(cfg, { port: 0 });
    try {
      const resp = await postStream(inst.port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(resp.status, 200, 'status ' + resp.status);
      const { reasoning, content } = readStream(resp.body);
      assert.ok(reasoning.includes('总结'), 'reasoning 应含总结结果, got: ' + reasoning.slice(0, 60));
      assert.ok(summerCalls >= 1, 'summer 应被调用, got ' + summerCalls);
      assert.strictEqual(content, '这是最终答案', 'content 完整');
    } finally { inst.server.close(); upstream.close(); summer.close(); }
  });

  console.log('\n=== F. summarize 顺序保证: reasoning 全部在正文前 ===');
  await okAsync('正文等在飞总结完成后发出, 顺序不乱', async () => {
    // summer 故意慢 1.5s, 验证: 迟到的总结不会排到正文后面(用户报告的"思考里有正文"根因)
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      // 一段足够长的思考(>200字触发分段总结)
      send({ choices: [{ delta: { reasoning_content: 'A'.repeat(250) } }] });
      // 紧接着正文(此时第一段总结还在进行中)
      send({ choices: [{ delta: { content: '正文立刻就来' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n'); res.end();
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upP = upstream.address().port;
    const summer = http.createServer((req, res) => {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '总结回来了' } }] })); }, 1500);
    });
    await new Promise(r => summer.listen(0, '127.0.0.1', r));
    const sumP = summer.address().port;
    const cfg = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [{ name: 'main', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true }],
      thinkingSummary: { enable: true, mode: 'summarize', summarizeBaseUrl: 'http://127.0.0.1:' + sumP, summarizeApiKey: 'k', summarizeModel: 's', summarizePrompt: '总结:', maxSegments: 5, maxCharsPerSegment: 80 },
      modelSync: { enable: false },
    };
    const inst = await gw.startServer(cfg, { port: 0 });
    try {
      const t0 = Date.now();
      const resp = await postStream(inst.port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const dt = Date.now() - t0;
      const { reasoning, content } = readStream(resp.body);
      assert.strictEqual(content, '正文立刻就来', '正文完整');
      assert.strictEqual(resp.status, 200);
      assert.ok(reasoning.includes('总结回来了'), '总结结果应已 flush (end 等待 pending)');
      // ★核心断言: SSE 流里总结(reasoning)必须出现在正文(content)之前
      const iReason = resp.body.indexOf('总结回来了');
      const iContent = resp.body.indexOf('正文立刻就来');
      assert.ok(iReason !== -1 && iContent !== -1, '两段内容都应在流里');
      assert.ok(iReason < iContent, '总结必须在正文前! reason@' + iReason + ' content@' + iContent);
      console.log('    (响应耗时 ' + dt + 'ms, 含等总结 1.5s)');
    } finally { inst.server.close(); upstream.close(); summer.close(); }
  });

  console.log('\n=== G. summarize 防护: text 打断后后续 reasoning 不进总结 ===');
  await okAsync('text 后的 reasoning 当正文透传, 不被总结', async () => {
    // summer 记录收到的内容, 验证"正文内容"没被发去总结
    let summerGot = [];
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { reasoning_content: '这是一段很长的思考内容需要被总结掉'.repeat(10) } }] }); // >200字触发总结
      send({ choices: [{ delta: { content: '这是真正的正文' } }] }); // text 打断思考
      // 之后又来 reasoning(异常模型/或思考尾巴) — 不应进总结
      send({ choices: [{ delta: { reasoning_content: '这段不该被总结, 应当正文透传' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n'); res.end();
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upP = upstream.address().port;
    const summer = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => { summerGot.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '总结段' } }] })); });
    });
    await new Promise(r => summer.listen(0, '127.0.0.1', r));
    const sumP = summer.address().port;
    const cfg = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [{ name: 'main', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true }],
      thinkingSummary: { enable: true, mode: 'summarize', summarizeBaseUrl: 'http://127.0.0.1:' + sumP, summarizeApiKey: 'k', summarizeModel: 's', summarizePrompt: '总结:', maxSegments: 5, maxCharsPerSegment: 80 },
      modelSync: { enable: false },
    };
    const inst = await gw.startServer(cfg, { port: 0 });
    try {
      const resp = await postStream(inst.port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(resp.status, 200);
      const { reasoning, content } = readStream(resp.body);
      // 正文应完整透传
      assert.ok(content.includes('这是真正的正文'), '正文应透传: ' + content);
      // text 后的 reasoning "这段不该被总结" 应出现在输出里(当正文透传), 不在总结里
      assert.ok(resp.body.includes('这段不该被总结') || reasoning.includes('这段不该被总结'), '后续 reasoning 应透传');
      // summer 收到的内容里不应包含 "这段不该被总结"
      const allSummer = summerGot.join('');
      assert.ok(!allSummer.includes('这段不该被总结'), '正文段不应被发去总结! summer got: ' + allSummer.slice(0, 80));
    } finally { inst.server.close(); upstream.close(); summer.close(); }
  });

  console.log('\n=== H. summarize 失败回退截断: 不吞思考 ===');
  await okAsync('总结模型返回空/失败时回退截断, 思考不丢', async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { reasoning_content: 'A'.repeat(250) } }] }); // >200 触发总结
      send({ choices: [{ delta: { content: '正文' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n'); res.end();
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upP = upstream.address().port;
    // summer 故意返回空 content(模拟总结模型失败)
    const summer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); });
    await new Promise(r => summer.listen(0, '127.0.0.1', r));
    const sumP = summer.address().port;
    const cfg = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [{ name: 'main', type: 'openai', baseUrl: 'http://127.0.0.1:' + upP, apiKey: 'k', models: ['m'], default: true }],
      thinkingSummary: { enable: true, mode: 'summarize', summarizeBaseUrl: 'http://127.0.0.1:' + sumP, summarizeApiKey: 'k', summarizeModel: 's', summarizePrompt: '总结:', maxSegments: 5, maxCharsPerSegment: 30 },
      modelSync: { enable: false },
    };
    const inst = await gw.startServer(cfg, { port: 0 });
    try {
      const resp = await postStream(inst.port, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(resp.status, 200);
      const { reasoning, content } = readStream(resp.body);
      assert.strictEqual(content, '正文', '正文完整');
      // 总结模型返回空 → 应回退截断, reasoning 不为空(不吞思考)
      assert.ok(reasoning.length > 0, '总结失败应回退截断, 不应吞掉思考! got reasoning 为空');
      assert.ok(reasoning.includes('A') || reasoning.includes('•'), '回退截断应含原文片段, got: ' + reasoning.slice(0, 40));
    } finally { inst.server.close(); upstream.close(); summer.close(); }
  });

  console.log('\n=============================');
  console.log(`结果: \x1b[32m${pass} pass\x1b[0m, \x1b[31m${fail} fail\x1b[0m`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
