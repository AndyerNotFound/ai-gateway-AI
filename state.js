'use strict';
// ================= 进程级共享状态(原 gateway.js 顶层 let) =================
// 必须以 state.CUR_POOL / state.CUR_CFG 形式访问(保持引用实时性), 不可解构
module.exports = {
  get CUR_POOL() { return this._pool; }, set CUR_POOL(v) { this._pool = v; },
  get CUR_CFG() { return this._cfg; }, set CUR_CFG(v) { this._cfg = v; },
  _pool: null, _cfg: null,
};
