import { useEffect, useMemo, useRef } from 'react'
import { useActiveWorkspace, useStore } from './store/useStore'
import { exitReason, killedByOs } from '@shared/exit'
import { terminals } from './lib/terminals'
import { applyTheme, resolveTheme } from './lib/theme'
import { TitleBar } from './components/TitleBar'
import { WorkspaceRail } from './components/WorkspaceRail'
import { Launcher } from './components/Launcher'
import { SetupWizard } from './components/SetupWizard'
import { TerminalGrid } from './components/TerminalGrid'
import { BrowserPanel } from './components/BrowserPanel'
import { SideDock } from './components/SideDock'
import { StagePageView } from './components/StagePageView'
import { ErrorBoundary } from './components/ErrorBoundary'

/** What to call each page when one of them fails to render. */
const PAGE_LABEL: Record<string, string> = {
  search: 'Search',
  automations: 'Automations',
  pulls: 'Pull requests',
  pages: 'Pages'
}
import { WorkspaceTabs } from './components/WorkspaceTabs'
import { CommandPalette } from './components/CommandPalette'
import { ResumeDialog } from './components/ResumeDialog'
import { SettingsModal } from './components/SettingsModal'
import { PresetEditor } from './components/PresetEditor'
import { Board } from './components/Board'
import { Vault } from './components/Vault'
import { Brain } from './components/Brain'
import { Stats } from './components/Stats'
import { DictationHUD } from './components/DictationHUD'
import { UpdateCard } from './components/UpdateCard'
import { dictation } from './lib/dictation'
import { cancelDictation, startDictation, stopDictation, toggleDictation } from './lib/voice'
import { announceFinished, hushSpeech } from './lib/speech'
import { commandFor, effectiveHoldKey } from './lib/keys'
import { useAutomationSchedule } from './lib/automation-schedule'

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const hydrate = useStore((s) => s.hydrate)
  const settings = useStore((s) => s.settings)
  const railOpen = useStore((s) => s.railOpen)
  const dockOpen = useStore((s) => s.dockOpen)
  const wizard = useStore((s) => s.wizard)
  const stagePage = useStore((s) => s.stagePage)
  const workspacesAll = useStore((s) => s.workspaces)
  /*
   * Mounted for as long as they exist, not only while in front — see below.
   *
   * Filtered here rather than inside the selector: a selector that returns
   * `s.workspaces.filter(...)` builds a new array on every call, zustand
   * compares what it gets back by reference, and the store re-renders forever.
   * That took the whole window down to its error boundary.
   */
  const browsers = useMemo(
    () => workspacesAll.filter((w) => w.kind === 'browser'),
    [workspacesAll]
  )
  const home = useStore((s) => s.home)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const resumeOpen = useStore((s) => s.resumeOpen)
  const presetEditorId = useStore((s) => s.presetEditorId)
  const workspace = useActiveWorkspace()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The last change before quitting, closing the window or reloading must
  // reach disk; the save debounce would otherwise still be holding it.
  useEffect(() => {
    const flush = (): void => useStore.getState().flushPersist()
    const off = window.eaon.state.onFlushRequest(flush)
    window.addEventListener('pagehide', flush)
    return () => {
      off()
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  // Daily automations. Nothing fires until their time comes round while the
  // app is actually watching — see useAutomationSchedule.
  useAutomationSchedule()

  // A pane's agent is whatever is running in it now, not what it was opened
  // as. Close Codex and type `opencode` and the header's mark and name follow.
  useEffect(() => {
    return window.eaon.paneAgents.onChange((_e, { paneId, agentId }) => {
      useStore.getState().setPaneAgent(paneId, agentId)
    })
  }, [])

  // ---- terminal plumbing -------------------------------------------------
  useEffect(() => {
    const store = useStore.getState

    terminals.init(
      {
        onTitle: (paneId, title) => store().patchPane(paneId, { title }),
        onStatus: (paneId, status) => {
          const s = store()
          if (status === 'attention' && !s.settings.bellAttention) return
          // Stamped here as well as on `working` because ringing the bell is
          // the pane changing what it is doing — an agent that stopped to ask
          // a question has been waiting since this moment, not since the last
          // time it went quiet.
          s.patchPane(paneId, { status, lastActiveAt: Date.now() })

          if (status !== 'attention') return
          const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
          const pane = ws?.panes.find((p) => p.id === paneId)
          if (!ws || !pane) return
          // Only shout when you are not already looking at that pane.
          if (ws.id === s.activeWorkspaceId && ws.activePaneId === paneId) return
          s.notify({
            kind: 'attention',
            title: `${pane.name} needs you`,
            text: pane.title ?? `In ${ws.name}`,
            paneId,
            workspaceId: ws.id
          })
        },
        onContext: (paneId, contextPct) => store().patchPane(paneId, { contextPct }),
        // Only ever called on a change (terminals.ts compares before it
        // emits), so stamping the clock here costs one write per transition
        // rather than one per tick.
        onWorking: (paneId, working) =>
          store().patchPane(paneId, { working, lastActiveAt: Date.now() }),
        onExit: (paneId, code, signal, requested) => {
          const s = store()
          s.patchPane(paneId, { status: 'exited', working: false, lastActiveAt: Date.now() })
          const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
          const pane = ws?.panes.find((p) => p.id === paneId)
          /*
           * Not `code !== 0`. A process the kernel kills exits with code 0 and
           * a signal, so the old test was false for exactly the case people
           * were reporting — the session vanished and nothing was ever said
           * about it. exitReason() is null only when the exit was asked for.
           */
          const reason = pane ? exitReason(code, signal, requested) : null
          if (pane && reason) {
            const notify = (text: string): void => {
              s.notify({
                kind: 'error',
                title: killedByOs(signal, requested)
                  ? `${pane.name} was stopped`
                  : `${pane.name} exited`,
                text,
                paneId,
                workspaceId: ws?.id
              })
            }
            // The memory reading is worth waiting a tick for: it is what turns
            // "it quit again" into something the person can do something about.
            if (killedByOs(signal, requested)) {
              void window.eaon.sys
                .memory()
                .then((room) => notify(room.note ? `${reason} ${room.note}` : reason))
                .catch(() => notify(reason))
            } else {
              notify(reason)
            }
          }
        },
        onFinished: (paneId) => {
          const s = store()
          const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
          const pane = ws?.panes.find((p) => p.id === paneId)
          if (!ws || !pane) return
          void announceFinished(
            {
              paneId,
              paneName: pane.name,
              // A bare shell goes quiet after every command it runs. Only a
              // pane that was started with something in it has "finished"
              // anything worth saying out loud.
              isAgent: Boolean(pane.command),
              watching:
                document.hasFocus() && ws.id === s.activeWorkspaceId && ws.activePaneId === paneId
            },
            s.settings
          )
        }
      },
      useStore.getState().settings
    )

    const offData = window.eaon.pty.onData((paneId, data) => terminals.receive(paneId, data))
    const offExit = window.eaon.pty.onExit((paneId, code, signal, requested, token) =>
      terminals.markExited(paneId, code, signal, requested, token)
    )
    return () => {
      offData()
      offExit()
      // A reload must not leave the last announcement talking over the boot.
      hushSpeech()
    }
  }, [])

  // ---- auto update -------------------------------------------------------
  useEffect(() => {
    const store = useStore.getState
    window.eaon.update.state().then((s) => store().setUpdate(s))
    return window.eaon.update.onState((s) => store().setUpdate(s))
  }, [])

  // ---- voice dictation ---------------------------------------------------
  useEffect(() => {
    const store = useStore.getState
    const offProgress = window.eaon.stt.onProgress((p) => store().setSttProgress(p))
    const offState = window.eaon.stt.onState((s) => store().setSttEngine(s))
    return () => {
      offProgress()
      offState()
      // Never leave the microphone open behind a reload.
      cancelDictation()
    }
  }, [])

  useEffect(() => {
    /**
     * Hold-to-talk on a modifier needs a moment's patience. Right ⌘ is also the
     * first half of Right ⌘ + C, so dictation waits to see whether a second key
     * follows before it opens the microphone.
     */
    const ARM_MS = 180
    const hold = { armed: false, open: false, timer: 0 }

    const disarm = (): void => {
      if (hold.timer) window.clearTimeout(hold.timer)
      hold.timer = 0
      hold.armed = false
    }

    const release = (): void => {
      disarm()
      if (!hold.open) return
      hold.open = false
      void stopDictation()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const s = useStore.getState()

      if (e.key === 'Escape' && dictation.active) {
        // Beat the Conductor and the modals to it — while the microphone is
        // live, Escape means "throw this away", not "close that panel".
        e.preventDefault()
        e.stopPropagation()
        hold.open = false
        disarm()
        cancelDictation()
        return
      }

      // The chord toggles, for dictating something longer than you want to hold
      // a key for. Which chord that is depends on the platform — see lib/keys.
      if (commandFor(e) === 'dictate') {
        e.preventDefault()
        // Immediate: the app's other shortcut handler is bound to window too,
        // and plain stopPropagation does not stop a sibling on the same target.
        e.stopImmediatePropagation()
        void toggleDictation()
        return
      }

      // Right ⌘ on macOS; on Windows that key belongs to the Start menu, so the
      // stored default resolves to Right Control instead.
      const holdKey = effectiveHoldKey(s.settings.voiceHoldKey)
      if (holdKey && e.code === holdKey) {
        // Auto-repeat fires continuously while a key is held; only the first
        // press starts anything.
        if (e.repeat || hold.armed || hold.open) return
        if (holdKey === 'F5') e.preventDefault()
        hold.armed = true
        hold.timer = window.setTimeout(() => {
          hold.timer = 0
          if (!hold.armed) return
          hold.armed = false
          hold.open = true
          void startDictation()
        }, ARM_MS)
        return
      }

      /*
       * Any other key while the hold key is down means a chord, not speech.
       *
       * The hold key is Right ⌘ by default, which is also the first half of
       * ⌘⌫, ⌘← and every other Command shortcut. Holding it for the moment it
       * takes to reach the second key would otherwise open the microphone
       * mid-shortcut and, on release, type whatever it had heard into the pane.
       * The audio is discarded rather than transcribed.
       */
      if (hold.armed || hold.open) {
        disarm()
        if (hold.open) {
          hold.open = false
          cancelDictation()
        }
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      const holdKey = effectiveHoldKey(useStore.getState().settings.voiceHoldKey)
      if (holdKey && e.code === holdKey) release()
    }

    // A keyup can be missed entirely if the window loses focus mid-hold, which
    // would otherwise leave the microphone open indefinitely.
    const onBlur = (): void => release()

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      release()
    }
  }, [])

  // ---- theme -------------------------------------------------------------
  useEffect(() => {
    const theme = resolveTheme(settings)
    applyTheme(theme)
    terminals.applyPalette(theme.terminal)
    document.documentElement.dataset.reduceMotion = String(settings.reduceMotion)
  }, [settings.themeId, settings.accentOverride, settings.reduceMotion, settings])

  // ---- global shortcuts --------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Which modifier means "the app" differs by platform, and the rule lives
      // in one place so this handler and the one inside each pane cannot
      // disagree about who owns a key. See lib/keys.ts.
      const command = commandFor(e)
      if (!command) return

      const s = useStore.getState()

      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null

      const take = (fn: () => void): void => {
        e.preventDefault()
        e.stopPropagation()
        fn()
      }

      /*
       * While you are in the preview panel these zoom the page, and it handles
       * them itself. Without this they would do both at once.
       */
      if (
        document.activeElement?.closest('.browser') &&
        ['fontIn', 'fontOut', 'fontReset'].includes(command as string)
      ) {
        return
      }

      switch (command) {
        case 'fontIn':
          return take(() => s.updateSettings({ fontSize: Math.min(22, s.settings.fontSize + 1) }))
        case 'fontOut':
          return take(() => s.updateSettings({ fontSize: Math.max(8, s.settings.fontSize - 1) }))
        case 'fontReset':
          return take(() => s.updateSettings({ fontSize: 12 }))
        case 'palette':
          return take(() => s.setPalette(!s.paletteOpen))
        case 'newWorkspace':
          return take(() => s.openWizard('grid'))
        case 'rail':
          return take(() => s.toggleRail())
        case 'dock':
          return take(() => s.toggleDock())
        case 'conductor':
          return take(() => s.toggleConductor())
        case 'settings':
          return take(() => s.setSettingsOpen(!s.settingsOpen))
        case 'resume':
          return take(() => s.setResumeOpen(true))
        case 'reopenTab':
          return take(() => {
            // Nothing to bring back is worth saying, or the chord looks broken.
            if (!s.reopenClosed()) {
              s.notify({ kind: 'info', title: 'Nothing to reopen', text: 'No tab has been closed yet.' })
            }
          })
        case 'dictate':
          // Handled by the dictation listener, which runs first and stops this
          // one; reaching here means it declined, so do nothing.
          return
        case 'selectAll':
          // Belongs to whichever pane has focus. It reaches the terminal's own
          // handler, which is the only thing that can select its buffer.
          return
        default:
          break
      }

      if (!ws) return

      // The pane owns the search box; this only names which pane should open
      // it. Before this the binding did nothing at all.
      if (command === 'find' && ws.activePaneId) {
        return take(() => s.setFindPane(ws.activePaneId))
      }

      if (command === 'addPane') return take(() => s.addPane(ws.id))
      if (command === 'zoomPane' && ws.activePaneId) {
        return take(() => s.zoomPane(ws.id, ws.zoomedPaneId ? null : ws.activePaneId))
      }
      if (command === 'closePane' && ws.activePaneId) {
        return take(() => s.closePane(ws.id, ws.activePaneId as string))
      }
      const pane = /^pane([1-9])$/.exec(command)
      if (pane) {
        const index = Number(pane[1]) - 1
        if (ws.panes[index]) return take(() => s.focusPane(ws.id, ws.panes[index].id))
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Panels changing width means every terminal needs to re-measure.
  useEffect(() => {
    const id = window.setTimeout(() => terminals.fitAll(), 220)
    return () => window.clearTimeout(id)
  }, [railOpen, dockOpen, workspace?.id, wizard])

  // Dismissing a dialog should hand the keyboard back to the terminal.
  const anyOverlay = paletteOpen || settingsOpen || resumeOpen || presetEditorId !== null
  const hadOverlay = useRef(false)
  useEffect(() => {
    if (hadOverlay.current && !anyOverlay && workspace?.activePaneId) {
      terminals.focus(workspace.activePaneId)
    }
    hadOverlay.current = anyOverlay
  }, [anyOverlay, workspace?.activePaneId])

  if (!ready) {
    return (
      <div className="app">
        <div className="empty" style={{ height: '100%' }}>
          <span className="eyebrow">Starting Eaon</span>
        </div>
      </div>
    )
  }

  const stage = (): React.JSX.Element => {
    // Settings is a place you go, not a dialog you dismiss. It takes the stage
    // and holds it until you close it, with the workspace rail still alongside.
    if (settingsOpen) return <SettingsModal />
    if (wizard) return <SetupWizard />
    // A rail destination outranks the workspace: you asked to look at
    // something, and the workspace is still there when you come back.
    if (stagePage)
      return (
        /*
         * Keyed by the page, so navigating elsewhere remounts the boundary and
         * clears a failure rather than carrying it to the next page.
         */
        <ErrorBoundary key={stagePage} scope={PAGE_LABEL[stagePage] ?? 'This page'}>
          <StagePageView page={stagePage} cwd={workspace?.cwd ?? home} />
        </ErrorBoundary>
      )
    if (!workspace) return <Launcher />
    // What the stage shows is a property of the workspace you are in, not a
    // separate mode laid over it. That is what lets the Board be somewhere you
    // switch to and back from without disturbing a single running shell.
    // A browser workspace draws nothing here — it lives in the persistent
    // layer below, mounted whether or not it is the tab in front.
    if (workspace.kind === 'browser') return <></>
    if (workspace.kind === 'board') return <Board />
    if (workspace.kind === 'vault') return <Vault />
    if (workspace.kind === 'brain') return <Brain />
    if (workspace.kind === 'stats') return <Stats />
    return <TerminalGrid workspace={workspace} />
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        {railOpen && <WorkspaceRail />}
        {/*
          The tab strip belongs to the stage, not the window: it scrolls with
          the workspace you are in and stays clear of the rail and the dock.
        */}
        <div className="stage-wrap">
          {!settingsOpen && !wizard && <WorkspaceTabs />}
          <main className="stage">
            {stage()}
            {/*
              Every browser tab stays mounted and is hidden when another tab is
              in front. A <webview> reloads its page from scratch when it
              re-attaches, so unmounting on every tab switch would cost you the
              scroll position, the half-filled form, and whatever route a
              single-page app was on. This is the same trade the side dock used
              to make for the one browser it held.
            */}
            {browsers.map((w) => (
              <div
                key={w.id}
                className="stage-slot"
                hidden={settingsOpen || Boolean(wizard) || Boolean(stagePage) || w.id !== workspace?.id}
              >
                <BrowserPanel
                  visible={
                    !settingsOpen && !wizard && !stagePage && w.id === workspace?.id
                  }
                />
              </div>
            ))}
          </main>
        </div>
        {dockOpen && <SideDock workspace={workspace} />}
      </div>

      <UpdateCard />
      <DictationHUD />
      <CommandPalette />
      <ResumeDialog />
      <PresetEditor />
    </div>
  )
}
