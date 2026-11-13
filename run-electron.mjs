/**
 * Launch the desktop app without the environment this session sets.
 *
 * The agent shell exports `ELECTRON_RUN_AS_NODE=1`. With it, Electron runs as a
 * bare Node process: `require('electron')` returns the binary path as a string,
 * `app` is undefined, and the window never opens. Everything downstream of that is
 * a correct app failing for an environment reason, so the launcher is explicit
 * about it rather than asking every future run to remember.
 */
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
})
child.on('exit', (code) => process.exit(code ?? 0))
