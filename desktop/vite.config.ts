import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'path';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  root: join(__dirname, 'src/renderer'),
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        entry: join(__dirname, 'src/main/index.ts'),
      },
      preload: {
        input: join(__dirname, 'src/preload/index.ts'),
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: join(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': join(__dirname, 'src/renderer'),
    },
  },
});
