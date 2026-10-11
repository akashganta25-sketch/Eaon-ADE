import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { exitReason, killedByOs } from '@shared/exit'
import { getTheme, type TerminalPalette } from '@shared/themes'
import type { PaneStatus, Settings } from '@shared/types'
import type { SshHost } from '@shared/ssh'
import { IS_MAC, commandFor } from './keys'
import { stripAnsi } from './util'
import { linesToText } from '@shared/handoff'

/** Patterns that mean the agent has stopped and is waiting on a human. */
const WAITING = [
  /do you want to (proceed|continue|allow)/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press enter to continue/i,
  /enter to confirm/i,
  /esc to cancel/i,
  /waiting for your input/i,
  /permission (to|request)/i
]

/**
 * Context readouts agents print in their status lines. Everything is
 * normalised to "percent used" so one pill means one thing across agents.
 */
const CONTEXT_PATTERNS: { re: RegExp; reportsRemaining: boolean }[] = [
  { re: /context left until auto-compact:\s*(\d{1,3})\s*%/i, reportsRemaining: true },
  { re: /(\d{1,3})\s*%\s*context\s*(?:left|remaining)/i, reportsRemaining: true },
  { re: /context(?:\s+window)?(?:\s+used)?:\s*(\d{1,3})\s*%/i, reportsRemaining: false },
  { re: /\d+(?:\.\d+)?k\s*\((\d{1,3})%\)/i, reportsRemaining: false }
]

/**
 * What the Command key does to a line of text everywhere else on a Mac.
 *
 * These are the readline control codes, not the arrow-key escapes: a shell,
 * a REPL and an agent's own prompt all bind ^A/^E/^U, while `ESC[H` style
 * sequences are only understood by some of them.
 */
const MAC_LINE_EDITING: Record<string, string> = {
  ArrowLeft: '\x01', // beginning of line
  ArrowRight: '\x05', // end of line
  Backspace: '\x15', // kill to the start of the line
  Delete: '\x0b' // kill to the end of the line
}

/**
 * Option + a navigation key, the way macOS moves and deletes by word.
 *
 * These are sent as meta-letter sequences rather than the modified arrow
 * escapes xterm produces on its own. `ESC b` and `ESC f` are bound by readline
 * itself, so they work in every shell, REPL and agent prompt without setup;
 * `ESC[1;3D` needs the application to have been taught about it, and in bash it
 * is not merely ignored — the tail of the sequence lands on the line as text.
 */
const WORD_EDITING: Record<string, string> = {
  ArrowLeft: '\x1bb', // backward one word
  ArrowRight: '\x1bf', // forward one word
  Delete: '\x1bd' // kill the word ahead
}

/**
 * True when the keyboard is inside a terminal pane.
 *
 * xterm takes keys through a hidden textarea, so "is a text field focused?" is
 * not the same question and would answer yes for the wrong reasons.
 */
export function terminalHasFocus(): boolean {
  const el = document.activeElement
  if (!el) return false
  return Boolean(el.classList?.contains('xterm-helper-textarea') || el.closest('.xterm'))
}

/** What should happen to a key pressed inside a pane. */
export type KeyVerdict =
  | { do: 'terminal' }
  | { do: 'app' }
  | { do: 'send'; data: string }
  | { do: 'selectAll' }
  | { do: 'copy' }
  | { do: 'paste' }

/** Only the fields the decision depends on, so it can be exercised directly. */
export type KeyLike = Pick<
  KeyboardEvent,
  'type' | 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'
> & { code?: string }

/** What the pane knows that the key alone does not. */
export interface KeyContext {
  /** Whether anything is selected, which is what makes Ctrl+C ambiguous. */
  hasSelection?: boolean
}

/**
 * Decide who owns a keypress: the shell, the app, or this layer.
 *
 * Kept apart from xterm so the mapping can be checked on its own — the whole
 * bug class here is "two different keys send the same bytes", which is
 * invisible from the outside and obvious from a table.
 */
