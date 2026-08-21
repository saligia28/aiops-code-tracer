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
    build: {
      rollupOptions: {
        output: {
          // 只固定"每屏都要、且极少变"的两块，让它们独立缓存：
          //   react 全家桶（版本不动就永远命中缓存）
          //   antd 的样式引擎（cssinjs + 主题算法，ConfigProvider 一挂载就需要）
          // 刻意**不**把 antd 组件整包归到一个 chunk —— 那会让首屏被迫下载
          //   Modal/Select/Card/Descriptions 等只有懒加载路由才用的组件，
          //   反而把首屏做大。组件级拆分交给 rollup 按引用图自然切。
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (/[\\/]node_modules[\\/](\.pnpm[\\/])?(react|react-dom|scheduler|react-router|react-router-dom)([\\/@]|$)/.test(id)) {
              return 'vendor-react';
            }
            if (id.includes('@ant-design/cssinjs') || id.includes('@ant-design/fast-color') || id.includes('/stylis/')) {
              return 'vendor-antd-style';
            }
          },
        },
      },
    },
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
