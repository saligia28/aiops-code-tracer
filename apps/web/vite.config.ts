import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// 端口/后端目标读取自仓库根 .env（与 apps/api 经 dotenv 读取的同一份，单一事实源：API_PORT / WEB_PORT），
// 也可用 shell 环境变量覆盖，便于在同机并行运行多个 checkout 实例而不抢端口。
// 例：WEB_PORT=4300 VITE_API_TARGET=http://127.0.0.1:4301 pnpm dev:web
const MONOREPO_ROOT = resolve(__dirname, '../..')

export default defineConfig(({ mode }) => {
  // loadEnv 不会写入 process.env，需手动合并；shell 环境变量优先级高于 .env。
  const rootEnv = loadEnv(mode, MONOREPO_ROOT, '')
  const env = { ...rootEnv, ...process.env }

  const WEB_PORT = Number(env.WEB_PORT) || 4200
  const API_PORT = Number(env.API_PORT) || 4201
  // 用 127.0.0.1 而非 localhost：API 绑定 IPv4 0.0.0.0，Node 17+ 可能把 localhost 先解析为 ::1 导致 ECONNREFUSED。
  const API_TARGET = env.VITE_API_TARGET || `http://127.0.0.1:${API_PORT}`
  const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: WEB_PORT,
      strictPort: true, // 端口被占用直接报错，避免静默改端口导致连错后端
      allowedHosts: ['.local', 'macbook-pro.local', 'luotong.saligia.asia'],
      proxy: {
        '/api': {
          target: API_TARGET,
          changeOrigin: true,
        },
        '/ws': {
          target: WS_TARGET,
          ws: true,
        },
      },
    },
  }
})
