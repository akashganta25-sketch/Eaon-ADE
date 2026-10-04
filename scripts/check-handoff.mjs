/*
 * Checks Conductor hand-off pure helpers:
 * - sanitizePaste (control characters, bracketed paste end marker, newlines, unicode)
 * - fenceFor (Markdown code fence backtick calculation)
 *
 *   node scripts/check-handoff.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-handoff-'))

let pass = 0
const failures = []
let group = ''
const describe = (name) => {
  group = name
  console.log(`\n\x1b[1m${name}\x1b[0m`)
}
const ok = (label, cond, detail) => {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failures.push(`${group} › ${label}${detail ? `\n      ${detail}` : ''}`)
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `\n      ${detail}` : ''}`)
  }
}
const eq = (label, actual, expected) =>
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

/* ── bundle and import the shared module ───────────────────────────────────── */

const bundle = path.join(tmp, 'handoff.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/handoff.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

const { sanitizePaste, fenceFor, collapseRepeats, linesToText } = await import(
  pathToFileURL(bundle).href
)

/* ── 1. sanitizePaste ──────────────────────────────────────────────────────── */

describe('1. sanitizePaste: newline normalisation and C0 stripping')

eq('empty string returns empty', sanitizePaste(''), '')
eq('normalises CRLF to LF', sanitizePaste('line 1\r\nline 2\r\n'), 'line 1\nline 2\n')
eq('normalises bare CR to LF', sanitizePaste('line 1\rline 2\r'), 'line 1\nline 2\n')
eq('preserves regular newlines and tabs', sanitizePaste('\titem 1\n\titem 2\n'), '\titem 1\n\titem 2\n')
eq('strips NUL (0x00)', sanitizePaste('hello\x00world'), 'helloworld')
eq('strips bell (0x07)', sanitizePaste('warning\x07!'), 'warning!')
eq('strips backspace and form-feed', sanitizePaste('a\x08b\x0cc'), 'abc')
eq('strips vertical tab and DEL (0x7F)', sanitizePaste('x\x0by\x7fz'), 'xyz')

describe('2. sanitizePaste: ESC and bracketed-paste exit injection')

eq('strips standalone ESC (0x1B)', sanitizePaste('text\x1bmore'), 'textmore')
eq(
  'defangs exact bracketed paste exit marker payload',
  sanitizePaste('\x1b[201~echo HACKED\n'),
  '[201~echo HACKED\n'
)
eq(
  'strips multiple ANSI color codes',
  sanitizePaste('\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m'),
  '[31mred[0m [32mgreen[0m'
)

describe('3. sanitizePaste: unicode, emoji and international text')

eq('preserves emoji', sanitizePaste('Agent 🚀 completed work ✨'), 'Agent 🚀 completed work ✨')
eq('preserves CJK text', sanitizePaste('こんにちは世界 / 你好世界 / 한국어'), 'こんにちは世界 / 你好世界 / 한국어')
eq('preserves accented characters', sanitizePaste('résumé café Zürich'), 'résumé café Zürich')

/* ── 4. fenceFor ───────────────────────────────────────────────────────────── */

describe('4. fenceFor: Markdown code fence length')

eq('empty content gets default 3 backticks', fenceFor(''), '```')
eq('content with no backticks gets 3 backticks', fenceFor('hello world\nconst x = 1;'), '```')
eq('content with 1 backtick gets 3 backticks', fenceFor('use `inline code` here'), '```')
eq('content with 2 backticks gets 3 backticks', fenceFor('use ``double backticks`` here'), '```')
eq('content with 3 backticks gets 4 backticks', fenceFor('```js\nconsole.log(1)\n```'), '````')
eq('content with 6 backticks gets 7 backticks', fenceFor('some text `````` more text'), '```````')
eq('content with 1000 backticks gets 1001 backticks', fenceFor('`'.repeat(1000)), '`'.repeat(1001))

/* ── 5. collapseRepeats ────────────────────────────────────────────────────── */

describe('5. collapseRepeats: identical consecutive lines')

eq('empty array returns empty', JSON.stringify(collapseRepeats([])), JSON.stringify([]))
eq('single line preserved', JSON.stringify(collapseRepeats(['line 1'])), JSON.stringify(['line 1']))
eq(
  'run of exactly 2 identical lines preserved',
  JSON.stringify(collapseRepeats(['item', 'item'])),
  JSON.stringify(['item', 'item'])
)
eq(
  'run of exactly 3 identical lines collapsed',
  JSON.stringify(collapseRepeats(['item', 'item', 'item'])),
  JSON.stringify(['item', '[repeated 2 more times]'])
)
eq(
  'run of 1000 identical lines collapsed',
  JSON.stringify(collapseRepeats(Array(1000).fill('spinner'))),
  JSON.stringify(['spinner', '[repeated 999 more times]'])
)
eq(
  'mixed runs correctly processed',
  JSON.stringify(collapseRepeats(['a', 'b', 'b', 'b', 'c', 'c', 'd', 'd', 'd', 'd'])),
  JSON.stringify(['a', 'b', '[repeated 2 more times]', 'c', 'c', 'd', '[repeated 3 more times]'])
)

/* ── 6. linesToText ────────────────────────────────────────────────────────── */

describe('6. linesToText: soft-wrap joining, trailing blank trim, and repeat collapse')

eq('empty lines array returns empty string', linesToText([]), '')
eq(
  'single unwrapped line returns its text',
  linesToText([{ text: 'const answer = 42', wrapped: false }]),
  'const answer = 42'
)
eq(
  'joins soft-wrapped lines across columns',
  linesToText([
    { text: 'curl https://api.example.com/', wrapped: false },
    { text: 'v1/resources?status=active', wrapped: true }
  ]),
  'curl https://api.example.com/v1/resources?status=active'
)
eq(
  'joins multiple consecutive soft-wrapped segments',
  linesToText([
    { text: 'part 1 - ', wrapped: false },
    { text: 'part 2 - ', wrapped: true },
    { text: 'part 3', wrapped: true },
    { text: 'next line', wrapped: false }
  ]),
  'part 1 - part 2 - part 3\nnext line'
)
eq(
  'trims trailing blank lines',
  linesToText([
    { text: 'output line', wrapped: false },
    { text: '   ', wrapped: false },
    { text: '', wrapped: false }
  ]),
  'output line'
)
eq(
  'collapses 3+ identical lines in terminal buffer',
  linesToText([
    { text: 'loading...', wrapped: false },
    { text: 'loading...', wrapped: false },
    { text: 'loading...', wrapped: false },
    { text: 'done', wrapped: false }
  ]),
  'loading...\n[repeated 2 more times]\ndone'
)

/* ── finish up ────────────────────────────────────────────────────────────── */

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed\x1b[0m\n`)
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`)
  process.exit(1)
}
