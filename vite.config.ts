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
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@tiptap') || id.includes('prosemirror')) return 'editor';
          if (id.includes('framer-motion') || id.includes('motion')) return 'motion';
          if (id.includes('wavesurfer')) return 'audio';
          if (id.includes('react') || id.includes('scheduler') || id.includes('zustand')) return 'react';
          if (id.includes('lucide')) return 'icons';
          return 'vendor';
        },
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
