import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// 端口/后端目标可由环境变量覆盖，便于在同机并行运行多个 checkout 实例而不抢端口。
// 例：WEB_PORT=4300 VITE_API_TARGET=http://localhost:4301 pnpm dev:web
const WEB_PORT = Number(process.env.WEB_PORT) || 4200
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4201'
const WS_TARGET = API_TARGET.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [vue()],
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
})
