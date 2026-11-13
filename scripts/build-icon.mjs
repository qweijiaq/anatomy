/**
 * Generate the app icon.
 *
 * macOS does **not** round the corners of an .icns: whatever the PNG contains is
 * what the Dock draws. A full-bleed square therefore reads as a raw bitmap next to
 * every other app's rounded tile. So the master is drawn the way Apple's own icons
 * are: an 824px rounded square centred on a 1024 canvas — the "squircle" grid where
 * the tile occupies about 80% and the transparent margin gives the shadow room.
 *
 * The mark itself is two shapes, because at 16px in the Dock only two survive: a
 * filled dot and a rule.
 *
 *   node scripts/build-icon.mjs
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const out = path.join(process.cwd(), 'build')
mkdirSync(out, { recursive: true })

/** Apple's icon grid: 1024 canvas, 824 tile, 100px margins, corner radius ~180. */
const CANVAS = 1024
const TILE = 824
const INSET = (CANVAS - TILE) / 2
const RADIUS = 186

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" preserveAspectRatio="xMidYMid meet"
     style="display:block;width:${CANVAS}px;height:${CANVAS}px">
  <style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
  <!-- the tile: a rounded square, inset so the Dock can draw its shadow -->
  <rect x="${INSET}" y="${INSET}" width="${TILE}" height="${TILE}" rx="${RADIUS}" ry="${RADIUS}" fill="#faf9f7"/>
  <!-- a hairline just inside the edge, the way macOS tiles catch light -->
  <rect x="${INSET + 2}" y="${INSET + 2}" width="${TILE - 4}" height="${TILE - 4}" rx="${RADIUS - 2}" ry="${RADIUS - 2}"
        fill="none" stroke="#e4e0d8" stroke-width="2"/>
  <circle cx="${CANVAS / 2}" cy="${CANVAS / 2 - 96}" r="104" fill="#b4532a"/>
  <rect x="${CANVAS / 2 - 214}" y="${CANVAS / 2 + 78}" width="428" height="21" rx="10" fill="#1f1c18"/>
  <rect x="${CANVAS / 2 - 214}" y="${CANVAS / 2 + 136}" width="318" height="21" rx="10" fill="#d3cec3"/>
  <rect x="${CANVAS / 2 - 214}" y="${CANVAS / 2 + 194}" width="242" height="21" rx="10" fill="#e4e0d8"/>
</svg>`

const svgPath = path.join(out, 'icon.svg')
writeFileSync(svgPath, svg)

// `sips` cannot read SVG, and `qlmanage` renders only the strokes — the filled tile
// comes out fully transparent, which made the Dock icon invisible. Headless Chrome
// rasterises SVG with its alpha intact, and it is already on this machine.
const iconset = path.join(out, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

const master = path.join(out, 'icon-1024.png')
const chrome = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  process.stderr.write('need Chrome or Chromium to rasterise the icon\n')
  process.exit(1)
}
execFileSync(
  chrome,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--screenshot=${master}`,
    `--window-size=${CANVAS},${CANVAS}`,
    '--default-background-color=00000000',
    `file://${svgPath}`,
  ],
  { stdio: 'ignore' },
)

// Every size macOS asks for; missing entries make the Dock fall back to a blurry one.
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    execFileSync('/usr/bin/sips', ['-z', String(px), String(px), master, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    })
  }
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })

process.stdout.write(`wrote build/icon.icns (tile ${TILE}px on a ${CANVAS}px canvas, radius ${RADIUS})\n`)