export function resolveKey(e: KeyLike, ctx: KeyContext = {}): KeyVerdict {
  if (e.type !== 'keydown') return { do: 'terminal' }

  /*
   * Shift+Enter opens a line instead of submitting one.
   *
   * A terminal has no way to say this on its own: Enter and Shift+Enter both
   * arrive as a bare CR, so the agent on the other end cannot tell them apart
   * and treats every one as "send". ESC CR is the sequence CLI agents read as
   * "newline, do not send" — the same thing iTerm2 and VS Code users bind by
   * hand to make Shift+Enter work.
   *
   * Alt+Enter already produces this via macOptionIsMeta, so both work.
   */
  if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { do: 'send', data: '\x1b\r' }
  }

  if (!IS_MAC) {
    /*
     * Windows and Linux have one modifier, and the shell already owns every
     * bare Control chord — ^C interrupts, ^D ends input, ^W deletes a word,
     * ^K kills a line. None of them can become application shortcuts without
     * leaving an agent you cannot exit. So the app takes Ctrl+Shift, and
     * anything else Control does goes straight through.
     */
    const command = commandFor(e)
    if (command === 'selectAll') return { do: 'selectAll' }
    if (command) return { do: 'app' }

    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const key = e.key.toLowerCase()
      // Ctrl+Shift+C and Ctrl+Shift+V, which is where every Windows terminal
      // puts the clipboard precisely because Ctrl+C is spoken for.
      if (e.shiftKey && key === 'c') return { do: 'copy' }
      if (e.shiftKey && key === 'v') return { do: 'paste' }

      /*
       * Bare Ctrl+C is the one genuine ambiguity on this platform: copy, or
       * interrupt? Windows Terminal resolves it by what is on screen — with a
       * selection it copies, without one it interrupts — and that is what a
       * Windows user's hands already expect.
       */
      if (!e.shiftKey && key === 'c' && ctx.hasSelection) return { do: 'copy' }
      if (!e.shiftKey && key === 'v') return { do: 'paste' }
    }

    return { do: 'terminal' }
  }

  /*
   * Everything below is macOS, where Option is Meta.
   *
   * Option + arrows and forward-delete move and cut by word. Sent as
   * meta-letter sequences rather than the modified arrow escapes xterm emits,
   * because readline binds those everywhere — and in bash `ESC[1;3D` is not
   * merely ignored, the tail of it lands on the line as text.
   */
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const word = WORD_EDITING[e.key]
    if (word) return { do: 'send', data: word }
  }

  // Command-key combos belong to the app, not the shell, apart from the handful
  // a terminal is expected to own itself.
  if (e.metaKey) {
    const key = e.key.toLowerCase()

    // Select-all has to be done by the terminal. Left to the browser it selects
    // the contents of xterm's hidden input, which is empty, so the binding the
    // app advertises would quietly do nothing.
    if (key === 'a') return { do: 'selectAll' }

    // The line-editing keys every other macOS text field has. Sent as readline
    // control codes rather than arrow escapes, because those are what shells
    // and the agents' own prompts actually bind.
    const editing = MAC_LINE_EDITING[e.key]
    if (editing) return { do: 'send', data: editing }

    // Copy and paste stay with the browser, which already routes them through
    // xterm's own clipboard handling. Everything else is an app shortcut.
    return key === 'c' || key === 'v' ? { do: 'terminal' } : { do: 'app' }
  }

  return { do: 'terminal' }
}

/** Everything a pane needs to start the right thing in the right conversation. */
export interface Launch {
  command: string | null
  agentId: string
  sessionId: string | null
  /** Set for a pane on a remote workspace — runs `ssh` instead of a local shell. */
  host?: SshHost | null
}

export interface TerminalEvents {
  onTitle: (paneId: string, title: string) => void
  onStatus: (paneId: string, status: PaneStatus) => void
  onContext: (paneId: string, pct: number) => void
  onExit: (paneId: string, code: number, signal?: number, requested?: boolean) => void
  /** An agent worked for a while and then went quiet. `runMs` is how long. */
  onFinished: (paneId: string, runMs: number) => void
  /** Something started or stopped running in this pane. */
  onWorking: (paneId: string, working: boolean) => void
}

interface Runtime {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  wrapper: HTMLDivElement
  host: HTMLElement | null
  observer: ResizeObserver | null
  /** Last size actually sent to the PTY, so we never resend the same one. */
  sentCols: number
  sentRows: number
  fitTimer: number | null
  lastData: number
  /** When this pane last went from quiet to producing output. */
  busySince: number
  /**
   * When the current unbroken run of output began.
   *
   * Not busySince, which only resets after IDLE_MS of quiet and so would treat
   * a box repainting every second as one continuous stream. This resets on any
   * gap worth calling a gap.
   */
  streakSince: number
  /** When bytes were last sent *to* the shell, from a key, a paste or a broadcast. */
  lastInput: number
  /** When the shell under this pane was started. */
  spawnedAt: number
  /** Whether something is currently running in here. See looksWorking(). */
  working: boolean
  status: PaneStatus
  /** Rolling plain-text tail used for status-line parsing. */
  tail: string
  /** Raw output still to be folded into `tail`, drained on the ticker. */
  pending: string[]
  pendingLen: number
  contextPct: number | null
  spawned: boolean
  /** GPU renderer, or null when this pane fell back to the DOM one. */
  webgl: WebglAddon | null
  /** Why the last spawn was refused, for the pane to show. */
  lastError: string | null
  /** How many times we have tried to get this pane back onto the GPU. */
  renderRetries: number
  sessionToken?: number
  /**
   * WebGL is not available at all here, so stop asking. Set only when building
   * the addon throws — not when a context is released on purpose, which is a
   * pane going off screen and expects to get one back.
   */
  gpuBlocked: boolean
  disposers: (() => void)[]
}

