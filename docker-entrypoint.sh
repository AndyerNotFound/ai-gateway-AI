#!/bin/sh
# ai-gateway 容器入口: 首次启动初始化数据卷配置
set -e
DATA=/app/data
mkdir -p "$DATA/log"
if [ ! -f "$DATA/config.json" ]; then
  echo "[entrypoint] 首次启动, 初始化默认配置到 /app/data/config.json"
  echo "[entrypoint] ⚠️ 公网部署请尽快运行 agw web login 获取面板链接(/auth?key=<访问令牌>), 设置 gatewayKey!"
  cat > "$DATA/config.json" <<'EOF'
{
  "listen": { "host": "0.0.0.0", "port": 16384 },
  "gatewayKey": "",
  "adminKey": "",
  "channels": [
    { "name": "default", "type": "openai", "baseUrl": "https://api.deepseek.com", "apiKey": "把这里改成你的API-Key", "default": true }
  ]
}
EOF
fi
exec node gateway.js "$DATA/config.json"
