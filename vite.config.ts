import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

/**
 * Three builds, one config each: the renderer (below), the main process and the
 * preload script (in `scripts/build-electron.mjs`). They are separate because the
 * renderer runs sandboxed in a browser context while the other two are Node.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