const TICK_MS = 400
const IDLE_MS = 1800

/**
 * How long a pane must have been working on its own before going quiet counts
 * as "the agent finished" — measured from the last thing you typed, not from
 * the first byte out.
 *
 * That distinction is the whole trick. A CLI agent redraws its prompt box on
 * every keystroke, so a pane is technically "producing output" the entire time
 * you are composing a message, and pausing to think mid-sentence looks exactly
 * like a run ending. Timing from the last keypress instead collapses that case
 * to nothing, while a real run — where you pressed Return and then waited —
 * measures the part you actually waited through.
 */
const MIN_RUN_MS = 4000

/**
 * Quiet window after a shell starts.
 *
 * Agents print a banner and spin up for a few seconds before settling at their
 * prompt, which is a run by every measure above. You are still looking at the
 * pane you just opened, so there is nothing to announce.
 */
const SETTLE_MS = 12000

/**
 * How long output must keep arriving after your last keystroke before the pane
 * counts as working.
 *
 * `status === 'live'` cannot answer this. It means "bytes arrived", and bytes
 * arrive when a CLI agent redraws its prompt box in response to a keypress —
 * which is every keypress. Anything keyed off it lights up while you type.
 *
 * The separation is that a keystroke produces one short burst and then stops,
 * while a running command produces output that keeps coming on its own. So the
 * measure is the gap between the last thing you sent and the last thing that
 * came back: near zero the whole time you are typing, and growing steadily once
 * something is actually running.
 *
 * Shorter than MIN_RUN_MS above because the two questions are different. That
 * one asks, after the fact, whether a run was substantial enough to announce
 * out loud. This one asks whether something is happening right now, and wants
 * to say so while it still matters.
 */
const WORK_GRACE_MS = 900

/**
 * A pause longer than this ends the current run of output.
 *
 * Measured against a real Claude Code pane: a running command emitted a chunk
 * roughly every 110ms, while the prompt box sitting untouched emitted a single
 * chunk about every ten seconds. Six hundred sits far enough above the first and
 * far enough below the second that neither is a close call.
 */
const STREAM_GAP_MS = 600

/**
 * How long output must have been arriving *continuously* before it counts.
 *
 * This is the half that the gap-since-your-last-keystroke rule cannot do. An
 * agent's prompt box repaints on its own every few seconds — a tip rotating, a
 * clock ticking — and each of those repaints is, by every timing measure,
 * output that arrived long after you last typed. Requiring a run of output
 * rather than a single burst is what separates a thing that is working from a
 * thing that is merely redrawing itself.
 *
 * Volume cannot do it either, and is worth recording so nobody tries: the idle
 * box measured 15 bytes a second and a genuinely busy shell measured 9, because
 * a repaint carries a whole box and a running command carries one character.
 */
const WORK_STREAK_MS = 700

/**
 * How long output must stop before the pane stops counting as working.
 *
 * Longer than a spinner's redraw interval, so a command that pauses briefly —
 * an agent waiting on a tool, a build between steps — does not strobe the
 * indicator off and on.
 */
const WORK_IDLE_MS = 1500

/** What the working judgement is made from. */
export interface WorkTimings {
  now: number
  /** When output last arrived. */
  lastData: number
  /** When the current unbroken run of output began. */
  streakSince: number
  /** When bytes were last sent to the shell. */
  lastInput: number
  /** When the shell was started, or 0 if it never was. */
  spawnedAt: number
  /** Whether the pane is already counted as working. */
  working: boolean
}

/**
 * Whether something is running in this pane right now.
 *
 * Deliberately asymmetric. Starting requires output that outlived your typing;
 * stopping only requires output to stop. Without that, typing a follow-up while
 * an agent is still working would drop the indicator and bring it back a moment
 * later, and a flicker in the corner of your eye is worse than no indicator at
 * all.
 */
export function looksWorking(t: WorkTimings): boolean {
  if (t.spawnedAt <= 0) return false
  // Whatever else is true, output has to still be arriving.
  if (t.now - t.lastData >= WORK_IDLE_MS) return false
  if (t.working) return true
  // Output has to have been coming for a while, not just once — otherwise a
  // prompt box redrawing itself on a timer reads as a running command.
  if (t.lastData - t.streakSince < WORK_STREAK_MS) return false
  // And it has to have outlived your typing. Time from the last thing you sent
  // to the last thing that came back; a shell that has never been typed into is
  // measured from when it started.
  return t.lastData - Math.max(t.lastInput, t.spawnedAt) >= WORK_GRACE_MS
}

/** The timestamps the judgement below is made from. */
export interface RunTimings {
  now: number
  /** When output last arrived. */
  lastData: number
  /** When output started again after a quiet spell. */
  busySince: number
  /** When bytes were last sent to the shell. */
  lastInput: number
  /** When the shell was started, or 0 if it never was. */
  spawnedAt: number
}

