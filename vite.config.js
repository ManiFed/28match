import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy all /api calls (except polymarket which is handled specially below) to the local Express server
      // This lets the new /api/share/* and /api/insights endpoints work during development.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Keep the direct Polymarket proxy for fast external calls (optional but preserved)
      '/api/polymarket': {
        target: 'https://gamma-api.polymarket.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/polymarket/, ''),
      },
    },
  },
})
