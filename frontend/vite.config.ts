import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: '../web',
    emptyOutDir: false,
    sourcemap: false,
  },
});
