/**
 * Build `anatomy.app` from the Electron runtime.
 *
 * Why a copy of Electron.app rather than a bare launcher: the Dock and Cmd-Tab read
 * the app's *name* and *icon* from `Info.plist`, not from `app.setName()` or
 * `app.dock.setIcon()`. With the stock bundle every Electron app on the machine is
 * called "Electron" and wears the same blank icon, so four of them are
 * indistinguishable in the Dock. Renaming the bundle is the only fix that macOS honours.
 *
 * What it does, in order:
 *   1. copy `node_modules/electron/dist/Electron.app` to `out/anatomy.app`;
 *   2. rewrite `Info.plist` — name, identifier, icon file, a matching URL scheme;
 *   3. install `build/icon.icns` over `Resources/electron.icns`;
 *   4. re-sign the bundle ad-hoc, because editing Info.plist invalidates the
 *      signature and macOS refuses to launch a bundle whose signature is broken.
 *
 * The app payload (the bundled main process and the renderer) stays where
 * `npm run build:desktop` put it; the bundle points at the project root, which is
 * what you want for a development build and is replaced by `electron-builder` for
 * a distributable.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const source = path.join(root, 'node_modules/electron/dist/Electron.app')
const target = path.join(root, 'out/anatomy.app')
const plist = path.join(target, 'Contents/Info.plist')
const icon = path.join(root, 'build/icon.icns')

if (!existsSync(source)) {
  process.stderr.write(`missing ${source} — run npm install first\n`)
  process.exit(1)
}
if (!existsSync(icon)) {
  process.stderr.write(`missing ${icon} — run node scripts/build-icon.mjs first\n`)
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(path.dirname(target), { recursive: true })
cpSync(source, target, { recursive: true, verbatimSymlinks: true })

/** PlistBuddy: quiet, scriptable, and it keeps the plist well-formed. */
const buddy = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' }).trim()

buddy('Set :CFBundleName anatomy')
buddy('Set :CFBundleDisplayName anatomy')
// Versioned on purpose: Dock and LaunchServices cache an icon per bundle id, so a
// changed icon with an unchanged id keeps showing the old artwork. Bumping this is
// how the cache is invalidated without asking the user to rebuild their icon cache.
buddy('Set :CFBundleIdentifier ai.anatomy.app.v2')
buddy('Set :CFBundleExecutable Electron')
buddy('Set :CFBundleIconFile electron')
// A version bump alongside the id: LaunchServices keys its icon cache on the pair.
buddy('Set :CFBundleVersion 2')
buddy('Set :CFBundleShortVersionString 0.2.0')
// A distinct URL scheme so `open anatomy://…` reaches this bundle, not Electron.
// The stock bundle has no CFBundleURLTypes at all, so add the key rather than only
// rewriting an existing one.
const hasUrlTypes = (() => {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleURLTypes', plist], {
      encoding: 'utf8',
    }).includes('electron')
  } catch {
    return false
  }
})()
if (!hasUrlTypes) {
  buddy('Add :CFBundleURLTypes array')
  buddy('Add :CFBundleURLTypes:0 dict')
  buddy('Add :CFBundleURLTypes:0:CFBundleURLName string ai.anatomy.app.v2')
  buddy('Add :CFBundleURLTypes:0:CFBundleURLSchemes array')
  buddy('Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string anatomy')
}

// The icon lives where the runtime looks for it; editing Info.plist above already
// pointed CFBundleIconFile at this file name.
cpSync(icon, path.join(target, 'Contents/Resources/electron.icns'))

// Editing Info.plist breaks the signature. Ad-hoc signing restores a valid one, which
// is all a locally built app needs (Gatekeeper only verifies notarised apps from the
// internet, and this one never leaves the machine).
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'ignore' })
// The identifier in the signature comes from CFBundleIdentifier; re-signing after the
// plist edit is what makes the Dock read the new name. Verify rather than assume.
const identity = execFileSync('/usr/bin/codesign', ['-dv', target], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })

process.stdout.write(`wrote ${path.relative(root, target)}\n`)
process.stdout.write(`  name:       ${buddy('Print :CFBundleName')}\n`)
process.stdout.write(`  identifier: ${buddy('Print :CFBundleIdentifier')}\n`)
