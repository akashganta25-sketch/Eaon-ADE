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
