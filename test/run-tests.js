'use strict';
/* ai-gateway 测试: 单元(转换器) + E2E(9组合互转) + 代理隧道 + 鉴权 + 路由 + 多实例 */
const http = require('http');
const G = require('../gateway.js');
const M = require('./mocks.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }
function safeJ(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function fakeRes() {
  const out = [];
  const r = { out, ended: false, write: s => out.push(s), end: () => { r.ended = true; }, headersSent: false };
  return r;
}
async function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}
async function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    req.end();
  });
}
function sseDataChunks(raw) {
  return raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
}
function parseOpenAIStream(raw) {
  let content = '', finish = null, usage = null;
  const toolArgs = {};
  for (const l of sseDataChunks(raw)) {
    if (l === '[DONE]') continue;
    const j = JSON.parse(l);
    if (j.usage) usage = j.usage;
    const c = j.choices && j.choices[0];
    if (!c) continue;
    if (c.delta && typeof c.delta.content === 'string') content += c.delta.content;
    if (c.delta && Array.isArray(c.delta.tool_calls)) {
      for (const tc of c.delta.tool_calls) {
        toolArgs[tc.index] = toolArgs[tc.index] || { name: '', args: '' };
        if (tc.function && tc.function.name) toolArgs[tc.index].name = tc.function.name;
        if (tc.function && tc.function.arguments) toolArgs[tc.index].args += tc.function.arguments;
      }
    }
    if (c.finish_reason) finish = c.finish_reason;
  }
  return { content, finish, usage, toolArgs };
}
function parseClaudeStream(raw) {
  let text = '', started = false, stopped = false, stopReason = null, inTok = 0, outTok = 0;
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) cur = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      const j = JSON.parse(line.slice(6));
      if (cur === 'message_start') { started = true; inTok = j.message.usage.input_tokens; }
      if (cur === 'content_block_delta' && j.delta.type === 'text_delta') text += j.delta.text;
      if (cur === 'message_delta') { stopped = true; stopReason = j.delta.stop_reason; outTok = j.usage.output_tokens; }
    }
  }
  return { text, started, stopped, stopReason, inTok, outTok };
}
function parseGeminiSSE(raw) {
  let text = '', finish = null;
  for (const l of sseDataChunks(raw)) {
    const j = JSON.parse(l);
    for (const p of (j.candidates[0].content.parts || [])) if (typeof p.text === 'string' && !p.thought) text += p.text;
    if (j.candidates[0].finishReason) finish = j.candidates[0].finishReason;
  }
  return { text, finish };
}
function respText(client, raw) {
  const j = JSON.parse(raw);
  if (client === 'openai') return j.choices[0].message.content;
  if (client === 'claude') return j.content[0].text;
  return j.candidates[0].content.parts[0].text;
}

