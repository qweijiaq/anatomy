#!/usr/bin/env node
/**
 * Copy the Python sidecar into the build output.
 *
 * The kernel spawns `./python_index.py` relative to its own compiled location, so
 * `tsc` — which only knows about `.ts` — leaves an installed `ana` pointing at a
 * file that is not there. The failure is quiet and total: exit code 2 and no
 * Python structure for anyone. Hence a build step, and a test that runs it.
 *
 * Usage: node scripts/copy-sidecar.mjs [outDir]   (default: ./dist)
 */

import { chmod, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.dirname(here)
const outDir = process.argv[2] === undefined ? path.join(packageRoot, 'dist') : path.resolve(process.argv[2])

const source = path.join(packageRoot, 'src', 'kernel', 'structure', 'python_index.py')
const target = path.join(outDir, 'kernel', 'structure', 'python_index.py')

await mkdir(path.dirname(target), { recursive: true })
await copyFile(source, target)
// Executable like its source, so the sidecar can also be run by hand when debugging.
await chmod(target, 0o755)

console.log(`copied ${path.relative(packageRoot, source)} -> ${path.relative(packageRoot, target)}`)
