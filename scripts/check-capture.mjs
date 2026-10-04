/*
 * Checks the pure parts of the browser capture handler: filename construction,
 * age-based file pruning, and bounded-work enforcement.
 *
 *   node scripts/check-capture.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-capture-test-'))

let pass = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

const outfile = path.join(tmp, 'browser.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/browser.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'e', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            export const app = { getPath: () => ${JSON.stringify(tmp)} }
            export const webContents = { fromId: () => null }
            export const BrowserWindow = {}
          `,
          loader: 'js'
        }))
      }
    }
  ]
})
const browser = await import(outfile)

/* ---- 1. filename generation ---------------------------------------------- */

console.log('\nfilename builder produces sanitized, timestamped names')

const t0 = 1728000000000
const name1 = browser.buildCaptureFilename(t0)
check('starts with preview-', name1.startsWith('preview-'))
check('ends with .png', name1.endsWith('.png'))
check('contains base36 timestamp', name1 === `preview-${t0.toString(36)}.png`)

const defaultName = browser.buildCaptureFilename()
check('default call produces valid name', /^preview-[0-9a-z]+\.png$/.test(defaultName))

/* ---- 2. age-based cleanup ------------------------------------------------ */

console.log('\ncleanupOldCaptures deletes only old preview captures')

const captureDir = path.join(tmp, 'captures')
fs.mkdirSync(captureDir, { recursive: true })

const now = Date.now()
const oneHourAgo = (now - 3600 * 1000) / 1000
const twentyFiveHoursAgo = (now - 25 * 3600 * 1000) / 1000
const twoDaysAgo = (now - 48 * 3600 * 1000) / 1000

// 1. Fresh capture (should be kept)
const freshFile = path.join(captureDir, 'preview-recent.png')
fs.writeFileSync(freshFile, 'fresh')
fs.utimesSync(freshFile, oneHourAgo, oneHourAgo)

// 2. Old captures (should be deleted)
const oldFile1 = path.join(captureDir, 'preview-old1.png')
fs.writeFileSync(oldFile1, 'old1')
fs.utimesSync(oldFile1, twentyFiveHoursAgo, twentyFiveHoursAgo)

const oldFile2 = path.join(captureDir, 'preview-old2.png')
fs.writeFileSync(oldFile2, 'old2')
fs.utimesSync(oldFile2, twoDaysAgo, twoDaysAgo)

// 3. Unrelated files (must never be touched even if old)
const unrelatedTxt = path.join(captureDir, 'unrelated.txt')
fs.writeFileSync(unrelatedTxt, 'text')
fs.utimesSync(unrelatedTxt, twoDaysAgo, twoDaysAgo)

const unrelatedImg = path.join(captureDir, 'photo.png')
fs.writeFileSync(unrelatedImg, 'photo')
fs.utimesSync(unrelatedImg, twoDaysAgo, twoDaysAgo)

const cleaned = await browser.cleanupOldCaptures(captureDir, now, 24 * 3600 * 1000, 200)

check('reports 2 files cleaned', cleaned === 2, `cleaned=${cleaned}`)
check('old preview 1 is deleted', !fs.existsSync(oldFile1))
check('old preview 2 is deleted', !fs.existsSync(oldFile2))
check('fresh preview is preserved', fs.existsSync(freshFile))
check('unrelated txt is preserved', fs.existsSync(unrelatedTxt))
check('unrelated photo is preserved', fs.existsSync(unrelatedImg))

/* ---- 3. bounded examination limit ---------------------------------------- */

console.log('\ncleanupOldCaptures honors bounded examination ceiling')

const boundedDir = path.join(tmp, 'bounded')
fs.mkdirSync(boundedDir, { recursive: true })

for (let i = 0; i < 30; i++) {
  const p = path.join(boundedDir, `preview-item-${i.toString().padStart(3, '0')}.png`)
  fs.writeFileSync(p, 'old')
  fs.utimesSync(p, twoDaysAgo, twoDaysAgo)
}

// Limit examine count to 10
const boundedCleaned = await browser.cleanupOldCaptures(boundedDir, now, 24 * 3600 * 1000, 10)
check('cleans at most maxExamine files', boundedCleaned === 10, `cleaned=${boundedCleaned}`)
const remaining = fs.readdirSync(boundedDir).length
check('remaining files left for future passes', remaining === 20, `remaining=${remaining}`)

/* ---- 4. non-existent directory handles gracefully ------------------------ */

console.log('\nnon-existent directory returns 0 without throwing')
const nonExistent = path.join(tmp, 'does-not-exist')
const res = await browser.cleanupOldCaptures(nonExistent, now)
check('returns 0 for missing directory', res === 0)

/* ---- done ------------------------------------------------------------------ */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
