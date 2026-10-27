'use strict';
// ================= 进程级单例(插件管理器, 原 gateway.js 顶层初始化) =================
let PLUGINS = null;
try { PLUGINS = new (require('./plugins.js').PluginManager)(__dirname, (...a) => { require('./util').log(...a); }); }
catch (e) { require('./util').logErr('插件管理器初始化失败:', e && e.message); }
module.exports = { get PLUGINS() { return PLUGINS; }, set PLUGINS(v) { PLUGINS = v; } };
