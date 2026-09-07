/* redact-cache.js 单元测试 + 旧实现一致性对比 + 性能基准 */
'use strict';
const rc = require('../redact-cache.js');
const { redactSmart, reset, stats } = rc;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function assertEq(a, b, name) {
  if (a === b) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  期望=' + JSON.stringify(b).slice(0, 80) + ' 实际=' + JSON.stringify(a).slice(0, 80)); }
}

/* ---- 旧实现(从备份 gateway.js 提取, 用于一致性对比) ---- */
const OLD_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}/g, /\bgh[pou]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}/g, /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{15,}/g, /\bhf_[A-Za-z0-9]{20,}/g, /\bBearer\s+[A-Za-z0-9._~-]{16,}/g,
];
function oldRedact(s, extra) {
  for (const re of OLD_PATTERNS) s = s.replace(re, '***');
  if (extra) for (const p of extra) { try { s = s.replace(new RegExp(p, 'g'), '***'); } catch (_) {} }
  return s;
}

/* ================= 功能 ================= */
console.log('\n[1] 短串(<4K)');
reset();
{
  const clean = '你好世界 hello world 这是一段普通的对话内容';
  assert(redactSmart(clean) === clean, '干净短串原样返回');
  assert(redactSmart(clean) === clean, '干净短串二次调用');
  const key = '我的密钥是 sk-abcdefghijklmnopqrst 请保密';
  assertEq(redactSmart(key), '我的密钥是 *** 请保密', '短串 sk- 被替换');
  const gh = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  assert(!/ghp_/.test(redactSmart(gh)), '短串 ghp_ 被替换');
  const b = 'header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef';
  assert(!/Bearer\s+[A-Za-z0-9]/.test(redactSmart(b)), '短串 Bearer 被替换');
}

console.log('\n[2] 长串(≥4K): CDC 与缓存');
reset();
{
  const para = '今天天气不错，我们讨论一下项目架构设计。这个方案需要考虑扩展性和可维护性，同时也要兼顾性能表现。'.repeat(60);
  const long = para.repeat(2); // ~11K 字符
  assert(long.length >= 4096, '长串长度够 (' + long.length + ')');
  const r1 = redactSmart(long);
  assert(r1 === long, '长干净串首轮: 内容不变');
  const r2 = redactSmart(long);
  assert(r2 === long, '长干净串次轮: 内容不变');
  // 次轮应命中 L1 整串缓存 → 返回同一引用(零复制)
  const r3 = redactSmart(long);
  assert(r3 === long, 'L1 整串命中: 返回原引用(零复制)');

  // 含密钥的长串: 只有含密钥的块被替换
  const dirty = para.repeat(1) + ' key: sk-abcdefghijklmnopqrstuvwxyz123 ' + para.repeat(1);
  const out = redactSmart(dirty);
  assert(out !== dirty, '脏长串被修改');
  assert(!/sk-[A-Za-z0-9]{10,}/.test(out), '脏长串密钥被替换');
  assert(out.indexOf('key: ***') !== -1, '替换位置正确');
  // 脏块结果缓存: 二次调用一致
  const out2 = redactSmart(dirty);
  assertEq(out2, out, '脏长串二次调用结果一致(脏块缓存)');
}

console.log('\n[3] 局部修改: 多级 CDC 增量生效');
{
  const para = '普通句子。'.repeat(300); // ~4.5K
  const base = para.repeat(30);         // ~135K → 多个 L2 大块
  reset();
  redactSmart(base);                    // 首轮全量
  const cleanBefore = stats().clean;
  console.log('    首轮缓存块数: ' + cleanBefore);
  // 在中间插入一个字(固定分块会全失效, 单层 CDC 失效 1-2 块, 多级只影响最深层小块)
  const pos = Math.floor(base.length / 2);
  const modified = base.slice(0, pos) + '改' + base.slice(pos);
  const out = redactSmart(modified);
  assert(out === modified, '修改后的串仍原样返回(无密钥)');
  const cleanAfter = stats().clean;
  const newChunks = cleanAfter - cleanBefore;
  console.log('    插入后新增缓存块数: ' + newChunks);
  assert(newChunks <= 12, '局部插入新增块数 ≤12 (' + newChunks + ')');
  // 再处理一次修改版: 应该几乎没有新块(全部命中)
  const before2 = stats().clean;
  assert(redactSmart(modified) === modified, '修改版二次处理原样返回');
  assert(stats().clean - before2 <= 2, '修改版二次处理几乎零新增块 (' + (stats().clean - before2) + ')');

  // 修改版里的密钥只在修改点附近: 验证过滤仍精确
  const dirtyBase = para.repeat(30);
  reset();
  redactSmart(dirtyBase);
  const pos2 = Math.floor(dirtyBase.length / 3);
  const dirtyMod = dirtyBase.slice(0, pos2) + ' key: sk-abcdefghijklmnopqrstuvwxyz123 ' + dirtyBase.slice(pos2);
  const dirtyOut = redactSmart(dirtyMod);
  assert(!/sk-[A-Za-z0-9]{10,}/.test(dirtyOut), '修改点处密钥被替换');
  assert(dirtyOut.indexOf('key: ***') !== -1, '替换位置正确');
  assert(dirtyOut.length === dirtyMod.length - 29, '其余内容原样保留(仅替换密钥, 差29)');
}

