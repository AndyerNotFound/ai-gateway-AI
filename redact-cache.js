/* redact-cache.js — 隐私过滤: 规则编译 + 增量分块缓存 + 流式过滤器
 *
 * 核心思路: 对话请求每次都会把完整上下文重发一遍, 其中绝大多数内容
 * 与上次请求相同。用「内容定义分块(CDC) + 内容 hash 缓存」跳过已确认
 * 干净的部分, 只有没见过的/被修改过的块才真正跑正则过滤。
 *
 * 多级切割(用户指定):
 *   L1 整串 hash → 命中直接原样返回(零复制/零正则/零 CDC)
 *   L2 大块: min 4K / max 64K / avg 16K
 *   L3 中块: min 1K / max 4K / avg 2K   (L2 块未命中时递归)
 *   L4 小块: min 256 / max 1K / avg 512 (L3 块未命中时递归, 再小直接正则)
 *   → 局部修改只让「真正变化的微小块」失效, 其余块照常命中缓存
 *
 * 两个关键技术点(缺一不可):
 * 1. buzhash 滚动(固定 64B 窗口)替代 Gear(无限记忆):
 *    插入/删除只影响 ±64B 窗口内的切点, 错位传播 ≤1 块
 * 2. 安全切点 safeCut: 切点若落在 token 串中间, 先后移到整串末尾
 *    (密钥/JWT/邮箱/身份证/卡号长度无上限, 只靠固定窗口会切漏);
 *    再检查前后 OVERLAP 字符, 若有正则 match 横跨切点则后移。
 *
 * 快路径: 没有 extra 规则时, 整串扫描一遍「可能触发规则的特征」
 * (密钥前缀 / @ / 连续数字 / IPv4 形状), 完全没有就直接返回原串 ——
 * 普通对话不跑正则、不算 hash、不进缓存, 只剩一次字符扫描。
 *
 * 内容 hash: 双 FNV-1a 32 位拼 64 位(计算快; 5 万条碰撞概率 ~1e-10)
 * 缓存: CLEAN 标记(上限 10 万) + 脏块替换结果(上限 2000, 仅 ≤32K 的块)
 * 切点后移时, 块 hash 会继续覆盖完整块(见 cutChunks 的 pendingEnd),
 * 保证「指纹 == 内容」, 不会出现改了尾部仍命中旧块。
 *
 * ⚠️ extra 正则配置变化时结果可能不同 → 自动按指纹失效(或调用 reset())
 * (gateway.js 的 loadConfig() 已自动调用 reset())
 */
'use strict';

/* ---- buzhash 随机表: 固定种子确定性生成 ---- */
const BT = new Uint32Array(256);
{
  let seed = 0x12345678;
  for (let i = 0; i < 256; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    BT[i] = seed;
  }
}
const WINDOW = 64;          // buzhash 滚动窗口(字节): 切点判定位置无关
const OVERLAP = 128;        // 安全切点检查范围(字符)
const MAX_TOKEN_RUN = 16384; // 切点为了避开 token 串最多后移多少字符

/* ---- 多级 CDC 参数(字符) ---- */
const LEVELS = [
  { min: 4096,  max: 65536, mask: 0x3fff }, // L2: avg 16K
  { min: 1024,  max: 4096,  mask: 0x7ff },  // L3: avg 2K
  { min: 256,   max: 1024,  mask: 0x1ff },  // L4: avg 512
];
const MIN_TOP = LEVELS[0].min;

/* ---- FNV-1a 32 种子(两个不同种子 = 两个独立 32 位 hash) ---- */
const F1_SEED = 0x811c9dc5;
const F2_SEED = 0x01000193;

