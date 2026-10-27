'use strict';
/* 隐私过滤测试
 * 覆盖: ① 内置规则(API Key/Bearer/邮箱/手机号/身份证/银行卡/内网IP)  ② 非敏感长数字不误伤
 *       ③ 无特征文本快路径(零复制)  ④ 长 token 跨 CDC 切点不漏  ⑤ extra 规则与缓存失效
 *       ⑥ 流式过滤(逐字符/随机分片)与整串结果一致
 * 跑法: node test/redact_test.js
 */
const R = require('../redact-cache.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

/* ① 内置规则 */
eq(R.redactSmart('key sk-abcdefghijklmnopqrstuvwx'), 'key ***', 'sk- 密钥');
eq(R.redactSmart('token ghp_abcdefghijklmnopqrstuvwxyz'), 'token ***', 'GitHub token');
eq(R.redactSmart('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: ***', 'Bearer');
eq(R.redactSmart('mail me: user.name+tag@example.co.uk'), 'mail me: ***', '邮箱');
eq(R.redactSmart('tel 13800138000 ok'), 'tel *** ok', '手机号');
eq(R.redactSmart('id 110105199003071234 ok'), 'id *** ok', '身份证');
eq(R.redactSmart('card 4111 1111 1111 1111 ok'), 'card *** ok', '银行卡(带空格, Luhn 通过)');
eq(R.redactSmart('host 192.168.100.20'), 'host ***', '内网 IPv4');

/* ② 误伤控制 */
eq(R.redactSmart('order 1234567890123456 done'), 'order 1234567890123456 done', '非 Luhn 长数字不误伤');
eq(R.redactSmart('date 2026-10-27 12:00'), 'date 2026-10-27 12:00', '日期不误伤');
eq(R.redactSmart('v1.2.3 build 7654321'), 'v1.2.3 build 7654321', '短数字不误伤');

/* ③ 快路径: 普通大文本原引用返回(不复制/不进缓存) */
const plain = ('这是一段普通对话内容, 用来模拟很长的上下文. ' + 'normal words, punctuation! 42. ').repeat(2000);
ok(R.redactSmart(plain) === plain, '无敏感特征文本走快路径(引用相同)');

/* ④ 长 token 跨块: 在多种偏移下都不能漏 */
const tok = 'A'.repeat(900);
const bearerLeak = (off) => {
  const s = 'x'.repeat(120000 + off) + ' Bearer ' + tok + ' tail';
  const out = R.redactSmart(s);
  return out.includes(tok.slice(0, 64)) || out.includes(tok.slice(-64));
};
for (const off of [0, 7, 101, 999, 4097, 12345]) ok(!bearerLeak(off), '长 Bearer token 跨块不漏 (offset=' + off + ')');
const skTok = 'sk-' + 'B'.repeat(600);
const s2 = 'y'.repeat(90000) + ' ' + skTok + ' z';
ok(!R.redactSmart(s2).includes('B'.repeat(64)), '超长 sk- 密钥跨块不漏');

/* ⑤ extra 规则 + 指纹切换 */
eq(R.redactSmart('id EMP-42 ok', ['EMP-\\d+']), 'id *** ok', 'extra 规则生效');
eq(R.redactSmart('id EMP-42 ok'), 'id EMP-42 ok', '去掉 extra 后缓存自动失效');
eq(R.redactSmart('id DEV-7 ok', ['DEV-\\d']), 'id *** ok', '更换 extra 规则后立即生效');

/* ⑥ 流式: 任意分片都必须与整串过滤结果一致 */
const secrets = [
  'sk-abcdefghijklmnopqrstuvwxyz012345', 'Bearer ' + 'Q'.repeat(900),
  'user.name+tag@example.co.uk', '13800138000', '110105199003071234',
  '192.168.100.200', '4111 1111 1111 1111',
];
let s = '';
for (let i = 0; i < 30; i++) s += '这是普通内容 with words, punctuation! 12345. ' + (i % 7 === 0 ? secrets[i % secrets.length] : '');
s += ' END';
const full = R.redactSmart(s);
for (const step of [1, 3, 7, 53]) {
  const f = R.createStreamFilter();
  let out = '';
  for (let i = 0; i < s.length; i += step) out += f.push(s.slice(i, i + step));
  out += f.flush();
  ok(out === full, '流式分片(' + step + ')结果与整串一致');
  ok(!/Q{64}|B{64}/.test(out) && !out.includes('13800138000') && !out.includes('example.co.uk'), '流式分片(' + step + ')无泄漏');
}
/* extra 规则在流式里同样生效 */
{
  const ef = R.createStreamFilter(['EMP-[0-9]+']);
  let eo = '';
  for (let i = 0; i < '员工 EMP-12345 打卡'.length; i += 2) eo += ef.push('员工 EMP-12345 打卡'.slice(i, i + 2));
  eo += ef.flush();
  eq(eo, '员工 *** 打卡', 'extra 规则的流式过滤');
}
/* 空输入 / undefined 不炸 */
eq(R.redactSmart(''), '', '空串');
eq(R.redactSmart(undefined), undefined, 'undefined');
const emptyF = R.createStreamFilter();
eq(emptyF.push(''), '', '流式空分片');
eq(emptyF.flush(), '', '流式空收尾');

/* ⑦ 同前缀不同尾部: 缓存不能把旧打码结果套到新内容上 */
R.reset();
const p = 'z'.repeat(5000) + ' sk-AAAAAAAAAAAAAAAAAAAAA';
const q = 'z'.repeat(5000) + ' sk-BBBBBBBBBBBBBBBBBBBBB';
R.redactSmart(p);
const qOut = R.redactSmart(q);
ok(!qOut.includes('BBBBBBBBBBBBBBBBBBBBB') && qOut.includes('***'), '缓存块内容变化后重新过滤');
ok(!qOut.includes('AAAAAAAAAAAAAAAAAAAAA'), '缓存不串味(不返回上一次的正文)');

console.log(`\nredact test: ${pass} passed, ${fail} failed`);
if (fail) { console.error(failures.join('\n')); process.exit(1); }
