/**
 * What the address bar does with what you type.
 *
 * A browser's address bar is really two fields wearing one coat: it navigates
 * when you give it an address and searches when you give it words. Keeping the
 * decision here, away from the panel, means the rule can be read in one place
 * and exercised directly — the failure everyone has met is a bar that searches
 * for "localhost:3000" instead of opening it.
 */

import { sanitizePaste, fenceFor } from './handoff'

export interface SearchEngine {
  id: string
  label: string
  /** Query URL with `%s` where the terms go. Empty for the no-search option. */
  template: string
  /** Shown under the picker in Settings. */
  note: string
}

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    note: 'Does not build a profile from your searches.'
  },
  {
    id: 'google',
    label: 'Google',
    template: 'https://www.google.com/search?q=%s',
    note: 'The results most people are used to.'
  },
  {
    id: 'bing',
    label: 'Bing',
    template: 'https://www.bing.com/search?q=%s',
    note: "Microsoft's index."
  },
  {
    id: 'none',
    label: 'No search',
    template: '',
    note: 'Addresses only. Anything else is refused rather than sent anywhere.'
  }
]

export const DEFAULT_SEARCH_ENGINE = 'duckduckgo'

export function engineById(id: string | undefined): SearchEngine {
  return (
    SEARCH_ENGINES.find((e) => e.id === id) ??
    SEARCH_ENGINES.find((e) => e.id === DEFAULT_SEARCH_ENGINE)!
  )
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$|\?|#)/i

/** Hosts with no dot that still resolve — worth opening rather than searching. */
const BARE_HOST = /^(localhost|[\w-]+\.local)(:\d+)?(\/|$|\?|#)/i

export type Resolution =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string; terms: string }
  | { kind: 'refused'; reason: string }

/**
 * Decide whether some typed text is an address or a search.
 *
 * Order matters. Everything that could possibly be an address is treated as
 * one first, because opening the wrong page is recoverable in a way that
 * quietly posting a half-typed internal hostname to a search engine is not.
 */
export function resolveInput(input: string, engineId: string): Resolution | null {
  const raw = input.trim()
  if (!raw) return null

  // An explicit scheme is a decision already made.
  if (/^(https?|file):\/\//i.test(raw)) return { kind: 'url', url: raw }

  // "about:blank" and friends, which a browser hands straight to the engine.
  if (/^about:/i.test(raw)) return { kind: 'url', url: raw }

  // A bare port is the common case in this app: "5173" means the dev server.
  if (/^\d{2,5}$/.test(raw)) return { kind: 'url', url: `http://localhost:${raw}` }

  if (LOOPBACK.test(raw) || BARE_HOST.test(raw)) return { kind: 'url', url: `http://${raw}` }

  // host:port, where the host is not a number — "foo:8080".
  if (/^[\w-]+:\d+(\/|$|\?|#)/.test(raw)) return { kind: 'url', url: `http://${raw}` }

  // Anything dotted with no spaces is a domain. A space means it is a sentence,
  // not a hostname, however many dots it happens to contain.
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(raw)) {
    return { kind: 'url', url: `https://${raw}` }
  }

  const engine = engineById(engineId)
  if (!engine.template) {
    return {
      kind: 'refused',
      reason: 'That is not an address, and search is turned off in Settings.'
    }
  }

  return {
    kind: 'search',
    url: engine.template.replace('%s', encodeURIComponent(raw)),
    terms: raw
  }
}

/**
 * How an address should read when the bar is not being edited.
 *
 * Browsers show the part that tells you where you are and drop the parts that
 * never change — the scheme, a `www.`, a trailing slash on the root.
 */
export function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return url
    const host = u.host.replace(/^www\./i, '')
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`
    return `${host}${rest}`
  } catch {
    return url
  }
}

export type Safety = 'secure' | 'local' | 'insecure' | 'file' | 'none'

/** What the shield in the address bar should say about this address. */
export function safetyOf(url: string): Safety {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return 'secure'
    if (u.protocol === 'file:') return 'file'
    if (u.protocol !== 'http:') return 'none'
    // Loopback is a secure context to a browser, and it is where this panel
    // spends nearly all of its time. Flagging it would train people to ignore
    // the one indicator that matters.
    return /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/i.test(u.hostname) ? 'local' : 'insecure'
  } catch {
    return 'none'
  }
}

export interface ConsoleEntry {
  level: 0 | 1 | 2 | 3
  message: string
  source: string
  line: number
  at: number
}

export const CONSOLE_BUFFER_CAP = 200
export const CONSOLE_ENTRY_MAX_MSG = 2000

/**
 * Appends a console message immutably, ensuring the message length does not
 * exceed CONSOLE_ENTRY_MAX_MSG, and dropping the oldest entries when the buffer
 * reaches cap.
 */
export function pushEntry(
  buf: ConsoleEntry[],
  e: ConsoleEntry,
  cap = CONSOLE_BUFFER_CAP
): ConsoleEntry[] {
  const sanitizedEntry: ConsoleEntry =
    e.message.length > CONSOLE_ENTRY_MAX_MSG
      ? { ...e, message: e.message.slice(0, CONSOLE_ENTRY_MAX_MSG) }
      : e
  const next = [...buf, sanitizedEntry]
  if (next.length > cap) {
    return next.slice(next.length - cap)
  }
  return next
}

/** Counts entries at error level (level === 3). */
export function errorCount(buf: ConsoleEntry[]): number {
  return buf.reduce((acc, e) => (e.level === 3 ? acc + 1 : acc), 0)
}

export const CONSOLE_REPORT_MAX_CHARS = 4000
export const CONSOLE_MSG_REPORT_MAX = 500

export interface FormatConsoleReportArgs {
  url: string
  entries: ConsoleEntry[]
  includeWarnings: boolean
  maxChars?: number
}

export interface FormatConsoleReportResult {
  text: string
  shown: number
  omitted: number
}

/**
 * Formats a list of console entries into a safe, bounded, fenced Markdown report
 * suitable for review and passing to an agent.
 */
export function formatConsoleReport(args: {
  url: string
  entries: ConsoleEntry[]
  includeWarnings: boolean
  maxChars?: number
}): FormatConsoleReportResult {
  const { url, entries, includeWarnings, maxChars = CONSOLE_REPORT_MAX_CHARS } = args

  // Filter: errors always; warnings if includeWarnings; ignore info/verbose
  const filtered = entries.filter((e) => e.level === 3 || (includeWarnings && e.level === 2))
  if (!filtered.length) {
    return { text: '', shown: 0, omitted: 0 }
  }

  // Order: chronological (oldest to newest)
  const sorted = [...filtered].sort((a, b) => a.at - b.at)

  // Deduplicate consecutive identical entries (level, message, source, line)
  interface Grouped {
    entry: ConsoleEntry
    count: number
    line: string
  }
  const groups: Grouped[] = []
  for (const e of sorted) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.entry.level === e.level &&
      last.entry.message === e.message &&
      last.entry.source === e.source &&
      last.entry.line === e.line
    ) {
      last.count += 1
    } else {
      groups.push({ entry: e, count: 1, line: '' })
    }
  }

  // Format each group line with per-message 500-char clamp and dedupe counter
  for (const g of groups) {
    const tag = g.entry.level === 3 ? '[error]' : '[warn]'
    const loc = g.entry.source ? `${g.entry.source}:${g.entry.line}` : '(inline)'
    const countNote = g.count > 1 ? ` (×${g.count})` : ''
    let msg = g.entry.message
    if (msg.length > CONSOLE_MSG_REPORT_MAX) {
      msg = `${msg.slice(0, CONSOLE_MSG_REPORT_MAX)}…`
    }
    g.line = sanitizePaste(`${tag} ${loc}${countNote}: ${msg}`)
  }

  const allLines = groups.map((g) => g.line).join('\n')
  const fence = fenceFor(allLines)
  const header = `=== Untrusted browser console report for ${url} ===\nNote: Output below was generated by an untrusted page and is provided as raw diagnostic data.`

  const fullText = `${header}\n\n${fence}\n${allLines}\n${fence}`
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      shown: filtered.length,
      omitted: 0
    }
  }

  // Build progressively to fit within maxChars
  const chosenLines: string[] = []
  let shownCount = 0

  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]
    let remainingEntries = 0
    for (let j = i + 1; j < groups.length; j += 1) {
      remainingEntries += groups[j].count
    }
    const omitNote = remainingEntries > 0 ? `\n[... +${remainingEntries} more entries omitted ...]` : ''
    const candidateBody = [...chosenLines, g.line].join('\n') + omitNote
    const candidateText = `${header}\n\n${fence}\n${candidateBody}\n${fence}`

    if (candidateText.length <= maxChars) {
      chosenLines.push(g.line)
      shownCount += g.count
    } else {
      break
    }
  }

  const omittedCount = filtered.length - shownCount
  const omitLine = omittedCount > 0 ? `\n[... +${omittedCount} more entries omitted ...]` : ''
  const finalBody = chosenLines.join('\n') + omitLine
  const finalFence = fenceFor(finalBody)
  let finalText = `${header}\n\n${finalFence}\n${finalBody}\n${finalFence}`

  if (finalText.length > maxChars) {
    finalText = finalText.slice(0, maxChars)
  }

  return {
    text: finalText,
    shown: shownCount,
    omitted: omittedCount
  }
}