async function main() {
  /* ============ Part 1: 单元测试 — 转换器 ============ */
  console.log('── Part 1: 转换器单元测试 ──');
  {
    // canonical → Claude body
    const c = {
      model: 'claude-3', stream: false,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
      ],
      max_tokens: 100,
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
    };
    const b = G.canonicalToClaudeBody(c);
    eq(b.system, 'sys', 'claude body: system 提取');
    eq(b.messages.length, 3, 'claude body: 3 条消息(system 跳过)');
    eq(b.messages[0].content[0].text, 'hi', 'claude body: user 文本');
    eq(b.messages[1].content[0].type, 'tool_use', 'claude body: tool_use block');
    eq(b.messages[1].content[0].name, 'get_weather', 'claude body: tool name');
    eq(b.messages[1].content[0].input.city, 'SF', 'claude body: tool args 解析');
    eq(b.messages[2].content[0].type, 'tool_result', 'claude body: tool_result block');
    eq(b.messages[2].content[0].tool_use_id, 'call_1', 'claude body: tool_result id');
    eq(b.tools[0].name, 'get_weather', 'claude body: tools 映射');
    eq(b.tools[0].input_schema.type, 'object', 'claude body: input_schema');
    eq(b.max_tokens, 100, 'claude body: max_tokens');

    // canonical → Gemini body
    const gb = G.canonicalToGeminiBody(c);
    eq(gb.systemInstruction.parts[0].text, 'sys', 'gemini body: systemInstruction');
    eq(gb.contents.length, 3, 'gemini body: 3 contents');
    eq(gb.contents[0].role, 'user', 'gemini body: user role');
    eq(gb.contents[1].parts[0].functionCall.name, 'get_weather', 'gemini body: functionCall');
    eq(gb.contents[1].parts[0].functionCall.args.city, 'SF', 'gemini body: functionCall args');
    eq(gb.contents[2].parts[0].functionResponse.name, 'get_weather', 'gemini body: functionResponse name(id回查)');
    eq(gb.contents[2].parts[0].functionResponse.response.temp, 20, 'gemini body: functionResponse 内容');
    eq(gb.tools[0].functionDeclarations[0].name, 'get_weather', 'gemini body: functionDeclarations');
    eq(gb.generationConfig.maxOutputTokens, 100, 'gemini body: maxOutputTokens');

    // Claude 入 → canonical
    const claudeBody = {
      model: 'x', max_tokens: 50, system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'res' }] },
      ],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
    };
    const can = G.claudeToCanonical(claudeBody);
    eq(can.messages.length, 4, 'claude入: system+user+assistant+tool');
    eq(can.messages[0].content, 'sys', 'claude入: system 转 message');
    eq(can.messages[2].tool_calls[0].function.name, 'f', 'claude入: tool_use → tool_calls');
    eq(JSON.parse(can.messages[2].tool_calls[0].function.arguments).a, 1, 'claude入: tool input 序列化');
    eq(can.messages[3].role, 'tool', 'claude入: tool_result → tool 消息');
    eq(can.messages[3].tool_call_id, 'tu_1', 'claude入: tool_call_id');
    eq(can.tools[0].function.name, 'f', 'claude入: tools → OpenAI 形');
    eq(can.max_tokens, 50, 'claude入: max_tokens');

    // Claude 入含图片(base64)
    const canImg = G.claudeToCanonical({
      model: 'x', max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: '这是什么' }] }],
    });
    eq(canImg.messages[0].content[0].type, 'image_url', 'claude入: base64图 → image_url');
    ok(canImg.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,AAA'), 'claude入: data URI 正确');

    // Gemini 入 → canonical
    const gmBody = {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 77 },
    };
    const can2 = G.geminiToCanonical(gmBody);
    eq(can2.messages[0].content, 'sys', 'gemini入: systemInstruction → system');
    eq(can2.messages[1].content[0].text, 'hi', 'gemini入: user text');
    eq(can2.messages[2].role, 'assistant', 'gemini入: model → assistant');
    eq(can2.messages[2].tool_calls[0].function.name, 'f', 'gemini入: functionCall → tool_calls');
    eq(can2.messages[3].role, 'tool', 'gemini入: functionResponse → tool');
    eq(can2.messages[3].name, 'f', 'gemini入: tool 消息带 name');
    eq(can2.tools[0].function.name, 'f', 'gemini入: functionDeclarations → tools');
    eq(can2.max_tokens, 77, 'gemini入: maxOutputTokens');

    // 响应: claude resp → canonical → openai/gemini resp
    const cr = G.claudeRespToCanonical({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } });
    eq(cr.text, 'hello', 'claude resp: text');
    eq(cr.usage.input, 3, 'claude resp: input_tokens');
    eq(cr.finish_reason, 'stop', 'claude resp: finish map');
    const oa = G.canonicalToOpenAIResp(cr, 'm');
    eq(oa.choices[0].message.content, 'hello', 'openai resp: content');
    eq(oa.usage.prompt_tokens, 3, 'openai resp: usage 映射');
    const gr = G.canonicalToGeminiResp(cr, 'm');
    eq(gr.candidates[0].content.parts[0].text, 'hello', 'gemini resp: parts text');
    eq(gr.usageMetadata.promptTokenCount, 3, 'gemini resp: usage 映射');

    // 响应: gemini resp → canonical (含 tool)
    const gResp = {
      candidates: [{ content: { parts: [{ functionCall: { name: 'fn1', args: { x: 2 } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    };
    const can3 = G.geminiRespToCanonical(gResp);
    eq(can3.finish_reason, 'tool_calls', 'gemini resp: tool → finish_reason');
    eq(can3.tool_calls[0].function.name, 'fn1', 'gemini resp: functionCall → tool_calls');
    const oa2 = G.canonicalToOpenAIResp(can3, 'm');
    eq(oa2.choices[0].finish_reason, 'tool_calls', 'openai resp: tool_calls finish');
    eq(JSON.parse(oa2.choices[0].message.tool_calls[0].function.arguments).x, 2, 'openai resp: tool arguments');
    const cl2 = G.canonicalToClaudeResp(can3, 'm');
    eq(cl2.stop_reason, 'tool_use', 'claude resp: tool_use stop_reason');
    eq(cl2.content[0].type, 'tool_use', 'claude resp: tool_use block');

    // 流式: openai 上游 chunks → 事件
    const evs = [];
    const p = new G.UpstreamStreamParser('openai', e => evs.push(e));
    p.handle({ choices: [{ delta: { role: 'assistant', content: '' } }] });
    p.handle({ choices: [{ delta: { content: 'A' } }] });
    p.handle({ choices: [{ delta: { content: 'B' } }] });
    p.handle({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    p.handle({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
    p.finish();
    eq(evs.filter(e => e.type === 'text').map(e => e.t).join(''), 'AB', 'openai流: text 事件拼接');
    eq(evs[evs.length - 1].type, 'end', 'openai流: end 事件');
    eq(evs[evs.length - 1].usage.input, 5, 'openai流: usage');
    eq(evs[evs.length - 1].finish_reason, 'stop', 'openai流: finish_reason');

    // 流式: claude 上游事件 → 事件
    const evs2 = [];
    const p2 = new G.UpstreamStreamParser('claude', e => evs2.push(e));
    p2.handle({ type: 'message_start', message: { usage: { input_tokens: 8 } } });
    p2.handle({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'xy' } });
    p2.handle({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    p2.handle({ type: 'message_stop' });
    p2.finish();
    const end2 = evs2[evs2.length - 1];
    eq(end2.usage.input, 8, 'claude流: input usage');
    eq(end2.usage.output, 3, 'claude流: output usage');
    eq(end2.finish_reason, 'stop', 'claude流: finish');

    // 流式: claude 上游工具调用 → openai writer
    const res4 = fakeRes();
    const w4 = G.makeWriter('openai', res4, 'm');
    const p4 = new G.UpstreamStreamParser('claude', e => w4.onEvent(e));
    p4.handle({ type: 'message_start', message: { usage: { input_tokens: 5 } } });
    p4.handle({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu9', name: 'lookup' } });
    p4.handle({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } });
    p4.handle({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"x"}' } });
    p4.handle({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
    p4.handle({ type: 'message_stop' });
    p4.finish();
    const s4raw = res4.out.join('');
    const s4 = parseOpenAIStream(s4raw);
    eq(s4.toolArgs['0'].name, 'lookup', 'claude上游→openai流: tool name');
    eq(s4.toolArgs['0'].args, '{"q":"x"}', 'claude上游→openai流: tool args 增量拼接');
    eq(s4.finish, 'tool_calls', 'claude上游→openai流: finish_reason');

    // writer: claude 出口
    const res1 = fakeRes();
    const w1 = G.makeWriter('claude', res1, 'm');
    w1.onEvent({ type: 'text', t: 'he' });
    w1.onEvent({ type: 'text', t: 'llo' });
    w1.onEvent({ type: 'end', finish_reason: 'stop', usage: { input: 4, output: 2 } });
    const s1 = res1.out.join('');
    ok(s1.startsWith('event: message_start'), 'claude writer: message_start 开头');
    ok(s1.includes('"type":"text_delta","text":"he"'), 'claude writer: text_delta');
    ok(s1.includes('event: message_stop'), 'claude writer: message_stop');

    // writer: openai 出口
    const res2 = fakeRes();
    const w2 = G.makeWriter('openai', res2, 'm');
    w2.onEvent({ type: 'text', t: 'a' });
    w2.onEvent({ type: 'end', finish_reason: 'stop', usage: { input: 1, output: 1 } });
    const s2 = res2.out.join('');
    ok(s2.includes('"content":"a"'), 'openai writer: content chunk');
    ok(s2.trimEnd().endsWith('data: [DONE]') && res2.ended, 'openai writer: [DONE] 结束');

    // writer: gemini 数组流出口
    const res3 = fakeRes();
    const w3 = G.makeWriter('gemini', res3, 'm', { geminiArray: true });
    w3.onEvent({ type: 'text', t: 'z' });
    w3.onEvent({ type: 'end', finish_reason: 'stop', usage: { input: 1, output: 1 } });
    const s3 = res3.out.join('');
    ok(s3.startsWith('['), 'gemini数组流: [ 开头');
    ok(s3.endsWith(']'), 'gemini数组流: ] 结尾');
    const arr = JSON.parse(s3);
    eq(arr[0].candidates[0].content.parts[0].text, 'z', 'gemini数组流: 可解析');

    // writer: gemini 工具调用(SSE)
    const res5 = fakeRes();
    const w5 = G.makeWriter('gemini', res5, 'm');
    w5.onEvent({ type: 'tool_start', i: 0, id: 'c1', name: 'search' });
    w5.onEvent({ type: 'tool_delta', i: 0, s: '{"k":' });
    w5.onEvent({ type: 'tool_delta', i: 0, s: '1}' });
    w5.onEvent({ type: 'end', finish_reason: 'tool_calls', usage: { input: 2, output: 2 } });
    const s5chunks = sseDataChunks(res5.out.join(''));
    const callChunk = s5chunks.map(s => safeJ(s)).find(j => j && j.candidates && JSON.stringify(j.candidates).includes('functionCall'));
    ok(callChunk && callChunk.candidates[0].content.parts[0].functionCall.name === 'search', 'gemini writer: functionCall 输出');
    ok(callChunk && callChunk.candidates[0].content.parts[0].functionCall.args.k === 1, 'gemini writer: functionCall args 增量拼接');
  }

  /* ============ Part 2: E2E — 9 组合互转 ============ */
  console.log('── Part 2: E2E 9组合互转(非流式+流式) ──');
  const openaiMock = await M.makeOpenAIMock();
  const claudeMock = await M.makeClaudeMock();
  const geminiMock = await M.makeGeminiMock();
  const gwCfg = {
    listen: { host: '127.0.0.1', port: 0 },
    channels: [
      { name: 'up-openai', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk-test', models: ['m-openai'] },
      { name: 'up-claude', type: 'claude', baseUrl: `http://127.0.0.1:${claudeMock.port}`, apiKey: 'ak-test', models: ['m-claude'] },
      { name: 'up-gemini', type: 'gemini', baseUrl: `http://127.0.0.1:${geminiMock.port}`, apiKey: 'gm-test', models: ['m-gemini'] },
    ],
  };
  const gw = await G.startServer(gwCfg, { port: 0 });
  eq(gwCfg.channels.length, 3, 'E2E: 3 渠道加载');

  const cases = [
    { client: 'openai', model: 'm-openai', mock: openaiMock, mt: 'openai' },
    { client: 'openai', model: 'm-claude', mock: claudeMock, mt: 'claude' },
    { client: 'openai', model: 'm-gemini', mock: geminiMock, mt: 'gemini' },
    { client: 'claude', model: 'm-openai', mock: openaiMock, mt: 'openai' },
    { client: 'claude', model: 'm-claude', mock: claudeMock, mt: 'claude' },
    { client: 'claude', model: 'm-gemini', mock: geminiMock, mt: 'gemini' },
    { client: 'gemini', model: 'm-openai', mock: openaiMock, mt: 'openai' },
    { client: 'gemini', model: 'm-claude', mock: claudeMock, mt: 'claude' },
    { client: 'gemini', model: 'm-gemini', mock: geminiMock, mt: 'gemini' },
  ];
  const reqBody = (client, model, stream) => {
    if (client === 'openai') return { model, stream, messages: [{ role: 'system', content: 'S1' }, { role: 'user', content: 'U1' }], temperature: 0.5, max_tokens: 100 };
    if (client === 'claude') return { model, stream, system: 'S1', messages: [{ role: 'user', content: 'U1' }], temperature: 0.5, max_tokens: 100 };
    return { systemInstruction: { parts: [{ text: 'S1' }] }, contents: [{ role: 'user', parts: [{ text: 'U1' }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 100 } };
  };
  const reqPath = (client, model, stream, altSse) => {
    if (client === 'openai') return '/v1/chat/completions';
    if (client === 'claude') return '/v1/messages';
    return `/v1beta/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}` + (stream && altSse ? '?alt=sse' : '');
  };

  for (const cs of cases) {
    // 非流式
    const r = await post(gw.port, reqPath(cs.client, cs.model, false), reqBody(cs.client, cs.model, false));
    eq(r.status, 200, `E2E ${cs.client}>${cs.mt} 非流式: status`);
    eq(respText(cs.client, r.raw), '你好，世界', `E2E ${cs.client}>${cs.mt} 非流式: 文本`);
    const lr = cs.mock.state.lastReq;
    // 上游鉴权头
    if (cs.mt === 'openai') eq(lr.headers.authorization, 'Bearer sk-test', `E2E ${cs.client}>${cs.mt}: 上游 key`);
    if (cs.mt === 'claude') eq(lr.headers['x-api-key'], 'ak-test', `E2E ${cs.client}>${cs.mt}: 上游 key`);
    if (cs.mt === 'gemini') eq(lr.headers['x-goog-api-key'], 'gm-test', `E2E ${cs.client}>${cs.mt}: 上游 key`);
    // 上游收到格式正确
    const ub = lr.body;
    if (cs.mt === 'openai') { eq(ub.messages[1].content, 'U1', `E2E ${cs.client}>openai: user 文本`); ok(ub.messages.some(m => m.role === 'system' && m.content === 'S1'), `E2E ${cs.client}>openai: system`); }
    if (cs.mt === 'claude') { eq(ub.system, 'S1', `E2E ${cs.client}>claude: system`); const u0 = Array.isArray(ub.messages[0].content) ? ub.messages[0].content[0].text : ub.messages[0].content; eq(u0, 'U1', `E2E ${cs.client}>claude: user`); eq(ub.max_tokens, 100, `E2E ${cs.client}>claude: max_tokens`); }
    if (cs.mt === 'gemini') { eq(ub.systemInstruction.parts[0].text, 'S1', `E2E ${cs.client}>gemini: systemInstruction`); eq(ub.contents[0].parts[0].text, 'U1', `E2E ${cs.client}>gemini: user`); eq(ub.generationConfig.maxOutputTokens, 100, `E2E ${cs.client}>gemini: maxOutputTokens`); }
  }

  for (const cs of cases) {
    const alt = cs.client === 'gemini';
    const r = await post(gw.port, reqPath(cs.client, cs.model, true, alt), reqBody(cs.client, cs.model, true));
    eq(r.status, 200, `E2E ${cs.client}>${cs.mt} 流式: status`);
    if (cs.client === 'openai') {
      const st = parseOpenAIStream(r.raw);
      eq(st.content, '你好，世界', `E2E ${cs.client}>${cs.mt} 流式: 文本拼接`);
      eq(st.finish, 'stop', `E2E ${cs.client}>${cs.mt} 流式: finish`);
      ok(st.usage && st.usage.prompt_tokens > 0, `E2E ${cs.client}>${cs.mt} 流式: usage`);
      ok(r.raw.includes('[DONE]'), `E2E ${cs.client}>${cs.mt} 流式: [DONE]`);
    } else if (cs.client === 'claude') {
      const st = parseClaudeStream(r.raw);
      eq(st.text, '你好，世界', `E2E ${cs.client}>${cs.mt} 流式: 文本拼接`);
      ok(st.started, `E2E ${cs.client}>${cs.mt} 流式: message_start`);
      ok(st.stopped, `E2E ${cs.client}>${cs.mt} 流式: message_delta`);
      eq(st.stopReason, 'end_turn', `E2E ${cs.client}>${cs.mt} 流式: stop_reason`);
    } else {
      const st = parseGeminiSSE(r.raw);
      eq(st.text, '你好，世界', `E2E ${cs.client}>${cs.mt} 流式: 文本拼接`);
      eq(st.finish, 'STOP', `E2E ${cs.client}>${cs.mt} 流式: finishReason`);
    }
  }
  // gemini→gemini 直通: 无 alt=sse 的 JSON 数组流
  {
    const r = await post(gw.port, '/v1beta/models/m-gemini:streamGenerateContent', reqBody('gemini', 'm-gemini', true));
    eq(r.status, 200, 'E2E gemini直通数组流: status');
    ok(r.raw.startsWith('[') && r.raw.endsWith(']'), 'E2E gemini直通数组流: JSON 数组');
    const arr = JSON.parse(r.raw);
    const text = arr.map(c => (c.candidates[0].content.parts || []).map(p => p.text || '').join('')).join('');
    eq(text, '你好，世界', 'E2E gemini直通数组流: 文本');
  }
  // 直通无损: openai→openai body 原样
  {
    await post(gw.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'X' }], response_format: { type: 'json_object' }, custom_field: 123 });
    const lb = openaiMock.state.lastReq.body;
    eq(lb.custom_field, 123, '直通: 自定义字段保留');
    eq(lb.response_format.type, 'json_object', '直通: response_format 保留');
  }

  /* ============ Part 3: 代理隧道 ============ */
  console.log('── Part 3: SOCKS5 / HTTP 代理 ──');
  const socksA = await M.makeSocks5Mock({});
  {
    const cfgP = {
      listen: { host: '127.0.0.1', port: 0 },
      proxies: { p1: { type: 'socks5', host: '127.0.0.1', port: socksA.port } },
      channels: [{ name: 'via-socks', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk', proxy: 'p1' }],
    };
    const gp = await G.startServer(cfgP, { port: 0 });
    const r = await post(gp.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'via-socks' }] });
    eq(r.status, 200, 'socks5 无认证: 200');
    eq(socksA.state.conns, 1, 'socks5 无认证: 隧道建立');
    eq(openaiMock.state.lastReq.body.messages[0].content, 'via-socks', 'socks5 无认证: 上游收到');
  }
  const socksB = await M.makeSocks5Mock({ username: 'u1', password: 'p1' });
  const socksC = await M.makeSocks5Mock({ username: 'u1', password: 'p1' });
  {
    const cfgP = {
      listen: { host: '127.0.0.1', port: 0 },
      proxies: { p2: 'socks5://u1:p1@127.0.0.1:' + socksB.port },
      channels: [{ name: 'via-socks-auth', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk', proxy: 'p2' }],
    };
    const gp = await G.startServer(cfgP, { port: 0 });
    const r1 = await post(gp.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'auth-ok' }] });
    eq(r1.status, 200, 'socks5 认证: 200');
    const cfgBad = {
      listen: { host: '127.0.0.1', port: 0 },
      proxies: { p3: { type: 'socks5', host: '127.0.0.1', port: socksC.port, username: 'u1', password: 'WRONG' } },
      channels: [{ name: 'bad', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk', proxy: 'p3' }],
    };
    const gpBad = await G.startServer(cfgBad, { port: 0 });
    const r2 = await post(gpBad.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'x' }] });
    eq(r2.status, 502, 'socks5 认证失败: 502');
    ok(r2.raw.includes('auth failed') || r2.raw.includes('gateway_error'), 'socks5 认证失败: 错误信息');
  }
  const hcx = await M.makeHttpConnectMock();
  {
    const cfgP = {
      listen: { host: '127.0.0.1', port: 0 },
      proxies: { p4: { type: 'http', host: '127.0.0.1', port: hcx.port, username: 'hu', password: 'hp' } },
      channels: [{ name: 'via-http', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk', proxy: 'p4' }],
    };
    const gp = await G.startServer(cfgP, { port: 0 });
    const r = await post(gp.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'via-http-connect' }] });
    eq(r.status, 200, 'http CONNECT(带认证): 200');
    eq(hcx.state.conns, 1, 'http CONNECT: 隧道建立');
    ok(hcx.state.sawAuth && hcx.state.sawAuth.startsWith('Basic '), 'http CONNECT: Proxy-Authorization 发送');
  }
  {
    let certs = null;
    try { certs = M.ensureCerts(__dirname + '/certs'); } catch (e) { console.error('  (openssl 不可用, 跳过 HTTPS 代理测试)'); }
    if (certs) {
      const httpsMock = await M.makeOpenAIMock({ tls: true, cert: certs.cert, key: certs.key });
      const cfgP = {
        listen: { host: '127.0.0.1', port: 0 },
        proxies: { p5: { type: 'socks5', host: '127.0.0.1', port: socksA.port } },
        channels: [
          { name: 'via-socks-tls', type: 'openai', baseUrl: `https://127.0.0.1:${httpsMock.port}`, apiKey: 'sk', proxy: 'p5', insecure: true },
          { name: 'direct-tls', type: 'openai', baseUrl: `https://127.0.0.1:${httpsMock.port}`, apiKey: 'sk', insecure: true },
        ],
      };
      const gp = await G.startServer(cfgP, { port: 0 });
      const r1 = await post(gp.port, '/v1/chat/completions', { model: 'm-openai', messages: [{ role: 'user', content: 'tls-via-socks' }] });
      eq(r1.status, 200, 'HTTPS over SOCKS5(自签+insecure): 200');
      const r2 = await post(gp.port, '/v1/chat/completions', { model: 'direct-tls', messages: [{ role: 'user', content: 'tls-direct' }] });
      eq(r2.status, 200, 'HTTPS 直连(insecure): 200');
      httpsMock.server.close();
    }
  }

  /* ============ Part 4: 网关鉴权 ============ */
  console.log('── Part 4: 网关鉴权 ──');
  {
    const cfgK = {
      listen: { host: '127.0.0.1', port: 0 }, gatewayKey: 'secret123',
      channels: [{ name: 'k', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'sk', default: true }],
    };
    const gk = await G.startServer(cfgK, { port: 0 });
    const body = { model: 'm-openai', messages: [{ role: 'user', content: 'hi' }] };
    const r1 = await post(gk.port, '/v1/chat/completions', body);
    eq(r1.status, 401, '鉴权: 无 key → 401');
    const r2 = await post(gk.port, '/v1/chat/completions', body, { Authorization: 'Bearer secret123' });
    eq(r2.status, 200, '鉴权: Bearer → 200');
    const r3 = await post(gk.port, '/v1/messages', { model: 'm-openai', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }, { 'x-api-key': 'secret123' });
    eq(r3.status, 200, '鉴权: x-api-key → 200');
    const r4 = await post(gk.port, '/v1beta/models/m-openai:generateContent?key=secret123', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    eq(r4.status, 200, '鉴权: query key → 200');
    const r5 = await get(gk.port, '/v1/models');
    eq(r5.status, 401, '鉴权: models 列表也要 key');
  }

  /* ============ Part 5: 渠道路由 ============ */
  console.log('── Part 5: 渠道路由 ──');
  {
    const cfgR = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'A', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'k', modelMap: { mx: 'upstream-x' } },
        { name: 'B', type: 'claude', baseUrl: `http://127.0.0.1:${claudeMock.port}`, apiKey: 'k', models: ['my'] },
        { name: 'C', type: 'gemini', baseUrl: `http://127.0.0.1:${geminiMock.port}`, apiKey: 'k', default: true },
      ],
    };
    const gr = await G.startServer(cfgR, { port: 0 });
    await post(gr.port, '/v1/chat/completions', { model: 'mx', messages: [{ role: 'user', content: 'a' }] });
    eq(openaiMock.state.lastReq.body.model, 'upstream-x', '路由: modelMap 命中且模型改写');
    await post(gr.port, '/v1/chat/completions', { model: 'my', messages: [{ role: 'user', content: 'b' }] });
    eq(claudeMock.state.lastReq.body.model, 'my', '路由: models 列表命中');
    await post(gr.port, '/v1/chat/completions', { model: 'zzz-unknown', messages: [{ role: 'user', content: 'c' }] });
    ok(geminiMock.state.lastReq.path.includes('zzz-unknown'), '路由: 未知名落 default 渠道');
    // models 列表
    const m1 = await get(gr.port, '/v1/models');
    const j1 = JSON.parse(m1.raw);
    ok(j1.data.some(x => x.id === 'mx') && j1.data.some(x => x.id === 'my'), 'models: /v1/models 聚合');
    const m2 = await get(gr.port, '/v1beta/models');
    const j2 = JSON.parse(m2.raw);
    ok(j2.models.some(x => x.name === 'models/mx'), 'models: /v1beta/models 聚合');
  }

  /* ============ Part 6: 多实例 ============ */
  console.log('── Part 6: 多实例 ──');
  {
    const cfgA = { listen: { host: '127.0.0.1', port: 0 }, channels: [{ name: 'a', type: 'openai', baseUrl: `http://127.0.0.1:${openaiMock.port}`, apiKey: 'k', default: true }] };
    const cfgB = { listen: { host: '127.0.0.1', port: 0 }, channels: [{ name: 'b', type: 'claude', baseUrl: `http://127.0.0.1:${claudeMock.port}`, apiKey: 'k', default: true }] };
    const ga = await G.startServer(cfgA, { port: 0 });
    const gb2 = await G.startServer(cfgB, { port: 0 });
    ok(ga.port !== gb2.port, '多实例: 端口独立');
    const ha = await get(ga.port, '/health');
    const hb = await get(gb2.port, '/health');
    eq(ha.status, 200, '多实例: A health');
    eq(hb.status, 200, '多实例: B health');
    const r = await post(gb2.port, '/v1/messages', { model: 'whatever', max_tokens: 5, messages: [{ role: 'user', content: 'multi' }] });
    eq(r.status, 200, '多实例: B 实例转发正常');
    eq(claudeMock.state.lastReq.body.messages[0].content, 'multi', '多实例: B 转到 claude 上游');
  }

  /* ============ Part 7: 轮询 (Round-Robin) ============ */
  console.log('── Part 7: 轮询 ──');
  {
    // 两个 openai mock, 同一模型, 网关应轮流分发
    const oa1 = await M.makeOpenAIMock();
    const oa2 = await M.makeOpenAIMock();
    const cfgRR = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'rr-a', type: 'openai', baseUrl: `http://127.0.0.1:${oa1.port}`, apiKey: 'k1', models: ['m-rr'] },
        { name: 'rr-b', type: 'openai', baseUrl: `http://127.0.0.1:${oa2.port}`, apiKey: 'k2', models: ['m-rr'] },
      ],
    };
    const gw = await G.startServer(cfgRR, { port: 0 });
    const hits = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(gw.port, '/v1/chat/completions', { model: 'm-rr', messages: [{ role: 'user', content: String(i) }] });
      eq(r.status, 200, `轮询 #${i}: status`);
      // 哪个 mock 收到了? 用 lastReq 的 apiKey 区分
      const a1 = oa1.state.lastReq, a2 = oa2.state.lastReq;
      // 比较最近一次请求的内容来判断
      hits.push(a1 && a1.body.messages[0].content === String(i) ? 'A' : (a2 && a2.body.messages[0].content === String(i) ? 'B' : '?'));
    }
    // 6 次请求应交替 A B A B A B (round-robin)
    const aCount = hits.filter(h => h === 'A').length;
    const bCount = hits.filter(h => h === 'B').length;
    eq(aCount, 3, '轮询: A 收到 3 次');
    eq(bCount, 3, '轮询: B 收到 3 次');
    // 验证严格交替(不相邻重复)
    ok(hits[0] !== hits[1] && hits[1] !== hits[2], '轮询: 严格交替不相邻重复');
    console.log('  轮询分布:', hits.join(' '));
  }

  /* ============ Part 8: 故障切换 (Failover) ============ */
  console.log('── Part 8: 故障切换 ──');
  {
    // 渠道1 返回 429(限流), 渠道2 正常 → 应自动切到渠道2
    // 注意: 轮询会旋转起始位置, 所以多发几次确保至少有一次从坏渠道开始
    const badMock = await M.makeOpenAIMock();
    // 把 badMock 改成总是返回 429
    badMock.server.removeAllListeners('request');
    badMock.server.on('request', (req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        badMock.state.lastReq = { path: req.url, headers: req.headers, body: JSON.parse(b || '{}') };
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
      });
    });
    const goodMock = await M.makeOpenAIMock();
    const cfgFO = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'fo-bad', type: 'openai', baseUrl: `http://127.0.0.1:${badMock.port}`, apiKey: 'k', models: ['m-fo'] },
        { name: 'fo-good', type: 'openai', baseUrl: `http://127.0.0.1:${goodMock.port}`, apiKey: 'k', models: ['m-fo'] },
      ],
    };
    const gw = await G.startServer(cfgFO, { port: 0 });
    // 发多次(轮询旋转), 每次都应成功(不管从哪个开始, 429的那次会切到好的)
    let allOk = true, badTried = false;
    for (let i = 0; i < 4; i++) {
      const r = await post(gw.port, '/v1/chat/completions', { model: 'm-fo', messages: [{ role: 'user', content: 'fo-' + i }] });
      if (r.status !== 200) allOk = false;
      if (badMock.state.lastReq && badMock.state.lastReq.body.messages[0].content === 'fo-' + i) badTried = true;
    }
    ok(allOk, '故障切换: 429 后总是能切到好渠道, 全部返回 200');
    ok(badTried, '故障切换: 坏渠道至少被尝试过一次');

    // 单次验证内容正确
    const r = await post(gw.port, '/v1/chat/completions', { model: 'm-fo', messages: [{ role: 'user', content: 'failover-check' }] });
    eq(r.status, 200, '故障切换: 返回 200');
    eq(respText('openai', r.raw), '你好，世界', '故障切换: 切换后内容正确');

    // 流式故障切换: 坏渠道 429 → 切好渠道流式
    const r2 = await post(gw.port, '/v1/chat/completions', { model: 'm-fo', stream: true, messages: [{ role: 'user', content: 'fo-stream' }] });
    eq(r2.status, 200, '故障切换(流式): 429 后切换, 返回 200');
    const st2 = parseOpenAIStream(r2.raw);
    eq(st2.content, '你好，世界', '故障切换(流式): 切换后流式内容正确');
    ok(r2.raw.includes('[DONE]'), '故障切换(流式): [DONE] 正常结束');
  }
  {
    // 连接错误故障切换: 渠道1 指向不存在的端口 → 渠道2 正常
    const goodMock2 = await M.makeOpenAIMock();
    const cfgFO2 = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'fo-dead', type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', models: ['m-fo2'], default: true },
        { name: 'fo-good2', type: 'openai', baseUrl: `http://127.0.0.1:${goodMock2.port}`, apiKey: 'k', models: ['m-fo2'] },
      ],
    };
    const gw = await G.startServer(cfgFO2, { port: 0 });
    const r = await post(gw.port, '/v1/chat/completions', { model: 'm-fo2', messages: [{ role: 'user', content: 'conn-fail' }] });
    eq(r.status, 200, '故障切换(连接失败): 死端口后切换, 返回 200');
    eq(goodMock2.state.lastReq.body.messages[0].content, 'conn-fail', '故障切换(连接失败): 好渠道收到');
  }
  {
    // 不可重试错误(400): 不切换, 直接透传
    const bad400 = await M.makeOpenAIMock();
    bad400.server.removeAllListeners('request');
    bad400.server.on('request', (req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request: invalid model', type: 'invalid_request_error' } }));
      });
    });
    const goodMock3 = await M.makeOpenAIMock();
    const cfgFO3 = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'first', type: 'openai', baseUrl: `http://127.0.0.1:${bad400.port}`, apiKey: 'k', models: ['m-fo3'] },
        { name: 'second', type: 'openai', baseUrl: `http://127.0.0.1:${goodMock3.port}`, apiKey: 'k', models: ['m-fo3'] },
      ],
    };
    const gw = await G.startServer(cfgFO3, { port: 0 });
    // 轮询旋转: 发4次, 当坏渠道排在第一位时会直接返回400(不切换)
    // 当好渠道排第一时会返回200. 我们验证: 至少有一次拿到400且不切换
    let got400 = false, goodUntouchedWhen400 = true;
    for (let i = 0; i < 4; i++) {
      const before = goodMock3.state.lastReq ? goodMock3.state.lastReq.body.messages[0].content : null;
      const r = await post(gw.port, '/v1/chat/completions', { model: 'm-fo3', messages: [{ role: 'user', content: 'nr400-' + i }] });
      if (r.status === 400) {
        got400 = true;
        const after = goodMock3.state.lastReq ? goodMock3.state.lastReq.body.messages[0].content : null;
        if (after === 'nr400-' + i) goodUntouchedWhen400 = false; // 好渠道不该收到400那次
        ok(r.raw.includes('bad request'), '不可重试(400): 错误体透传');
      }
    }
    ok(got400, '不可重试(400): 至少有一次直接返回 400 (不切换)');
    ok(goodUntouchedWhen400, '不可重试(400): 400时不切换到其他渠道');
  }
  {
    // 全部渠道都失败 → 返回 502
    const badA = await M.makeOpenAIMock();
    const badB = await M.makeOpenAIMock();
    for (const bm of [badA, badB]) {
      bm.server.removeAllListeners('request');
      bm.server.on('request', (req, res) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.writeHead(503,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'server error'}})); }); });
    }
    const cfgFO4 = {
      listen: { host: '127.0.0.1', port: 0 },
      channels: [
        { name: 'allbad-a', type: 'openai', baseUrl: `http://127.0.0.1:${badA.port}`, apiKey: 'k', models: ['m-fo4'] },
        { name: 'allbad-b', type: 'openai', baseUrl: `http://127.0.0.1:${badB.port}`, apiKey: 'k', models: ['m-fo4'] },
      ],
    };
    const gw = await G.startServer(cfgFO4, { port: 0 });
    const r = await post(gw.port, '/v1/chat/completions', { model: 'm-fo4', messages: [{ role: 'user', content: 'all-fail' }] });
    ok(r.status === 502 || r.status === 503, '全部失败: 返回 502/503 (最后一个渠道的错误透传)');
    ok(r.raw.includes('error') || r.raw.includes('failed'), '全部失败: 错误信息含详情');
  }

  /* ============ 汇总 ============ */
  console.log('──────────────────────────────');
  console.log(`通过 ${pass} 项, 失败 ${fail} 项`);
  if (fail) { console.log('失败明细:'); for (const f of failures) console.log('  - ' + f); }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
