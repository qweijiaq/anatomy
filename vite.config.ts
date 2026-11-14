import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Three builds, one config each: the renderer (below), the main process and the
 * preload script (in `scripts/build-electron.mjs`). They are separate because the
 * renderer runs sandboxed in a browser context while the other two are Node.
 */
/**
 * Put the Content-Security-Policy in the document itself, for the packaged build.
 *
 * `ses.webRequest.onHeadersReceived` in the main process does not enforce a policy
 * on a `file://` document: measured on the built app, the hook fires but an inline
 * script still runs, so the packaged renderer had no CSP while the code claimed it
 * did. A meta tag is enforced for `file://`.
 *
 * Build only. The dev server needs its websocket and Vite's inline HMR client, which
 * the strict policy blocks — dev keeps the looser header from the main process.
 */
function strictCsp(): Plugin {
  const policy =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'"
  return {
    name: 'anatomy-strict-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      )
    },
  }
}

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'renderer'),
  base: './',
  plugins: [react(), strictCsp()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
