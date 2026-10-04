/*
 * Checks the main-process half of rich previews: binary-safe reading, mime
 * detection, and the size cap.
 *
 * The renderer half — markdown-to-HTML and sanitization — needs a real DOM
 * (DOMPurify requires one) and is deliberately verified live, against the
 * actual running app, with a genuine XSS payload and a canary that proves
 * whether it fired. See the live check for that; this script covers what a
 * plain Node process can prove deterministically.
 *
 *   node scripts/check-preview.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-preview-'))

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

const outfile = path.join(tmp, 'fsapi.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/fsapi.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // fsapi.ts reaches into `electron` only for app.getPath('temp') inside
  // saveDropped, which nothing below calls.
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'e', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} }`,
          loader: 'js'
        }))
      }
    }
  ]
})
const fsapi = await import(outfile)

/* ---- 1. mime detection --------------------------------------------------- */

console.log('\nmime detection is extension-based and nothing else')
check('.png maps to image/png', fsapi.mimeFor('/a/b.png') === 'image/png')
check('.PNG (uppercase) still matches', fsapi.mimeFor('/a/b.PNG') === 'image/png')
check('.jpg and .jpeg both map to image/jpeg', fsapi.mimeFor('x.jpg') === 'image/jpeg' && fsapi.mimeFor('x.jpeg') === 'image/jpeg')
check('.svg maps to image/svg+xml', fsapi.mimeFor('x.svg') === 'image/svg+xml')
check('.pdf maps to application/pdf', fsapi.mimeFor('x.pdf') === 'application/pdf')
check('.md is not a binary-previewable type', fsapi.mimeFor('x.md') === null)
check('.exe is not guessed at', fsapi.mimeFor('x.exe') === null)
check('a file with no extension is not guessed at', fsapi.mimeFor('README') === null)

/* ---- 2. reading real bytes ------------------------------------------------ */

console.log('\nreadBinary round-trips real bytes as base64')
// A real (tiny, valid) PNG — the 1x1 transparent pixel every test suite uses.
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const pngPath = path.join(tmp, 'pixel.png')
fs.writeFileSync(pngPath, pngBytes)

const read = await fsapi.readBinary(pngPath)
check('the mime is reported', read.mime === 'image/png', read.mime)
check('not marked truncated', read.truncated === false)
check(
  'decoding the base64 reproduces the exact original bytes',
  Buffer.from(read.base64, 'base64').equals(pngBytes)
)

/* ---- 3. the size cap ------------------------------------------------------ */

console.log('\noversized files are refused, not silently truncated')
// A real file one byte over the actual 24 MB constant — writing 24 MB to a
// temp file is fast enough not to matter, and this is the exact boundary the
// source enforces, not a stand-in for it.
const overCapPath = path.join(tmp, 'over-cap.png')
const capBytes = 24 * 1024 * 1024 + 1
fs.writeFileSync(overCapPath, Buffer.alloc(capBytes))
let capError = null
try {
  await fsapi.readBinary(overCapPath)
} catch (err) {
  capError = err
}
check('a file one byte over the cap is refused', capError instanceof Error)
check(
  'the message states the limit in human terms, not a raw byte count',
  /MB/.test(capError?.message ?? ''),
  capError?.message
)
fs.rmSync(overCapPath, { force: true })

/* ---- 4. refusing what it was not built for -------------------------------- */

console.log('\na non-previewable extension is refused before any bytes are touched')
const txtPath = path.join(tmp, 'notes.txt')
fs.writeFileSync(txtPath, 'plain text, not an image')
let textError = null
try {
  await fsapi.readBinary(txtPath)
} catch (err) {
  textError = err
}
check('a .txt file is refused by readBinary', textError instanceof Error)
check('with a clear reason', /not.*previewable/i.test(textError?.message ?? ''), textError?.message)

/* ---- 5. console buffer helpers (pushEntry & errorCount) ------------------- */

console.log('\nconsole buffer helpers enforce capacity, immutability, and count errors')

const browserOut = path.join(tmp, 'browser.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/browser.ts')],
  outfile: browserOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const browser = await import(browserOut)

const emptyBuf = []
const entry1 = { level: 3, message: 'ReferenceError: foo is not defined', source: 'app.js', line: 42, at: 1000 }
const buf1 = browser.pushEntry(emptyBuf, entry1)

check('pushEntry returns new array', Array.isArray(buf1) && buf1.length === 1)
check('pushEntry is immutable', emptyBuf.length === 0)
check('pushed entry contains properties', buf1[0].message === entry1.message && buf1[0].level === 3)

