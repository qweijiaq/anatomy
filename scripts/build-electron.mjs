/**
 * Build the two Node-side entry points of the desktop app.
 *
 * `tsc` cannot emit them alone: the main process imports the kernel's TypeScript
 * sources (`src/writing/client.ts`, `src/commands/analyze.ts`) and the project is
 * ESM with `.js` import specifiers. `esbuild` bundles both into single CJS files
 * next to the renderer's output, which is also what Electron loads.
 *
 * The kernel's own build (`npm run build`) stays untouched: the CLI remains a
 * self-contained `dist/cli.js`.
 */
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'dist-electron')

await mkdir(outDir, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Off by default. The main bundle is 9.7 MB and its source map is 14 MB — the
  // largest file in the working tree by a wide margin, for a payload that a local
  // launcher loads once. Set ANA_SOURCEMAP=1 when a stack trace actually needs to
  // point at TypeScript.
  sourcemap: process.env.ANA_SOURCEMAP === '1',
  // Electron is provided by the runtime; everything else is bundled so the app has
  // no dependency on node_modules at launch.
  external: ['electron'],
  logLevel: 'warning',
}

await build({
  ...shared,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  // The Python sidecar is a data file, not a module: it is copied, not bundled.
  loader: { '.py': 'copy' },
})

await build({
  ...shared,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
})

// The Python structure pass spawns a script that must exist on disk beside the
// bundle; without it a Python repository silently reports no structure.
await copyFile(
  path.join(root, 'src/kernel/structure/python_index.py'),
  path.join(outDir, 'python_index.py'),
)

// The Dock icon is read from `<app>/build/`; copy it next to the bundle so the path
// in main.ts holds in a packaged layout too.
await copyFile(path.join(root, 'build', 'icon-1024.png'), path.join(outDir, 'icon-1024.png'))

process.stdout.write('built dist-electron/main.cjs and dist-electron/preload.cjs\n')
