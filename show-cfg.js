const fs = require("fs");
const f = process.argv[2];
if (!f || !fs.existsSync(f)) { console.error("文件不存在: " + f); process.exit(1); }
let cfg;
try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); }
catch (e) { console.log("  (配置解析失败: " + e.message.split("\n")[0] + ")"); process.exit(0); }
const port = (cfg.listen && cfg.listen.port) || 16384;
const gw = cfg.gatewayKey ? "已设" : "无";
const proxies = Object.keys(cfg.proxies || {});
const chs = cfg.channels || [];
const tls = cfg.tls || (cfg.listen && cfg.listen.tls) || {};
const tlsOn = tls.enable ? "已启用" : "无";
const tlsPort = tls.enable ? (tls.port != null ? tls.port : port + "(同HTTP)") : "-";
console.log("  ┌ 端口 " + port + "  网关密码:" + gw + "  TLS:" + tlsOn + (tls.enable ? "(" + tlsPort + ")" : "") + "  代理:" + (proxies.length ? proxies.join(",") : "无"));
if (!chs.length) { console.log("  └ 无渠道!"); process.exit(0); }
const dup = {};
for (const ch of chs) for (const m of (ch.models || [])) dup[m] = (dup[m] || 0) + 1;
const rr = Object.entries(dup).filter(([m, c]) => c > 1).map(([m]) => m);
for (let i = 0; i < chs.length; i++) {
  const ch = chs[i];
  const m = (ch.models || []).map(x => rr.includes(x) ? x + "⚡" : x).join(", ") || "(无)";
  const px = ch.proxy ? ("proxy=" + ch.proxy) : "直连";
  const df = ch.default ? " [default]" : "";
  const last = i === chs.length - 1;
  console.log("  " + (last ? "└" : "├") + " [" + ch.type + "] " + ch.name + df + "  " + px);
  console.log("  " + (last ? " " : "│") + "   baseUrl: " + ch.baseUrl);
  console.log("  " + (last ? " " : "│") + "   models:  " + m);
  if (ch.modelMap && Object.keys(ch.modelMap).length) console.log("  " + (last ? " " : "│") + "   modelMap: " + JSON.stringify(ch.modelMap));
}
if (rr.length) console.log("  (⚡=多渠道轮询+故障切换)");
