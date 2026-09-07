'use strict';
/* 测试用 mock: 三种格式上游 + SOCKS5 代理 + HTTP CONNECT 代理 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');

/* ---------- OpenAI 格式上游 ---------- */
function makeOpenAIMock(opts = {}) {
  const state = { lastReq: null };
  const handler = (req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      state.lastReq = { path: req.url, headers: req.headers, body };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, fr) => res.write('data: ' + JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: body.model,
          choices: [{ index: 0, delta, finish_reason: fr || null }],
        }) + '\n\n');
        chunk({ role: 'assistant', content: '' });
        chunk({ content: '你好' });
        chunk({ content: '，世界' });
        chunk({}, 'stop');
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }));
      }
    });
  };
  let server;
  if (opts.tls) server = https.createServer({ cert: opts.cert, key: opts.key }, handler);
  else server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state, proto: opts.tls ? 'https' : 'http' })));
}

/* ---------- Claude 格式上游 ---------- */
function makeClaudeMock(opts = {}) {
  const state = { lastReq: null };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      state.lastReq = { path: req.url, headers: req.headers, body };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const ev = (name, obj) => res.write('event: ' + name + '\ndata: ' + JSON.stringify(obj) + '\n\n');
        ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 13, output_tokens: 1 } } });
        ev('ping', { type: 'ping' });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
        ev('message_stop', { type: 'message_stop' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: '你好，世界' }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 13, output_tokens: 7 },
        }));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

/* ---------- Gemini 格式上游 ---------- */
function makeGeminiMock(opts = {}) {
  const state = { lastReq: null };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      state.lastReq = { path: req.url, headers: req.headers, body };
      const model = decodeURIComponent((req.url.match(/\/models\/([^:]+):/) || [])[1] || '');
      const usage = { promptTokenCount: 9, candidatesTokenCount: 7, totalTokenCount: 16 };
      if (/streamGenerateContent/.test(req.url)) {
        const sse = /alt=sse/.test(req.url);
        res.writeHead(200, { 'Content-Type': sse ? 'text/event-stream' : 'application/json' });
        const chunks = [
          { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] }, index: 0 }] },
          { candidates: [{ content: { role: 'model', parts: [{ text: '，世界' }] }, index: 0 }] },
          { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage },
        ];
        if (sse) {
          for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
          res.end();
        } else {
          // JSON 数组分块流
          res.write('[');
          chunks.forEach((c, i) => res.write((i ? ',' : '') + JSON.stringify(c)));
          res.write(']');
          res.end();
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: '你好，世界' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: usage, modelVersion: model,
        }));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

/* ---------- SOCKS5 代理 mock ---------- */
function makeSocks5Mock(opts = {}) {
  const state = { conns: 0 };
  const server = net.createServer(sock => {
    sock.once('error', () => {});
    let stage = 0;
    let buf = Buffer.alloc(0);
    let up = null;
    function pump() {
      if (up) { // 隧道已建立: 残留数据转发给目标, 之后由 pipe 接管
        if (buf.length) { up.write(buf); buf = Buffer.alloc(0); }
        return;
      }
      if (stage === 0 && buf.length >= 2) {
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        const hasNoAuth = methods.includes(0);
        if (opts.username) {
          if (!methods.includes(2)) { sock.write(Buffer.from([5, 0xff])); return sock.destroy(); }
          sock.write(Buffer.from([5, 2]));
          stage = 1;
        } else if (hasNoAuth) {
          sock.write(Buffer.from([5, 0]));
          stage = 2;
        } else {
          sock.write(Buffer.from([5, 0xff]));
          return sock.destroy();
        }
      }
      if (stage === 1 && buf.length >= 2) {
        // RFC 1929: [VER=1, ULEN, USER, PLEN, PASS]
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const good = user === opts.username && pass === (opts.password || '');
        sock.write(Buffer.from([1, good ? 0 : 1]));
        if (!good) return sock.destroy();
        stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const atyp = buf[3];
        let need, host, port;
        if (atyp === 1) { need = 10; if (buf.length < need) return; host = [...buf.subarray(4, 8)].join('.'); }
        else if (atyp === 3) { const l = buf[4]; need = 7 + l; if (buf.length < need) return; host = buf.subarray(5, 5 + l).toString(); }
        else if (atyp === 4) { need = 22; if (buf.length < need) return; host = [...buf.subarray(4, 20)].map(b => b.toString(16)).join(':'); }
        else { sock.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return sock.destroy(); }
        if (buf[1] !== 1) { sock.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return sock.destroy(); }
        port = buf.readUInt16BE(need - 2);
        buf = buf.subarray(need);
        up = net.connect(port, host, () => {
          state.conns++;
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          sock.removeListener('data', onData); // 停止 pump, 交给 pipe
          if (buf.length) { up.write(buf); buf = Buffer.alloc(0); } // CONNECT 与后续请求合并到达的残留
          up.pipe(sock);
          sock.pipe(up);
        });
        up.once('error', () => {
          try { sock.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); sock.destroy(); } catch (_) {}
        });
        sock.once('error', () => up.destroy());
      }
    }
    const onData = c => {
      buf = Buffer.concat([buf, c]);
      try { pump(); } catch (e) { sock.destroy(); }
    };
    sock.on('data', onData);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

/* ---------- HTTP CONNECT 代理 mock ---------- */
function makeHttpConnectMock() {
  const state = { conns: 0, sawAuth: null };
  const server = http.createServer((req, res) => { res.writeHead(405); res.end('use CONNECT'); });
  server.on('connect', (req, clientSocket, head) => {
    state.sawAuth = req.headers['proxy-authorization'] || null;
    const m = /^(.+):(\d+)$/.exec(req.url);
    const host = m ? m[1] : '127.0.0.1';
    const port = m ? Number(m[2]) : 80;
    const up = net.connect(port, host, () => {
      state.conns++;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.once('error', () => {
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy(); } catch (_) {}
    });
    clientSocket.once('error', () => up.destroy());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

/* ---------- 自签证书 ---------- */
function ensureCerts(dir) {
  const cert = dir + '/cert.pem', key = dir + '/key.pem';
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  const { execSync } = require('child_process');
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${key}" -out "${cert}" -days 3 -nodes -subj "/CN=127.0.0.1" 2>/dev/null`);
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

module.exports = { makeOpenAIMock, makeClaudeMock, makeGeminiMock, makeSocks5Mock, makeHttpConnectMock, ensureCerts };
