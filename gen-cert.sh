#!/usr/bin/env bash
# [DEPRECATED] old self-signed cert generator -- replaced by tls/gen-server.sh (with gen-ca.sh).
# Current flow: agw-tls setup -> tls/gen-ca.sh + tls/gen-server.sh (certs land in data/, SAN auto-includes all LAN IPs)
# Kept only for compatibility with old docs/muscle memory; do not use for new deployments.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CN="${1:-localhost}"
echo "⚠ 此脚本已弃用: 证书 SAN 硬编码单 IP, 无法自动覆盖局域网地址变化。"
echo "  请改用: bash tls/gen-server.sh        # 产物在 data/cert.pem + data/key.pem"
echo "          bash tls/gen-ca.sh            # 首次需先建 CA"
exit 1
