import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import * as pty from 'node-pty'
import type { SpawnRequest } from '../shared/types'
import { remoteShellCommand, sshArgv } from './ssh'
import { isProvisioned } from './brain/register'
import { loginShell, loginShellArgs } from './login-shell'

/**
 * Variables that describe whatever launched Eaon rather than the terminal we
 * are about to open. A shell started from Finder never sees these, so neither
 * should ours — otherwise a CLI agent run inside Eaon inherits the session
 * markers of the process that started the app and quietly degrades itself.
 *
 * The login shell re-sources the user's profile, so anything they genuinely
 * set for themselves comes straight back.
 */
const DROP_PREFIXES = [
  'npm_', // npm/npx lifecycle vars — npm_config_prefix breaks nvm
  'ELECTRON_',
  'VITE_',
  'CLAUDE_CODE_',
  'VSCODE_',
  'CURSOR_'
]

const DROP_EXACT = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'INIT_CWD',
  'NODE_ENV',
  'NODE_OPTIONS',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'COLORFGBG',
  'CHROME_DESKTOP',
  'ORIGINAL_XDG_CURRENT_DESKTOP'
])

interface Session {
  proc: pty.IPty
  buffer: string[]
  /** Bytes currently sitting in `buffer`, tracked so a flood can be capped. */
  buffered: number
  timer: NodeJS.Timeout | null
  alive: boolean
  /** Command waiting for the shell to finish printing its prompt. */
  pendingCommand: string | null
  commandTimer: NodeJS.Timeout | null
  sawOutput: boolean
  /** Unique per spawn, so a restarted pane never settles the old one's wait. */
  token: number
  pid: number
  /** Whether this shell is `ssh`, not a local process — see spawn(). */
  remote: boolean
  /** What this shell was started for, so a re-spawn can tell "the same pane
   *  coming back" from "a different thing in the same slot". */
  cwd: string
  hostKey: string
}

type Sender = (channel: string, payload: unknown) => void

