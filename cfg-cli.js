#!/usr/bin/env node
'use strict';
/**
 * ai-gateway 配置工具 — 交互式 + 参数式
 * 用法:
 *   agw.sh config                           交互式: 选实例 → 主菜单
 *   agw.sh config [实例名]                  直接进某实例的主菜单
 *   agw.sh config [实例名] add              交互式添加渠道
 *   agw.sh config [实例名] list             列出渠道
 *   agw.sh config [实例名] remove [渠道名]  删除渠道
 *   agw.sh config [实例名] add --name X --type openai --baseUrl URL --apiKey K --models a,b,c
 *   agw.sh config [实例名] set-port 16390
 *   agw.sh config [实例名] set-key "密码"
 *   agw.sh config [实例名] add-proxy myproxy --type socks5 --host 127.0.0.1 --port 7890
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const DIR = path.join(os.homedir(), 'ai-gateway');
const TYPES = ['openai', 'gemini', 'claude'];

function cfgFile(name) {
  return name === 'default' ? path.join(DIR, 'config.json') : path.join(DIR, `config.${name}.json`);
}

function listInstances() {
  const out = [];
  if (fs.existsSync(path.join(DIR, 'config.json'))) out.push('default');
  try {
    for (const f of fs.readdirSync(DIR)) {
      const m = /^config\.(.+)\.json$/.exec(f);
      if (m) out.push(m[1]);
    }
  } catch (_) {}
  return out;
}

function loadCfg(name) {
  const f = cfgFile(name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveCfg(name, cfg) {
  fs.writeFileSync(cfgFile(name), JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✓ 已保存到 ${cfgFile(name)}`);
}

// ---- readline helpers ----
function ask(rl, q, def) {
  return new Promise(r => {
    const p = def != null ? `${q} [${def}]: ` : `${q}: `;
    rl.question(p, a => { a = (a || '').trim(); r(a || (def != null ? def : '')); });
  });
}
function askChoice(rl, q, opts) {
  return new Promise(r => {
    console.log(q);
    opts.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    rl.question('选择 (数字): ', a => {
      const i = parseInt(a, 10) - 1;
      r(i >= 0 && i < opts.length ? opts[i] : opts[0]);
    });
  });
}
function askYesNo(rl, q, defY) {
  return new Promise(r => {
    rl.question(`${q} (${defY ? 'Y/n' : 'y/N'}): `, a => {
      a = (a || '').trim().toLowerCase();
      r(a === '' ? defY : (a === 'y' || a === 'yes'));
    });
  });
}

// ---- 渠道显示 ----
function showChannels(cfg) {
  if (!cfg.channels || !cfg.channels.length) { console.log('  (无渠道)'); return; }
  const dup = {};
  for (const ch of cfg.channels) for (const m of (ch.models || [])) dup[m] = (dup[m] || 0) + 1;
  const rr = Object.entries(dup).filter(([, c]) => c > 1).map(([m]) => m);
  for (let i = 0; i < cfg.channels.length; i++) {
    const ch = cfg.channels[i];
    const models = (ch.models || []).map(m => rr.includes(m) ? m + '⚡' : m).join(', ') || '(无)';
    const px = ch.proxy ? `proxy=${ch.proxy}` : '直连';
    const df = ch.default ? ' [default]' : '';
    console.log(`  ${i + 1}. [${ch.type}] ${ch.name}${df}  ${px}`);
    console.log(`     baseUrl: ${ch.baseUrl}`);
    console.log(`     models:  ${models}`);
    if (ch.modelMap) console.log(`     modelMap: ${JSON.stringify(ch.modelMap)}`);
  }
  if (rr.length) console.log('  (⚡=多渠道轮询)');
}

// ---- 交互式添加渠道 ----
async function interactiveAdd(rl, cfg) {
  const name = await ask(rl, '渠道名 (如 my-free-key)');
  if (!name) { console.log('✗ 渠道名不能为空'); return null; }
  if (cfg.channels.some(c => c.name === name)) {
    const overwrite = await askYesNo(rl, `渠道 "${name}" 已存在, 覆盖?`, false);
    if (!overwrite) return null;
    cfg.channels = cfg.channels.filter(c => c.name !== name);
  }

  const type = await askChoice(rl, '上游格式', TYPES);
  let baseUrl = await ask(rl, 'baseUrl (如 https://api.deepseek.com)');
  // 自动补全常见 baseUrl
  if (baseUrl && !baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const apiKey = await ask(rl, 'apiKey (粘贴密钥, 直接回车=稍后填)');

  // 代理选择
  const proxyNames = Object.keys(cfg.proxies || {});
  const proxyOpts = ['直连 (不走代理)', ...proxyNames.map(p => `${p} (${cfg.proxies[p].type}://${cfg.proxies[p].host}:${cfg.proxies[p].port})`), '+ 新建代理...'];
  let proxy = null;
  const proxyChoice = await askChoice(rl, '出站代理', proxyOpts);
  if (proxyChoice.startsWith('直连')) proxy = null;
  else if (proxyChoice.includes('+ 新建')) {
    const pname = await ask(rl, '新代理名 (如 clash)');
    const ptype = await askChoice(rl, '代理类型', ['socks5', 'http']);
    const phost = await ask(rl, '代理地址', '127.0.0.1');
    const pport = await ask(rl, '代理端口', '7890');
    const puser = await ask(rl, '用户名 (可空)');
    const ppass = await ask(rl, '密码 (可空)');
    cfg.proxies = cfg.proxies || {};
    cfg.proxies[pname] = { type: ptype, host: phost, port: Number(pport) };
    if (puser) cfg.proxies[pname].username = puser;
    if (ppass) cfg.proxies[pname].password = ppass;
    proxy = pname;
  } else {
    proxy = proxyNames[proxyOpts.indexOf(proxyChoice) - 1];
  }

  // 模型配置
  console.log('\n模型配置 (两种方式选一):');
  console.log('  A) models 列表: 直接列出上游模型名, 客户端发啥就用啥');
  console.log('  B) modelMap 改名: 把不同上游的模型名统一成一个对外名 (推荐多源轮询时用)');
  const modeChoice = await askChoice(rl, '选择配置方式', ['A) models 列表', 'B) modelMap 改名']);

  let channel = { name, type, baseUrl, apiKey, proxy };
  if (modeChoice.startsWith('A')) {
    const modelsStr = await ask(rl, '模型列表 (逗号分隔, 如 deepseek-chat,deepseek-reasoner)');
    const models = modelsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (models.length) channel.models = models;
  } else {
    channel.modelMap = {};
    console.log('输入映射对 (统一名 → 上游真实名), 空行结束:');
    while (true) {
      const alias = await ask(rl, '对外统一名 (空=结束)');
      if (!alias) break;
      const real = await ask(rl, `  "${alias}" 的上游真实名`);
      if (real) channel.modelMap[alias] = real;
    }
    if (!Object.keys(channel.modelMap).length) { console.log('⚠ modelMap 为空, 自动加 models 兜底'); }
  }

  const isDefault = await askYesNo(rl, '设为 default (兜底) 渠道?', !cfg.channels.length);
  if (isDefault) {
    // 取消其他渠道的 default
    for (const c of cfg.channels) c.default = false;
    channel.default = true;
  }

  cfg.channels.push(channel);
  return cfg;
}

// ---- 交互式主菜单 ----
async function mainMenu(rl, name, cfg) {
  while (true) {
    console.log(`\n━━━ 实例 [${name}] 端口=${(cfg.listen||{}).port} 密码=${cfg.gatewayKey ? '已设' : '无'} 渠道=${(cfg.channels||[]).length} ━━━`);
    const action = await askChoice(rl, '操作', [
      '查看渠道',
      '添加渠道',
      '删除渠道',
      '设置端口',
      '设置网关密码',
      '添加代理',
      '删除代理',
      '保存并退出',
      '不保存退出',
    ]);
    switch (action) {
      case '查看渠道':
        showChannels(cfg);
        break;
      case '添加渠道':
        await interactiveAdd(rl, cfg);
        break;
      case '删除渠道': {
        if (!cfg.channels || !cfg.channels.length) { console.log('  (无渠道可删)'); break; }
        const names = cfg.channels.map(c => `${c.name} [${c.type}]`);
        const toDel = await askChoice(rl, '选择要删除的渠道', [...names, '取消']);
        if (toDel !== '取消') {
          const dn = toDel.split(' [')[0];
          cfg.channels = cfg.channels.filter(c => c.name !== dn);
          console.log(`✓ 已删除渠道 "${dn}" (记得保存)`);
        }
        break;
      }
      case '设置端口': {
        const p = await ask(rl, '端口号', String((cfg.listen || {}).port || 16384));
        cfg.listen = cfg.listen || {};
        cfg.listen.port = Number(p) || 16384;
        cfg.listen.host = cfg.listen.host || '0.0.0.0';
        console.log(`✓ 端口改为 ${cfg.listen.port} (记得保存)`);
        break;
      }
      case '设置网关密码': {
        const k = await ask(rl, '网关密码 (空=取消密码保护)');
        cfg.gatewayKey = k;
        console.log(k ? '✓ 网关密码已设 (记得保存)' : '✓ 已取消密码保护 (记得保存)');
        break;
      }
      case '添加代理': {
        const pname = await ask(rl, '代理名 (如 clash)');
        if (!pname || (cfg.proxies && cfg.proxies[pname])) { console.log('✗ 名字为空或已存在'); break; }
        const ptype = await askChoice(rl, '类型', ['socks5', 'http']);
        const phost = await ask(rl, '地址', '127.0.0.1');
        const pport = await ask(rl, '端口', '7890');
        const puser = await ask(rl, '用户名 (可空)');
        const ppass = await ask(rl, '密码 (可空)');
        cfg.proxies = cfg.proxies || {};
        cfg.proxies[pname] = { type: ptype, host: phost, port: Number(pport) };
        if (puser) cfg.proxies[pname].username = puser;
        if (ppass) cfg.proxies[pname].password = ppass;
        console.log(`✓ 代理 "${pname}" 已添加 (记得保存)`);
        break;
      }
      case '删除代理': {
        const pnames = Object.keys(cfg.proxies || {});
        if (!pnames.length) { console.log('  (无代理)'); break; }
        const toDel = await askChoice(rl, '选择要删除的代理', [...pnames, '取消']);
        if (toDel !== '取消') {
          delete cfg.proxies[toDel];
          // 清理引用该代理的渠道
          for (const c of cfg.channels) if (c.proxy === toDel) { c.proxy = null; console.log(`  ⚠ 渠道 "${c.name}" 的代理被清空`); }
          console.log(`✓ 已删除代理 "${toDel}" (记得保存)`);
        }
        break;
      }
      case '保存并退出':
        saveCfg(name, cfg);
        console.log('💡 改完记得重启实例: agw.sh restart ' + name);
        return;
      case '不保存退出':
        console.log('• 未保存, 退出');
        return;
    }
  }
}

// ---- 参数模式 ----
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      opts[key] = val;
    }
  }
  return opts;
}

function paramAdd(name, opts) {
  let cfg = loadCfg(name);
  if (!cfg) {
    console.log(`✗ 实例 [${name}] 配置不存在, 先创建: agw.sh config ${name}`);
    process.exit(1);
  }
  if (!opts.name) { console.log('✗ 需要 --name 参数'); process.exit(1); }
  const type = opts.type || 'openai';
  if (!TYPES.includes(type)) { console.log(`✗ --type 必须是 ${TYPES.join('/')}`); process.exit(1); }
  if (!opts.baseUrl) { console.log('✗ 需要 --baseUrl'); process.exit(1); }
  // 移除同名旧渠道
  cfg.channels = (cfg.channels || []).filter(c => c.name !== opts.name);
  const ch = { name: opts.name, type, baseUrl: opts.baseUrl, apiKey: opts.apiKey || '', proxy: opts.proxy || null };
  if (opts.models) ch.models = opts.models.split(',').map(s => s.trim()).filter(Boolean);
  if (opts.default) { for (const c of cfg.channels) c.default = false; ch.default = true; }
  cfg.channels.push(ch);
  saveCfg(name, cfg);
}

function main() {
  const args = process.argv.slice(2);
  const instances = listInstances();

  // 无参数 → 交互式选实例
  if (!args.length) {
    if (!instances.length) { console.log('✗ 没有任何配置文件, 先手动创建一个 config.json'); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    (async () => {
      const name = await askChoice(rl, '选择实例', instances);
      let cfg = loadCfg(name);
      if (!cfg) { console.log('✗ 配置解析失败'); rl.close(); return; }
      await mainMenu(rl, name, cfg);
      rl.close();
    })();
    return;
  }

  // 第一个参数 = 实例名
  let name = args[0];
  const cmd = args[1] || '';
  const rest = args.slice(2);

  // 如果第一个参数是命令(不是实例名), 则先选实例
  if (['add', 'list', 'remove', 'set-port', 'set-key', 'add-proxy'].includes(name)) {
    const cmd2 = name; name = ''; // 后面处理
    // 交互式选实例
    if (!instances.length) { console.log('✗ 没有配置文件'); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    (async () => {
      const inst = await askChoice(rl, '选择实例', instances);
      let cfg = loadCfg(inst);
      if (!cfg) { console.log('✗ 配置解析失败'); rl.close(); return; }
      if (cmd2 === 'add') { cfg = await interactiveAdd(rl, cfg); if (cfg) { saveCfg(inst, cfg); console.log('💡 重启: agw.sh restart ' + inst); } }
      else if (cmd2 === 'list') showChannels(cfg);
      else if (cmd2 === 'remove' && rest[0]) { cfg.channels = (cfg.channels||[]).filter(c => c.name !== rest[0]); saveCfg(inst, cfg); }
      else if (cmd2 === 'set-port' && rest[0]) { cfg.listen = cfg.listen||{}; cfg.listen.port = Number(rest[0]); saveCfg(inst, cfg); }
      else if (cmd2 === 'set-key') { cfg.gatewayKey = rest[0]||''; saveCfg(inst, cfg); }
      else console.log('用法: agw.sh config [实例] <add|list|remove|set-port|set-key>');
      rl.close();
    })();
    return;
  }

  // 正常: name = 实例名, cmd = 命令
  if (cmd === 'add') {
    if (rest.length && rest[0].startsWith('--')) {
      // 参数模式
      paramAdd(name, parseArgs(rest));
    } else {
      // 交互式
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let cfg = loadCfg(name);
      if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); rl.close(); process.exit(1); }
      (async () => {
        cfg = await interactiveAdd(rl, cfg);
        if (cfg) { saveCfg(name, cfg); console.log('💡 重启: agw.sh restart ' + name); }
        rl.close();
      })();
    }
  } else if (cmd === 'list') {
    const cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    showChannels(cfg);
  } else if (cmd === 'remove') {
    if (!rest[0]) { console.log('✗ 需要 渠道名: agw.sh config [实例] remove [渠道名]'); process.exit(1); }
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    const before = cfg.channels.length;
    cfg.channels = (cfg.channels || []).filter(c => c.name !== rest[0]);
    if (cfg.channels.length < before) { saveCfg(name, cfg); console.log(`✓ 已删除渠道 "${rest[0]}", 重启: agw.sh restart ${name}`); }
    else console.log(`✗ 没找到渠道 "${rest[0]}"`);
  } else if (cmd === 'set-port') {
    if (!rest[0]) { console.log('✗ 需要 端口号'); process.exit(1); }
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    cfg.listen = cfg.listen || {}; cfg.listen.port = Number(rest[0]); cfg.listen.host = cfg.listen.host || '0.0.0.0';
    saveCfg(name, cfg); console.log(`✓ 端口改为 ${rest[0]}, 重启: agw.sh restart ${name}`);
  } else if (cmd === 'set-key') {
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    cfg.gatewayKey = rest[0] || '';
    saveCfg(name, cfg); console.log(rest[0] ? `✓ 网关密码已设, 重启: agw.sh restart ${name}` : `✓ 已取消密码, 重启: agw.sh restart ${name}`);
  } else if (cmd === 'set-admin-key') {
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    cfg.adminKey = rest[0] || '';
    saveCfg(name, cfg);
    if (rest[0]) { console.log(`✓ 管理密码已设, 重启后访问: http://127.0.0.1:${(cfg.listen||{}).port}/admin?adminKey=${rest[0]}`); console.log(`  重启: agw.sh restart ${name}`); }
    else { console.log(`✓ 已关闭管理面板, 重启: agw.sh restart ${name}`); }
  } else if (cmd === 'enable-tls') {
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    const dir = path.dirname(cfgFile(name));
    if (!fs.existsSync(path.join(dir, 'cert.pem')) || !fs.existsSync(path.join(dir, 'key.pem'))) {
      console.log('✗ 证书不存在, 请先运行: bash ~/ai-gateway/gen-cert.sh');
      process.exit(1);
    }
    const tlsPort = rest[0] ? Number(rest[0]) : (cfg.listen.port + 9);
    cfg.tls = { enable: true, cert: 'cert.pem', key: 'key.pem', port: tlsPort };
    saveCfg(name, cfg);
    console.log(`✓ TLS 已启用, HTTPS 端口: ${tlsPort} (HTTP ${cfg.listen.port} 保留)`);
    console.log(`  重启: agw.sh restart ${name}`);
    console.log(`  ⚠ 自签证书, 客户端需跳过验证 (curl 加 -k)`);
  } else if (cmd === 'disable-tls') {
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    cfg.tls = { enable: false };
    saveCfg(name, cfg);
    console.log(`✓ TLS 已关闭, 重启: agw.sh restart ${name}`);
  } else if (!cmd) {
    // 只有实例名 → 进主菜单
    let cfg = loadCfg(name);
    if (!cfg) { console.log(`✗ 实例 [${name}] 配置不存在`); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    mainMenu(rl, name, cfg).then(() => rl.close());
  } else {
    console.log('未知命令: ' + cmd + '\n用法: agw.sh config [实例名] [add|list|remove|set-port|set-key]');
  }
}

main();
