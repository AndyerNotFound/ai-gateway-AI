'use strict';
/**
 * ctxp — global per-model context limits (warn / max, absolute tokens).
 *
 * Rules live in <DIR>/ctx-limits.json (shared by ALL gateway instances):
 *   { "rules": { "<model-glob>": { "max": 128000, "warn": 100000 } }, "_warnAt": { "<glob>": ts } }
 *
 * - `agw config ctxp <glob> max 200k warn 160k` writes rules via the admin API,
 *   which updates every running instance in place (no restart).
 * - max exceeded  -> request blocked with HTTP 400 (never reaches upstream).
 * - warn exceeded -> one TermuxBridge notification (throttled per rule, 5 min).
 * - Estimation reuses gateway's estimatePromptTokens (CJK ~1 tok/char, else cpt).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const DIR = __dirname;
const RULES_FILE = path.join(DIR, 'data', 'ctx-limits.json');
const WARN_THROTTLE_MS = 5 * 60 * 1000;

// raw JSON of the rules file we last loaded; pool reloads re-read only when changed
let _lastRaw = null;

function loadRules() {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    _lastRaw = raw;
    const j = JSON.parse(raw);
    return (j && typeof j.rules === 'object' && j.rules) || {};
  } catch (_) {
    return {};
  }
}

/** re-read rules only if the file changed since last load (cheap for pool reloads) */
function loadRulesIfChanged() {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf8');
    if (raw === _lastRaw) return undefined; // unchanged
    _lastRaw = raw;
    const j = JSON.parse(raw);
    return (j && typeof j.rules === 'object' && j.rules) || {};
  } catch (_) { return {}; }
}

function writeRules(rules) {
  let meta = {};
  try { const j = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); if (j && typeof j === 'object') meta = j; } catch (_) {}
  meta.rules = rules;
  fs.writeFileSync(RULES_FILE, JSON.stringify(meta, null, 2) + '\n');
}

/** glob with a single leading/trailing or middle '*' (case-insensitive, same spirit as gateway.globMatch) */
function globMatch(pat, str) {
  const esc = String(pat).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + esc + '$', 'i').test(String(str)); } catch (_) { return false; }
}

/** first matching rule entry for a model, or null */
function matchRule(rules, model) {
  const m = String(model || '');
  for (const [pat, r] of Object.entries(rules)) {
    if (!r || (Number(r.max) <= 0 && Number(r.warn) <= 0)) continue;
    if (pat === m || globMatch(pat, m)) return { pattern: pat, rule: r };
  }
  return null;
}

/** parse 200k / 1.5m / 128ki / 2mi / 4096 -> tokens (k=1000, ki=1024) */
function parseNum(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase().replace(/,/g, '');
  const m = /^([0-9]*\.?[0-9]+)\s*(ki|mi|k|m)?$/.exec(t);
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2];
  if (!u) return Math.round(n);
  if (u === 'k') return Math.round(n * 1000);
  if (u === 'm') return Math.round(n * 1000000);
  if (u === 'ki') return Math.round(n * 1024);
  if (u === 'mi') return Math.round(n * 1024 * 1024);
  return NaN;
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + 'm';
  if (n >= 1000 && n % 1000 === 0) return (n / 1000) + 'k';
  return String(n);
}

/** send one notification through TermuxBridge (TCP 127.0.0.1:8021, JSON line) */
function tbNotify(title, text) {
  return new Promise((resolve) => {
    let payload;
    try { payload = JSON.stringify({ cmd: 'notify', title: String(title || 'ai-gateway'), text: String(text || '') }) + '\n'; }
    catch (_) { return resolve(false); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    let s;
    try { s = net.connect(8021, '127.0.0.1'); } catch (_) { return resolve(false); }
    s.setTimeout(3000, () => finish(false));
    s.on('connect', () => s.write(payload));
    s.on('data', () => finish(true));       // bridge answers one JSON line; content not needed
    s.on('error', () => finish(false));
    s.on('close', () => finish(true));
  });
}

/** fire warn notification for a rule, throttled per pattern (in-memory, per process) */
const _warnAt = Object.create(null);
async function fireWarn(pattern, rule, model, est) {
  const now = Date.now();
  if (now - (_warnAt[pattern] || 0) < WARN_THROTTLE_MS) return false;
  _warnAt[pattern] = now;
  const ok = await tbNotify(
    'ai-gateway 上下文告警',
    '模型 ' + model + ' 估算 ' + fmtNum(est) + ' tokens 已超过 warn 上限 ' + fmtNum(rule.warn) + ' (规则: ' + pattern + ', max ' + fmtNum(rule.max || 0) + ')'
  );
  try {
    if (process.send) process.send({ ctxpWarn: true, pattern, model, est });
  } catch (_) {}
  console.log('[ctxp] warn: model=' + model + ' est=' + est + ' > warn=' + rule.warn + ' (rule ' + pattern + ')' + (ok ? '' : ' [bridge notify 不可用]'));
  return true;
}

/**
 * Check a canonical request against the global rules.
 * Returns { action: 'allow' } | { action: 'warn', est, rule, pattern } | { action: 'block', est, rule, pattern, limit }
 */
function check(rules, canonical, estimateFn) {
  const model = canonical && canonical.model;
  const hit = matchRule(rules, model);
  if (!hit) return { action: 'allow' };
  const { pattern, rule } = hit;
  const max = Math.max(0, Number(rule.max) || 0);
  const warn = Math.max(0, Number(rule.warn) || 0);
  const need = max > 0 || warn > 0;
  if (!need) return { action: 'allow' };
  const est = estimateFn(canonical);
  if (max > 0 && est > max) return { action: 'block', est, rule, pattern, limit: max };
  if (warn > 0 && est > warn) return { action: 'warn', est, rule, pattern };
  return { action: 'allow', est, pattern };
}

module.exports = {
  RULES_FILE, WARN_THROTTLE_MS,
  loadRules, loadRulesIfChanged, writeRules, matchRule, globMatch,
  parseNum, fmtNum, check, fireWarn, tbNotify,
};
