#!/usr/bin/env sh
# 顺序编排开发栈，消除 web↔api 的启动竞速（vite 代理 "socket hang up"）。
#
# 背景：pnpm 并行启动时 web(vite) 毫秒级就绪，而 API 需要数秒同步构建内存索引
# （向量召回 / 事实索引 / 加载图谱）才开始响应。浏览器在这个空窗里打到 /api/* 与 /ws，
# 就会被 vite 代理报 socket hang up。这里改成：先起 packages 监视器 + API，
# 待 /api/health 通过后再起 web —— 浏览器只在 API 就绪后才发请求。
#
# 仅包含真正的开发栈：packages/* + @aiops/api + @aiops/web。
# 刻意排除 @aiops/mcp（由 Claude Code 按需 stdio 拉起）与 @aiops/indexer（CLI，无需常驻）。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# 确定 API 端口用于健康检查：优先环境变量（与 dotenv 一致：env 覆盖 .env），
# 否则读 .env，再否则默认 4201。
if [ -z "$API_PORT" ]; then
  API_PORT="$(grep -E '^[[:space:]]*API_PORT=' .env 2>/dev/null | head -n1 | cut -d= -f2 | tr -d '[:space:]')"
fi
[ -z "$API_PORT" ] && API_PORT=4201
HEALTH="http://127.0.0.1:${API_PORT}/api/health"

# Ctrl+C / 退出时，停掉整个进程组（一次全停，避免残留 tsx/vite 监视器）。
cleanup() { trap - EXIT INT TERM; kill 0 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "[dev] 启动 packages 监视器 + API …"
pnpm --parallel --filter "./packages/*" --filter @aiops/api run dev &

printf "[dev] 等待 API 就绪 %s " "$HEALTH"
i=0
while [ "$i" -lt 90 ]; do
  if curl -s -m 2 "$HEALTH" >/dev/null 2>&1; then
    echo " ✓"
    break
  fi
  printf "."
  sleep 1
  i=$((i + 1))
done
[ "$i" -ge 90 ] && echo " (超时 90s，仍继续启动 web)"

echo "[dev] 启动 web …"
pnpm --filter @aiops/web run dev &

wait