/**
 * Whether a pane going quiet was an agent finishing, or just you pausing.
 *
 * Split out from the ticker because it is the one piece of this feature that
 * can be wrong in a way nobody notices until the app has been talking nonsense
 * at them for an afternoon.
 */
export function looksFinished(t: RunTimings): boolean {
  if (t.spawnedAt <= 0) return false
  if (t.now - t.spawnedAt <= SETTLE_MS) return false
  return t.lastData - Math.max(t.busySince, t.lastInput) >= MIN_RUN_MS
}

/**
 * Raw output held for the next parse pass. Comfortably more than the 3000
 * stripped characters the patterns look at, since escape sequences are most of
 * what a full-screen CLI emits and all of it strips away.
 */
const PARSE_WINDOW = 16 * 1024

/**
 * Owns every xterm instance. Terminals outlive their React components — each
 * one lives in a detached wrapper element that gets re-parented as you move
 * between workspaces, so a background agent keeps streaming while you're away.
 */
class TerminalRegistry {
  private panes = new Map<string, Runtime>()
  private events: TerminalEvents | null = null
  private settings: Settings | null = null
  private ticker: number | null = null
  private palette: ITheme = getTheme(undefined).terminal
  private resizeListeners = new Map<string, (cols: number, rows: number) => void>()

  init(events: TerminalEvents, settings: Settings): void {
    this.events = events
    this.settings = settings
    if (this.ticker === null) {
      this.ticker = window.setInterval(() => this.tick(), TICK_MS)
    }
  }

  /** Repaints every open terminal when the theme changes. */
  applyPalette(palette: TerminalPalette): void {
    this.palette = palette
    for (const rt of this.panes.values()) rt.term.options.theme = palette
  }

  /**
   * Folds buffered output into the plain-text tail and re-reads the status
   * line. Deferred off the write path deliberately: stripping escapes and
   * running the patterns costs more than drawing the chunk did, and a flush
   * arrives every 12ms per pane.
   */
  private digest(paneId: string, rt: Runtime): void {
    if (!rt.pending.length) return
    const raw = rt.pending.join('')
    rt.pending.length = 0
    rt.pendingLen = 0
    rt.tail = (rt.tail + stripAnsi(raw)).slice(-3000)

    for (const { re, reportsRemaining } of CONTEXT_PATTERNS) {
      const m = rt.tail.match(re)
      if (!m) continue
      const value = Number(m[1])
      if (value < 0 || value > 100) break
      const used = reportsRemaining ? 100 - value : value
      if (used !== rt.contextPct) {
        rt.contextPct = used
        this.events?.onContext(paneId, used)
      }
      break
    }
  }

  /** Drops panes back to idle once their output has been quiet long enough. */
  private tick(): void {
    const now = Date.now()
    for (const [id, rt] of this.panes) {
      this.digest(id, rt)
      if (rt.status === 'live' && now - rt.lastData > IDLE_MS) {
        rt.status = 'idle'
        this.events?.onStatus(id, 'idle')

        // Time from the last thing you typed to the last thing it printed.
        const runMs = rt.lastData - Math.max(rt.busySince, rt.lastInput)
        const timings: RunTimings = {
          now,
          lastData: rt.lastData,
          busySince: rt.busySince,
          lastInput: rt.lastInput,
          spawnedAt: rt.spawnedAt
        }
        if (looksFinished(timings)) this.events?.onFinished(id, runMs)
      }

      const working = looksWorking({
        now,
        lastData: rt.lastData,
        streakSince: rt.streakSince,
        lastInput: rt.lastInput,
        spawnedAt: rt.spawnedAt,
        working: rt.working
      })
      if (working !== rt.working) {
        rt.working = working
        this.events?.onWorking(id, working)
      }
    }
  }