/* ---- 规则 ---- */
const BASE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g,            // OpenAI/DeepSeek/Anthropic 风格
  /\bgh[pou]_[A-Za-z0-9]{20,}/g,          // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /\bAKIA[0-9A-Z]{16}/g,                  // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g,            // Google
  /\bglpat-[A-Za-z0-9_-]{15,}/g,          // GitLab
  /\bhf_[A-Za-z0-9]{20,}/g,               // HuggingFace
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,     // 文本里粘贴的 Bearer 头
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                             // 邮箱
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,                                                         // 中国大陆手机号
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,  // 身份证
  /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?:[ -]?\d{1,3})?(?!\d)/g,                             // 银行卡(过 Luhn 才打码)
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, // 内网 IPv4
];
/* 规则最低限度的字面特征: 有任意一个才可能命中 BASE_PATTERNS */
const PREFIX_HINTS = ['sk-', 'ghp_', 'gho_', 'ghu_', 'github_pat_', 'xox', 'AKIA', 'AIza', 'glpat-', 'hf_', 'Bearer'];
/* 快路径门槛(单次字符扫描, 比正则快一个数量级):
 * 只有出现 @ / ≥11 位连续数字(允许单个空格/连字符分隔) / IPv4 形状 / 密钥前缀
 * 时才需要跑正则。普通叙事里零散的数字不会触发。 */
function quickHit(s) {
  const n = s.length;
  let digits = 0, sep = 0, seg = 0, dots = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {                 // 0-9
      digits++; sep = 0; seg++;
      if (digits >= 11) return true;
    } else if ((c === 32 || c === 45) && digits > 0 && sep === 0) {
      sep = 1; dots = 0; seg = 0;             // 数字之间允许一个空格/连字符(卡号/手机号); IP 不含空格
    } else if (c === 46 && seg >= 1 && seg <= 3 && dots < 3) {  // .
      dots++; seg = 0;
    } else {
      if (dots >= 3) return true;             // 1.2.3.4 形状
      if (c === 64) return true;              // @
      digits = 0; sep = 0; seg = 0; dots = 0;
    }
  }
  if (dots >= 3) return true;
  for (let i = 0; i < PREFIX_HINTS.length; i++) if (s.indexOf(PREFIX_HINTS[i]) !== -1) return true;
  return false;
}

const ID_SHAPE = /^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/;

