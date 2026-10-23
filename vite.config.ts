import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    // 加密/解密等大计算任务放到独立 worker，不阻塞主线程
    worker: {
      format: 'es'
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});