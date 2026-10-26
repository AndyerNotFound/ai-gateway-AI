#!/usr/bin/env bash
# 证书续签包装：只在证书真的变化时才动网关。
#   bash tls/renew.sh              检查 + 必要时重签 + 重启 + 回验
#   bash tls/renew.sh --no-restart 只检查/重签（交给 ops/guard.sh 统一重启）
# 退出码: 0=无需变更或已完成, 2=重签失败
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"
CERT="$ROOT/cert.pem"
CA="$DIR/ca.pem"

probe_url() {
  node -e '
    const fs=require("fs"),path=require("path");
    const D=process.argv[1];
    try{
      const c=require(path.join(D,"crypt.js"));
      let r=fs.readFileSync(path.join(D,"config.json"),"utf8");
      if(c.isEncText(r))r=c.decryptText(r,c.loadPass());
      const j=JSON.parse(r),t=j.tls||(j.listen&&j.listen.tls)||{};
      const hp=(j.listen||{}).port||16384;
      if(t.enable){const p=(t.port!=null)?Number(t.port):hp;process.stdout.write("https://127.0.0.1:"+p+"/health")}
      else process.stdout.write("http://127.0.0.1:"+hp+"/health");
    }catch(e){process.stdout.write("")}
  ' "$1"
}
tls_port() {
  node -e 'try{const fs=require("fs"),c=require(process.argv[2]+"/crypt.js");let r=fs.readFileSync(process.argv[1],"utf8");if(c.isEncText(r))r=c.decryptText(r,c.loadPass());const j=JSON.parse(r).tls||{};process.stdout.write(String(j.enable&&j.port?j.port:""))}catch(e){process.stdout.write("")}' "$ROOT/config.json" "$ROOT"
}

before="$(sha256sum "$CERT" 2>/dev/null | awk '{print $1}')"
out="$(bash "$DIR/gen-server.sh" --ensure 2>&1)"
rc=$?
if [ $rc -ne 0 ]; then
  echo "failed"; echo "$out" | tail -n 5
  exit 2
fi
after="$(sha256sum "$CERT" 2>/dev/null | awk '{print $1}')"

if [ "$before" = "$after" ]; then
  echo "nochange"
  exit 0
fi

echo "renewed"
echo "$out" | tail -n 6

[ "${1:-}" = "--no-restart" ] && exit 0

bash "$ROOT/agw.sh" restart >/dev/null 2>&1
sleep 3
P="$(tls_port)"
if [ -n "$P" ]; then
  if curl -sf -m 8 --cacert "$CA" "$(probe_url "$ROOT")" >/dev/null 2>&1; then
    echo "✓ 重启完成，健康检查通过"
  else
    echo "✗ 重启后 HTTPS :$P 健康检查失败"; exit 2
  fi
fi