function luhn(d) {
  if (d.length < 13) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
/* 统一替换回调: 卡号要过 Luhn(避免把普通长数字全打码), 身份证形状直接打码 */
function repl(m) {
  if (m.length >= 16 && /^[\d -]+$/.test(m)) {
    if (ID_SHAPE.test(m)) return '***';
    if (!luhn(m.replace(/\D/g, ''))) return m;
  }
  return '***';
}

/* ---- 编译 & 缓存(按 extra 指纹) ---- */
function extraFingerprint(extra) {
  if (!extra || !extra.length) return 0;
  let h = 0xdeadbeef;
  for (const p of extra) {
    if (typeof p !== 'string') continue;
    for (let i = 0; i < p.length; i++) h = (Math.imul(h ^ p.charCodeAt(i), 0x01000193)) >>> 0;
  }
  return h;
}
function buildMaster(extra) {
  const parts = BASE_PATTERNS.map(re => '(?:' + re.source + ')');
  if (extra) for (const p of extra) {
    if (typeof p !== 'string' || !p) continue;
    try { new RegExp(p); parts.push('(?:' + p + ')'); } catch (_) {}
  }
  return new RegExp(parts.join('|'), 'g');
}
let rulesCache = { key: null, re: null, hasExtra: false };
function getRules(extra) {
  const hasExtra = !!(extra && extra.length);
  const key = hasExtra ? extraFingerprint(extra) : 0;
  if (rulesCache.key !== key || !rulesCache.re || rulesCache.hasExtra !== hasExtra) {
    const prev = rulesCache.key;
    rulesCache = { key, re: buildMaster(hasExtra ? extra : null), hasExtra };
    if (prev !== null) reset();   // 规则变了 → 旧缓存(尤其脏块结果)必须作废
  }
  return rulesCache;
}
function plainRedact(s, rules) {
  if (!rules.hasExtra && !quickHit(s)) return s;
  return s.replace(rules.re, repl);
}

/* ---- 缓存 ---- */
const CLEAN = Symbol('clean');
const cleanCache = new Map();   // key(BigInt) → CLEAN
const dirtyCache = new Map();   // key(BigInt) → 替换后字符串
const CLEAN_MAX = 100000;
const DIRTY_MAX = 2000;
const DIRTY_MAX_LEN = 32768;    // 超过此长度的脏块不缓存结果(防内存)
let cacheHits = 0, cacheMiss = 0;

function trimCache(map, max) {
  if (map.size <= max) return;
  let del = map.size - max + (max >> 2); // 删到 max 之下再留 1/4 余量
  for (const k of map.keys()) { if (del-- <= 0) break; map.delete(k); }
}

/* 配置(extra)变化时必须调用 */
function reset() { cleanCache.clear(); dirtyCache.clear(); cacheHits = 0; cacheMiss = 0; }
function stats() { return { clean: cleanCache.size, dirty: dirtyCache.size, hits: cacheHits, miss: cacheMiss }; }

function keyOf(a, b) { return (BigInt(a) << 32n) | BigInt(b >>> 0); }
function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

/* token 串字符: 各类密钥/JWT/邮箱/数字串的公共字符集(含 @ 以便邮箱整体后移) */
function isTok(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
         c === 45 || c === 46 || c === 95 || c === 126 || c === 43 || c === 64 || c === 37;
}

/* 安全切点: ①不切在 token 串中间 ②不切在跨切点的正则 match 中间。
 * 返回 ≤ end 的切点。 */
function safeCut(s, cutAt, end, rules) {
  let c = Math.min(cutAt, end);
  if (c <= 0 || c >= end) return c;
  /* ① token 串整体后移(长度无上限的密钥最容易在这里被切漏) */
  if (isTok(s.charCodeAt(c - 1)) || isTok(s.charCodeAt(c))) {
    const lim = Math.min(end, c + MAX_TOKEN_RUN);
    let e = c;
    while (e < lim && isTok(s.charCodeAt(e))) e++;
    if (e > c && !(e >= lim && e < end)) c = e;  // 超长 token: 放弃后移, 走正则窗口兜底
    if (c >= end) return end;
  }
  /* ② 正则 match 横跨切点 → 后移到 match 结束 */
  for (let guard = 0; guard < 8; guard++) {
    const ws = Math.max(0, c - OVERLAP), we = Math.min(end, c + OVERLAP);
    const win = s.slice(ws, we);
    if (!rules.hasExtra && !quickHit(win)) return c; // 窗口无敏感特征, 直接切
    const off = c - ws;
    let moved = false;
    rules.re.lastIndex = 0;
    let m;
    while ((m = rules.re.exec(win)) !== null) {
      if (m[0].length === 0) { rules.re.lastIndex++; continue; }
      if (m.index < off && m.index + m[0].length > off) {
        c = ws + m.index + m[0].length;
        moved = true;
        break;
      }
    }
    if (!moved) return c;
  }
  return c;
}

/* 短串(< 顶层 min): 整串 hash → 命中返回原引用; 未命中跑正则并缓存结果 */
function lookupShort(s, rules) {
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const key = keyOf(f1, f2);
  if (cleanCache.has(key)) { cacheHits++; return s; }
  const dirty = dirtyCache.get(key);
  if (dirty !== undefined) { cacheHits++; return dirty; }
  cacheMiss++;
  const out = plainRedact(s, rules);
  if (out === s) { cleanCache.set(key, CLEAN); return s; }
  if (s.length <= DIRTY_MAX_LEN) dirtyCache.set(key, out);
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return out;
}

/* 对 [start, end) 做该层 CDC 切块(buzhash + 安全切点), 同时算每块双 FNV。
 * pendingEnd: safeCut 把切点后移后, 继续把中间字符计入本块 hash/滚动窗口,
 * 到点再落块 —— 保证块指纹覆盖完整块内容。 */
function cutChunks(s, start, end, level, rules) {
  let h = 0;
  let cf1 = F1_SEED, cf2 = F2_SEED;
  let cs = start;
  let pendingEnd = -1;
  const chunks = [];
  const win = new Uint8Array(WINDOW);
  let wpos = 0, wcount = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const b = c & 0xff;
    h = rotl32(h, 1) ^ BT[b];
    if (wcount >= WINDOW) h ^= rotl32(BT[win[wpos]], WINDOW);
    else wcount++;
    win[wpos] = b;
    wpos = (wpos + 1) % WINDOW;
    cf1 = Math.imul(cf1 ^ c, 0x01000193) >>> 0;
    cf2 = Math.imul(cf2 ^ c, 0x01000193) >>> 0;

    const pos = i + 1;
    if (pendingEnd > 0) {
      if (pos === pendingEnd) {
        chunks.push({ s: cs, e: pos, f1: cf1, f2: cf2 });
        cs = pos; cf1 = F1_SEED; cf2 = F2_SEED; pendingEnd = -1;
      }
      continue;
    }
    const size = pos - cs;
    if (size < level.min) continue;
    let cutAt = -1;
    if (size >= level.max) cutAt = pos;
    else if ((h & level.mask) === 0) cutAt = pos;
    if (cutAt <= 0) continue;
    const safe = safeCut(s, cutAt, end, rules);
    if (safe >= end) { pendingEnd = end; continue; }        // 一直不切到块尾
    if (safe <= pos) {                                       // 原地切
      chunks.push({ s: cs, e: pos, f1: cf1, f2: cf2 });
      cs = pos; cf1 = F1_SEED; cf2 = F2_SEED;
    } else {
      pendingEnd = safe;                                     // 继续计 hash 到 safe
    }
  }
  if (pendingEnd > 0) { chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 }); cs = end; }
  if (cs < end) chunks.push({ s: cs, e: end, f1: cf1, f2: cf2 });
  return chunks;
}