  ensure(paneId: string, settings: Settings): Runtime {
    const existing = this.panes.get(paneId)
    if (existing) return existing

    const wrapper = document.createElement('div')
    wrapper.style.width = '100%'
    wrapper.style.height = '100%'

    const term = new Terminal({
      allowProposedApi: true,
      // No transparency: the theme paints the terminal background directly, and
      // transparent mode costs a redraw path that leaves stale cells behind.
      allowTransparency: false,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      macOptionIsMeta: true,
      // 1 disables contrast correction. A CLI's colours are its own business;
      // rewriting them is how "themed" terminals end up looking wrong.
      minimumContrastRatio: 1,
      // Draw block and box-drawing characters as geometry rather than glyphs,
      // so solid runs meet exactly. Needs the GPU renderer below.
      customGlyphs: true,
      theme: this.palette
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)

    try {
      term.loadAddon(new WebLinksAddon((_e, uri) => window.eaon.sys.openExternal(uri)))
    } catch {
      /* links are a nicety, never a blocker */
    }

    term.open(wrapper)

    const rt: Runtime = {
      term,
      fit,
      search,
      wrapper,
      host: null,
      observer: null,
      sentCols: 0,
      sentRows: 0,
      fitTimer: null,
      lastData: 0,
      busySince: 0,
      streakSince: 0,
      lastInput: 0,
      spawnedAt: 0,
      working: false,
      status: 'idle',
      tail: '',
      pending: [],
      pendingLen: 0,
      contextPct: null,
      spawned: false,
      webgl: null,
      lastError: null,
      renderRetries: 0,
      gpuBlocked: false,
      disposers: []
    }

    // Must come after open(). This is the whole reason block art comes out
    // solid: only the GPU renderer honours `customGlyphs` and paints ▀ ▄ █ and
    // the box-drawing set as exact rectangles. The DOM renderer draws them as
    // font glyphs in separately positioned cells, and fractional cell metrics
    // leave hairline cracks through anything meant to be solid.
    this.attachRenderer(paneId, rt)

    const listeners = [
      term.onData((data) => {
        rt.lastInput = Date.now()
        window.eaon.pty.write(paneId, data)
      }),
      term.onBinary((data) => {
        rt.lastInput = Date.now()
        window.eaon.pty.write(paneId, data)
      }),
      term.onTitleChange((title) => {
        const clean = title.trim()
        if (clean) this.events?.onTitle(paneId, clean)
      }),
      term.onBell(() => {
        rt.status = 'attention'
        this.events?.onStatus(paneId, 'attention')
      })
    ]
    for (const listener of listeners) rt.disposers.push(() => listener.dispose())

    term.attachCustomKeyEventHandler((e) => {
      const verdict = resolveKey(e, { hasSelection: term.hasSelection() })
      switch (verdict.do) {
        case 'send':
          e.preventDefault()
          // Through input() rather than straight to the PTY, so these behave
          // like any other keystroke — including scrolling back to the prompt.
          term.input(verdict.data)
          return false
        case 'selectAll':
          e.preventDefault()
          term.selectAll()
          return false
        case 'copy': {
          const text = term.getSelection()
          e.preventDefault()
          // Nothing selected is not an error, it is a no-op — and on Windows
          // this path is only reached with a selection anyway.
          if (text) void navigator.clipboard.writeText(text)
          return false
        }
        case 'paste':
          e.preventDefault()
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text)
            })
            .catch(() => {
              /* clipboard refused; nothing useful to do about it */
            })
          return false
        case 'app':
          return false
        default:
          return true
      }
    })

    this.panes.set(paneId, rt)
    return rt
  }

  /**
   * Puts a pane on the GPU renderer, falling back to the DOM one if WebGL is
   * unavailable or the context is later lost. Losing a context is normal — the
   * browser drops the oldest when too many are alive — so it must degrade
   * quietly rather than leave a pane blank.
   */
  private attachRenderer(paneId: string, rt: Runtime): void {
    if (rt.gpuBlocked) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // Disposing is what hands the pane back to the DOM renderer; without
        // it the terminal keeps drawing into a dead context and shows nothing.
        try {
          addon.dispose()
        } catch {
          /* already gone */
        }
        rt.webgl = null

        /*
         * Then try to get back onto the GPU. A lost context nearly always
         * means the GPU process restarted, and the next one succeeds. Left
         * alone, every pane open at that moment would spend the rest of the
         * session on the DOM renderer — which is a great deal slower, and is
         * where "it was fine and then it got sluggish" comes from.
         */
        if (rt.renderRetries >= 3) return
        rt.renderRetries += 1
        window.setTimeout(() => {
          // Only worth retrying for a pane still on screen. A hidden one has
          // given its context up on purpose and will ask for another when it
          // is next shown.
          if (this.panes.get(paneId) !== rt || rt.webgl || !rt.host) return
          this.attachRenderer(paneId, rt)
        }, 800 * rt.renderRetries)
      })
      rt.term.loadAddon(addon)
      rt.webgl = addon
    } catch {
      /*
       * No WebGL at all on this machine. xterm keeps the DOM renderer and the
       * terminal still works — but this must be remembered, or every show of
       * every pane would build another addon just to watch it throw.
       */
      rt.webgl = null
      rt.gpuBlocked = true
    }
  }

  /**
   * Hands a pane's GPU context back while it is off screen.
   *
   * A browser will only keep so many WebGL contexts alive — this app asks for
   * 32 — and drops the oldest without a word once that is passed. Terminals
   * here outlive the components that show them, so a context was being held
   * for every pane in every workspace you had visited, not for the panes you
   * can actually see. Forty-three panes over sixteen workspaces against a
   * ceiling of thirty-two is not a close thing: the panes you were looking at
   * were the ones silently demoted to the DOM renderer, which is exactly the
   * "it was fine and then it got slow" this file already warns about.
   *
   * Only the context goes. The terminal, its scrollback and its stream are
   * untouched, so a background agent keeps working and its output is all still
   * there when you come back.
   */
  private releaseRenderer(rt: Runtime): void {
    if (!rt.webgl) return
    try {
      rt.webgl.dispose()
    } catch {
      /* already gone */
    }
    rt.webgl = null
  }

  /** Which renderer a pane ended up on. Surfaced in Settings › Terminal. */
  rendererOf(paneId: string): 'gpu' | 'dom' {
    return this.panes.get(paneId)?.webgl ? 'gpu' : 'dom'
  }

  attach(paneId: string, host: HTMLElement, settings: Settings): void {
    const rt = this.ensure(paneId, settings)
    if (rt.host === host) return
    rt.host = host
    host.appendChild(rt.wrapper)

    /*
     * Back on screen, so take a GPU context again. The budget spent while a
     * pane is hidden is what used to push the visible ones off the GPU, and
     * the retry count goes with it: it exists to stop a pane thrashing against
     * a context it keeps losing, not to ration how often you may look at it.
     */
    if (!rt.webgl) {
      rt.renderRetries = 0
      this.attachRenderer(paneId, rt)
    }

    rt.observer?.disconnect()
    rt.observer = new ResizeObserver(() => this.scheduleFit(paneId))
    rt.observer.observe(host)
    // Two frames: one for layout, one for the font metrics xterm needs.
    requestAnimationFrame(() => requestAnimationFrame(() => this.fit(paneId)))
  }

  /**
   * Coalesces resizes. Dragging a divider fires the observer dozens of times,
   * and every SIGWINCH makes a full-screen CLI repaint from scratch — which is
   * exactly when output tears.
   */
  private scheduleFit(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    if (rt.fitTimer !== null) window.clearTimeout(rt.fitTimer)
    rt.fitTimer = window.setTimeout(() => {
      rt.fitTimer = null
      this.fit(paneId)
    }, 60)
  }

  detach(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    rt.observer?.disconnect()
    rt.observer = null
    if (rt.wrapper.parentElement) rt.wrapper.parentElement.removeChild(rt.wrapper)
    rt.host = null
    // Nothing is drawing this pane now, so it has no use for a GPU context —
    // and holding one is what starves the panes that are on screen.
    this.releaseRenderer(rt)
  }

  fit(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt || !rt.host) return
    const { width, height } = rt.host.getBoundingClientRect()
    if (width < 40 || height < 30) return
    try {
      rt.fit.fit()
      const { cols, rows } = rt.term
      // Only tell the shell when the size genuinely changed.
      if (cols === rt.sentCols && rows === rt.sentRows) return
      rt.sentCols = cols
      rt.sentRows = rows
      window.eaon.pty.resize(paneId, cols, rows)
      this.resizeListeners.get(paneId)?.(cols, rows)
    } catch {
      /* the pane can be mid-unmount */
    }
  }

  /** Lets a pane show its own size while it is being resized. */
  onResize(paneId: string, cb: (cols: number, rows: number) => void): () => void {
    this.resizeListeners.set(paneId, cb)
    return () => this.resizeListeners.delete(paneId)
  }

  dimensions(paneId: string): { cols: number; rows: number } | null {
    const rt = this.panes.get(paneId)
    return rt ? { cols: rt.term.cols, rows: rt.term.rows } : null
  }

  fitAll(): void {
    for (const id of this.panes.keys()) this.fit(id)
  }

  /** Starts the shell for a pane, once. */
  async spawn(paneId: string, cwd: string, launch: Launch, settings: Settings): Promise<void> {
    const rt = this.ensure(paneId, settings)
    if (rt.spawned) return
    rt.spawned = true
    rt.spawnedAt = Date.now()
    const res = await window.eaon.pty.spawn({
      paneId,
      cwd,
      cols: rt.term.cols || 80,
      rows: rt.term.rows || 24,
      shell: settings.shell || undefined,
      command: launch.command,
      // Carried through so the main process can decide whether this pane is
      // starting a conversation or reopening one. It is the side that can see
      // the transcripts, so it is the side that decides.
      agentId: launch.agentId,
      sessionId: launch.sessionId,
      host: launch.host
    })
    if (!res.ok) {
      /*
       * `spawned` deliberately stays true.
       *
       * Resetting it looked like the tidy thing — the shell did not start, so
       * the pane has not spawned — but the effect that calls this runs again
       * on every attach, and a pane re-attaches whenever you switch back to
       * its workspace or it re-renders. So a refusal turned into a retry
       * every time you looked at it: another failed spawn, another copy of
       * the message down the pane, and another trip through the memory probe.
       *
       * The refusal that matters is the one for being out of memory, which is
       * exactly when the machine can least afford a pane quietly asking again
       * whenever it is shown. Restarting is a thing you ask for — `restart()`
       * builds a fresh runtime, so the button in the pane still works.
       */
      rt.lastError = res.error ?? 'The shell could not be started.'
      rt.term.writeln(`\r\n  Could not start a shell here.\r\n  ${res.error ?? ''}\r\n`)
      this.events?.onStatus(paneId, 'exited')
      return
    }
    rt.sessionToken = res.token
    rt.lastError = null
    /*
     * The shell was already running and we were given it back, rather than a
     * fresh one — the window went away and this one did not. Say so, because
     * the terminal is blank (the scrollback died with the old renderer) while
     * the agent underneath has been working the whole time, and a blank pane
     * otherwise reads as a dead one.
     */
    if (res.reattached) {
      rt.term.writeln('\r\n  [reattached — this session kept running]\r\n')
      this.events?.onStatus(paneId, 'idle')
    }
  }

  /**
   * Tear a pane's shell down and bring a fresh one up in the same place.
   *
   * Disposing a terminal takes its DOM with it, and a pane only attaches its
   * terminal when the component mounts — which does not happen again, because
   * the pane id has not changed. Re-spawning on its own therefore leaves a live
   * shell with nothing on screen. Holding on to the host element across the
   * swap is what keeps the restarted session visible.
   */
  restart(paneId: string, cwd: string, launch: Launch, settings: Settings): void {
    const host = this.panes.get(paneId)?.host ?? null
    this.dispose(paneId)
    this.ensure(paneId, settings)
    if (host) this.attach(paneId, host, settings)

    // Two frames, so the fresh terminal has measured itself before the shell
    // starts and the PTY is created at the size it will actually be drawn at.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.fit(paneId)
        void this.spawn(paneId, cwd, launch, settings)
        // Restarting is always something you asked for, so the caret belongs
        // in the pane you asked about.
        this.focus(paneId)
      })
    )
  }

  /** Feeds PTY output into the terminal and updates the derived signals. */
  receive(paneId: string, data: string): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    rt.term.write(data)
    const at = Date.now()
    // A long enough silence means whatever comes next is a new run of output,
    // not a continuation of the last one.
    if (at - rt.lastData > STREAM_GAP_MS) rt.streakSince = at
    rt.lastData = at

    if (rt.status !== 'live') {
      rt.busySince = rt.lastData
      rt.status = 'live'
      this.events?.onStatus(paneId, 'live')
    }

    // Held for the ticker rather than parsed here; see digest(). Only the tail
    // is ever read, so anything older than the window can go now.
    rt.pending.push(data)
    rt.pendingLen += data.length
    while (rt.pendingLen > PARSE_WINDOW && rt.pending.length > 1) {
      rt.pendingLen -= rt.pending.shift()!.length
    }
  }

  markExited(
    paneId: string,
    code: number,
    signal?: number,
    requested?: boolean,
    token?: number
  ): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    // A fresh terminal instance created during restart that hasn't spawned yet
    // must ignore exits from an older killed session.
    if (!rt.spawned) return
    // If a session token was attached, only accept exits matching the active session.
    if (token !== undefined && rt.sessionToken !== undefined && token !== rt.sessionToken) return

    rt.spawned = false
    // A shell that has gone is running nothing, and the ticker would otherwise
    // take a beat to notice.
    if (rt.working) {
      rt.working = false
      this.events?.onWorking(paneId, false)
    }
    rt.status = 'exited'

    /*
     * The overlay reads lastError, so whatever is said here is what somebody
     * sees over the dead pane instead of "This session ended."
     */
    const reason = exitReason(code, signal, requested)
    rt.lastError = reason
    rt.term.writeln(reason ? `\r\n  [${reason}]` : `\r\n  [session ended, exit ${code}]`)

    /*
     * Say how tight the machine actually was. The overlay has already been
     * painted by then, but the terminal is live and this is the number that
     * tells somebody whether to close something — and it is the difference
     * between "my app keeps crashing" and "my machine is full".
     */
    if (killedByOs(signal, requested)) {
      void window.eaon.sys
        .memory()
        .then((room) => {
          if (room.note && this.panes.get(paneId) === rt) {
            rt.term.writeln(`  [${room.note} Closing something else will make room.]`)
          }
        })
        .catch(() => {
          /* the reading is a courtesy; the reason above stands without it */
        })
    }

    this.events?.onExit(paneId, code, signal, requested)
  }

  /**
   * Ends a pane's shell but keeps the pane.
   *
   * Unlike dispose(), the terminal and everything on it stay exactly where they
   * were — the shell's exit comes back through the usual path and writes the
   * same "session ended" line an agent quitting on its own would, so what is on
   * screen is still readable and the pane can be started again.
   */
  stop(paneId: string): void {
    /*
     * Killed without first checking that this renderer has a terminal for the
     * pane, because that check would have been wrong in exactly the case that
     * matters. Shells live in the main process and outlive a reload, while a
     * terminal is only created when its pane is first drawn — so a workspace
     * you have not opened since launch has live shells and nothing here to find
     * them by, and those are the ones most likely to be running forgotten.
     *
     * The shell's exit comes back through pty:exit and markExited() paints the
     * pane, when there is a pane on screen to paint.
     */
    window.eaon.pty.kill(paneId)
  }

  /** Called when a pane gets focus — clears a pending attention flag. */
  acknowledge(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt || rt.status !== 'attention') return
    rt.status = 'idle'
    this.events?.onStatus(paneId, 'idle')
  }

  /** True when the recent output looks like a prompt waiting on a human. */
  looksBlocked(paneId: string): boolean {
    const rt = this.panes.get(paneId)
    if (!rt) return false
    // Asked for on demand, so it must not answer from a tail the ticker has
    // not caught up with yet.
    this.digest(paneId, rt)
    const tail = rt.tail.slice(-600)
    return WAITING.some((re) => re.test(tail))
  }

  send(paneId: string, text: string): void {
    const rt = this.panes.get(paneId)
    // A broadcast from the conductor is input too — without this, the reply it
    // provokes would be timed from the pane's last keystroke instead.
    if (rt) rt.lastInput = Date.now()
    window.eaon.pty.write(paneId, text)
  }

  /** Goes through xterm so bracketed paste is honoured, like a real terminal. */
  paste(paneId: string, text: string): void {
    const rt = this.panes.get(paneId)
    if (!rt || !text) return
    rt.term.paste(text)
  }

  selectAll(paneId: string): void {
    this.panes.get(paneId)?.term.selectAll()
  }

  focus(paneId: string): void {
    this.panes.get(paneId)?.term.focus()
  }

  status(paneId: string): PaneStatus {
    return this.panes.get(paneId)?.status ?? 'idle'
  }

  clear(paneId: string): void {
    this.panes.get(paneId)?.term.clear()
  }

  find(paneId: string, query: string, back = false): void {
    const rt = this.panes.get(paneId)
    if (!rt || !query) return
    const opts = { caseSensitive: false, regex: false, wholeWord: false }
    if (back) rt.search.findPrevious(query, opts)
    else rt.search.findNext(query, opts)
  }

  clearFind(paneId: string): void {
    this.panes.get(paneId)?.search.clearDecorations()
  }

  selection(paneId: string): string {
    return this.panes.get(paneId)?.term.getSelection() ?? ''
  }

  /**
   * Reads up to `maxLines` from the bottom of a pane's xterm buffer without
   * mutating terminal state, stealing focus, or altering selection.
   *
   * Translates buffer lines to text, respects soft-wrapped lines, trims trailing
   * blank lines, and collapses spinner redraw runs via linesToText.
   * Returns null if the pane is not found.
   */
  readTail(paneId: string, maxLines = 80): string | null {
    const rt = this.panes.get(paneId)
    if (!rt) return null
    const buffer = rt.term.buffer.active
    const total = buffer.length
    const start = Math.max(0, total - Math.max(1, maxLines))
    const rawLines: { text: string; wrapped: boolean }[] = []
    for (let i = start; i < total; i += 1) {
      const line = buffer.getLine(i)
      if (!line) continue
      rawLines.push({
        text: line.translateToString(true),
        wrapped: Boolean(line.isWrapped)
      })
    }
    return linesToText(rawLines)
  }

  applySettings(settings: Settings): void {
    this.settings = settings
    for (const [id, rt] of this.panes) {
      rt.term.options.fontFamily = settings.fontFamily
      rt.term.options.fontSize = settings.fontSize
      rt.term.options.lineHeight = settings.lineHeight
      rt.term.options.cursorStyle = settings.cursorStyle
      rt.term.options.cursorBlink = settings.cursorBlink
      rt.term.options.scrollback = settings.scrollback
      // New metrics mean a new grid, so the cached size no longer applies.
      rt.sentCols = 0
      rt.sentRows = 0
      this.fit(id)
    }
  }

  /**
   * Why this pane's shell would not start, if that is why it is not running.
   *
   * The overlay a stopped pane shows sits on top of the terminal, so the line
   * explaining the refusal was behind it — the one piece of text that said
   * what to do about it was the one piece you could not read.
   */
  lastError(paneId: string): string | null {
    return this.panes.get(paneId)?.lastError ?? null
  }

  currentSettings(): Settings | null {
    return this.settings
  }

  dispose(paneId: string): void {
    const rt = this.panes.get(paneId)
    if (!rt) return
    window.eaon.pty.kill(paneId)
    if (rt.fitTimer !== null) window.clearTimeout(rt.fitTimer)
    rt.pending.length = 0
    rt.pendingLen = 0
    this.resizeListeners.delete(paneId)
    // Free the GPU context explicitly; there is a hard cap on live ones.
    try {
      rt.webgl?.dispose()
    } catch {
      /* already gone */
    }
    rt.webgl = null
    rt.observer?.disconnect()
    for (const off of rt.disposers) {
      try {
        off()
      } catch {
        /* already gone */
      }
    }
    if (rt.wrapper.parentElement) rt.wrapper.parentElement.removeChild(rt.wrapper)
    rt.term.dispose()
    this.panes.delete(paneId)
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }
}

export const terminals = new TerminalRegistry()