/**
 * Owns every pseudo-terminal. Output is coalesced on a short timer before it
 * crosses the IPC boundary — with a dozen agents streaming at once, one message
 * per read would flood the renderer.
 *
 * Nothing thrown inside a node-pty callback may escape. node-pty delivers reads
 * on a thread-safe function, and an exception there is converted to a C++ throw
 * with no JS scope to catch it, which aborts the whole process. Every callback
 * body below is wrapped for that reason — a window closing mid-stream must not
 * be able to take the app down.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()
  private readonly flushMs = 12
  /**
   * Most a single shell may queue between flushes. `cat`-ing a large binary
   * produces megabytes faster than the renderer can draw them, and without a
   * ceiling that backlog lives in main-process memory and crosses IPC in full.
   * Past the cap the oldest bytes go — a terminal only ever shows the tail.
   */
  private readonly maxBuffered = 256 * 1024
  private send: Sender = () => {}
  /** Set while there is no window to talk to, so sends are dropped, not thrown. */
  private muted = false
  private nextToken = 1
  /** Resolvers for shells we are waiting to see reaped, keyed by spawn token. */
  private reaping = new Map<number, () => void>()

  /** Called once at startup with a sender that resolves the live window. */
  setSender(sender: Sender): void {
    this.send = sender
    this.muted = false
  }

  /**
   * Re-opens the channel after a window went away.
   *
   * On macOS closing the window does not quit the app, and clicking the Dock
   * icon builds a new one. The sender resolves the live window at send time, so
   * it stays valid across that — only the mute needs lifting.
   */
  unmute(): void {
    this.muted = false
  }

  /**
   * Stops sending to the window without touching the shells.
   *
   * The renderer can go away while every agent under it is fine. Muting is how
   * a PTY read avoids landing on a destroyed webContents; killing the shells
   * was the old way, and it threw the work away to solve a delivery problem.
   */
  mute(): void {
    this.muted = true
  }

  private emit(channel: string, payload: unknown): void {
    if (this.muted) return
    try {
      this.send(channel, payload)
    } catch {
      /* the window went away between the check and the send */
    }
  }

  /** Releases anything waiting on this shell to be reaped. */
  private settle(token: number): void {
    const done = this.reaping.get(token)
    if (!done) return
    this.reaping.delete(token)
    done()
  }

  /**
   * The best shell on this machine, in the order a developer would pick.
   *
   * COMSPEC on Windows is cmd.exe, which is the wrong host for a CLI agent: no
   * readline-style line editing, a different quoting dialect from everything an
   * agent will suggest, and a scrollback that fights the one drawn here. So
   * PowerShell 7 first, then the Windows PowerShell every installation already
   * has, and cmd.exe only if both are somehow missing.
   */
  private defaultShell(): string {
    if (process.platform !== 'win32') return loginShell()

    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    ]
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* unreadable path; try the next */
      }
    }
    return process.env.COMSPEC || 'powershell.exe'
  }

  /** Login shells inherit the user's PATH, which is where `claude` usually lives. */
  private shellArgs(shell: string): string[] {
    if (process.platform === 'win32') {
      // The banner is three lines of version blurb in front of every new pane,
      // and in a twelve-up grid that is most of what you can see.
      return /(pwsh|powershell)\.exe$/i.test(shell) ? ['-NoLogo'] : []
    }
    return loginShellArgs(shell)
  }

  /** The environment a freshly opened terminal window would actually have. */
  private buildEnv(paneId: string, cwd: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (DROP_EXACT.has(key)) continue
      if (DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
      env[key] = value
    }

    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // No space: TERM_PROGRAM is compared verbatim by shells and CLIs.
    env.TERM_PROGRAM = 'EaonADE'
    env.TERM_PROGRAM_VERSION = app.getVersion()
    env.EAON_PANE = paneId

    // Launched from Finder there is no locale, and every box-drawing character
    // in a CLI's UI turns to mojibake without one. Windows has no such variable
    // — the console's encoding is UTF-8 through ConPTY regardless — so setting
    // it there would only mislead anything that reads it.
    if (process.platform !== 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) {
      env.LANG = 'en_US.UTF-8'
    }

    /*
     * Which Claude account this shell belongs to.
     *
     * Set only when an added account is the active one. Leaving it unset is not
     * the same as pointing it at `~/.claude`: unset is what every other terminal
     * on this machine does, and a pane that behaves identically to those is the
     * point of never touching the original account.
     */
    const configDir = this.configDir()
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir

    // The same bargain for Codex, which reads CODEX_HOME. Unset means "use
    // ~/.codex exactly as any other terminal would", which is why the default
    // account contributes nothing here rather than naming its own directory.
    const codexHome = this.codexHome()
    if (codexHome) env.CODEX_HOME = codexHome

    /*
     * Claude Code has its own built-in per-machine memory, and by default a
     * session reaches for it before ever considering a skill — plain `Write`
     * into `~/.claude/projects/<hash>/memory/`, never a tool call the eaon-brain
     * skill could redirect. That defeats the entire point of the shared, in-repo
     * brain: what gets written is private to this machine and this CLI, invisible
     * to Codex or Gemini, invisible in the Brain panel, and never committed.
     *
     * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is Claude Code's own documented escape
     * hatch (see `claude --help`, and what `--bare` turns off). With it set, a
     * session with something to say reaches for the eaon-brain skill instead —
     * confirmed by running real sessions both ways: unset, a session writes
     * straight to its own store and never touches the skill; set, in a
     * provisioned workspace, it searches the brain, then writes there.
     *
     * Scoped to workspaces we provisioned, not set globally: turning off a
     * feature with nothing to redirect to would just be a regression for a pane
     * opened in an unprovisioned folder, or for any other agent, which will
     * ignore an env var it has never heard of either way.
     */
    if (isProvisioned(cwd)) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

    /*
     * Service credentials, so an agent can push or read an issue without being
     * handed a token in the prompt. These come from the login shell rather than
     * from our own environment, so they are added last but never over an
     * existing value — a token exported in the terminal that launched the app
     * is the one the user meant.
     */
    for (const [key, value] of Object.entries(this.extraEnv())) {
      if (!env[key]) env[key] = value
    }

    return env
  }

  /**
   * Where the active account keeps its configuration, asked at spawn time
   * rather than held, so a pane started after a switch gets the new answer.
   */
  private configDir: () => string | null = () => null

  setConfigDir(fn: () => string | null): void {
    this.configDir = fn
  }

  /** The active Codex account's home, asked at spawn time for the same reason. */
  private codexHome: () => string | null = () => null

  setCodexHome(fn: () => string | null): void {
    this.codexHome = fn
  }

  /** Extra environment for new panes, asked at spawn time for the same reason. */
  private extraEnv: () => Record<string, string> = () => ({})

  setExtraEnv(fn: () => Record<string, string>): void {
    this.extraEnv = fn
  }

  spawn(req: SpawnRequest): { ok: boolean; error?: string; reattached?: boolean; token?: number } {
    const remoteHost = req.host ?? null
    const cwd = req.cwd && req.cwd.length ? req.cwd : os.homedir()
    const hostKey = remoteHost ? `${remoteHost.user ?? ''}@${remoteHost.hostname}` : ''

    /*
     * A pane asking for a shell it already has gets the one it has.
     *
     * Shells live here, not in the renderer, so they outlive it — and the
     * renderer goes away more often than anyone would like: a crash, the
     * recovery reload that follows, a hot reload in development. Every one of
     * those used to end with this method killing a perfectly healthy agent
     * mid-task, because the first thing it did was kill whatever was in the
     * slot. That is the "sessions keep exiting on their own" nobody pressed a
     * button for.
     *
     * Only when the request matches. A pane pointed somewhere new, or at a
     * different machine, genuinely wants a different shell, and restart() and
     * stop() kill theirs first so they never reach this.
     */
    const existing = this.sessions.get(req.paneId)
    if (existing?.alive && existing.cwd === cwd && existing.hostKey === hostKey) {
      try {
        existing.proc.resize(Math.max(20, req.cols || 80), Math.max(5, req.rows || 24))
      } catch {
        /* the shell died between the check and the resize; fall through next time */
      }
      return { ok: true, reattached: true, token: existing.token }
    }

    this.kill(req.paneId)

    /*
     * A remote pane's local child process is `ssh` itself, not a shell — the
     * remote directory and the remote login shell are both baked into the
     * single command string ssh is told to run (remoteShellCommand), the
     * exact way a person would type `ssh host` and land there themselves.
     * The local `cwd` node-pty is given is irrelevant to that and is only
     * ever a valid directory for the `ssh` process to have been launched
     * from — the home directory is as good as any other.
     */
    const shell = remoteHost ? 'ssh' : req.shell?.trim() || this.defaultShell()
    const spawnCwd = remoteHost ? os.homedir() : cwd
    const localArgs = remoteHost
      ? [...sshArgv(remoteHost, { interactive: true }), remoteShellCommand(cwd)]
      : this.shellArgs(shell)

    try {
      const proc = pty.spawn(shell, localArgs, {
        name: 'xterm-256color',
        cols: Math.max(20, req.cols || 80),
        rows: Math.max(5, req.rows || 24),
        cwd: spawnCwd,
        env: this.buildEnv(req.paneId, cwd)
      })

      const session: Session = {
        proc,
        buffer: [],
        buffered: 0,
        timer: null,
        alive: true,
        pendingCommand: req.command?.trim() || null,
        commandTimer: null,
        sawOutput: false,
        token: this.nextToken++,
        pid: proc.pid,
        remote: Boolean(remoteHost),
        cwd,
        hostKey
      }
      this.sessions.set(req.paneId, session)

      proc.onData((chunk) => {
        try {
          // Type the launch command once the shell has actually printed a
          // prompt. A dozen shells starting at once makes fixed delays unsafe.
          // A remote session's first byte is usually ssh's own handshake
          // noise or the start of an MOTD banner, not a ready prompt, so it
          // gets a longer wait — the kernel pty on the far end buffers
          // keystrokes typed before the remote shell reads them, same as
          // type-ahead in any terminal, but a banner that pauses for
          // acknowledgement is not worth risking on a tight local timing.
          if (session.pendingCommand && !session.sawOutput) {
            session.sawOutput = true
            this.scheduleCommand(session, session.remote ? 1200 : 400)
          }

          session.buffer.push(chunk)
          session.buffered += chunk.length
          // Under a flood, keep the tail and drop what nobody would have read.
          while (session.buffered > this.maxBuffered && session.buffer.length > 1) {
            session.buffered -= session.buffer.shift()!.length
          }

          if (session.timer) return
          session.timer = setTimeout(() => {
            session.timer = null
            const data = session.buffer.join('')
            session.buffer.length = 0
            session.buffered = 0
            if (data) this.emit('pty:data', { paneId: req.paneId, data })
          }, this.flushMs)
        } catch {
          /* never let this reach node-pty's thread-safe function */
        }
      })

      proc.onExit(({ exitCode, signal }) => {
        try {
          /*
           * Read before the assignment below, because it is the answer to
           * "did anybody ask for this?".
           *
           * kill() clears `alive` synchronously and only then signals, and
           * every teardown in the app goes through it — stopping a pane,
           * closing a workspace, killAll(), shutdown(), and spawn() clearing a
           * slot before it reuses it. So `alive` still being true here means
           * nothing in the app asked: the shell exited on its own, or
           * something outside ended it.
           *
           * Without this the renderer could not tell the two apart, and it
           * showed the same error for a session somebody deliberately stopped
           * as for one the kernel killed — which is a good way to teach people
           * to ignore the message that matters.
           */
          const requested = !session.alive
          session.alive = false
          if (session.timer) {
            clearTimeout(session.timer)
            session.timer = null
          }
          if (session.commandTimer) {
            clearTimeout(session.commandTimer)
            session.commandTimer = null
          }
          const tail = session.buffer.join('')
          session.buffer.length = 0
          session.buffered = 0
          const superseded =
            this.sessions.has(req.paneId) && this.sessions.get(req.paneId)?.token !== session.token
          if (!superseded) {
            if (tail) this.emit('pty:data', { paneId: req.paneId, data: tail })
            this.emit('pty:exit', {
              paneId: req.paneId,
              exitCode,
              signal,
              requested,
              token: session.token
            })
          }
        } catch {
          /* never let this reach node-pty's thread-safe function */
        } finally {
          // Only if this pane has not already been handed a fresh shell.
          if (this.sessions.get(req.paneId)?.token === session.token) {
            this.sessions.delete(req.paneId)
          }
          this.settle(session.token)
        }
      })

      // Fallback for shells that print nothing at all before their prompt.
      if (session.pendingCommand) this.scheduleCommand(session, session.remote ? 6000 : 2500)

      return { ok: true, token: session.token }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[eaon] pty spawn failed for ${req.paneId} in ${cwd}:`, message)
      return { ok: false, error: message }
    }
  }

  /** Types the pending launch command exactly once, after `delay` ms. */
  private scheduleCommand(session: Session, delay: number): void {
    if (session.commandTimer) clearTimeout(session.commandTimer)
    session.commandTimer = setTimeout(() => {
      session.commandTimer = null
      const line = session.pendingCommand
      if (!line || !session.alive) return
      session.pendingCommand = null
      try {
        session.proc.write(`${line}\r`)
      } catch {
        /* the shell exited before it could be driven */
      }
    }, delay)
  }

  /**
   * The live shell behind each pane, so what is running inside one can be found
   * by walking down from it. This is the only link between a pane and the agent
   * in it — the agent itself carries nothing that names the terminal.
   */
  pids(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [paneId, session] of this.sessions) {
      if (session.alive && session.pid > 0) out.set(paneId, session.pid)
    }
    return out
  }

  write(paneId: string, data: string): void {
    const s = this.sessions.get(paneId)
    if (!s?.alive) return
    try {
      s.proc.write(data)
    } catch {
      /* the shell exited between the check and the write */
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId)
    if (!s?.alive) return
    try {
      s.proc.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    } catch {
      /* the process can exit between the check and the resize */
    }
  }

  kill(paneId: string): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    s.alive = false
    if (s.timer) clearTimeout(s.timer)
    if (s.commandTimer) clearTimeout(s.commandTimer)
    s.buffer.length = 0
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    this.sessions.delete(paneId)
  }

  has(paneId: string): boolean {
    return this.sessions.get(paneId)?.alive === true
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  /** Stops sending to the renderer, then tears every shell down. */
  killAll(): void {
    this.muted = true
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /**
   * Tears every shell down and waits for the kernel to actually reap them.
   *
   * This is the difference between quitting and aborting, and it is the whole
   * reason the app used to die with SIGABRT instead of exiting. node-pty waits
   * on each child from its own thread and reports the exit back through a
   * thread-safe function. If that call lands after V8 has begun tearing the
   * environment down, N-API cannot deliver it, so node-addon-api raises a C++
   * exception with no JavaScript frame anywhere to catch it — `std::terminate`,
   * then `abort`. Nothing on the JS side can guard against that, because the
   * throw happens before any of our code is reached.
   *
   * Waiting here means those callbacks have already run, and the thread-safe
   * functions have already been released, while the environment was still
   * whole. SIGHUP is what a closing terminal sends; anything still standing
   * after `graceMs` is not going to leave politely and gets SIGKILL.
   */
  async shutdown(timeoutMs = 2000, graceMs = 600): Promise<void> {
    this.muted = true

    const doomed = [...this.sessions.values()].map((s) => ({ token: s.token, pid: s.pid }))
    if (!doomed.length) return

    const reaped = doomed.map(
      ({ token }) => new Promise<void>((resolve) => this.reaping.set(token, resolve))
    )
    const outstanding = (): number => doomed.filter((d) => this.reaping.has(d.token)).length

    for (const id of [...this.sessions.keys()]) this.kill(id)

    const wait = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

    await Promise.race([Promise.all(reaped).then(() => undefined), wait(graceMs)])

    if (outstanding()) {
      for (const { token, pid } of doomed) {
        if (!this.reaping.has(token) || !pid) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone, or never ours to signal */
        }
      }
      await Promise.race([Promise.all(reaped).then(() => undefined), wait(timeoutMs - graceMs)])
    }

    // Whatever is still outstanding will never be settled; drop the waits so
    // nothing holds a reference into the dying environment.
    this.reaping.clear()
  }
}
