// MCP 服务器修复验证: ①多连接(断线重连场景) ②shell 异步不冻结
const http = require('http');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? String(extra).slice(0, 200) : ''); }
}

function sseClient(port, onEvent) {
  const req = http.request({ host: '127.0.0.1', port, path: '/sse', method: 'GET', headers: { Accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = {};
        for (const l of block.split('\n')) {
          if (l.startsWith('event:')) ev.event = l.slice(6).trim();
          else if (l.startsWith('data:')) ev.data = (ev.data ? ev.data + '\n' : '') + l.slice(5).trim();
        }
        if (ev.event) onEvent(ev);
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return req;
}

function post(port, path, obj) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(obj));
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.write(data); r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 建连 + initialize, 返回 { ok, send(toolName, args) -> Promise<结果文本>, close }
function mcpClient(port, label) {
  return new Promise((resolve) => {
    let endpoint = null;
    const waiters = {};
    let nextId = 1;
    const timeout = setTimeout(() => resolve({ ok: false, label, err: '连接/初始化超时(10s)' }), 10000);
    const req = sseClient(port, (ev) => {
      if (ev.event === 'endpoint') { endpoint = ev.data; return; }
      if (ev.event === 'message') {
        let j; try { j = JSON.parse(ev.data); } catch (_) { return; }
        if (j.id && waiters[j.id]) { waiters[j.id](j); delete waiters[j.id]; }
      }
    });
    const send0 = (method, params) => new Promise((res2) => {
      const id = nextId++;
      waiters[id] = res2;
      post(port, endpoint, { jsonrpc: '2.0', id, method, params });
    });
    (async () => {
      while (!endpoint) await sleep(50);
      const init = await send0('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      if (!init || !init.result) { clearTimeout(timeout); return resolve({ ok: false, label, err: 'initialize 无 result: ' + JSON.stringify(init).slice(0, 150) }); }
      await post(port, endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
      clearTimeout(timeout);
      resolve({
        ok: true, label,
        call: (name, args) => send0('tools/call', { name, arguments: args || {} }).then(j => j && j.result && j.result.content && j.result.content[0] ? j.result.content[0].text : JSON.stringify(j).slice(0, 150)),
        close: () => { try { req.destroy(); } catch (_) {} },
      });
    })();
  });
}

(async () => {
  console.log('== P: pixiv-mcp (6219) 多连接/重连 ==');
  const p1 = await mcpClient(6219, 'p1');
  t('P1 第一个连接初始化', p1.ok, p1.err);
  const p2 = await mcpClient(6219, 'p2');
  t('P2 第二个连接初始化(修复前会卡死)', p2.ok, p2.err);
  if (p1.ok && p2.ok) {
    const l = await Promise.race([p1.call('__no_such_tool__', {}), sleep(8000).then(() => 'TIMEOUT')]);
    t('P3 第一连接仍能调工具', l !== 'TIMEOUT', l);
    p1.close(); p2.close();
    await sleep(300);
    const p3 = await mcpClient(6219, 'p3');
    t('P4 断开后再重连', p3.ok, p3.err);
    if (p3.ok) p3.close();
  }

  console.log('== M: termux-mcp (6218) shell 异步不冻结 ==');
  const m1 = await mcpClient(6218, 'm1');
  t('M1 连接A初始化', m1.ok, m1.err);
  const m2 = await mcpClient(6218, 'm2');
  t('M2 连接B初始化', m2.ok, m2.err);
  if (m1.ok && m2.ok) {
    const slow = m1.call('shell', { command: 'sleep 5 && echo slow-done' });
    await sleep(300);
    const t0 = Date.now();
    const fast = await m2.call('shell', { command: 'echo fast-alive' });
    const dt = Date.now() - t0;
    t('M3 慢命令执行期间快命令 <3s 返回(修复前冻结5s)', dt < 3000, dt + 'ms');
    t('M4 快命令结果正确', String(fast).includes('fast-alive'), fast);
    const slowRes = await slow;
    t('M5 慢命令正常完成', String(slowRes).includes('slow-done'), slowRes);
    const chk = await m2.call('check_environment', { tool: 'node' });
    t('M6 check_environment 正常', String(chk).includes('node'), chk);
    const f = await m2.call('file', { action: 'list', target: '.' });
    t('M7 file 工具正常', String(f).length > 2, String(f).slice(0, 80));
    m1.close(); m2.close();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
