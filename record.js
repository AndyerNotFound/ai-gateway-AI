'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { logErr, rpCompile, log, hdrName, utf8, safeParse, rpWalk, randId } = require('./util');
const { dsmlDiag, makeDirectPipe, wrapDsmlClean, dsmlExtractCall, dsmlCleanText, dsmlPickCall } = require('./dsml');
const { ResponsesStreamParser, UpstreamStreamParser, SSEDecoder, responsesRespToCanonical, makeResponsesWriter, makeWriter, canonicalToResponsesResp, canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp, responsesToCanonical } = require('./convert');
const { UP_RESP, TO_CANON, buildRequestForChannel, SAME_RETRYABLE, BUILD_BODY } = require('./sync');
const { tokOf, sendError, corsHeaders, estPromptAdj, matchContextWindow, pickChannels, forcedChannelName, analyzePrompt, calibRatio, calibUpdate, scaleDist, recordContext } = require('./router');
const { wrapThinkingSummary, summarizeReasoningText, truncateReasoning, upstreamRequest, joinUrl } = require('./upstream');
const { respRedactOn, wrapRedactWriter, redactText, redactDeep } = require('./redact');
const { isConnErr, makeFreshAgents } = require('./proxy');
const ctxp = require('./ctxp');

// ================= 请求记录 / Token 统计 =================
/* ================= 请求记录 (config.record: {enable, server, maxChars}) ================= */
function instName(cfg) {
  if (cfg._name) return cfg._name;
  const bn = cfg._configFile ? path.basename(cfg._configFile, '.json') : 'config';
  return bn === 'config' ? 'default' : bn.replace(/^config\./, '');
}
// 写一条记录: 配了 server 就 POST JSON 过去(异步, 不阻塞响应), 否则追加到本机 log/requests-<实例>.jsonl
function writeRequestRecord(cfg, recCfg, rec) {
  const line = JSON.stringify(rec);
  if (recCfg.server) { postRequestRecord(recCfg.server, line); return; }
  try {
    const dir = path.join(path.dirname(cfg._configFile || process.cwd()), 'log');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'requests-' + instName(cfg) + '.jsonl');
    // 简单轮转: 超过 5MB 时只保留尾部约 2MB (按行截断, 不截断 JSON)
    try {
      const st = fs.statSync(f);
      if (st.size > 5 * 1024 * 1024) {
        const txt = fs.readFileSync(f, 'utf8');
        const cut = txt.indexOf('\n', Math.max(0, txt.length - 2 * 1024 * 1024));
        fs.writeFileSync(f, cut >= 0 ? txt.slice(cut + 1) : txt.slice(-2 * 1024 * 1024));
      }
    } catch (_) {}
    fs.appendFileSync(f, line + '\n');
  } catch (e) { logErr('请求记录写入失败:', e.message); }
}
function postRequestRecord(server, line) {
  try {
    const u = new URL(server);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
    }, (resp) => { resp.resume(); });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => logErr('请求记录上报失败:', e.message));
    r.end(line);
  } catch (e) { logErr('请求记录服务器地址无效:', e.message); }
}