// Message cap at 2000 chars
const longMsg = 'X'.repeat(3000)
const longEntry = { level: 2, message: longMsg, source: 'vendor.js', line: 1, at: 1001 }
const bufWithLong = browser.pushEntry([], longEntry)
check('message is truncated to 2000 chars', bufWithLong[0].message.length === 2000)

// Cap enforcement and dropping oldest
let testBuf = []
for (let i = 0; i < 205; i++) {
  testBuf = browser.pushEntry(testBuf, {
    level: (i % 4),
    message: `Message #${i}`,
    source: `file${i}.js`,
    line: i + 1,
    at: 1000 + i
  })
}

check('buffer cap of 200 is enforced', testBuf.length === 200)
check('oldest entries are dropped', testBuf[0].message === 'Message #5')
check('newest entry is preserved at end', testBuf[199].message === 'Message #204')

// Custom cap parameter
let customCapBuf = []
for (let i = 0; i < 10; i++) {
  customCapBuf = browser.pushEntry(customCapBuf, {
    level: 1,
    message: `Entry ${i}`,
    source: 's.js',
    line: i,
    at: i
  }, 5)
}
check('custom cap parameter is respected', customCapBuf.length === 5 && customCapBuf[0].message === 'Entry 5')

// errorCount
check('errorCount on empty buffer is 0', browser.errorCount([]) === 0)

const mixedEntries = [
  { level: 0, message: 'verbose', source: 'a.js', line: 1, at: 1 },
  { level: 1, message: 'info', source: 'b.js', line: 2, at: 2 },
  { level: 2, message: 'warning 1', source: 'c.js', line: 3, at: 3 },
  { level: 3, message: 'error 1', source: 'd.js', line: 4, at: 4 },
  { level: 2, message: 'warning 2', source: 'e.js', line: 5, at: 5 },
  { level: 3, message: 'error 2', source: 'f.js', line: 6, at: 6 },
  { level: 3, message: 'error 3', source: 'g.js', line: 7, at: 7 }
]

check('errorCount counts only level 3 entries', browser.errorCount(mixedEntries) === 3)

const noErrors = [
  { level: 0, message: 'verbose', source: 'a.js', line: 1, at: 1 },
  { level: 1, message: 'info', source: 'b.js', line: 2, at: 2 },
  { level: 2, message: 'warning', source: 'c.js', line: 3, at: 3 }
]
check('errorCount returns 0 when no errors exist', browser.errorCount(noErrors) === 0)

/* ---- 6. formatConsoleReport ----------------------------------------------- */

console.log('\nformatConsoleReport: header, dedupe, truncation, fencing, and security')

// Empty entries
const emptyReport = browser.formatConsoleReport({
  url: 'http://localhost:5173/',
  entries: [],
  includeWarnings: false
})
check('empty entries returns empty text', emptyReport.text === '')
check('empty entries shown is 0', emptyReport.shown === 0)
check('empty entries omitted is 0', emptyReport.omitted === 0)

// Header with URL containing quotes and spaces
const urlWithSpecial = 'http://localhost:3000/app "test"/?q=hello world'
const basicReport = browser.formatConsoleReport({
  url: urlWithSpecial,
  entries: [{ level: 3, message: 'Crash occurred', source: 'main.ts', line: 12, at: 100 }],
  includeWarnings: false
})
check('header contains exact url', basicReport.text.includes(urlWithSpecial))
check('header identifies report as untrusted', basicReport.text.includes('Untrusted browser console report'))
check('basic report shown is 1', basicReport.shown === 1)
check('basic report omitted is 0', basicReport.omitted === 0)

// includeWarnings filtering
const mixedWarnError = [
  { level: 0, message: 'verbose log', source: 'a.js', line: 1, at: 10 },
  { level: 1, message: 'info log', source: 'b.js', line: 2, at: 20 },
  { level: 2, message: 'warning log', source: 'c.js', line: 3, at: 30 },
  { level: 3, message: 'error log', source: 'd.js', line: 4, at: 40 }
]

const noWarnReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: mixedWarnError,
  includeWarnings: false
})
check('includeWarnings=false omits warnings', !noWarnReport.text.includes('warning log'))
check('includeWarnings=false omits verbose/info', !noWarnReport.text.includes('verbose log') && !noWarnReport.text.includes('info log'))
check('includeWarnings=false includes errors', noWarnReport.text.includes('error log') && noWarnReport.shown === 1)

const withWarnReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: mixedWarnError,
  includeWarnings: true
})
check('includeWarnings=true includes warnings', withWarnReport.text.includes('warning log'))
check('includeWarnings=true includes errors', withWarnReport.text.includes('error log'))
check('includeWarnings=true omits verbose/info', !withWarnReport.text.includes('verbose log') && !withWarnReport.text.includes('info log'))
check('includeWarnings=true shown count is 2', withWarnReport.shown === 2)

// Deduplication of consecutive identical entries
const repeatedEntries = [
  { level: 3, message: 'Network failed', source: 'fetch.js', line: 55, at: 10 },
  { level: 3, message: 'Network failed', source: 'fetch.js', line: 55, at: 20 },
  { level: 3, message: 'Network failed', source: 'fetch.js', line: 55, at: 30 },
  { level: 3, message: 'TypeError: null', source: 'ui.js', line: 80, at: 40 },
  { level: 3, message: 'Network failed', source: 'fetch.js', line: 55, at: 50 } // non-consecutive
]
const dedupeReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: repeatedEntries,
  includeWarnings: false
})
check('consecutive duplicates are collapsed with count', dedupeReport.text.includes('(×3)'))
check('non-consecutive duplicate is not merged into earlier group', dedupeReport.text.match(/Network failed/g)?.length === 2)
check('total shown count reflects all 5 underlying events', dedupeReport.shown === 5)

// Chronological ordering
const unorderedEntries = [
  { level: 3, message: 'Event 3', source: 'c.js', line: 3, at: 300 },
  { level: 3, message: 'Event 1', source: 'a.js', line: 1, at: 100 },
  { level: 3, message: 'Event 2', source: 'b.js', line: 2, at: 200 }
]
const orderedReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: unorderedEntries,
  includeWarnings: false
})
const pos1 = orderedReport.text.indexOf('Event 1')
const pos2 = orderedReport.text.indexOf('Event 2')
const pos3 = orderedReport.text.indexOf('Event 3')
check('entries are ordered chronologically', pos1 < pos2 && pos2 < pos3)

// Huge message (clamped to 500 chars)
const hugeMsg = 'Z'.repeat(1200)
const hugeReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: [{ level: 3, message: hugeMsg, source: 'huge.js', line: 1, at: 10 }],
  includeWarnings: false
})
check('huge message is clamped with ellipsis', hugeReport.text.includes('Z'.repeat(500) + '…') && !hugeReport.text.includes('Z'.repeat(501)))

// Triple backticks and dynamic fence escalation
const backtickReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: [{ level: 3, message: 'Error in ```typescript code``` block', source: 'syntax.js', line: 10, at: 10 }],
  includeWarnings: false
})
check('outer fence expands to 4 backticks when content has 3 backticks', backtickReport.text.includes('````\n[error]'))

// ESC and bracketed-paste exit defanging
const injectionMsg = '\x1b[201~echo HACKED;\x1b[0m alert(1)'
const safeReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: [{ level: 3, message: injectionMsg, source: 'eval.js', line: 99, at: 10 }],
  includeWarnings: false
})
check('ESC character is stripped', !safeReport.text.includes('\x1b'))
check('bracketed paste exit injection is defanged', !safeReport.text.includes('\x1b[201~'))

// Unicode, CJK and emoji preserved
const unicodeReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: [{ level: 3, message: 'エラー発生: 💥 Server failed to respond', source: 'api.js', line: 5, at: 10 }],
  includeWarnings: false
})
check('CJK text is preserved', unicodeReport.text.includes('エラー発生:'))
check('emoji is preserved', unicodeReport.text.includes('💥'))

// Total cap and omitted count calculation
const manyEntries = []
for (let i = 0; i < 100; i++) {
  manyEntries.push({
    level: 3,
    message: `Detailed runtime error description for failure number ${i} in transaction handler`,
    source: `transaction_${i}.js`,
    line: i + 10,
    at: 1000 + i
  })
}

const cappedReport = browser.formatConsoleReport({
  url: 'http://localhost:5173',
  entries: manyEntries,
  includeWarnings: false,
  maxChars: 1500
})
check('total text length stays within maxChars', cappedReport.text.length <= 1500)
check('omitted count is accurate', cappedReport.omitted > 0)
check('shown + omitted equals total filtered entries', cappedReport.shown + cappedReport.omitted === 100)
check('includes omitted note in body', cappedReport.text.includes(`[... +${cappedReport.omitted} more entries omitted ...]`))

/* ---- done ------------------------------------------------------------------ */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
