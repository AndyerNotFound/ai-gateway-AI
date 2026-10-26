'use strict';
// hello 插件：验证插件骨架（路由注册 + 数据持久化 + 定时任务）
module.exports = {
  activate(ctx) {
    ctx.log('hello 插件已激活, 实例=' + ctx.instanceName);

    ctx.registerRoute('GET', '/ping', async (req, res, params) => {
      // 数据持久化演示：累计 ping 次数
      const n = (ctx.data.get('pings') || 0) + 1;
      ctx.data.set('pings', n);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, msg: 'pong', plugin: ctx.id, instance: ctx.instanceName, pings: n, time: Date.now() }));
    });

    ctx.registerRoute('GET', '/count', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pings: ctx.data.get('pings') || 0 }));
    });
  },
  deactivate() { /* 清理（timer 由框架自动清） */ }
};