function handleUpstreamResponse(cfg, ch, clientFormat, clientApi, canonical, body, urlInfo, req, res, upRes, upReq, built, ctx, retryHook) {
  const { direct, stream, upApi } = built;
  const { logMeta, t0, usageCapture, stats } = ctx;
  const rpInc = (cfg.replace && Array.isArray(cfg.replace.inc)) ? rpCompile(cfg.replace.inc) : [];
  // 渠道级覆盖(ch.transcreet): on / off / res-only; 未设=沿用实例全局 dsmlClean
  const chTrans = ch && ch.transcreet ? String(ch.transcreet).toLowerCase() : '';
  const dsmlOn = chTrans === 'off' ? false : (chTrans ? true : !!(cfg.dsmlClean && cfg.dsmlClean.enable));        // 内置 DSML 标记清洗(默认开)
  const dsmlThink = chTrans === 'on' ? true : (chTrans === 'off' || chTrans === 'res-only') ? false : !!(cfg.dsmlClean && cfg.dsmlClean.reasoning); // 思考字段是否也清
  /* ★DSML 清洗只对"能按事件解析"的响应生效: SSE 流 与 非流式 JSON。
   *   Gemini 的 JSON 数组流(content-type: application/json)不解析 —— 要解析就得整份缓冲,
   *   会把"边收边发"退化成"收完再发"(打字机效果直接没了)。那条链路维持原样。 */
  /* 回填闸: 只有"函数名命中客户端本次声明的工具"才把文本态调用还原成结构化调用 */
  const dsmlBackfill = !!(cfg.dsmlClean && cfg.dsmlClean.backfill);
  const dsmlToolNames = (() => {
    if (!dsmlBackfill) return null;
    const arr = (canonical && Array.isArray(canonical.tools)) ? canonical.tools : [];
    const set = new Set();
    for (const t of arr) { const n = t && t.function && t.function.name; if (n) set.add(String(n)); }
    return set.size ? set : null;
  })();
  const dsmlOpts = {
    toolNames: dsmlToolNames,
    onDiag: (rec) => dsmlDiag(cfg, Object.assign({ ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: !!stream, direct: !!direct }, rec)),
  };
  const ctSse = /event-stream/i.test(String(upRes.headers['content-type'] || ''));
  const dsmlPipe = dsmlOn && (ctSse || !stream);
  const isResponsesUp = ch.type === 'openai' && upApi === 'responses';

  /* ★★统一结算 + 收尾加固（2026-09-18，与 ai-gateway-core 同源）
   * 事故：direct 流式分支的 `upRes.on('end')` 直接裸调 `ctx.logDone()`。它一旦抛错，EventEmitter
   * 的 emit 循环就中断 —— `upRes.pipe(res)` 的 onend 不会被调用，于是**下游永远等不到结束标记**、
   * 统计里留下「1 次请求 / 0 token」的幽灵记录（core 侧表现为请求挂 9 分钟不结算）。
   * 现在：①结算只做一次；②结算异常绝不影响下游收尾；③流中断也要结算。 */
  let __settled = false;
  const __settle = (status, why) => {
    if (__settled) return;
    __settled = true;
    if (__doneTimer) { clearTimeout(__doneTimer); __doneTimer = null; }
    if (why) logErr('[settle]', why, 'status=' + status);
    try { ctx.logDone(status); } catch (e) { logErr('[settle] logDone 失败:', e.message); }
  };

  /* ★客户端断开(点停止 / 关页面 / 弱网断): 立即取消上游请求。
   *   之前完全没有这条通道 —— 用户按停止后上游继续生成到自然结束或 180s 超时, 表现为"停止按钮没效果/卡死"。 */
  /* ★上游发完 finish_reason/[DONE] 却不关连接(反代很常见): 2.5s 后强制收尾。
   *   没有这条, 结算/logDone 永不触发 —— 统计 0 token、悬浮球上下文圈不动、客户端一直转圈。 */
  let __forceEnd = () => { try { if (!res.writableEnded) res.end(); } catch (_) {} };
  let __doneTimer = null;
  const __armForceEnd = () => {
    if (__doneTimer || __settled) return;
    __doneTimer = setTimeout(() => {
      __doneTimer = null;
      if (__settled) return;
      log('[force-end] 上游未关连接, 强制收尾 req=' + ctx.reqId);
      __settle(upRes.statusCode && upRes.statusCode < 400 ? upRes.statusCode : 200);
      try { __forceEnd(); } catch (_) {}
      try { upRes.destroy(); } catch (_) {}
    }, 2500);
  };
  /* ★兜底结算: 上游断流/客户端断开时以前根本不走 logDone —— 统计停在「1 次请求 0 token」,
   *  悬浮球的上下文圈也就永远不动(2026-10-26 实测: 20:5x 的 4 次请求全是这样消失的)。 */
  upRes.on('close', () => { if (!__settled) __settle(upRes.statusCode || 200, '上游连接关闭(没等到 end)'); });
  let clientGone = false;
  const killUp = () => {
    if (clientGone) return; clientGone = true;
    try { if (upReq) upReq.destroy(); } catch (_) {}
    try { if (upRes) upRes.destroy(); } catch (_) {}
    __settle(499, '客户端断开, 已取消上游');
  };
  res.on('close', () => { if (!res.writableEnded) killUp(); });
  req.on('aborted', () => killUp());
  res.on('error', () => {});   // ★吃掉"对已结束/已断开响应写入"的流错误: 客户端断开瞬间的 write-after-end 曾以 uncaughtException 打死整个网关进程(2026-10-16 实测)

  if (direct) {
    const ct = upRes.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json');
    try {
      res.writeHead(upRes.statusCode, { 'Content-Type': ct, 'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    } catch (e) {
      /* ★不能静默 return：报头下发失败时，客户端收不到任何东西、上游响应也无人读取，
       *  请求会永久悬挂。改为明确报错 + 释放上游连接。 */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    if (stream) {
      const parser = isResponsesUp ? new ResponsesStreamParser(() => {}) : new UpstreamStreamParser(ch.type, () => {});
      const dec = new SSEDecoder((data) => {
        try {
          if (data === '[DONE]') { __armForceEnd(); return; }
          const j = JSON.parse(data);
          const c0 = j && j.choices && j.choices[0];
          if (c0 && (c0.finish_reason || (c0.delta && c0.delta.finish_reason))) __armForceEnd();
          parser.handle(j);
        } catch (_) {}
      });
      const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
      upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
      upRes.on('end', () => {
        try {
          dec.end(); parser.finish();
          usageCapture.input = parser.usage ? parser.usage.input : 0;
          usageCapture.output = parser.usage ? parser.usage.output : 0;
          usageCapture.cached = parser.usage ? (parser.usage.cached || 0) : 0;
          usageCapture.reasoning = parser.usage ? (parser.usage.reasoning || 0) : 0;
          __settle(upRes.statusCode);
        } catch (e) { logErr('[stream] 结算失败，仍强制给下游收尾:', e.message); }
        /* ★有改写管道(inc 替换 / DSML 清洗)时, 收尾交给管道 —— 它得先冲掉末行残留与状态机残留;
         *   这里先 res.end() 会让管道尾部写入变成 write after end(实测尾部丢字, 2026-10-15)。 */
        if (!rpInc.length && !dsmlPipe) { try { res.end(); } catch (_) {} }
      });
      upRes.on('error', (e) => { if (!rpInc.length && !dsmlPipe) { try { res.end(); } catch (_) {} } __settle(502, '上游流中断(' + e.message + ')'); });
    } else {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const j = safeParse(Buffer.concat(chunks).toString('utf8'));
        if (j) {
          const cr = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
          usageCapture.input = cr.usage.input; usageCapture.output = cr.usage.output;
          usageCapture.cached = cr.usage.cached || 0; usageCapture.reasoning = cr.usage.reasoning || 0;
          try {
            const __cpt = Math.max(1, Number((cfg.contextLimit || {}).charsPerToken) || 4);
            const __tok = (t) => tokOf(t, __cpt);
            ctx.respDist.reasoning = __tok(cr.reasoning);
            ctx.respDist.text = __tok(cr.text);
            if (Array.isArray(cr.tool_calls)) for (const tc of cr.tool_calls) { const fn = (tc && tc.function) || {}; ctx.respDist.tool += __tok(fn.name) + __tok(fn.arguments) + 8; }
          } catch (_) {}
        }
        __settle(upRes.statusCode);
      });
      upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(非流式): ' + e.message); });
    }
    /* ★DSML 清洗只对"能按事件解析"的响应生效: SSE 流 与 非流式 JSON(条件见函数开头 dsmlPipe)。 */
    if (rpInc.length || dsmlPipe) {
      /* 统一改写管道(2026-10-15): inc 文本替换 + 内置 DSML 标记清洗
       *   - 逐行改写, 不需要改写的行原样透传(同格式直通尽量零损耗);
       *   - DSML 状态机按字段隔离, 只动 content/text 与 reasoning_content/reasoning/thinking;
       *   - 收尾(末行残留 + 状态机残留)与 res.end() 都在管道内, 详见 makeDirectPipe。 */
      const pipe = makeDirectPipe(res, rpInc, dsmlPipe, dsmlThink, stream, dsmlOpts);
      let upEnded = false;
      const finishPipe = () => { if (upEnded) return; upEnded = true; try { pipe.end(); } catch (_) {} };
      __forceEnd = () => finishPipe();
      upRes.on('data', c => pipe.push(c));
      upRes.on('end', finishPipe);
      upRes.on('close', finishPipe);                          // ★上游连接被重置/掐断(没发 end) → 强制在管道内收尾, 下游不再悬挂
      upRes.on('error', (e) => { __settle(502, '上游中断(改写管道): ' + e.message); finishPipe(); });   // 错误也走管道收尾(补 [DONE]), 不提前 res.end()
    } else {
      upRes.on('close', () => { if (!res.writableEnded) { try { res.end(); } catch (_) {} } });   // 裸直通同样兜住上游断流
      upRes.pipe(res);
    }
    return;
  }

  // 跨格式转换
  if (stream) {
    const isArrayStream = clientFormat === 'gemini' && !urlInfo.altSse;
    try {
      res.writeHead(200, {
        'Content-Type': isArrayStream ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'X-AI-Gateway-Channel': hdrName(ch.name), 'Access-Control-Allow-Origin': '*',
      });
    } catch (e) {
      /* ★不能静默 return：报头下发失败时，客户端收不到任何东西、上游响应也无人读取，
       *  请求会永久悬挂。改为明确报错 + 释放上游连接。 */
      logErr('[resp] 响应头下发失败, 已中断该请求:', e.message);
      try {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"gateway: 响应头下发失败","type":"gateway_error"}}'); }
        else res.destroy();
      } catch (_) { try { res.destroy(); } catch (_) {} }
      try { upRes.resume(); } catch (_) {}
      return;
    }
    const baseWriter = (clientFormat === 'openai' && clientApi === 'responses') ? makeResponsesWriter(res, canonical.model) : makeWriter(clientFormat, res, canonical.model, { geminiArray: isArrayStream });
    /* DSML 清洗放在最内层(紧贴 writer): 正文/思考在变成客户端格式前就已干净,
     * 也不会把内部标记喂给 thinkingSummary 的总结模型。 */
    let writer = wrapThinkingSummary(dsmlOn ? wrapDsmlClean(baseWriter, true, dsmlThink, dsmlOpts) : baseWriter, cfg.thinkingSummary, ch, cfg);
    if (respRedactOn(cfg, urlInfo)) writer = wrapRedactWriter(writer, cfg.redact && cfg.redact.extra);
    // 响应侧 Token 分布计数(旁路, 只数不转发; ctx.respDist 声明在 handleChat 顶层)
    const __origOnEvent = writer.onEvent.bind(writer);
    writer.onEvent = (ev) => {
      try {
        const cpt = Math.max(1, Number((cfg.contextLimit || {}).charsPerToken) || 4);
        if (ev.type === 'reasoning') ctx.respDist.reasoning += tokOf(ev.t);
        else if (ev.type === 'text') ctx.respDist.text += tokOf(ev.t);
        else if (ev.type === 'tool_start') ctx.respDist.tool += tokOf(ev.name) + 8;
        else if (ev.type === 'tool_delta') ctx.respDist.tool += tokOf(ev.s);
      } catch (_) {}
      return __origOnEvent(ev);
    };
    const parser = isResponsesUp ? new ResponsesStreamParser(ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    }) : new UpstreamStreamParser(ch.type, ev => {
      try { if (rpInc.length) rpWalk(ev, rpInc, 0, false); writer.onEvent(ev); } catch (e) { logErr('writer error:', e.message); }
    });
    const dec = new SSEDecoder((data) => {
      if (data === '[DONE]') { parser.finish(); return; }
      try { parser.handle(JSON.parse(data)); } catch (e) { logErr('bad SSE data (first 200 chars):', String(data).slice(0, 200)); }
    });
    const u8 = utf8();   /* ★跨分块安全解码(2026-09-18) */
    upRes.on('data', c => { try { dec.push(u8(c)); } catch (_) {} });
    let upStreamDone = false;
    const upStreamFinal = () => {
      if (upStreamDone) return; upStreamDone = true;
      try {
        dec.end(); parser.finish();
        usageCapture.input = parser.usage ? parser.usage.input : 0;
        usageCapture.output = parser.usage ? parser.usage.output : 0;
        usageCapture.cached = parser.usage ? (parser.usage.cached || 0) : 0;
        usageCapture.reasoning = parser.usage ? (parser.usage.reasoning || 0) : 0;
        __settle(200);
      } catch (e) { logErr('[stream] 转换路径结算失败，仍强制收尾:', e.message); }
      try { res.end(); } catch (_) {}
    };
    upRes.on('end', upStreamFinal);
    upRes.on('close', upStreamFinal);                         // ★上游断流(连接重置, 没发 end)也强制收尾
    upRes.on('error', (e) => { logErr('upstream stream error:', e.message); try { res.end(); } catch (_) {} __settle(502, '上游流中断(转换): ' + e.message); });
  } else {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', async () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      const j = safeParse(txt);
      if (!j) {
        // 上游 200 但正文不是 JSON(HTML 错误页等, content-type 也可能伪装成 json): 可重试
        const why = 'upstream returned non-JSON: ' + redactText(txt.slice(0, 200), cfg.redact && cfg.redact.extra);
        if (retryHook && retryHook(why)) return;
        stats.errors++;
        return sendError(clientFormat, res, 502, why);
      }
      const cresp = isResponsesUp ? responsesRespToCanonical(j) : UP_RESP[ch.type](j);
      usageCapture.input = cresp.usage.input;
      usageCapture.output = cresp.usage.output;
      if (dsmlOn) {   /* 非流式: 整段一次性清洗(final=true: 未闭合的标记块丢弃, 暂缓的尾巴补回) + 文本态调用回填 */
        try {
          if (typeof cresp.text === 'string') {
            const cand = dsmlExtractCall(cresp.text);
            cresp.text = dsmlCleanText(cresp.text);
            const hasStructured = Array.isArray(cresp.tool_calls) && cresp.tool_calls.length;
            const pick = (!hasStructured && cand) ? dsmlPickCall(cand, dsmlToolNames) : null;
            if (pick) {
              cresp.tool_calls = [{ id: randId('call_dsml_'), type: 'function', function: { name: pick.name, arguments: pick.arguments } }];
              if (!cresp.finish_reason || cresp.finish_reason === 'stop') cresp.finish_reason = 'tool_calls';
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, content: 1, emptied: cand ? 1 : 0, blocks: cand ? cand.length : 0, names: (cand || []).map(c => c.name), backfill: 'no-structured-call→tool_calls', finishIn: 'stop', finishOut: cresp.finish_reason });
            } else if (cand && hasStructured) {
              dsmlDiag(cfg, { ch: ch.name, model: canonical && canonical.model, fmt: clientFormat, stream: false, direct: false, blocks: cand.length, names: cand.map(c => c.name), backfill: 'already-has-structured-call' });
            }
          }
          if (dsmlThink && typeof cresp.reasoning === 'string') cresp.reasoning = dsmlCleanText(cresp.reasoning);
        } catch (e) { logErr('[dsml] 非流式清洗失败:', e.message); }
      }
      if (cfg.thinkingSummary && cfg.thinkingSummary.enable && cresp.reasoning) {
        try {
          if (cfg.thinkingSummary.mode === 'summarize') { const s = await summarizeReasoningText(cresp.reasoning, cfg.thinkingSummary, ch, cfg); if (s) cresp.reasoning = s; }
          else cresp.reasoning = truncateReasoning(cresp.reasoning, cfg.thinkingSummary.maxCharsPerSegment);
        } catch (e) { logErr('[thinkingSummary] 非流式精简失败:', e.message); }
      }
      if (respRedactOn(cfg, urlInfo)) {   // 响应方向过滤(非流式): 正文/思考/工具参数
        try {
          const rx = cfg.redact && cfg.redact.extra;
          if (typeof cresp.text === 'string') cresp.text = redactText(cresp.text, rx);
          if (typeof cresp.reasoning === 'string') cresp.reasoning = redactText(cresp.reasoning, rx);
          if (Array.isArray(cresp.tool_calls)) for (const tc of cresp.tool_calls) {
            if (tc && tc.function && typeof tc.function.arguments === 'string') tc.function.arguments = redactText(tc.function.arguments, rx);
          }
        } catch (e) { logErr('[redact] 非流式响应过滤失败:', e.message); }
      }
      let out;
      if (clientFormat === 'openai') out = clientApi === 'responses' ? canonicalToResponsesResp(cresp, canonical.model) : canonicalToOpenAIResp(cresp, canonical.model);
      else if (clientFormat === 'claude') out = canonicalToClaudeResp(cresp, canonical.model);
      else out = canonicalToGeminiResp(cresp, canonical.model);
      if (rpInc.length) rpWalk(out, rpInc, 0, false);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
        res.end(JSON.stringify(out));
      } catch (e) { logErr('[resp] 响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
      __settle(200);
    });
    upRes.on('error', (e) => { try { res.end(); } catch (_) {} __settle(502, '上游中断(转换/非流式): ' + e.message); });
  }
}

