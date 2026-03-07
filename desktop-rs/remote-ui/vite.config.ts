import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api':        'http://localhost:7420',
      '/media-thumb':'http://localhost:7420',
      '/ws': { target: 'ws://localhost:7420', ws: true },
    },
  },
})
