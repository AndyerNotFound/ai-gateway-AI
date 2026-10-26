# ai-gateway —— 单容器中转站
# 构建: docker build -t ai-gateway .
# 运行: docker run -d -p 16384:16384 -v ai-gateway-data:/app/data --name ai-gateway ai-gateway
FROM node:22-alpine

WORKDIR /app

# 网关源码(零依赖, 不需要 npm install)
COPY gateway.js admin.js crypt.js show-cfg.js redact-cache.js cfg-cli.js ./
COPY m3 ./m3
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 配置/日志目录(挂卷持久化)
VOLUME /app/data
ENV NODE_ENV=production

EXPOSE 16384

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:16384/health || exit 1

# 配置文件指向数据卷(多实例模式自动托管 /app/data 下全部 config*.json)
ENTRYPOINT ["docker-entrypoint.sh"]