function handleChat(cfg, clientFormat, clientApi, req, res, urlInfo, bodyStr) {
  const stats = cfg._stats;
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch (e) { return sendError(clientFormat, res, 400, 'invalid JSON body: ' + e.message); }
  if (!body || typeof body !== 'object') return sendError(clientFormat, res, 400, 'request body must be a JSON object');
  // 隐私过滤: 转发前把请求体里的密钥/token 替换为 ***
  // 管理端总开关 redact.enable(实例级, 默认开) 是上限; 用户卡可 redact=false 覆盖关闭
  const redactInstOn = !(cfg.redact && cfg.redact.enable === false);
  let redactOn = redactInstOn;
  if (redactInstOn && urlInfo.userKey && urlInfo.userKey.redact === false) redactOn = false; // 用户端关
  if (redactOn) body = redactDeep(body, cfg.redact && cfg.redact.extra, 0);
  // 文本替换(发送方向): config.replace.out 规则作用于请求文本(model 字段与 data:URL 跳过)
  const rpOutRules = (cfg.replace && Array.isArray(cfg.replace.out)) ? rpCompile(cfg.replace.out) : [];
  if (rpOutRules.length) body = rpWalk(body, rpOutRules, 0, true);

  const canonical = (clientApi === 'responses') ? responsesToCanonical(body, urlInfo.model) : TO_CANON[clientFormat](body, urlInfo.model);
  if (urlInfo.stream) canonical.stream = true; // gemini: 流式标志在 URL 路径里
  if (!canonical.model) return sendError(clientFormat, res, 400, 'missing "model"');
  // 卡密模型白名单(按客户端请求的对外模型名判定)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.models) && urlInfo.userKey.models.length
      && !urlInfo.userKey.models.includes(canonical.model)) {
    return sendError(clientFormat, res, 403, '此卡密不允许使用模型: ' + canonical.model + ' (可用: ' + urlInfo.userKey.models.join(', ') + ')');
  }
  // 卡密分支白名单(只允许访问指定实例)
  if (urlInfo.userKey && Array.isArray(urlInfo.userKey.branches) && urlInfo.userKey.branches.length) {
    const br = cfg._name || 'default';
    if (!urlInfo.userKey.branches.includes(br)) {
      return sendError(clientFormat, res, 403, '此卡密不允许访问分组: ' + br + ' (可用: ' + urlInfo.userKey.branches.join(', ') + ')');
    }
  }
  // 卡级隐私过滤覆盖在 redactDeep 前已应用(2250行附近), 此处不再重复

  // 全局上下文上限(ctxp): 按模型名通配, max 拦截 / warn 走 TermuxBridge 通知(5分钟节流)
  {
    const __fresh = ctxp.loadRulesIfChanged();
    if (__fresh !== undefined) cfg._ctxpRules = __fresh;
    else if (!cfg._ctxpRules) cfg._ctxpRules = ctxp.loadRules();
    if (cfg._ctxpRules && Object.keys(cfg._ctxpRules).length) {
      const __hit = ctxp.matchRule(cfg._ctxpRules, canonical.model);
      if (__hit) {
        const __rule = __hit.rule;
        const __mx = Math.max(0, Number(__rule.max) || 0), __wn = Math.max(0, Number(__rule.warn) || 0);
        if ((__mx > 0 || __wn > 0) && (cfg.ctxpMode || 'force') !== 'none') {
          const __estC = estPromptAdj(cfg, canonical.model, canonical).total;
          if ((cfg.ctxpMode || 'force') === 'force' && __mx > 0 && __estC > __mx) {
            log('[ctxp] 拒收超限请求 model=' + canonical.model + ' est=' + __estC + ' max=' + __mx + ' (rule ' + __hit.pattern + ')');
            stats.errors++;
            return sendError(clientFormat, res, 400,
              '上下文超出全局上限: 估算 ' + __estC + ' tokens > max ' + __mx + ' (规则: ' + __hit.pattern + ')');
          }
          if (__wn > 0 && __estC > __wn) ctxp.fireWarn(__hit.pattern, __rule, canonical.model, __estC).catch(() => {});
        }
      }
    }
  }
  // 上下文硬上限: 按估算先卡住, 别白跑一趟上游(软上限只影响提示色, 不拦)
  const cl = cfg.contextLimit || { soft: 80, hard: 0, charsPerToken: 2 };
  if (cl.hard > 0) {
    const win = matchContextWindow(cfg, canonical.model);
    if (win > 0) {
      const est = estPromptAdj(cfg, canonical.model, canonical).total;
      const limit = Math.floor(win * cl.hard / 100);
      if (est > limit) {
        log('[ctx] 拒收超限请求 model=' + canonical.model + ' est=' + est + ' limit=' + limit + ' win=' + win);
        stats.errors++;
        return sendError(clientFormat, res, 400,
          '上下文超出硬上限: 估算 ' + est + ' tokens > 上限 ' + limit + ' (窗口 ' + win + ' × ' + cl.hard + '%)。估算: 中日韩 1 字/token, 其他 ' + cl.charsPerToken + ' 字符/token, 可在设置里调。');
      }
    }
  }

  const candidates = pickChannels(cfg, canonical.model, forcedChannelName(cfg, req));
  if (!candidates.length) return sendError(clientFormat, res, 503, 'no channel configured in config.json');

  stats.requests++;
  // 请求记录(可选, 默认关闭): 包一层 res.write/res.end 捕获实际发给客户端的响应正文
  const reqId = randId('req');
  // 进行中的请求(reqId -> 开始时间): 给悬浮球判断"思考中", 10 分钟自动过期
  stats._inflight = stats._inflight || new Map();
  for (const [k, t] of stats._inflight) if (Date.now() - t > 120000) stats._inflight.delete(k);
  stats._inflight.set(reqId, Date.now());
  const recCfg = (cfg.record && cfg.record.enable) ? cfg.record : null;
  const recState = { status: 0, chName: '' };
  let recChunks = null, recFinalized = false;
  const recordReq = (status, chName, inT, outT) => {
    recState.status = status; recState.chName = chName || '';
    stats.recent.push({ id: reqId, time: new Date().toISOString().slice(0, 19).replace('T', ' '), model: canonical.model, channel: chName || '', status, duration: Date.now() - t0, inputTokens: inT || 0, outputTokens: outT || 0, keyName: urlInfo.userKey ? (urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12)) : undefined });
    if (stats.recent.length > 200) stats.recent.shift();
  };
  const stream = canonical.stream;
  log('[req]', reqId, 'model=' + canonical.model, stream ? 'stream' : 'block',
    'tools=' + (Array.isArray(canonical.tools) ? canonical.tools.length : 0));
  const t0 = Date.now();
  const usageCapture = { input: 0, output: 0, cached: 0, reasoning: 0 };
  const respDist = { reasoning: 0, text: 0, tool: 0 }; // 响应侧分布计数(流式由 writer 钩子、非流式由 __settle 前填)
  // 首字时间(TTFB): 只记时间戳, 不改写内容
  let firstWriteAt = 0;
  try {
    const __ow = res.write.bind(res), __oe = res.end.bind(res);
    res.write = (c, ...a) => { if (!firstWriteAt && c) firstWriteAt = Date.now(); return __ow(c, ...a); };
    res.end = (c, ...a) => { if (!firstWriteAt && c && typeof c !== 'function') firstWriteAt = Date.now(); return __oe(c, ...a); };
  } catch (_) {}
  function finalizeRecord() {
    if (!recCfg || recFinalized) return; recFinalized = true;
    try {
      const maxC = (recCfg.maxChars > 0 ? recCfg.maxChars : 200000);
      let resp = Buffer.concat(recChunks).toString('utf8');
      if (resp.length > maxC) resp = resp.slice(0, maxC) + '\n…[截断]';
      let reqTxt = ''; try { reqTxt = JSON.stringify(body); } catch (_) {}
      if (reqTxt.length > maxC) reqTxt = reqTxt.slice(0, maxC) + '…[截断]';
      writeRequestRecord(cfg, recCfg, {
        id: reqId, time: new Date().toISOString(), instance: instName(cfg), format: clientFormat,
        model: canonical.model, channel: recState.chName, status: recState.status,
        duration: Date.now() - t0, inputTokens: usageCapture.input || 0, outputTokens: usageCapture.output || 0,
        request: safeParse(reqTxt) || reqTxt, response: resp,
      });
    } catch (_) {}
  }
  if (recCfg) {
    recChunks = [];
    const ow = res.write.bind(res), oe = res.end.bind(res);
    res.write = (c, ...a) => { try { if (c) recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {} return ow(c, ...a); };
    res.end = (c, ...a) => {
      try { if (c && typeof c !== 'function') recChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch (_) {}
      finalizeRecord();
      return oe(c, ...a);
    };
  }
  let attempt = 0;
  let lastErrStatus = 0;
  let lastErrMsg = '';

  // 逐个候选渠道尝试, 连接失败或可重试的 HTTP 错误 → 切下一个; 不可重试错误(如 400) → 直接透传
  const tryNext = () => {
    if (attempt >= candidates.length) {
      // 全部候选都失败了
      stats.errors++;
      recordReq(lastErrStatus || 502, '', 0, 0);
      const msg = lastErrMsg || ('all ' + candidates.length + ' channels failed');
      return sendError(clientFormat, res, lastErrStatus || 502, msg);
    }
    const pick = candidates[attempt];
    const ch = pick.ch;
    const myCanonical = { ...canonical, model: pick.upstreamModel || canonical.model };
    const built = buildRequestForChannel(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req);
    attempt++;

    // HTTP 头只允许 ASCII, 中文/全角字符的 apiKey 会让 node 抛内部错误
    for (const [hk, hv] of Object.entries(built.headers)) {
      if (typeof hv === 'string' && !/^[\x09\x20-\x7e]*$/.test(hv)) {
        return sendError(clientFormat, res, 500, `渠道 "${ch.name}" 的请求头 ${hk} 含非 ASCII 字符(可能是 apiKey 里残留了中文占位符), 请修改 config.json`);
      }
    }

    const ctx = {
      logMeta: [clientFormat + '>' + ch.type, 'model=' + canonical.model, 'ch=' + ch.name, 'proxy=' + (ch.proxy || '-'), stream ? 'stream' : 'block'].join(' '),
      t0, usageCapture, stats, reqId, respDist,
      logDone(status) {
        // 在 logDone 里结算 inflight: 这里 reqId/stats 一定在作用域内
        try { if (stats._inflight) stats._inflight.delete(reqId); } catch (_) {}
        log(ctx.logMeta, 'status=' + status, 'in=' + usageCapture.input, 'out=' + usageCapture.output,
          'ttfb=' + (firstWriteAt ? firstWriteAt - t0 : 0), 'ms=' + (Date.now() - t0));
        stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
        stats.byChannel[ch.name].inputTokens += usageCapture.input;
        stats.byChannel[ch.name].outputTokens += usageCapture.output;
        // 卡密用量统计 + 额度累计
        if (urlInfo.userKey) {
          const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
          stats.byKey = stats.byKey || {};
          stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
          stats.byKey[kn].inputTokens += usageCapture.input;
          stats.byKey[kn].outputTokens += usageCapture.output;
          urlInfo.userKey.usedTokens = (urlInfo.userKey.usedTokens || 0) + usageCapture.input + usageCapture.output;
          cfg._keyUsageDirty = true;
        }
        // 有的反代渠道不给 usage: 退回本地估算, 否则悬浮球的上下文圈永远不动
        const __cpt = Math.max(1, Number((cfg.contextLimit || {}).charsPerToken) || 4);
        const __raw = analyzePrompt(canonical, __cpt);
        const __est = !usageCapture.input;
        const __inTok = usageCapture.input || Math.round(__raw.total * calibRatio(cfg, canonical.model));
        calibUpdate(cfg, canonical.model, usageCapture.input, __raw.total); // 自校准 EMA(真实/估算)
        const __pd = scaleDist(__raw.dist, __raw.total, usageCapture.input); // 有真实 usage 时归一到 input
        recordContext(cfg, canonical.model, __inTok, usageCapture.output, ch.name, __est, { cached: usageCapture.cached || 0, dist: __pd });
        // ===== Token 分布 + daily/byModel 累加 (2026-10-27) =====
        try {
          const __rd = respDist || { reasoning: 0, text: 0, tool: 0 };
          const __rdActual = usageCapture.reasoning ? usageCapture.reasoning : __rd.reasoning;
          const __textTok = Math.max(0, (usageCapture.output || 0) - __rdActual - __rd.tool);
          const __cacheSaved = usageCapture.cached || 0;
          stats.byModel = stats.byModel || {};
          const __bm = stats.byModel[canonical.model] = stats.byModel[canonical.model] || { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
          __bm.requests++; __bm.inputTokens += __inTok; __bm.outputTokens += usageCapture.output || 0; __bm.cached += __cacheSaved;
          const __day = new Date().toISOString().slice(0, 10);
          stats.daily = stats.daily || {};
          const __dd = stats.daily[__day] = stats.daily[__day] || { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cached: 0, dist: { tools: 0, system: 0, user: 0, history: 0, reasoning: 0, text: 0, tool: 0 } };
          __dd.requests++; if (status >= 400) __dd.errors++;
          __dd.inputTokens += __inTok; __dd.outputTokens += usageCapture.output || 0; __dd.cached += __cacheSaved;
          for (const __k of ['tools', 'system', 'user', 'history']) __dd.dist[__k] += __pd[__k] || 0;
          __dd.dist.reasoning += __rdActual; __dd.dist.text += __textTok; __dd.dist.tool += __rd.tool;
        } catch (__e) { try { logErr('[stat] 累加失败:', __e.message); } catch (_) {} }
        recordReq(status, ch.name, usageCapture.input, usageCapture.output);
      },
    };
    stats.byChannel[ch.name] = stats.byChannel[ch.name] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    stats.byChannel[ch.name].requests++;
    if (urlInfo.userKey) {
      const kn = urlInfo.userKey.name || (urlInfo.userKey.key || '').slice(0, 12);
      stats.byKey = stats.byKey || {};
      stats.byKey[kn] = stats.byKey[kn] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      stats.byKey[kn].requests++;
    }

    // 渠道级排队延迟(渠道字段 delayMs, 毫秒): 每个请求发出前先等待; 同一渠道的并发请求经 _gate 链按间隔串行发出(并发也撞不到上游), 缓解 429 限流
    const delayMs = Math.min(120000, Number(ch.delayMs) || 0);
    // 连接级错误 / HTML 冒充成功的同渠道重试(默认 cfg.connRetry=2 次, 每次换全新连接):
    // socket hang up 等错误发生在收到任何响应之前, 重试安全不会重复计费
    let connRetries = 0;
    const maxConnRetry = Math.max(0, Number(cfg.connRetry) || 0);
    // 429/5xx 的同渠道重试预算(每渠道独立); 未配置时默认 1 次
    let sameLeft = Math.max(0, Number(cfg.retrySame == null ? 1 : cfg.retrySame) || 0);
    const maxSame = sameLeft;
    // 返回 true = 已安排同渠道重试或切换下一候选; false = 没招了, 调用方走最终失败
    const retrySameOrNext = (why) => {
      if (connRetries < maxConnRetry) {
        connRetries++;
        log('RETRY', ctx.logMeta, why, '→ 同渠道重试 (' + connRetries + '/' + maxConnRetry + ')');
        setTimeout(() => doSend(true), 400 * connRetries);
        return true;
      }
      if (attempt < candidates.length) {
        log('ERR', ctx.logMeta, why, '→ 切换渠道');
        tryNext();
        return true;
      }
      return false;
    };
    const doSend = (fresh) => upstreamRequest(cfg, ch, built.url, built.headers, built.bodyBuf, (err, upRes, upReq) => {
      if (err) {
        lastErrStatus = 502; lastErrMsg = 'upstream request failed: ' + err.message;
        if (isConnErr(err)) {
          if (retrySameOrNext(err.message)) return;
        } else {
          log('ERR', ctx.logMeta, err.message, attempt < candidates.length ? '→ 切换渠道' : '→ 无更多渠道');
          if (attempt < candidates.length) return tryNext();
        }
        stats.errors++;
        recordReq(502, ch.name, 0, 0);
        return sendError(clientFormat, res, 502, lastErrMsg);
      }

      // 上游拿 HTML 网页冒充成功(CDN 验证页/中转站故障页): 视为可重试错误, 先重试本渠道再换渠道
      const upCt = String(upRes.headers['content-type'] || '');
      if (upRes.statusCode < 400 && /text\/html/i.test(upCt)) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = 502;
          lastErrMsg = '渠道 ' + ch.name + ' 返回了 HTML 网页而非数据(content-type: ' + upCt + '): ' + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 200);
          if (retrySameOrNext('upstream returned HTML (content-type: ' + upCt + ')')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          return sendError(clientFormat, res, 502, lastErrMsg);
        });
        upRes.on('error', () => {
          if (retrySameOrNext('read HTML response failed')) return;
          stats.errors++;
          recordReq(502, ch.name, 0, 0);
          try { sendError(clientFormat, res, 502, lastErrMsg || 'upstream HTML response read failed'); } catch (_) {}
        });
        return;
      }

      if (upRes.statusCode >= 400 && SAME_RETRYABLE.has(upRes.statusCode)
          && (sameLeft > 0 || attempt < candidates.length)) {
        // 429/5xx: 同渠道退避重试 → 用完预算再切下一个候选; 其他可重试错误照旧直接切
        const sc = upRes.statusCode;
        const ra = parseInt(String(upRes.headers['retry-after'] || ''), 10);
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          lastErrStatus = sc;
          lastErrMsg = `渠道 ${ch.name} 返回 ${sc}: ` + redactText(Buffer.concat(chunks).toString('utf8'), cfg.redact && cfg.redact.extra).slice(0, 300);
          if (sameLeft > 0) {
            sameLeft--;
            const wait = Math.min(15000, (!isNaN(ra) && ra > 0) ? ra * 1000 : 400 * Math.pow(2, maxSame - sameLeft - 1));
            stats.retries = (stats.retries || 0) + 1;
            log('RETRY', ctx.logMeta, 'status=' + sc, '→ 同渠道重试 ' + wait + 'ms (' + (maxSame - sameLeft) + '/' + maxSame + ')');
            setTimeout(() => doSend(true), wait);
            return;
          }
          log('RETRY', ctx.logMeta, 'status=' + sc, '→ 切换渠道 (' + (candidates.length - attempt) + ' 个剩余)');
          tryNext();
        });
        upRes.on('error', () => { tryNext(); });
        return;
      }

      // ★ Responses 直通降级 (2026-10-16): 客户端 /v1/responses 直通上游 /v1/responses 时,
      //   上游返回 404/405(该上游不支持 Responses 端点, 如旧版 vLLM/部分中转) → 自动改发
      //   /v1/chat/completions(同一渠道), 响应照常转回 responses 格式。每个渠道只降级一次。
      if (clientApi === 'responses' && built.direct && ch.type === 'openai'
          && (upRes.statusCode === 404 || upRes.statusCode === 405)) {
        ctx.respDg = ctx.respDg || {};
        if (!ctx.respDg[ch.name]) {
          ctx.respDg[ch.name] = true;
          const sc = upRes.statusCode;
          const dgBody = Buffer.from(JSON.stringify(BUILD_BODY.openai(myCanonical, { addUsage: ch.addUsage })));
          const dgHeaders = { authorization: 'Bearer ' + ch.apiKey };
          if (stream) dgHeaders.accept = 'text/event-stream';
          const dgBuilt = { url: joinUrl(ch.baseUrl, '/v1/chat/completions'), headers: dgHeaders, bodyBuf: dgBody, direct: false, stream: !!stream, upApi: 'chat' };
          upRes.resume(); // 丢弃原 404/405 body
          log('DOWNGRADE', ctx.logMeta, 'status=' + sc, '上游不支持 /v1/responses → 改 chat 转换重发');
          return upstreamRequest(cfg, ch, dgBuilt.url, dgHeaders, dgBody, (err2, upRes2, upReq2) => {
            if (err2) {
              lastErrStatus = 502; lastErrMsg = 'downgrade chat failed: ' + err2.message;
              log('ERR', ctx.logMeta, err2.message, '(downgrade chat)');
              stats.errors++;
              recordReq(502, ch.name, 0, 0);
              return sendError(clientFormat, res, 502, lastErrMsg);
            }
            if (upRes2.statusCode >= 400) {
              // chat 也失败(非 404/405 直通, 本来就是转换路径) → 透传 chat 的错误
              const c2 = [];
              upRes2.on('data', c => c2.push(c));
              upRes2.on('end', () => {
                stats.errors++;
                recordReq(upRes2.statusCode, ch.name, 0, 0);
                log('UPERR', ctx.logMeta, 'status=' + upRes2.statusCode, '(downgrade chat 也失败)');
                try {
                  res.writeHead(upRes2.statusCode, { 'Content-Type': upRes2.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
                  res.end(Buffer.concat(c2));
                } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
              });
              upRes2.on('error', () => { try { res.end(); } catch (_) {} });
              return;
            }
            handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes2, upReq2, dgBuilt, ctx, (why) => {
              lastErrStatus = 502; lastErrMsg = why;
              return retrySameOrNext(why);
            });
          }, undefined, undefined);
        }
      }

      if (upRes.statusCode >= 400) {
        // 不可重试错误(如 400) 或已是最后候选 → 原样透传错误
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          stats.errors++;
          recordReq(upRes.statusCode, ch.name, 0, 0);
          log('UPERR', ctx.logMeta, 'status=' + upRes.statusCode, attempt > 1 ? '(已尝试 ' + attempt + ' 个渠道)' : '');
          try {
            res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'X-AI-Gateway-Channel': hdrName(ch.name), ...corsHeaders() });
            res.end(Buffer.concat(chunks));
          } catch (e) { logErr('[resp] 错误透传响应头下发失败:', e.message); try { res.destroy(); } catch (_) {} }
        });
        upRes.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }

      // 成功(2xx) → 正常处理, 从此不可回退(正文非 JSON 冒充成功时仍可经 hook 重试)
      handleUpstreamResponse(cfg, ch, clientFormat, clientApi, myCanonical, body, urlInfo, req, res, upRes, upReq, built, ctx, (why) => {
        lastErrStatus = 502; lastErrMsg = why;
        return retrySameOrNext(why);
      });
    }, undefined, fresh ? makeFreshAgents(cfg, ch) : undefined);
    if (delayMs > 0) {
      ch._gate = (ch._gate || Promise.resolve()).catch(() => {}).then(() => new Promise(r => setTimeout(r, delayMs)));
      ch._gate.then(() => { try { doSend(); } catch (e) { try { sendError(clientFormat, res, 500, 'upstream dispatch failed: ' + e.message); } catch (_) {} } });
    } else {
      doSend();
    }
  };
  tryNext();
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, ctxp, instName, writeRequestRecord, postRequestRecord, handleUpstreamResponse, handleChat };
