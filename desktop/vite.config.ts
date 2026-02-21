import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'path';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/index.ts',
      },
      preload: {
        input: 'src/preload/index.ts',
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': join(__dirname, 'src/renderer'),
    },
  },
});
