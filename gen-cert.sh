#!/usr/bin/env bash
# 为 ai-gateway 生成自签名 TLS 证书
# 用法: bash ~/ai-gateway/gen-cert.sh [域名或IP]
#   不带参数 → CN=localhost (本机用)
#   带参数   → CN=你指定的IP或域名 (如局域网IP <IP或域名>)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CN="${1:-localhost}"

if [ -f "$DIR/cert.pem" ] && [ -f "$DIR/key.pem" ]; then
  echo "• 证书已存在, 跳过 (如需重新生成请先删除 cert.pem 和 key.pem)"
  exit 0
fi

# 构造 subjectAltName
ALT="IP:127.0.0.1,DNS:localhost"
case "$CN" in
  *[0-9].*[0-9]) ALT="$ALT,IP:$CN" ;;   # IP 地址
  *) ALT="$ALT,DNS:$CN" ;;               # 域名
esac

echo "正在生成自签证书 (CN=$CN, 有效期 365 天)..."
openssl req -x509 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -days 365 -nodes \
  -subj "/CN=$CN" \
  -addext "subjectAltName=$ALT" \
  2>/dev/null
chmod 600 "$DIR/key.pem"
echo "✓ 证书已生成:"
echo "  $DIR/cert.pem (公钥, 可公开)"
echo "  $DIR/key.pem  (私钥, 已设 600 权限)"
echo ""
echo "下一步: 启用 TLS"
echo "  方式1: agw.sh config <实例名> enable-tls [HTTPS端口]"
echo "  方式2: 在 config.json 的 listen 段里加:"
echo '    "tls": { "enable": true, "cert": "cert.pem", "key": "key.pem", "port": 16393 }'
echo ""
echo "⚠ 自签证书客户端会提示不安全, 需跳过验证:"
echo "  curl -k https://...   |   openai SDK 设 httpx 不验证   |   浏览器点继续"
