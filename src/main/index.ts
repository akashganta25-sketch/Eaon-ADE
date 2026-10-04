import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme, screen } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PtyManager } from './pty-manager'
import { Store } from './store'
import * as fsapi from './fsapi'
import { collectTokenUsage } from './token-usage'
import { memoryHeadroom } from './memory'
import type { UsageRange } from '../shared/token-usage'
import * as git from './git'
import { launchCommand, listResumable, sessionCountFor, setCodexHome } from './sessions'
import { PaneSessions } from './pane-sessions'
import { Accounts, CODEX_SPEC } from './accounts'
import { AccountLogin } from './account-login'
import { SessionWatch } from './session-watch'
import { collectStats } from './stats'
import { anthropicUsage, localUsage, resetUsageCache, setUsagePaths } from './usage'
import { codexUsage, setCodexUsageHome } from './codex-usage'
import * as browser from './browser'
import * as models from './stt/models'
import * as speech from './speech'
import { SttHost } from './stt/host'
import { Updater } from './updater'
import { detectProviders, loadCredentials, refreshProviders, sessionEnv } from './integrations'
import * as worktrees from './worktrees'
import * as sshConfig from './ssh'
import * as tasks from './tasks'
import { BrainStore } from './brain/store'
import type { BrainScope } from '../shared/brain'
import { isProvisioned, provisionWorkspace } from './brain/register'
import { getTheme } from '../shared/themes'
import { STT_MODELS } from '../shared/stt'
import { AGENTS, type PersistedState, type SpawnRequest } from '../shared/types'
import type { SshHost } from '../shared/ssh'
import { loginShell } from './login-shell'

const run = promisify(execFile)

let mainWindow: BrowserWindow | null = null
let store: Store
/** What each pane was last seen running, so it can be reopened. */
let paneSessions: PaneSessions
let sessionWatch: SessionWatch
/** Signed-in Claude accounts, and which one new shells are given. */
let accounts: Accounts
/** Codex accounts, same mechanism, separate books. */
let codexAccounts: Accounts
/** At most one sign-in at a time; a second would race for the same directory. */
let login: { id: string; flow: AccountLogin } | null = null
const ptys = new PtyManager()
const stt = new SttHost()
const updater = new Updater()
/**
 * The brain for one folder.
 *
 * Built per call rather than held as one shared store. `BrainStore` is
 * stateless past its root and only touches disk when asked, so this costs
 * nothing — and it makes it impossible for a read or a write to land in a
 * folder other than the one the caller named.
 *
 * A remote folder gets no store at all. Its path belongs to another machine,
 * and pointing the local store at that string would read, and on write create,
 * a same-named folder on this one — quietly showing a local project's memory
 * under a remote workspace, or inventing `/home/dev/app/.eaonbrain` on a Mac.
 * Agents on remote panes are not provisioned either (see the `pty:spawn`
 * handler), so this keeps both halves telling the same story.
 */
function brainFor(scope: BrainScope | null | undefined): BrainStore {
  if (!scope || scope.host) return new BrainStore(null)
  return new BrainStore(scope.cwd)
}

// Set before the app is ready so the user-data folder is ours alone and never
// collides with another project that happens to share the package name.
//
// The unpackaged build takes a different name, and so a different folder. Both
// builds otherwise land on the same state.json — which holds your workspaces,
// panes and settings — and the last one to write it wins. That is how a
// development instance run alongside the installed app silently ate the user's
// open workspaces. Neither --user-data-dir nor a redirected HOME prevents it:
// this path is set explicitly, and macOS resolves appData through the OS.
/**
 * Leaves a line on disk when the window dies.
 *
 * A renderer crash is invisible after the fact: the reload repaints everything
 * and console output from a packaged app goes nowhere anybody will look. With
 * no record, "it keeps crashing" cannot be turned into a cause. One file,
 * appended to, capped so it cannot grow without bound.
 */
function recordCrash(message: string): void {
  const line = `${new Date().toISOString()}  ${message}\n`
  console.error(`[eaon] ${message}`)
  try {
    const dir = app.getPath('userData')
    const file = path.join(dir, 'crashes.log')
    try {
      // Keep the file to the last stretch of history rather than for ever.
      if (fs.statSync(file).size > 256 * 1024) fs.rmSync(file, { force: true })
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, line)
  } catch {
    /* logging must never be the thing that breaks */
  }
}

const APP_NAME = app.isPackaged ? 'Eaon ADE' : 'Eaon ADE (dev)'
app.setName(APP_NAME)
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME))

