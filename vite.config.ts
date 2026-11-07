import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { assetsInlineLimit: 0 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8001', changeOrigin: true } },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8001', changeOrigin: true } },
  },
});