/* 递归处理一块: 命中缓存跳过; 未命中下钻到更小层; 到底层才跑正则。
 * 返回 { text, allClean } */
function processChunk(s, start, end, rules, li) {
  const len = end - start;
  if (li >= LEVELS.length || len < LEVELS[li].min) {
    const sub = (start === 0 && end === s.length) ? s : s.slice(start, end);
    const out = plainRedact(sub, rules);
    return { text: out, allClean: out === sub };
  }
  const level = LEVELS[li];
  const chunks = cutChunks(s, start, end, level, rules);
  let allClean = true;
  const parts = [];
  for (const c of chunks) {
    const k = keyOf(c.f1, c.f2);
    if (cleanCache.has(k)) { cacheHits++; parts.push(s.slice(c.s, c.e)); continue; }
    const dirty = dirtyCache.get(k);
    if (dirty !== undefined) { cacheHits++; parts.push(dirty); allClean = false; continue; }
    cacheMiss++;
    const sub = processChunk(s, c.s, c.e, rules, li + 1);
    if (sub.allClean) {
      cleanCache.set(k, CLEAN);
      parts.push(s.slice(c.s, c.e)); // 零复制
    } else {
      allClean = false;
      if ((c.e - c.s) <= DIRTY_MAX_LEN && sub.text.length <= DIRTY_MAX_LEN) dirtyCache.set(k, sub.text);
      parts.push(sub.text);
    }
  }
  trimCache(cleanCache, CLEAN_MAX);
  trimCache(dirtyCache, DIRTY_MAX);
  return { text: parts.join(''), allClean };
}

