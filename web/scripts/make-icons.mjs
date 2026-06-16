// Renders the Agentkeep mark — an open book — onto the Reading Room cream ground
// at PWA / favicon sizes. Keep this in sync with the nav brandmark in
// web/app/components/Rail.tsx.
// Run once: node web/scripts/make-icons.mjs   (regenerates web/public/icon-*.png + web/app/icon.png)
import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'

const SPACE = '#F4EDDF' // Reading Room --space (warm cream paper)
const ACC = '#3B6B53' // Reading Room --acc (reading-lamp green)

// The open-book brandmark, drawn in its native 32-unit box; scaled to ~60% and
// centered so it sits inside a maskable icon's safe zone with room to breathe.
const mark = (s) => {
  const scale = (s * 0.6) / 32
  const off = s * 0.2
  const page = (d) => `<path d="${d}" fill="${ACC}" fill-opacity="0.1" stroke="${ACC}" stroke-width="2" stroke-linejoin="round"/>`
  return `<g transform="translate(${off} ${off}) scale(${scale})" fill="none">
    ${page('M16 8.6 C 11.5 6.1, 6.5 6.1, 3.5 7.9 L3.5 22.3 C 6.5 20.5, 11.5 20.5, 16 22.9 Z')}
    ${page('M16 8.6 C 20.5 6.1, 25.5 6.1, 28.5 7.9 L28.5 22.3 C 25.5 20.5, 20.5 20.5, 16 22.9 Z')}
  </g>`
}

const svg = (size, rx = size * 0.18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${SPACE}"/>
  ${mark(size)}
</svg>`

// maskable + apple are full-bleed (rx=0): the launcher / iOS apply their own
// mask, so a rounded ground would show the page background in the corners.
const targets = [
  ['../public/icon-192.png', 192],
  ['../public/icon-512.png', 512],
  ['../public/icon-512-maskable.png', 512, 0],
  ['../public/apple-touch-icon.png', 180, 0],
  ['../app/icon.png', 256], // Next app-icon → the browser-tab favicon
]
for (const [file, size, rx] of targets) {
  await writeFile(new URL(file, import.meta.url),
    await sharp(Buffer.from(svg(size, rx))).png().toBuffer())
  console.log('wrote', file)
}
