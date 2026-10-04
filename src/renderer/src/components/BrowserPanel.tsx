import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Lock,
  MoreVertical,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  SquareTerminal,
  X
} from 'lucide-react'
import {
  engineById,
  prettyUrl,
  resolveInput,
  safetyOf,
  type Safety
} from '@shared/browser'
import { useStore } from '../store/useStore'

/**
 * The preview browser.
 *
 * It is pointed at whatever the agents in the next pane are building, so it
 * opens on a running dev server rather than a home page and the address bar
 * takes a bare port. Everything else about it is deliberately an ordinary
 * browser: the same controls in the same order, the same keyboard shortcuts,
 * an address bar that searches when you give it words, find-in-page, zoom and
 * a right-click menu. Nobody should have to learn this panel.
 */

/** The bits of Electron's <webview> this panel drives. */
interface WebviewEl extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  setZoomFactor(factor: number): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
  getWebContentsId(): number
}

export interface WebviewConsoleMessageEvent extends Event {
  level: number
  message: string
  line: number
  sourceId: string
}

interface FailEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

interface NavEvent extends Event {
  url: string
}

interface TitleEvent extends Event {
  title: string
}

interface FoundEvent extends Event {
  result: { activeMatchOrdinal: number; matches: number }
}

interface ContextMenuEvent extends Event {
  params: {
    x: number
    y: number
    linkURL: string
    srcURL: string
    selectionText: string
    mediaType: string
  }
}

/** Chords the panel owns while it has focus, by the key that produces them. */
const CHORDS: Record<string, string> = {
  l: 'address',
  r: 'reload',
  f: 'find',
  '[': 'back',
  ']': 'forward',
  arrowleft: 'back',
  arrowright: 'forward',
  '=': 'zoom-in',
  '+': 'zoom-in',
  '-': 'zoom-out',
  _: 'zoom-out',
  '0': 'zoom-reset'
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]

/** What the indicator at the head of the address bar says about the page. */
const SAFETY: Record<Safety, { icon: typeof Lock; label: string; tone: string }> = {
  secure: { icon: Lock, label: 'The connection to this site is encrypted', tone: 'secure' },
  local: { icon: SquareTerminal, label: 'A server running on this machine', tone: 'local' },
  insecure: { icon: ShieldAlert, label: 'Not secure — this connection is plain HTTP', tone: 'warn' },
  file: { icon: FileText, label: 'A file on this machine', tone: 'local' },
  none: { icon: Globe, label: '', tone: 'plain' }
}

/**
 * The browser, as a tab of a project.
 *
 * `visible` is a prop rather than something read off the dock. It used to be
 * `dockOpen && dockTab === 'browser'`, which tied this component to being the
 * dock's — and it gates real work: port scanning and the keyboard chords both
 * stop when the browser is not on screen. Now that a browser is a tab, the
 * thing that knows whether it is showing is whatever rendered it.
 *
 * It is rendered mounted-but-hidden when another tab is in front, never
 * unmounted: a `<webview>` reloads its page from scratch when it re-attaches,
 * which would cost you the scroll position, the form you were filling in, and
 * whatever route a single-page app was on — every time you glanced at a
 * terminal and came back.
 */