/* ---- 对外: 文本过滤 ---- */
function redactSmart(s, extra) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const rules = getRules(extra);
  if (!rules.hasExtra && !quickHit(s)) return s; // 快路径: 普通文本零开销
  const len = s.length;
  if (len < MIN_TOP) return lookupShort(s, rules);

  /* L1: 整串双 FNV(廉价扫描), 命中直接返回原引用 */
  let f1 = F1_SEED, f2 = F2_SEED;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    f1 = Math.imul(f1 ^ c, 0x01000193) >>> 0;
    f2 = Math.imul(f2 ^ c, 0x01000193) >>> 0;
  }
  const allKey = keyOf(f1, f2);
  if (cleanCache.has(allKey)) { cacheHits++; return s; }

  const res2 = processChunk(s, 0, len, rules, 0);
  if (res2.allClean) { cleanCache.set(allKey, CLEAN); return s; }
  return res2.text;
}

/* ---- 对外: 响应流式过滤 ----
 * 把流式文本攒在缓冲区, 只放出「不可能被后续分片改写成敏感串」的前缀。
 * 尾部 token 串(密钥/JWT/邮箱/数字串)与残余前缀整体回压, 避免密钥被
 * SSE 分片切成两半而漏打码。 */
const HOLD = 16;         // 至少回压的字符数(覆盖最长前缀 github_pat_ 11 + 余量)
const MAX_STREAM_HOLD = 16384;

function digitGroupEnd(buf, k, n) {
  const isD = c => c >= 48 && c <= 57;
  const isSep = c => isD(c) || c === 32 || c === 45;
  if (!((k > 0 && isD(buf.charCodeAt(k - 1))) || (k < n && isD(buf.charCodeAt(k))))) return k;
  let a = k, b = k;
  while (a > 0 && isSep(buf.charCodeAt(a - 1))) a--;
  while (b < n && isSep(buf.charCodeAt(b))) b++;
  const seg = buf.slice(a, b);
  let digits = 0;
  for (let i = 0; i < seg.length; i++) { const c = seg.charCodeAt(i); if (c >= 48 && c <= 57) digits++; }
  return digits >= 11 ? b : k;   // 手机号/身份证/卡号(允许空格/连字符分隔)
}

function streamFlushLen(buf) {
  const n = buf.length;
  if (n <= HOLD) return 0;
  let k = n - HOLD;
  /* 切点落在敏感串中间 → 后移到串尾, 整串留给下一轮 */
  for (let guard = 0; guard < 3; guard++) {
    let moved = false;
    if (isTok(buf.charCodeAt(k - 1)) && isTok(buf.charCodeAt(k))) {
      let e = k;
      while (e < n && isTok(buf.charCodeAt(e))) e++;
      k = e; moved = true;
    }
    const d = digitGroupEnd(buf, k, n);
    if (d > k) { k = d; moved = true; }
    if (k >= n) {
      if (n <= MAX_STREAM_HOLD) return 0;
      k = n - MAX_STREAM_HOLD;
      break;
    }
    if (!moved) break;
  }
  /* 已出现但还没等到 token 的敏感前缀: 从该前缀起全部回压 */
  for (let i = 0; i < PREFIX_HINTS.length; i++) {
    const idx = buf.lastIndexOf(PREFIX_HINTS[i], n - 1);
    if (idx >= 0 && idx < k && n - idx <= MAX_STREAM_HOLD) k = idx;
  }
  if (n - k > MAX_STREAM_HOLD) k = n - MAX_STREAM_HOLD;
  return Math.max(0, Math.min(k, n));
}

function createStreamFilter(extra) {
  let buf = '';
  return {
    push(t) {
      if (t == null) return '';
      buf += String(t);
      const k = streamFlushLen(buf);
      if (k <= 0) return '';
      const out = redactSmart(buf.slice(0, k), extra);
      buf = buf.slice(k);
      return out;
    },
    flush() {
      if (!buf) return '';
      const out = redactSmart(buf, extra);
      buf = '';
      return out;
    },
    pending() { return buf.length; },
  };
}

module.exports = {
  redactSmart, createStreamFilter, reset, stats,
  LEVELS, MIN_CHUNK: MIN_TOP,
  _internals: { safeCut, streamFlushLen, luhn, quickHit, MAX_TOKEN_RUN, OVERLAP },
};
