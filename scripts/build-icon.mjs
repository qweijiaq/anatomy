/**
 * Generate the app icon.
 *
 * Electron's default icon is the generic "no icon" placeholder, which is why the
 * Dock shows nothing recognisable. Rendering one here instead of committing a
 * binary keeps the source readable: the mark is a circle and a rule, drawn from
 * the same tokens the window uses, and `sips` turns the 1024px master into the
 * `.icns` macOS wants.
 *
 *   node scripts/build-icon.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const out = path.join(process.cwd(), 'build')
mkdirSync(out, { recursive: true })

/**
 * The mark: a filled dot for the accent, a hairline for the page.
 *
 * At 16px in the Dock only the dot and the ring survive, so the shape has to read
 * as two things at that size: a circle and a horizontal line. No text — a two-letter
 * wordmark turns to mud below 32px.
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="228" fill="#faf9f7"/>
  <circle cx="512" cy="392" r="132" fill="#b4532a"/>
  <rect x="248" y="596" width="528" height="26" rx="13" fill="#1f1c18"/>
  <rect x="248" y="668" width="392" height="26" rx="13" fill="#d3cec3"/>
  <rect x="248" y="740" width="300" height="26" rx="13" fill="#e4e0d8"/>
</svg>`

const svgPath = path.join(out, 'icon.svg')
writeFileSync(svgPath, svg)

// `sips` cannot read SVG; `qlmanage` can rasterise it through Quick Look.
const iconset = path.join(out, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

const master = path.join(out, 'icon-1024.png')
execFileSync('/usr/bin/qlmanage', ['-t', '-s', '1024', '-o', out, svgPath], { stdio: 'ignore' })
const rendered = path.join(out, 'icon.svg.png')
execFileSync('/bin/mv', [rendered, master])

const sizes = [16, 32, 64, 128, 256, 512, 1024]
for (const size of sizes) {
  for (const scale of [1, 2]) {
    const px = size * scale
    if (px > 1024) continue
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    execFileSync('/usr/bin/sips', ['-z', String(px), String(px), master, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    })
  }
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })

process.stdout.write('wrote build/icon.icns\n')
