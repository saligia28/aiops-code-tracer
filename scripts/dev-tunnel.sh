#!/bin/sh
# 开发环境自动启动 cloudflare tunnel
# 等待本地服务就绪后再拉起 tunnel，避免 502

PORT=${WEB_PORT:-4200}
MAX_WAIT=60

# 仅开发环境 + 已安装 cloudflared 时运行
if [ "$NODE_ENV" = "production" ]; then
  echo "[tunnel] 生产环境，跳过 tunnel"
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] cloudflared 未安装，跳过 tunnel"
  exit 0
fi

echo "[tunnel] 等待 localhost:$PORT 就绪..."
elapsed=0
while ! curl -s -o /dev/null -w '' "http://localhost:$PORT" 2>/dev/null; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ $elapsed -ge $MAX_WAIT ]; then
    echo "[tunnel] 等待超时（${MAX_WAIT}s），跳过 tunnel"
    exit 1
  fi
done

echo "[tunnel] 服务就绪，启动 cloudflare tunnel..."
exec cloudflared tunnel run luotong