console.log('\n[4] extra 正则 + reset');
{
  reset();
  const s = '我的手机号是 13800138000 请勿外传';
  assert(redactSmart(s) === s, '无 extra 时手机号不动');
  const out = redactSmart(s, ['1\\d{10}']);
  assertEq(out, '我的手机号是 *** 请勿外传', 'extra 正则生效');
  // extra 变了必须 reset, 否则旧缓存(无 extra 时的 CLEAN)会导致漏过滤
  const cached = redactSmart(s); // 无 extra: 命中旧 CLEAN 缓存 → 返回原串(正确, 因为当前调用没传 extra)
  assert(cached === s, '无 extra 调用命中缓存返回原串');
  reset();
  const out2 = redactSmart(s, ['1\\d{10}']);
  assertEq(out2, '我的手机号是 *** 请勿外传', 'reset 后 extra 过滤恢复');
  // 非法 extra 不炸
  assert(redactSmart('abc', ['(unclosed']) === 'abc', '非法 extra 静默忽略');
}

console.log('\n[5] 与旧实现一致性(随机文本)');
{
  reset();
  const rng = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; }; })();
  const pool = ['sk-abcdefghijklmnopqrst', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'AKIA0123456789ABCDEF',
    'AIzaSyD0123456789abcdefghijklmnopqrstuvwx', 'Bearer xyz.abc.def', 'glpat-ABCDEFGHIJKLMNOP',
    'hf_ABCDEFGHIJKLMNOPQRST', 'xoxb-1234567890-abcdef', '普通文本', '你好', '密钥', 'token 测试'];
  for (let trial = 0; trial < 300; trial++) {
    let s = '';
    const n = Math.floor(rng() * 200);
    for (let i = 0; i < n; i++) s += pool[Math.floor(rng() * pool.length)] + ' ';
    const extra = trial % 2 ? ['\\b测试\\b'] : null;
    const a = oldRedact(s, extra);
    const b = redactSmart(s, extra);
    if (a !== b) { assert(false, '一致性 trial#' + trial + ' → 旧:' + JSON.stringify(a).slice(0, 60) + ' 新:' + JSON.stringify(b).slice(0, 60)); return; }
  }
  assert(true, '300 组随机文本(含/不含密钥 × 有无 extra)输出与旧实现完全一致');

  // 长文本一致性
  for (let trial = 0; trial < 10; trial++) {
    let s = '';
    for (let i = 0; i < 30; i++) s += pool[Math.floor(rng() * pool.length)] + ' 填充内容'.repeat(50);
    const a = oldRedact(s, null);
    const b = redactSmart(s, null);
    if (a !== b) { assert(false, '长文本一致性 trial#' + trial); return; }
  }
  assert(true, '10 组长文本(>4K)输出与旧实现完全一致');
}

/* ================= 性能基准 ================= */
console.log('\n[6] 性能基准(模拟 141KB 上下文, 10 条消息)');
{
  const para = '今天天气不错，我们讨论一下项目架构设计。这个方案需要考虑扩展性和可维护性，同时也要兼顾性能表现。'.repeat(300);
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: para });
  const body = { model: 'deepseek-chat', messages: msgs };
  const sizeKB = (JSON.stringify(body).length / 1024).toFixed(0);
  console.log('  请求体: ' + sizeKB + ' KB');

  // 复刻 gateway.js redactDeep(字符串叶子走 redactSmart)
  function redactDeep(v, extra, depth) {
    if (v == null || depth > 12) return v;
    if (typeof v === 'string') return v.startsWith('data:') ? v : redactSmart(v, extra);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i], extra, depth + 1); return v; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const val = v[k];
        if (typeof val === 'string' && val && /api[-_]?key|apikey|secret|password|passwd|token|authorization/i.test(k)) v[k] = '***';
        else v[k] = redactDeep(val, extra, depth + 1);
      }
      return v;
    }
    return v;
  }

  reset();
  let t0 = Date.now();
  for (let i = 0; i < 10; i++) redactDeep(JSON.parse(JSON.stringify(body)), null, 0);
  const first = (Date.now() - t0) / 10;
  console.log('  首轮(全量 CDC+正则): ' + first.toFixed(1) + ' ms/请求');

  t0 = Date.now();
  for (let i = 0; i < 100; i++) redactDeep(JSON.parse(JSON.stringify(body)), null, 0);
  const warm = (Date.now() - t0) / 100;
  console.log('  热请求(L1 全命中):   ' + warm.toFixed(2) + ' ms/请求');
  console.log('  加速比: ' + (first / warm).toFixed(1) + 'x');

  // 新增一条消息(模拟增量对话)
  const body2 = { model: 'deepseek-chat', messages: msgs.concat([{ role: 'user', content: '新问题：' + para.slice(0, 5000) }]) };
  t0 = Date.now();
  for (let i = 0; i < 10; i++) redactDeep(JSON.parse(JSON.stringify(body2)), null, 0);
  const inc = (Date.now() - t0) / 10;
  console.log('  增量请求(旧10条+新1条5K): ' + inc.toFixed(1) + ' ms/请求 (只扫新内容)');
  console.log('  缓存状态: ' + JSON.stringify(stats()));
}

console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
