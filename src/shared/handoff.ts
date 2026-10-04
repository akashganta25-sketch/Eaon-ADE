/**
 * Pure functions for Conductor hand-off between panes.
 *
 * Transmits recent output or diffs from one pane to another agent pane
 * safely, sanitising control escapes, fencing against Markdown collisions,
 * and protecting bare shells from unconfirmed command execution.
 */

/**
 * Strips dangerous control characters and normalises newlines before pasting.
 *
 * Removes all ESC (0x1B) characters — specifically defanging the bracketed paste
 * exit marker `\x1b[201~` which could terminate paste mode early and cause the
 * remainder of the text to be interpreted as live shell commands.
 *
 * Strips all C0 control characters except tab and newline, and converts `\r\n`
 * and standalone `\r` to `\n`.
 */
export function sanitizePaste(text: string): string {
  if (!text) return ''
  // 1. Normalise carriage returns to standard newlines.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 2. Strip all C0 control codes and DEL except tab (0x09) and newline (0x0a).
  // This explicitly covers 0x1b (ESC), 0x00 (NUL), 0x07 (BEL), etc.
  return normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/**
 * Returns a Markdown code fence string whose backtick count is strictly longer
 * than any contiguous run of backticks found within `content` (minimum 3 backticks).
 */
export function fenceFor(content: string): string {
  if (!content) return '```'
  const matches = content.match(/`+/g)
  if (!matches) return '```'
  let maxRun = 0
  for (const m of matches) {
    if (m.length > maxRun) maxRun = m.length
  }
  const needed = Math.max(3, maxRun + 1)
  return '`'.repeat(needed)
}

/**
 * Collapses 3 or more consecutive identical lines into the first line
 * followed by `[repeated N more times]`.
 *
 * Runs of 1 or 2 identical lines are preserved untouched.
 */
export function collapseRepeats(lines: string[]): string[] {
  if (!lines.length) return []
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const cur = lines[i]
    let j = i + 1
    while (j < lines.length && lines[j] === cur) {
      j += 1
    }
    const count = j - i
    if (count >= 3) {
      out.push(cur)
      out.push(`[repeated ${count - 1} more times]`)
    } else {
      for (let k = 0; k < count; k += 1) {
        out.push(cur)
      }
    }
    i = j
  }
  return out
}

/**
 * Converts xterm buffer lines to cleaned text:
 * 1. Joins soft-wrapped lines (where `wrapped: true`) into single continuous lines.
 * 2. Trims trailing blank lines.
 * 3. Collapses 3+ identical consecutive lines.
 * 4. Joins the resulting lines with newline.
 */
export function linesToText(lines: { text: string; wrapped: boolean }[]): string {
  if (!lines.length) return ''
  const unwrapped: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const item = lines[i]
    if (i > 0 && item.wrapped) {
      unwrapped[unwrapped.length - 1] += item.text
    } else {
      unwrapped.push(item.text)
    }
  }

  // Trim trailing blank lines
  while (unwrapped.length > 0 && unwrapped[unwrapped.length - 1].trim() === '') {
    unwrapped.pop()
  }

  const collapsed = collapseRepeats(unwrapped)
  return collapsed.join('\n')
}

