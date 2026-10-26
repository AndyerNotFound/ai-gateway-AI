#!/usr/bin/env bash
# [DEPRECATED] 旧的自签证书生成器 —— 已被 tls/gen-server.sh(配 gen-ca.sh) 取代。
# 现行链路: agw-tls setup → tls/gen-ca.sh + tls/gen-server.sh(证书落 data/, SAN 自动含全部局域网 IP)
# 保留本文件仅为兼容旧文档/肌肉记忆; 新部署请勿使用。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CN="${1:-localhost}"
echo "⚠ 此脚本已弃用: 证书 SAN 硬编码单 IP, 无法自动覆盖局域网地址变化。"
echo "  请改用: bash tls/gen-server.sh        # 产物在 data/cert.pem + data/key.pem"
echo "          bash tls/gen-ca.sh            # 首次需先建 CA"
exit 1
