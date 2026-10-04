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

export const DEFAULT_MAX_CHARS = 30000
export const HEADER_ALLOWANCE = 2048
export const DEFAULT_INSTRUCTION =
  'Here is the latest work from {from}. Please review it and point out bugs, gaps or risks.'

export interface HandoffInput {
  fromName: string
  kind: 'output' | 'changes'
  body: string
  instruction: string
  maxChars?: number
}

export interface HandoffResult {
  text: string
  chars: number
  truncated: boolean
  omitted: number
}

/**
 * Builds the complete formatted text string to be pasted into the target pane:
 * - Replaces `{from}` in the instruction with the source pane's name.
 * - Adds a header line identifying the source pane and kind.
 * - Caps body content at `maxChars` (preserving the tail for output, head for changes).
 * - Fences the body with a collision-free Markdown code fence.
 * - Runs the final string through `sanitizePaste`.
 */
export function buildHandoffText(input: HandoffInput): HandoffResult {
  const max = input.maxChars ?? DEFAULT_MAX_CHARS
  const rawBody = input.body ?? ''
  let bodyWithMarker = rawBody
  let truncated = false
  let omitted = 0

  if (rawBody.length > max) {
    truncated = true
    omitted = rawBody.length - max
    if (input.kind === 'output') {
      // Keep the tail (latest lines)
      const kept = rawBody.slice(omitted)
      bodyWithMarker = `[… ${omitted} characters omitted …]\n${kept}`
    } else {
      // Keep the head (file order)
      const kept = rawBody.slice(0, max)
      bodyWithMarker = `${kept}\n[… ${omitted} characters omitted …]`
    }
  }

  const fence = fenceFor(bodyWithMarker)
  const resolvedInstruction = input.instruction
    ? input.instruction.replace(/\{from\}/g, input.fromName).trim()
    : ''

  const header =
    input.kind === 'output'
      ? `Output from ${input.fromName}:`
      : `Changes from ${input.fromName}:`

  let full = ''
  if (resolvedInstruction) {
    full += `${resolvedInstruction}\n\n`
  }
  full += `${header}\n${fence}\n${bodyWithMarker}\n${fence}`

  const sanitized = sanitizePaste(full)
  return {
    text: sanitized,
    chars: sanitized.length,
    truncated,
    omitted
  }
}