export function BrowserPanel({ visible }: { visible: boolean }): React.JSX.Element {
  const home = useStore((s) => s.settings.browserHome)
  const engineId = useStore((s) => s.settings.browserSearchEngine)
  const savedZoom = useStore((s) => s.settings.browserZoom)
  const update = useStore((s) => s.updateSettings)

  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebviewEl | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)

  const [address, setAddress] = useState(home)
  const [current, setCurrent] = useState(home)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [back, setBack] = useState(false)
  const [forward, setForward] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ports, setPorts] = useState<number[]>([])
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [linkTarget, setLinkTarget] = useState('')

  // Zoom lives in settings, so it survives a restart and the Browser section of
  // Settings can drive it too. Kept in a ref as well, because the guest's
  // dom-ready listener is bound once and would otherwise reapply a stale one.
  const zoom = savedZoom || 1
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState({ active: 0, total: 0 })

  const [context, setContext] = useState<{
    x: number
    y: number
    linkURL: string
    selectionText: string
  } | null>(null)

  /**
   * True while the address bar holds something you typed rather than the page's
   * own URL. A ref, not state: it changes on every keystroke and nothing on
   * screen depends on it, so re-rendering for it would be wasted work.
   */
  const editing = useRef(false)

  const engine = useMemo(() => engineById(engineId), [engineId])
  const safety = SAFETY[safetyOf(current)]

  /** Calls into the guest, which throws until it has attached. */
  const view = useCallback(<T,>(fn: (v: WebviewEl) => T): T | undefined => {
    const el = viewRef.current
    if (!el) return undefined
    try {
      return fn(el)
    } catch {
      return undefined
    }
  }, [])

  const scanPorts = useCallback(() => {
    void window.eaon.browser.devPorts().then(setPorts)
  }, [])

  useEffect(() => {
    if (!visible) return
    scanPorts()
    // Dev servers come and go while you work; a slow poll keeps the chips true
    // without the panel feeling like it is doing something. Only while you are
    // actually looking at it — this opens thirteen sockets each time round.
    const id = window.setInterval(scanPorts, 8000)
    return () => window.clearInterval(id)
  }, [scanPorts, visible])

  const go = useCallback(
    (raw: string) => {
      const resolved = resolveInput(raw, engineId)
      if (!resolved) return
      if (resolved.kind === 'refused') {
        setError(resolved.reason)
        return
      }
      setError(null)
      editing.current = false
      setAddress(resolved.url)
      setCurrent(resolved.url)
      // Only real destinations are worth reopening on; a search is a detour.
      if (resolved.kind === 'url') update({ browserHome: resolved.url })
      view((v) => void v.loadURL(resolved.url).catch(() => undefined))
      addressRef.current?.blur()
    },
    [engineId, update, view]
  )

  const focusAddress = useCallback(() => {
    const el = addressRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const applyZoom = useCallback(
    (next: number) => {
      update({ browserZoom: Math.min(2.5, Math.max(0.5, Number(next.toFixed(2)))) })
    },
    [update]
  )

  // One place pushes the factor at the guest, whether it changed here or in
  // Settings.
  useEffect(() => {
    view((v) => v.setZoomFactor(zoom))
  }, [view, zoom])

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - zoom) < 0.001)
      if (i === -1) return applyZoom(zoom + direction * 0.1)
      const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))]
      applyZoom(next)
    },
    [applyZoom, zoom]
  )

  const runFind = useCallback(
    (text: string, forwards = true) => {
      if (!text) {
        view((v) => v.stopFindInPage('clearSelection'))
        setFindHits({ active: 0, total: 0 })
        return
      }
      /*
       * `findNext: true` on every request, the opening one included.
       *
       * Electron documents the flag as "begin a new text finding session…
       * should be true for initial requests and false for follow-up ones",
       * which reads like the opposite of this. In practice passing false emits
       * no found-in-page event at all, so the match counter never updates and
       * find looks broken. True advances from the current match rather than
       * restarting — which is what Return and the arrows are meant to do — and
       * changing the text starts a fresh count on its own.
       */
      view((v) => v.findInPage(text, { forward: forwards, findNext: true }))
    },
    [view]
  )

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindHits({ active: 0, total: 0 })
    view((v) => v.stopFindInPage('clearSelection'))
  }, [view])

  const handleChord = useCallback(
    (chord: string) => {
      switch (chord) {
        case 'address':
          return focusAddress()
        case 'reload':
          return void view((v) => v.reload())
        case 'reload+shift':
          return void view((v) => v.reloadIgnoringCache())
        case 'find':
          setFindOpen(true)
          // The bar may only be appearing now, so the focus waits for it.
          requestAnimationFrame(() => findRef.current?.select())
          return
        case 'back':
          return void view((v) => v.canGoBack() && v.goBack())
        case 'forward':
          return void view((v) => v.canGoForward() && v.goForward())
        case 'zoom-in':
          return stepZoom(1)
        case 'zoom-out':
          return stepZoom(-1)
        case 'zoom-reset':
          return applyZoom(1)
        default:
      }
    },
    [applyZoom, focusAddress, stepZoom, view]
  )

  // Chords pressed while the panel's own chrome has focus. Capture, so the
  // app's global shortcuts do not get to the zoom keys first.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || !root.contains(document.activeElement)) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const chord = CHORDS[e.key.toLowerCase()]
      if (!chord) return
      e.preventDefault()
      e.stopImmediatePropagation()
      handleChord(e.shiftKey ? `${chord}+shift` : chord)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handleChord, visible])

  // The same chords, pressed while the page had focus. Those never reach this
  // window on their own; the main process catches and forwards them.
  useEffect(() => window.eaon.browser.onKey(handleChord), [handleChord])

  // The webview is a custom element, so its events are plain DOM events rather
  // than React props and have to be wired by hand.
  useEffect(() => {
    const el = viewRef.current
    if (!el) return

    const sync = (): void => {
      try {
        setBack(el.canGoBack())
        setForward(el.canGoForward())
      } catch {
        /* the guest may not be attached yet */
      }
    }

    const onStart = (): void => {
      setLoading(true)
      setError(null)
    }
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    const onNavigate = (e: Event): void => {
      const url = (e as NavEvent).url
      setCurrent(url)
      // Never overwrite half-typed text: a page that redirects while you are
      // mid-address would otherwise yank the field out from under you.
      if (!editing.current) setAddress(url)
      setFindHits({ active: 0, total: 0 })
      sync()
    }
    const onTitle = (e: Event): void => setTitle((e as TitleEvent).title)
    const onTarget = (e: Event): void => setLinkTarget((e as NavEvent).url || '')
    const onFound = (e: Event): void => {
      const { activeMatchOrdinal, matches } = (e as FoundEvent).result
      setFindHits({ active: activeMatchOrdinal, total: matches })
    }
    const onReady = (): void => {
      // Zoom is per-guest and resets when a new one attaches.
      try {
        el.setZoomFactor(zoomRef.current)
      } catch {
        /* not attached after all */
      }
      sync()
    }
    const onContext = (e: Event): void => {
      const p = (e as ContextMenuEvent).params
      setMenuOpen(false)
      setContext({
        x: p.x,
        y: p.y,
        linkURL: p.linkURL || '',
        selectionText: p.selectionText || ''
      })
    }
    const onFail = (e: Event): void => {
      const fail = e as FailEvent
      // Sub-resources fail all the time on a half-built page; only a failed
      // main frame means the address did not load.
      if (!fail.isMainFrame) return
      // -3 is an aborted load, which is what a redirect or a fast retype looks
      // like. Reporting it would flash an error on perfectly normal navigation.
      if (fail.errorCode === -3) return
      setLoading(false)
      setError(
        fail.errorCode === -102 || fail.errorCode === -105
          ? `Nothing is answering at ${fail.validatedURL}. Is the dev server running?`
          : `${fail.errorDescription || 'Could not load that page'} (${fail.errorCode})`
      )
    }

    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('update-target-url', onTarget)
    el.addEventListener('found-in-page', onFound)
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('context-menu', onContext)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('update-target-url', onTarget)
      el.removeEventListener('found-in-page', onFound)
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('context-menu', onContext)
    }
  }, [])

  // Dismiss the overflow menu the way every menu in the app does.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (): void => setMenuOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const SafetyIcon = safety.icon
  const shown = focused ? address : prettyUrl(address)

  return (
    <div className="browser" ref={rootRef}>
      {/* What a tab strip would have told you, in a panel that has no room for
          one: which page you are actually looking at. */}
      <div className="browser-title" title={current}>
        <SafetyIcon size={11} aria-hidden="true" />
        <span className="browser-title-text">{title || prettyUrl(current)}</span>
      </div>

      <div className="browser-bar">
        <button
          className="icon-btn"
          disabled={!back}
          onClick={() => view((v) => v.goBack())}
          title="Back  ⌘["
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className="icon-btn"
          disabled={!forward}
          onClick={() => view((v) => v.goForward())}
          title="Forward  ⌘]"
          aria-label="Forward"
        >
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => view((v) => (loading ? v.stop() : v.reload()))}
          title={loading ? 'Stop' : 'Reload  ⌘R'}
          aria-label={loading ? 'Stop' : 'Reload'}
        >
          {loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>

        <div className="browser-omnibox" data-focused={focused}>
          <span
            className="browser-safety"
            data-tone={safety.tone}
            title={safety.label}
            aria-label={safety.label}
          >
            <SafetyIcon size={12} />
          </span>
          <input
            ref={addressRef}
            className="browser-address"
            value={shown}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              engine.template ? `Search ${engine.label} or enter address` : 'Enter an address'
            }
            aria-label="Address and search"
            onChange={(e) => {
              editing.current = true
              setAddress(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(address)
              if (e.key === 'Escape') {
                editing.current = false
                setAddress(current)
                setError(null)
                e.currentTarget.blur()
              }
            }}
            onFocus={(e) => {
              setFocused(true)
              // A browser hands you the whole address on one click, ready to
              // be replaced.
              e.currentTarget.select()
            }}
            onBlur={() => {
              setFocused(false)
              // Abandoned edits revert, so the bar always agrees with the page.
              if (!editing.current) return
              editing.current = false
              setAddress(current)
            }}
          />
          {zoom !== 1 && (
            <button
              className="browser-zoom-pill"
              onClick={() => applyZoom(1)}
              title="Reset zoom  ⌘0"
            >
              {Math.round(zoom * 100)}%
            </button>
          )}
        </div>

        <button
          className="icon-btn"
          onClick={() => window.eaon.sys.openExternal(current)}
          disabled={!/^https?:\/\//i.test(current)}
          title="Open in your browser"
          aria-label="Open in your browser"
        >
          <ExternalLink size={14} />
        </button>

        <span className="browser-more">
          <button
            className="icon-btn"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            title="More"
            aria-label="More"
          >
            <MoreVertical size={15} />
          </button>

          {menuOpen && (
            <div className="pane-menu browser-menu" onMouseDown={(e) => e.stopPropagation()}>
              <div className="browser-menu-zoom">
                <span>Zoom</span>
                <button className="icon-btn" onClick={() => stepZoom(-1)} aria-label="Zoom out">
                  −
                </button>
                <button className="browser-zoom-value" onClick={() => applyZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <button className="icon-btn" onClick={() => stepZoom(1)} aria-label="Zoom in">
                  +
                </button>
              </div>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  handleChord('find')
                }}
              >
                <Search size={13} />
                Find in page
                <span className="kbd">⌘F</span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(current)
                  setMenuOpen(false)
                }}
              >
                <Copy size={13} />
                Copy address
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  view((v) => v.reloadIgnoringCache())
                  setMenuOpen(false)
                }}
              >
                <RotateCw size={13} />
                Reload, ignoring cache
                <span className="kbd">⇧⌘R</span>
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  view((v) => (v.isDevToolsOpened() ? v.closeDevTools() : v.openDevTools()))
                  setMenuOpen(false)
                }}
              >
                <SquareTerminal size={13} />
                Developer tools
              </button>
            </div>
          )}
        </span>
      </div>

      {findOpen && (
        <div className="browser-find">
          <Search size={13} color="var(--text-dim)" aria-hidden="true" />
          <input
            ref={findRef}
            value={findQuery}
            autoFocus
            spellCheck={false}
            placeholder="Find in page"
            aria-label="Find in page"
            onChange={(e) => {
              setFindQuery(e.target.value)
              runFind(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runFind(findQuery, !e.shiftKey)
              if (e.key === 'Escape') closeFind()
            }}
          />
          <span className="browser-find-count">
            {findQuery ? `${findHits.active}/${findHits.total}` : ''}
          </span>
          <button
            className="icon-btn"
            onClick={() => runFind(findQuery, false)}
            disabled={!findHits.total}
            aria-label="Previous match"
          >
            <ChevronUp size={13} />
          </button>
          <button
            className="icon-btn"
            onClick={() => runFind(findQuery, true)}
            disabled={!findHits.total}
            aria-label="Next match"
          >
            <ChevronDown size={13} />
          </button>
          <button className="icon-btn" onClick={closeFind} aria-label="Close find">
            <X size={12} />
          </button>
        </div>
      )}

      {ports.length > 0 && (
        <div className="browser-ports">
          <Server size={11} aria-hidden="true" />
          <span className="browser-ports-label">running</span>
          {ports.map((port) => {
            const url = `http://localhost:${port}`
            return (
              <button
                className="chip browser-port"
                key={port}
                data-on={current.startsWith(url)}
                onClick={() => go(url)}
                title={url}
              >
                :{port}
              </button>
            )
          })}
        </div>
      )}

      <div className="browser-view" onMouseDown={() => setContext(null)}>
        {/* Attributes the custom element reads at attach time, so they are set
            here rather than through React state. */}
        <webview
          ref={viewRef as never}
          src={home}
          partition="persist:preview"
          allowpopups={undefined}
          style={{ width: '100%', height: '100%', display: 'flex' }}
        />
        {loading && <span className="browser-loading" aria-hidden="true" />}

        {context && (
          <div
            className="pane-menu browser-context"
            style={{ top: context.y, left: context.x, right: 'auto' }}
          >
            <button
              className="menu-item"
              disabled={!back}
              onClick={() => {
                view((v) => v.goBack())
                setContext(null)
              }}
            >
              <ArrowLeft size={13} />
              Back
            </button>
            <button
              className="menu-item"
              disabled={!forward}
              onClick={() => {
                view((v) => v.goForward())
                setContext(null)
              }}
            >
              <ArrowRight size={13} />
              Forward
            </button>
            <button
              className="menu-item"
              onClick={() => {
                view((v) => v.reload())
                setContext(null)
              }}
            >
              <RotateCw size={13} />
              Reload
            </button>
            {context.linkURL && (
              <>
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    void navigator.clipboard.writeText(context.linkURL)
                    setContext(null)
                  }}
                >
                  <Copy size={13} />
                  Copy link address
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    window.eaon.sys.openExternal(context.linkURL)
                    setContext(null)
                  }}
                >
                  <ExternalLink size={13} />
                  Open link in your browser
                </button>
              </>
            )}
            {context.selectionText && (
              <>
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    void navigator.clipboard.writeText(context.selectionText)
                    setContext(null)
                  }}
                >
                  <Copy size={13} />
                  Copy
                </button>
              </>
            )}
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                view((v) => v.openDevTools())
                setContext(null)
              }}
            >
              <SquareTerminal size={13} />
              Inspect
            </button>
          </div>
        )}

        {error && (
          <div className="browser-error" role="alert">
            <Globe size={22} color="var(--text-dim)" aria-hidden="true" />
            <strong>{error}</strong>
            <div className="browser-error-actions">
              <button className="btn" onClick={() => go(address)}>
                Try again
              </button>
              {ports.length > 0 && (
                <button className="btn" onClick={() => go(`http://localhost:${ports[0]}`)}>
                  Open :{ports[0]}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Where a link goes, in the corner, the way a browser does it. */}
        {linkTarget && !error && (
          <span className="browser-status" aria-hidden="true">
            {prettyUrl(linkTarget)}
          </span>
        )}
      </div>
    </div>
  )
}
