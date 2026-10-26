#!/usr/bin/env bash
# 用本地 CA 签发 ai-gateway 服务器证书。
#   bash gen-server.sh            生成/更新 cert.pem + key.pem（SAN 自动含本机全部非回环 IPv4）
#   bash gen-server.sh --ensure   仅当证书过期/不被本 CA 签发/SAN 缺当前 IP 时才重签（适合定时任务）
#   bash gen-server.sh --force    无条件重签
#   EXTRA_SAN="DNS:agw.local"     追加 SAN
# 注意: Termux 下 `ip` 命令无法绑定 netlink（Android 11+），只能用 ifconfig 探测地址。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
CA_PEM="$DIR/ca.pem"; CA_KEY="$DIR/ca.key"
OUT_CERT="$ROOT/data/cert.pem"; OUT_KEY="$ROOT/data/key.pem"
DAYS="${DAYS:-397}"
EXTRA_SAN="${EXTRA_SAN:-}"
MODE="${1:-}"
export PATH="$PATH:/data/data/com.termux/files/usr/bin"

[ -f "$CA_PEM" ] || { echo "✗ 缺少 $CA_PEM，先运行: bash $DIR/gen-ca.sh"; exit 1; }

# 输出 "接口名 IP"，优先 wlan/eth（局域网主地址）
detect_if_ip() {
  ifconfig 2>/dev/null | awk '/^[a-zA-Z0-9_.-]+:/{ifn=$1; sub(":","",ifn)} /inet /{print ifn, $2}' |
    grep -vE ' (127\.|$)' | awk '{print ($1 ~ /^(wlan|eth|ap|swlan)/ ? 0 : 1), $1, $2}' |
    sort -k1,1n -k2,2 | awk '{print $2" "$3}' || true
}
detect_ips() { detect_if_ip | awk '{print $2}' | sort -u; }

build_san() {
  local s="DNS:localhost,IP:127.0.0.1,IP:::1" ip
  for ip in $(detect_ips); do s="$s,IP:$ip"; done
  [ -n "$EXTRA_SAN" ] && s="$s,$EXTRA_SAN"
  printf '%s' "$s"
}

SAN="$(build_san)"
NEED=1

if [ "$MODE" != "--force" ] && [ -f "$OUT_CERT" ] && [ -f "$OUT_KEY" ]; then
  if openssl verify -CAfile "$CA_PEM" "$OUT_CERT" >/dev/null 2>&1 &&
     openssl x509 -in "$OUT_CERT" -noout -checkend 604800 >/dev/null 2>&1; then
    CUR="$(openssl x509 -in "$OUT_CERT" -noout -ext subjectAltName 2>/dev/null | tr -d ' \n')"
    OK=1
    case "$CUR" in *"DNS:localhost"*) ;; *) OK=0 ;; esac
    for ip in $(detect_ips); do
      case "$CUR" in *"IPAddress:$ip"*) ;; *) OK=0 ;; esac
    done
    [ "$OK" = "1" ] && NEED=0
  fi
fi

if [ "$NEED" = "0" ]; then
  echo "✓ 证书有效且覆盖当前全部 IP，无需重签"
  openssl x509 -in "$OUT_CERT" -noout -subject -enddate -ext subjectAltName
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CN="$(detect_if_ip | awk 'NR==1{print $2}')"
CN="${CN:-localhost}"

cat > "$TMP/ext.cnf" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF

openssl req -new -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/req.csr" \
  -subj "/O=ai-gateway Local/CN=$CN" 2>/dev/null
openssl x509 -req -in "$TMP/req.csr" -CA "$CA_PEM" -CAkey "$CA_KEY" -CAcreateserial \
  -days "$DAYS" -sha256 -extfile "$TMP/ext.cnf" -out "$TMP/cert.pem" 2>/dev/null
openssl verify -CAfile "$CA_PEM" "$TMP/cert.pem"

if [ -f "$OUT_CERT" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  cp -p "$OUT_CERT" "$DIR/legacy/cert.pem.$TS" 2>/dev/null || true
  cp -p "$OUT_KEY"  "$DIR/legacy/key.pem.$TS"  2>/dev/null || true
  echo "• 旧证书已归档到 $DIR/legacy/ ($TS)"
fi

install -m 644 "$TMP/cert.pem" "$OUT_CERT"
install -m 600 "$TMP/key.pem"  "$OUT_KEY"

echo "✓ 新证书已安装"
echo "  证书: $OUT_CERT"
echo "  私钥: $OUT_KEY (600)"
openssl x509 -in "$OUT_CERT" -noout -subject -enddate -ext subjectAltName
