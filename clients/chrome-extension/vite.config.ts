import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'popup',
  base: './',
  build: {
    outDir: '../dist/popup',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'popup.js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
})