// Each terminal draws on its own GPU context. The browser default caps live
// contexts at 16 and silently drops the oldest past that, which would blank a
// pane in a twelve-up grid.
app.commandLine.appendSwitch('max-active-webgl-contexts', '32')

/**
 * Chords the preview panel owns, by the key that produces them.
 *
 * Only these are taken from a page. Everything else a web app binds to the
 * Command key — and editors on the web bind a great many — is left alone.
 */
const BROWSER_CHORDS: Record<string, string> = {
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
  '0': 'zoom-reset'
}

function createWindow(): BrowserWindow {
  // Paint the window in the saved theme's backdrop so a cold start does not
  // flash the wrong colour before the renderer boots.
  const theme = getTheme(store?.load().settings.themeId)

  /*
   * A window that fits the screen it opens on.
   *
   * These numbers are sizes in device-independent pixels, which is not the same
   * as the pixels a display advertises. A 1920x1080 laptop at the 150% scaling
   * Windows picks by default has a work area of 1280x720 in these units, so a
   * fixed 1560x980 window is larger than the whole screen — the app opens with
   * its edges past the desktop and parts of it cannot be reached. The same is
   * true of any 1366x768 machine at 100%.
   *
   * So the preferred size is a ceiling rather than a promise, and the floor has
   * to bend too: a minimum of 900x620 on a screen smaller than that would stop
   * the window ever being sized down to fit.
   */
  const MAC = process.platform === 'darwin'
  // Enough of a margin that it reads as a window rather than a takeover.
  const MARGIN = 80
  const { workAreaSize } = screen.getPrimaryDisplay()

  // Left as it was on macOS, where nobody has reported it opening off-screen.
  const minWidth = MAC ? 900 : Math.min(900, workAreaSize.width)
  const minHeight = MAC ? 620 : Math.min(620, workAreaSize.height)
  const width = MAC ? 1560 : Math.max(minWidth, Math.min(1560, workAreaSize.width - MARGIN))
  const height = MAC ? 980 : Math.max(minHeight, Math.min(980, workAreaSize.height - MARGIN))

  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    backgroundColor: theme.tokens.ink000,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : { color: theme.tokens.ink100, symbolColor: theme.tokens.textMid, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The preview panel embeds a <webview>. It is the only element that
      // renders somebody else's page, and it is locked down below.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  /*
   * Everything the preview panel loads is untrusted by definition — it is the
   * open web, plus whatever a dev server happens to be serving. The guest is
   * stripped back to an ordinary sandboxed page before it is allowed to attach:
   * no Node, no preload of ours, no reaching back into the app.
   */
  win.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    params.allowpopups = 'false'
  })

  win.webContents.on('did-attach-webview', (_e, guest) => {
    /*
     * A link asking for a new window gets this one.
     *
     * Sending them to the user's real browser used to be the only sensible
     * answer, because the panel had no address bar and no history — a page
     * opened there would have been a dead end. It has both now, so opening in
     * place is both what a browser does and what keeps you inside the preview
     * you were testing.
     */
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void guest.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })

    /*
     * Browser shortcuts pressed while the page has focus.
     *
     * Keystrokes inside a <webview> are delivered to the guest's own process
     * and never reach our renderer, so ⌘L would open the address bar right up
     * until you clicked the page and then silently stop. Catching them here,
     * before the guest sees them, is the only place that works.
     */
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (!mod || input.alt) return

      const key = input.key.toLowerCase()
      const chord = BROWSER_CHORDS[key]
      if (!chord) return

      event.preventDefault()
      const wc = win.webContents
      if (!wc.isDestroyed()) wc.send('browser:key', input.shift ? `${chord}+shift` : chord)
    })
  })

  // Dictation needs the microphone. Everything else a web page might ask for is
  // refused — this app has no use for location, sensors or notifications.
  const ALLOWED = new Set(['media', 'fullscreen', 'clipboard-sanitized-write'])
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission))
  })
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))

  // Tear the shells down before the renderer goes away, so no PTY read lands
  // on a destroyed webContents. The watch stops first: an agent going away is
  // otherwise read as one you closed, and every agent goes away here at once.
  win.on('close', () => {
    sessionWatch?.stop()
    ptys.killAll()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  /*
   * A renderer that dies takes the entire UI with it and leaves the window
   * painted in the theme's backdrop — a black rectangle over the whole app,
   * with no way back short of quitting. Electron does nothing about this on its
   * own, so bring the window back rather than leaving somebody staring at it.
   *
   * The shells go first: their panes no longer exist as far as the new renderer
   * is concerned, and it will ask for fresh ones by the same pane ids.
   */
  let recoveries = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    recordCrash(`renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || win.isDestroyed()) return

    recoveries += 1
    if (recoveries > 3) {
      dialog.showErrorBox(
        'Eaon ADE stopped responding',
        'The window crashed repeatedly and could not be recovered. Quit and open it again.'
      )
      return
    }

    /*
     * The shells stay.
     *
     * This used to kill every one of them before reloading, which turned one
     * renderer crash — something the person watching did nothing to cause —
     * into every agent in every workspace dying at once, mid-task. The shells
     * live in this process and are unaffected by the window going away; the
     * only real problem was PTY output arriving at a destroyed webContents,
     * and muting solves that without throwing the work away.
     *
     * On reload the renderer asks for a shell per pane by the same pane ids,
     * and PtyManager.spawn hands back the running one instead of replacing it.
     */
    ptys.mute()
    setTimeout(() => {
      if (win.isDestroyed()) return
      ptys.unmute()
      win.reload()
    }, 300 * recoveries)
  })

  // Long enough to be reported, but a busy repaint across a dozen panes can
  // look like this too, so it is worth a line in the log and nothing more.
  win.webContents.on('unresponsive', () => console.error('[eaon] renderer unresponsive'))
  win.webContents.on('responsive', () => console.error('[eaon] renderer responsive again'))

  ptys.unmute()
  // Idempotent, and here for a window being opened a second time.
  sessionWatch?.start()

  // Anything that wants a new window opens in the user's browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const notifyFullscreen = () => win.webContents.send('win:fullscreen', win.isFullScreen())
  win.on('enter-full-screen', notifyFullscreen)
  win.on('leave-full-screen', notifyFullscreen)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

/** Resolve a binary through a login shell so PATH matches the user's terminal. */
async function which(bin: string): Promise<string | null> {
  if (!bin) return null
  const shell = loginShell()
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('where', [bin])
      return stdout.split('\n')[0].trim() || null
    }
    const { stdout } = await run(shell, ['-lic', `command -v ${bin}`], { timeout: 6000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function registerIpc(): void {
  // ---- terminals -------------------------------------------------------
  ipcMain.handle('pty:spawn', async (_e, req: SpawnRequest) => {
    /*
     * Ask whether there is room before starting another agent.
     *
     * Without this, opening one more tab on a loaded machine does not fail —
     * it succeeds, and the kernel takes the memory back from a *different*
     * agent that was part way through something. Measured on this machine
     * while it was happening: 59 agent processes holding 6.5 GB, 125 MB of RAM
     * free, swap at 10.9 of 12 GB. Nothing in the app killed those sessions
     * and nothing in the app could have noticed, because the app never asked.
     *
     * Refusing is reversible. Losing a running agent is not.
     */
    const room = await memoryHeadroom()
    if (room.pressure === 'critical') {
      return {
        ok: false,
        error:
          `Not enough memory to start another agent — ${room.note} ` +
          'Close a workspace you are done with, or quit something else, and try again.'
      }
    }

    // Wire the memory into this folder before the shell exists, not when the
    // Brain panel happens to be opened. An agent reads `.mcp.json` and
    // `.claude/skills/` once at startup, so anything written afterwards is
    // invisible until it is restarted — and "the brain is there, but only if
    // you visited the right tab first" is not a thing anyone can rely on.
    //
    // Skipped for a remote pane: req.cwd is a path on the far end, not on
    // this machine, and treating it as local here would write — or worse,
    // overwrite something at a coincidentally-matching path — on the wrong
    // computer. Provisioning a remote box's own Brain access is real future
    // work, not something this silently half-does today.
    if (!req.host) provisionWorkspace(req.cwd)
    // The session flags are decided here, where the transcripts are, rather
    // than in the renderer where they would only be a guess — and where what
    // the pane was last seen running is known, which the renderer never learns.
    return ptys.spawn({
      ...req,
      command: launchCommand({
        ...req,
        observed: paneSessions?.get(req.paneId),
        // Read at spawn time rather than carried on the pane, so turning the
        // setting off takes effect on the next launch instead of only on panes
        // created afterwards.
        bypass: store?.load().settings.bypassPermissions ?? false
      })
    })
  })
  ipcMain.on('pty:write', (_e, paneId: string, data: string) => ptys.write(paneId, data))
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) =>
    ptys.resize(paneId, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, paneId: string) => ptys.kill(paneId))
  ipcMain.handle('pty:alive', (_e, paneId: string) => ptys.has(paneId))

  // ---- Claude accounts -------------------------------------------------
  ipcMain.handle('accounts:list', () => accounts.list())

  ipcMain.handle('accounts:setActive', (_e, id: string) => {
    const next = accounts.setActive(id)
    // The readout is built from a cache keyed by file, and the files it was
    // reading belong to the account we just left.
    resetUsageCache()
    return next
  })

  ipcMain.handle('accounts:remove', (_e, id: string) => {
    const next = accounts.remove(id)
    resetUsageCache()
    return next
  })

  // ---- Codex accounts --------------------------------------------------
  // The same three doors, against the other vendor's books. Signing in is not
  // among them: Codex's own `codex login` writes into whatever CODEX_HOME
  // points at, so a pane opened on a reserved directory is the sign-in — there
  // is no browser flow for this app to drive the way there is for Claude.
  ipcMain.handle('codexAccounts:list', () => codexAccounts.list())
  ipcMain.handle('codexAccounts:setActive', (_e, id: string) => codexAccounts.setActive(id))
  ipcMain.handle('codexAccounts:remove', (_e, id: string) => codexAccounts.remove(id))
  /**
   * Makes an empty Codex home and hands back where it is, so the caller can
   * open a pane in it and run `codex login` there.
   */
  ipcMain.handle('codexAccounts:reserve', () => codexAccounts.reserve())
  ipcMain.handle('codexAccounts:commit', (_e, id: string) => codexAccounts.commit(id))

  /**
   * Starts a sign-in against a directory of its own.
   *
   * Nothing is added to the list here. A directory only becomes an account once
   * credentials actually appear in it, so an abandoned sign-in leaves an offer
   * you could switch to but never use.
   */
  ipcMain.handle('accounts:beginLogin', () => {
    login?.flow.cancel()
    const { id, configDir } = accounts.reserve()
    // Whose account `~/.claude` is, before anything signs in anywhere.
    const before = accounts.defaultIdentity()
    const flow = new AccountLogin(configDir, (ok) => {
      if (ok) accounts.commit(id)
      else accounts.discard(id)
      const wc = mainWindow?.webContents
      if (!wc || wc.isDestroyed()) return
      wc.send('accounts:changed', accounts.list())

      // A sign-in that changed who the original account belongs to went to the
      // one account this feature exists to leave alone.
      const after = accounts.defaultIdentity()
      if (before && after && before !== after) {
        wc.send('accounts:login', {
          phase: 'error',
          url: null,
          output: null,
          error:
            'That sign-in replaced the account already on this machine instead of adding one. ' +
            'Open Claude Code and sign back in to recover it.'
        })
      }
    })
    flow.onState((state) => {
      const wc = mainWindow?.webContents
      if (wc && !wc.isDestroyed()) wc.send('accounts:login', state)
    })
    login = { id, flow }
    flow.start()
    return flow.current()
  })

  ipcMain.on('accounts:submitCode', (_e, code: string) => login?.flow.submitCode(code))
  ipcMain.on('accounts:cancelLogin', () => {
    login?.flow.cancel()
    login = null
  })

  // ---- persisted state -------------------------------------------------
  ipcMain.handle('state:load', () => store.load())
  ipcMain.on('state:save', (_e, next: PersistedState) => store.save(next))
  ipcMain.handle('state:reset', () => store.reset())
  ipcMain.handle('state:path', () => store.path)

  // ---- filesystem ------------------------------------------------------
  ipcMain.handle('fs:list', (_e, dir: string) => fsapi.listDir(dir))
  ipcMain.handle('fs:read', (_e, file: string) => fsapi.readFile(file))
  ipcMain.handle('fs:readBinary', (_e, file: string) => fsapi.readBinary(file))
  ipcMain.handle('fs:mime', (_e, file: string) => fsapi.mimeFor(file))
  ipcMain.handle('fs:write', (_e, file: string, text: string) => fsapi.writeFile(file, text))
  ipcMain.handle('fs:search', (_e, root: string, q: string) => fsapi.searchFiles(root, q))
  ipcMain.handle('fs:grep', (_e, root: string, q: string) => fsapi.grepFiles(root, q, which))
  ipcMain.handle('usage:tokens', (_e, range: UsageRange) => collectTokenUsage(range))
  ipcMain.handle('sys:memory', () => memoryHeadroom())
  ipcMain.handle('fs:isDir', (_e, target: string) => fsapi.isDirectory(target))
  ipcMain.handle('fs:saveDropped', (_e, name: string, bytes: Uint8Array) =>
    fsapi.saveDropped(name, bytes)
  )

  ipcMain.handle('dialog:pickFolder', async (_e, startIn?: string) => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: startIn || os.homedir(),
      buttonLabel: 'Use this folder'
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- git ---------------------------------------------------------------
  // Every handler takes an optional trailing host: present, it runs over ssh
  // against a remote workspace; absent, this is the exact local call it
  // always was.
  ipcMain.handle('git:status', (_e, cwd: string, host?: SshHost | null) =>
    git.status(cwd, host)
  )
  ipcMain.handle('git:branch', (_e, cwd: string, host?: SshHost | null) =>
    git.branchOf(cwd, host)
  )
  ipcMain.handle('git:branches', (_e, cwd: string, host?: SshHost | null) =>
    git.branches(cwd, host)
  )
  ipcMain.handle('git:switch', (_e, cwd: string, branch: string, host?: SshHost | null) =>
    git.switchTo(cwd, branch, host)
  )
  ipcMain.handle(
    'git:diff',
    (_e, cwd: string, file: string, staged: boolean, host?: SshHost | null) =>
      git.diff(cwd, file, staged, host)
  )
  ipcMain.handle('git:stage', (_e, cwd: string, file: string, host?: SshHost | null) =>
    git.stage(cwd, file, host)
  )
  ipcMain.handle('git:unstage', (_e, cwd: string, file: string, host?: SshHost | null) =>
    git.unstage(cwd, file, host)
  )
  ipcMain.handle('git:stageAll', (_e, cwd: string, host?: SshHost | null) =>
    git.stageAll(cwd, host)
  )
  ipcMain.handle('git:commit', (_e, cwd: string, msg: string, host?: SshHost | null) =>
    git.commit(cwd, msg, host)
  )
  ipcMain.handle('git:log', (_e, cwd: string, host?: SshHost | null) => git.log(cwd, 20, host))

  // ---- work items ----------------------------------------------------------
  // Pull requests, issues and Linear tickets. The Linear API key is used to
  // set a header inside `tasks.ts` and is never part of anything these
  // handlers return — `scripts/check-tasks.mjs` greps the replies for a
  // canary value rather than trusting that to stay true by itself.
  ipcMain.handle('tasks:list', (_e, cwd: string) => tasks.allItems(cwd))
  ipcMain.handle('tasks:approvePr', (_e, cwd: string, number: number, body?: string) =>
    tasks.approvePr(cwd, number, body)
  )
  ipcMain.handle('tasks:linearTeams', () => tasks.linearTeams())
  ipcMain.handle(
    'tasks:createLinearIssue',
    (_e, input: { teamId: string; title: string; description?: string }) =>
      tasks.createLinearIssue(input)
  )
  ipcMain.handle('tasks:pullRequests', (_e, cwd: string, state: 'open' | 'merged' | 'all') =>
    tasks.pullRequests(cwd, state)
  )
  ipcMain.handle('tasks:prDetail', (_e, cwd: string, number: number) => tasks.prDetail(cwd, number))
  ipcMain.handle('tasks:prDiff', (_e, cwd: string, number: number) => tasks.prDiff(cwd, number))
  ipcMain.handle(
    'tasks:reviewPr',
    (_e, cwd: string, number: number, event: 'approve' | 'comment' | 'request-changes', body?: string) =>
      tasks.reviewPr(cwd, number, event, body)
  )

  // ---- ssh -----------------------------------------------------------------
  // Read-only: the picker's data source. Nothing here is a saved credential —
  // a chosen host is embedded directly in the workspace that uses it (see
  // Workspace.host), so there is no separate registry to keep in sync here.
  ipcMain.handle('ssh:listConfigHosts', () => sshConfig.parseSshConfig())

  // ---- agents & sessions ----------------------------------------------
  ipcMain.handle('agents:detect', async () => {
    const results = await Promise.all(
      AGENTS.map(async (a) => ({
        ...a,
        available: a.bin ? Boolean(await which(a.bin)) : true
      }))
    )
    return results
  })
  ipcMain.handle('agents:detectRemote', async (_e, host: SshHost) => {
    const results = await Promise.all(
      AGENTS.map(async (a) => ({
        ...a,
        available: a.bin ? await sshConfig.remoteWhich(host, a.bin) : true
      }))
    )
    return results
  })
  // ---- integrations ----------------------------------------------------
  // Both doors answer in provider names, statuses and variable names. A token
  // value has no route to the renderer, by construction rather than by care.
  ipcMain.handle('integrations:list', () => detectProviders(which))
  ipcMain.handle('integrations:refresh', () => refreshProviders(which))

  // ---- worktrees -------------------------------------------------------
  // Isolated checkouts, one per task, local or on a remote box. Everything is
  // addressed by absolute path, and the base commit travels with the request
  // so a branch moving underneath a running trial cannot change what each
  // agent appears to have changed. Each handler's trailing host follows the
  // same rule as git's: present, this runs over ssh; absent, it is exactly
  // the local call it always was.
  ipcMain.handle('worktrees:root', (_e, cwd: string, host?: SshHost | null) =>
    worktrees.repoRoot(cwd, host)
  )
  ipcMain.handle('worktrees:list', (_e, cwd: string, host?: SshHost | null) =>
    worktrees.list(cwd, host)
  )
  ipcMain.handle(
    'worktrees:create',
    (_e, req: worktrees.CreateRequest, host?: SshHost | null) => worktrees.create(req, host)
  )
  ipcMain.handle(
    'worktrees:change',
    (_e, dir: string, baseSha: string, host?: SshHost | null) =>
      worktrees.change(dir, baseSha, host)
  )
  ipcMain.handle(
    'worktrees:diff',
    (_e, dir: string, baseSha: string, host?: SshHost | null) => worktrees.diff(dir, baseSha, host)
  )
  ipcMain.handle(
    'worktrees:commitAll',
    (_e, dir: string, message: string, host?: SshHost | null) =>
      worktrees.commitAll(dir, message, host)
  )
  ipcMain.handle(
    'worktrees:merge',
    (_e, cwd: string, branch: string, host?: SshHost | null) => worktrees.merge(cwd, branch, host)
  )
  ipcMain.handle(
    'worktrees:remove',
    (
      _e,
      cwd: string,
      dir: string,
      opts: { force?: boolean; deleteBranch?: boolean },
      host?: SshHost | null
    ) => worktrees.remove(cwd, dir, opts, host)
  )
  ipcMain.handle('worktrees:prune', (_e, cwd: string, host?: SshHost | null) =>
    worktrees.prune(cwd, host)
  )

  ipcMain.handle('sessions:resumable', () => listResumable())
  ipcMain.handle('sessions:countFor', (_e, cwd: string) => sessionCountFor(cwd))

  // Stats: null counts every folder you have worked in.
  ipcMain.handle('stats:get', (_e, folder: string | null) => collectStats(folder))

  // ---- plan usage ------------------------------------------------------
  ipcMain.handle(
    'usage:read',
    (_e, opts: { fromAnthropic?: boolean; session?: number; week?: number }) => {
      const limits = {
        ...(opts?.session ? { session: opts.session } : {}),
        ...(opts?.week ? { week: opts.week } : {})
      }
      return opts?.fromAnthropic ? anthropicUsage() : localUsage(limits)
    }
  )
  ipcMain.on('usage:forget', () => resetUsageCache())
  /**
   * The same readout for Codex, measured from its own rollouts.
   *
   * Separate from `usage:read` rather than a flag on it: the two read
   * different files in different formats, and only one of them has an
   * "ask the vendor directly" mode.
   */
  ipcMain.handle('usage:codex', (_e, opts: { session?: number; week?: number }) =>
    codexUsage({
      ...(opts?.session ? { session: opts.session } : {}),
      ...(opts?.week ? { week: opts.week } : {})
    })
  )

  // ---- preview browser -------------------------------------------------
  ipcMain.handle('browser:devPorts', () => browser.devPorts())
  ipcMain.handle('browser:capture', (_e, webContentsId: number) =>
    browser.captureWebview(webContentsId, mainWindow)
  )

  // ---- voice dictation -------------------------------------------------
  ipcMain.handle('stt:catalog', () => STT_MODELS)
  ipcMain.handle('stt:installed', () => models.listInstalled())
  ipcMain.handle('stt:usage', () => models.usage())
  ipcMain.handle('stt:dir', () => models.modelsDir())
  ipcMain.handle('stt:state', () => stt.current())

  ipcMain.handle('stt:download', async (_e, modelId: string) => {
    try {
      await models.download(modelId, (p) => {
        const wc = mainWindow?.webContents
        if (wc && !wc.isDestroyed()) wc.send('stt:progress', p)
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.on('stt:cancel', (_e, modelId: string) => models.cancel(modelId))
  ipcMain.handle('stt:remove', (_e, modelId: string) => {
    // Unloading first means the files are not still open when they are deleted.
    stt.stop()
    models.remove(modelId)
    return models.listInstalled()
  })

  ipcMain.handle('stt:load', async (_e, modelId: string) => {
    try {
      await stt.load(modelId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle(
    'stt:transcribe',
    async (_e, modelId: string, audio: Float32Array, language: string) => {
      try {
        const text = await stt.transcribe(modelId, audio, language)
        return { ok: true, text }
      } catch (err) {
        return { ok: false, error: String(err instanceof Error ? err.message : err) }
      }
    }
  )
  ipcMain.on('stt:stop', () => stt.stop())

  // ---- spoken alerts ---------------------------------------------------
  ipcMain.handle('speech:support', () => speech.support())
  ipcMain.handle('speech:voices', () => speech.voices())
  ipcMain.handle('speech:refresh', () => {
    // Called when the settings panel is reopened, so a voice downloaded from
    // System Settings a moment ago turns up without restarting the app.
    speech.refreshVoices()
    return speech.voices()
  })
  ipcMain.on(
    'speech:speak',
    (_e, text: string, opts: { voice?: string; rate?: number; volume?: number }) => {
      speech.speak(text, opts ?? {})
    }
  )
  ipcMain.on('speech:stop', () => speech.stop())
  ipcMain.on('speech:openVoiceSettings', () => speech.openVoiceSettings())

  // ---- project memory --------------------------------------------------
  ipcMain.handle('brain:open', (_e, scope: BrainScope) => {
    // Provisioning writes `.mcp.json` and `.claude/skills/` with the local fs,
    // so it is skipped for a remote folder for the same reason pty:spawn skips
    // it — there is nothing here to write to.
    const local = scope?.cwd && !scope.host ? scope.cwd : null
    // Spawning a pane provisions the workspace too; doing it here as well
    // covers the case where the panel is opened before any agent has run, so
    // the badge tells the truth rather than "not connected yet, ask again".
    const registration = local ? provisionWorkspace(local) : null
    return {
      stats: brainFor(scope).stats(),
      registered: local ? isProvisioned(local) : false,
      registration,
      remote: Boolean(scope?.host)
    }
  })
  ipcMain.handle('brain:list', (_e, scope: BrainScope) => brainFor(scope).list())
  ipcMain.handle('brain:get', (_e, scope: BrainScope, slug: string) => brainFor(scope).get(slug))
  ipcMain.handle(
    'brain:write',
    (_e, scope: BrainScope, input: { title: string; content: string; tags?: string[]; slug?: string }) =>
      brainFor(scope).write(input)
  )
  ipcMain.handle('brain:remove', (_e, scope: BrainScope, slug: string) =>
    brainFor(scope).remove(slug)
  )
  ipcMain.handle('brain:search', (_e, scope: BrainScope, q: string) => brainFor(scope).search(q))
  ipcMain.handle('brain:related', (_e, scope: BrainScope, slug: string) =>
    brainFor(scope).related(slug)
  )
  ipcMain.handle('brain:graph', (_e, scope: BrainScope) => brainFor(scope).graph())
  ipcMain.handle('brain:stats', (_e, scope: BrainScope) => brainFor(scope).stats())

  // ---- auto update -----------------------------------------------------
  ipcMain.handle('update:state', () => updater.current())
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.on('update:install', () => updater.install())

  // ---- system ----------------------------------------------------------
  ipcMain.handle('sys:home', () => os.homedir())
  ipcMain.handle('sys:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    shell: process.env.SHELL || '',
    home: os.homedir()
  }))
  ipcMain.on('sys:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  ipcMain.on('sys:reveal', (_e, target: string) => shell.showItemInFolder(target))

  // ---- window ----------------------------------------------------------
  ipcMain.on('win:minimize', () => mainWindow?.minimize())
  ipcMain.on('win:toggleMaximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win:close', () => mainWindow?.close())
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'

  // Wear the brand in the Dock during development too, not Electron's default.
  if (process.platform === 'darwin' && app.dock) {
    const icon = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png')
    try {
      app.dock.setIcon(icon)
    } catch {
      /* a missing icon is not worth failing startup over */
    }
  }

  store = new Store()
  accounts = new Accounts()
  codexAccounts = new Accounts(undefined, CODEX_SPEC)
  // Every shell, the usage readout and the resume list all follow the account
  // that is active, so none of them can show another account's work.
  ptys.setConfigDir(() => accounts.activeConfigDir())
  ptys.setCodexHome(() => codexAccounts.activeConfigDir())
  // The resume list has to follow the switch too, not keep offering the
  // previous account's sessions.
  setCodexHome(() => codexAccounts.activeConfigDir())
  setCodexUsageHome(() => codexAccounts.activeConfigDir())
  // Service tokens, read from the login shell once so a pane opened from the
  // Dock can push exactly as one opened from a terminal can.
  ptys.setExtraEnv(() => sessionEnv())
  void loadCredentials()
  // Worktrees live under our own data folder rather than beside the repository,
  // so a trial never shows up as untracked noise in the repo it was cut from.
  worktrees.setBaseDir(path.join(app.getPath('userData'), 'worktrees'))
  setUsagePaths({
    projects: () => accounts.activeProjectsDir(),
    credentials: () => accounts.activeCredentialsFile(),
    // Null config dir means the original account, which is the only one whose
    // credentials Claude Code keeps in the login keychain.
    isDefaultAccount: () => accounts.activeConfigDir() === null
  })
  paneSessions = new PaneSessions()
  // Watches for the agents nobody told the app about — the ones you start by
  // typing `claude` into a shell — so those panes come back too.
  sessionWatch = new SessionWatch(() => ptys.pids(), paneSessions, (paneId, agentId) => {
    // Close Codex, type `opencode`, and the pane's mark and name follow what
    // is actually running rather than what it was opened as.
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send('pane:agent', { paneId, agentId })
  })
  sessionWatch.start()
  // Before anything asks which models are installed.
  models.migrateFromPreviousName()

  // Resolved at send time, so a recreated window never leaves the PTY layer
  // holding a stale reference.
  ptys.setSender((channel, payload) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  })

  stt.onState((state) => {
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send('stt:state', state)
  })

  updater.setSender((channel, payload) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  })

  registerIpc()
  mainWindow = createWindow()
  updater.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The GPU process taking every WebGL context down with it is survivable — each
// terminal falls back to its DOM renderer — but it is worth knowing about when
// somebody reports that panes went slow.
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit') return
  console.error(`[eaon] ${details.type} process gone: ${details.reason}`)
})

let quitting = false

/**
 * Stops everything the app owns, then leaves without unwinding Node.
 *
 * The order matters. `ptys.shutdown()` waits for every shell to be reaped
 * while the JavaScript environment is still intact, because node-pty reports
 * exits through a thread-safe function and one arriving mid-teardown aborts
 * the process outright — the SIGABRT this app used to die with. Once they are
 * gone there is nothing left worth unwinding, so exit rather than hand control
 * back and give a straggler another chance to land at the wrong moment.
 */
async function shutdownAndExit(): Promise<void> {
  if (quitting) return
  quitting = true

  // Nothing below may hang the quit. If it does, leave anyway.
  const failsafe = setTimeout(() => app.exit(0), 5000)
  failsafe.unref()

  try {
    updater.dispose()
  } catch {
    /* nothing here is worth blocking a quit */
  }
  try {
    stt.stop()
  } catch {
    /* nothing here is worth blocking a quit */
  }
  try {
    // Nobody wants the app to carry on talking after they have closed it.
    speech.stop()
  } catch {
    /* nothing here is worth blocking a quit */
  }
  try {
    store?.flush()
  } catch {
    /* nothing here is worth blocking a quit */
  }
  try {
    /*
     * Before the shells are reaped, and in this order.
     *
     * The watch reads a missing agent as one you closed and forgets its
     * conversation. Every agent is about to disappear at once, so leaving it
     * running through the shutdown would erase precisely the record the next
     * launch is meant to read — the sessions would be forgotten by the act of
     * quitting, which is the one moment they have to survive.
     */
    sessionWatch?.stop()
    paneSessions?.flush()
    login?.flow.stop()
  } catch {
    /* nothing here is worth blocking a quit */
  }
  try {
    await ptys.shutdown()
  } catch {
    /* nothing here is worth blocking a quit */
  }

  clearTimeout(failsafe)
  app.exit(0)
}

app.on('before-quit', (e) => {
  if (quitting) return
  // Held open only long enough to reap the shells; `shutdownAndExit` bounds
  // itself and then exits on its own.
  e.preventDefault()
  void shutdownAndExit()
})

// Shut down the same way when something outside the app asks us to stop, so
// the PTY threads are gone before the process starts tearing itself down.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdownAndExit())
}

// A stray rejection in a filesystem or git call must never surface as a crash
// dialog while a dozen agents are mid-run.
process.on('unhandledRejection', (reason) => {
  console.error('[eaon] unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[eaon] uncaught exception:', err)
})
