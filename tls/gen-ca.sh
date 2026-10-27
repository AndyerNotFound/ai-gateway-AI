#!/usr/bin/env bash
# Generate the ai-gateway local private CA (run once). Skipped if it exists; --force rebuilds and invalidates every installed device.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CA_KEY="$DIR/ca.key"
CA_PEM="$DIR/ca.pem"

if [ -f "$CA_PEM" ] && [ -f "$CA_KEY" ] && [ "${1:-}" != "--force" ]; then
  echo "• CA 已存在，跳过（--force 可重建，会导致已安装设备全部失效）"
  openssl x509 -in "$CA_PEM" -noout -subject -enddate
  exit 0
fi

openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -keyout "$CA_KEY" -out "$CA_PEM" \
  -subj "/O=ai-gateway Local/CN=ai-gateway Local Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" 2>/dev/null
chmod 600 "$CA_KEY"
chmod 644 "$CA_PEM"

echo "✓ 私有 CA 已生成"
openssl x509 -in "$CA_PEM" -noout -subject -enddate
echo ""
echo "  分发用（可公开，私钥 ca.key 不要外传）："
echo "    $CA_PEM"
echo "  局域网其他设备安装：把 ca.pem 改名为 ai-gateway-ca.crt 后装为「CA 证书」"
