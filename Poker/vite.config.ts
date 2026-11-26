import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Запросы /api из браузера уходят на Express-сервер.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
