import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, the Rust server runs on :8080 and Vite proxies the API to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
      '/readyz': 'http://127.0.0.1:8080',
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
