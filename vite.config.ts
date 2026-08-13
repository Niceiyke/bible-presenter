import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    // Multi-page build: the operator console (index.html) plus the browser
    // Remote Control bundle (src/remote -> dist/remote.html) that the Tauri
    // backend serves over the local network.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        remote: resolve(__dirname, 'remote.html'),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
