#!/bin/bash
# ai-gateway 一键安装脚本 (Linux / macOS / Termux)
# 用法: curl -fsSL <raw地址>/install.sh | bash
#    或: bash install.sh [安装目录]
set -e

DIR="${1:-$HOME/ai-gateway}"
REPO="https://raw.githubusercontent.com/AndyerNotFound/ai-gateway-AI/main"

echo "=== ai-gateway 一键安装 ==="
echo "安装目录: $DIR"

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js 18+:"
  echo "   Termux:  pkg install nodejs"
  echo "   Debian:  apt install nodejs"
  echo "   macOS:   brew install node"
  exit 1
fi
NV=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NV" -lt 18 ]; then echo "✗ Node 版本过低 ($(node -v)), 需要 18+"; exit 1; fi
echo "✓ node $(node -v)"

# 2. 下载源码(已存在则跳过, 用 agw.sh restart 更新)
mkdir -p "$DIR/m3"
if [ -f "$DIR/gateway.js" ]; then
  echo "• 目录已存在, 跳过下载 (升级请重新运行)"
else
  echo "下载源码..."
  FILES="gateway.js admin.js crypt.js show-cfg.js redact-cache.js agw.sh cfg-cli.js gen-cert.sh README.md"
  for f in $FILES; do
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$REPO/$f" -o "$DIR/$f"; else wget -q "$REPO/$f" -O "$DIR/$f"; fi
  done
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$REPO/m3/index.html" -o "$DIR/m3/index.html"; else wget -q "$REPO/m3/index.html" -O "$DIR/m3/index.html"; fi
  chmod +x "$DIR/agw.sh" "$DIR/gen-cert.sh" 2>/dev/null || true
  echo "✓ 源码就绪"
fi

# 3. 初始化配置(已有配置跳过)
if [ -f "$DIR/config.json" ]; then
  echo "• 已有配置, 跳过初始化"
else
  echo ""
  echo "--- 初始配置 ---"
  read -p "监听端口 [16384]: " PORT; PORT=${PORT:-16384}
  read -p "网关密码(客户端访问用, 留空=免密, 公网必设!): " GWKEY
  read -p "第一个渠道类型 [openai] (openai/claude/gemini): " CHTYPE; CHTYPE=${CHTYPE:-openai}
  read -p "渠道 Base URL: " CHURL
  read -p "渠道 API Key: " CHKEY
  CHURL=${CHURL:-https://api.deepseek.com}
  cat > "$DIR/config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "gatewayKey": "$GWKEY",
  "adminKey": "",
  "channels": [
    { "name": "default", "type": "$CHTYPE", "baseUrl": "$CHURL", "apiKey": "$CHKEY", "default": true }
  ]
}
EOF
  echo "✓ 配置已写入 $DIR/config.json"
fi

# 4. 启动
mkdir -p "$DIR/log" "$DIR/.run"
cd "$DIR"
nohup node gateway.js >> log/gateway.log 2>&1 &
echo $! > .run/main.pid
sleep 1
if kill -0 "$(cat .run/main.pid)" 2>/dev/null; then
  echo ""
  echo "=== 安装完成 ==="
  echo "  网关在跑: http://127.0.0.1:$PORT"
  echo "  管理面板: http://127.0.0.1:$PORT/admin/m3"
  echo "  客户端 base_url: http://127.0.0.1:$PORT/v1"
  echo "  管理命令: $DIR/agw.sh start|stop|restart|status|logs"
else
  echo "✗ 启动失败, 日志: $DIR/log/gateway.log"; tail -5 "$DIR/log/gateway.log"; exit 1
fi
