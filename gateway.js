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
const { loadConfig, normalizeProxy } = require('./config');
const { logErr, VERSION } = require('./util');
const { saveKeyUsage, pickChannel, pickChannels, collectModels, matchContextWindow, recordContext, globMatch, estimatePromptTokens, estimatePromptDist, analyzePrompt, calibRatio, calibUpdate, estPromptAdj, scaleDist, checkAuth, loadKeyUsage, keyUsageFile, hashPassword, verifyPassword, keyCreditsJSON, genApiKey } = require('./router');
const { flushStats, createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute, RESERVED_PATHS, INST_NAME_RE } = require('./pool');
const { startServer } = require('./server');
const { joinUrl, truncateReasoning, summarizeReasoningText, wrapThinkingSummary, callUpstreamText, balanceTarget, presetForChannel, fetchChannelBalance, fetchBalanceCached, pickBalanceChannel, BALANCE_PRESETS, balanceChannelList, balanceAggregate, balanceFxRate, probeRound, probeOnce, setupProbe } = require('./upstream');
const { RETRYABLE, chUsesResponses, buildRequestForChannel } = require('./sync');
const { openaiToCanonical, claudeToCanonical, geminiToCanonical, canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody, openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical, canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp, responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp, ResponsesStreamParser, makeResponsesWriter, SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish } = require('./convert');
const { socks5Connect, httpConnect, dialViaProxy, makeReader } = require('./proxy');
const state = require('./state');
const rt = require('./runtime');

// ================= main (assembly entry) =================
/* ================= main ================= */
function main() {
  const args = process.argv.slice(2);
  let configPath = path.join(__dirname, 'data', 'config.json');
  let portOverride;
  for (const a of args) {
    if (/^\d+$/.test(a)) portOverride = Number(a);
    else configPath = a;
  }
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    logErr('配置加载失败:', e.message);
    process.exit(1);
  }
  if (!cfg.channels.length) logErr('⚠ 配置里没有任何有效渠道, 请求会返回 503');
  process.on('unhandledRejection', e => logErr('unhandledRejection:', (e && e.message) || e));
  process.on('uncaughtException', e => logErr('uncaughtException:', (e && e.message) || e));
  process.on('SIGTERM', () => { const cs = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : [cfg]; for (const c of cs) { try { saveKeyUsage(c); } catch (_) {} try { flushStats(c); } catch (_) {} } try { rt.PLUGINS && rt.PLUGINS.flushAll(); } catch (_) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
// Defaults to single-process multi-instance mode (hosts all config*.json in the dir); AGW_SINGLE=1 or an explicit port arg falls back to a single instance
  const multi = portOverride == null && process.env.AGW_SINGLE !== '1';
  startServer(cfg, { port: portOverride, multi }).catch(e => { logErr('启动失败:', e.message); process.exit(1); });
}

if (require.main === module) main();

module.exports = {
  VERSION, loadConfig, normalizeProxy, joinUrl, pickChannel, pickChannels, collectModels, RETRYABLE,
  matchContextWindow, recordContext, globMatch, estimatePromptTokens, estimatePromptDist, analyzePrompt,
  calibRatio, calibUpdate, estPromptAdj, scaleDist,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp,
  ResponsesStreamParser, makeResponsesWriter, chUsesResponses, buildRequestForChannel,
  SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish,
  socks5Connect, httpConnect, dialViaProxy, makeReader,
  truncateReasoning, summarizeReasoningText, wrapThinkingSummary, callUpstreamText,
  startServer, checkAuth,
  balanceTarget, presetForChannel, fetchChannelBalance, fetchBalanceCached, pickBalanceChannel, BALANCE_PRESETS,
  balanceChannelList, balanceAggregate, balanceFxRate,
  createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute,
  RESERVED_PATHS, INST_NAME_RE,
  loadKeyUsage, saveKeyUsage, keyUsageFile,
  hashPassword, verifyPassword, keyCreditsJSON, genApiKey,
  probeRound, probeOnce, setupProbe,
};
