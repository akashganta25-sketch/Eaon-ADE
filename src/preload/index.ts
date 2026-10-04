import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DownloadProgress,
  InstalledModel,
  SttEngineState,
  SttModelDef
} from '../shared/stt'
import type { SpeechSupport, SystemVoice } from '../shared/speech'
import type { UpdateState } from '../shared/update'
import type { UsageReport } from '../shared/usage'
import type { TokenUsage, UsageRange } from '../shared/token-usage'
import type { MemoryHeadroom } from '../shared/memory'
import type { Account, LoginState } from '../shared/accounts'
import type { ProviderState } from '../shared/integrations'
import type { Worktree, WorktreeChange } from '../shared/worktrees'
import type { SshHost } from '../shared/ssh'
import type { GrepResult } from '../shared/grep'
import type { LinearTeam, PrDetail, TaskFetch } from '../shared/tasks'
import type { Stats } from '../shared/stats'
import type {
  BrainGraph,
  BrainScope,
  BrainStats,
  Memory,
  MemoryMeta,
  SearchHit
} from '../shared/brain'
import type {
  AgentDef,
  DirEntry,
  GitStatus,
  PersistedState,
  ResumableSession,
  SpawnRequest
} from '../shared/types'

export interface SysInfo {
  platform: string
  version: string
  electron: string
  node: string
  shell: string
  home: string
}

export interface LogEntry {
  hash: string
  subject: string
  when: string
  author: string
}

/**
 * The only surface the renderer gets. Node stays in the main process; every
 * call below is an explicit, typed door.
 */
const api = {
  pty: {
    spawn: (
      req: SpawnRequest
    ): Promise<{ ok: boolean; error?: string; reattached?: boolean }> =>
      ipcRenderer.invoke('pty:spawn', req),
    write: (paneId: string, data: string): void => ipcRenderer.send('pty:write', paneId, data),
    resize: (paneId: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', paneId, cols, rows),
    kill: (paneId: string): void => ipcRenderer.send('pty:kill', paneId),
    alive: (paneId: string): Promise<boolean> => ipcRenderer.invoke('pty:alive', paneId),
    onData: (cb: (paneId: string, data: string) => void): (() => void) => {
      const handler = (_e: unknown, p: { paneId: string; data: string }): void =>
        cb(p.paneId, p.data)
      ipcRenderer.on('pty:data', handler)
      return () => ipcRenderer.removeListener('pty:data', handler)
    },
    /*
     * `signal` is carried across deliberately. The main process has always
     * emitted it and this bridge used to drop it, which made an OOM kill
     * (exit code 0, signal 9) indistinguishable from a clean exit — so a
     * session the kernel had shot looked to the renderer like one that had
     * simply finished, and the pane went quiet with nothing to show.
     */
    onExit: (
      cb: (paneId: string, exitCode: number, signal?: number, requested?: boolean) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        p: { paneId: string; exitCode: number; signal?: number; requested?: boolean }
      ): void => cb(p.paneId, p.exitCode, p.signal, p.requested)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    }
  },

  /** The agent running in a pane, whenever it changes — including to nothing. */
  paneAgents: {
    onChange: (
      handler: (e: unknown, payload: { paneId: string; agentId: string | null }) => void
    ): (() => void) => {
      ipcRenderer.on('pane:agent', handler)
      return () => ipcRenderer.removeListener('pane:agent', handler)
    }
  },

  state: {
    load: (): Promise<PersistedState> => ipcRenderer.invoke('state:load'),
    save: (next: PersistedState): void => ipcRenderer.send('state:save', next),
    reset: (): Promise<PersistedState> => ipcRenderer.invoke('state:reset'),
    path: (): Promise<string> => ipcRenderer.invoke('state:path')
  },

  fs: {
    list: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
    read: (file: string): Promise<{ text: string; truncated: boolean }> =>
      ipcRenderer.invoke('fs:read', file),
    /**
     * Bytes, for images and PDFs — the one class of file `read` refuses on
     * sight. Base64, because a `data:` URL is the only source the renderer's
     * CSP admits; `file://` is silently blocked regardless of what the
     * component does with it.
     */
    readBinary: (file: string): Promise<{ base64: string; mime: string; truncated: boolean }> =>
      ipcRenderer.invoke('fs:readBinary', file),
    /** Null for anything that is not a previewable image/PDF extension. */
    mime: (file: string): Promise<string | null> => ipcRenderer.invoke('fs:mime', file),
    write: (file: string, text: string): Promise<void> =>
      ipcRenderer.invoke('fs:write', file, text),
    search: (root: string, q: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke('fs:search', root, q),
    /**
     * Inside the files, rather than across their names. Capped hard in the
     * main process — the result says when it stopped early rather than
     * presenting a slice as the whole answer.
     */
    grep: (root: string, q: string): Promise<GrepResult> =>
      ipcRenderer.invoke('fs:grep', root, q),
    isDir: (target: string): Promise<boolean> => ipcRenderer.invoke('fs:isDir', target),
    pickFolder: (startIn?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickFolder', startIn),

    /**
     * Where a dragged file actually lives.
     *
     * `File.path` was removed in Electron 32; this is the replacement, and it
     * only answers for files that came from a real drag or a file picker.
     * Anything synthesised in the page has no path and returns an empty string.
     */
    pathForDropped: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },

    /** Write a dropped payload that had no path of its own, and name it. */
    saveDropped: (name: string, bytes: Uint8Array): Promise<string> =>
      ipcRenderer.invoke('fs:saveDropped', name, bytes)
  },

  /**
   * Every method's trailing `host` runs it over ssh when given a workspace's
   * remote host, and locally — exactly as before this existed — when it is
   * omitted.
   */
  git: {
    status: (cwd: string, host?: SshHost | null): Promise<GitStatus> =>
      ipcRenderer.invoke('git:status', cwd, host),
    branch: (cwd: string, host?: SshHost | null): Promise<string | null> =>
      ipcRenderer.invoke('git:branch', cwd, host),
    branches: (cwd: string, host?: SshHost | null): Promise<string[]> =>
      ipcRenderer.invoke('git:branches', cwd, host),
    switch: (
      cwd: string,
      branch: string,
      host?: SshHost | null
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('git:switch', cwd, branch, host),
    diff: (cwd: string, file: string, staged: boolean, host?: SshHost | null): Promise<string> =>
      ipcRenderer.invoke('git:diff', cwd, file, staged, host),
    stage: (cwd: string, file: string, host?: SshHost | null): Promise<void> =>
      ipcRenderer.invoke('git:stage', cwd, file, host),
    unstage: (cwd: string, file: string, host?: SshHost | null): Promise<void> =>
      ipcRenderer.invoke('git:unstage', cwd, file, host),
    stageAll: (cwd: string, host?: SshHost | null): Promise<void> =>
      ipcRenderer.invoke('git:stageAll', cwd, host),
    commit: (cwd: string, msg: string, host?: SshHost | null): Promise<string> =>
      ipcRenderer.invoke('git:commit', cwd, msg, host),
    log: (cwd: string, host?: SshHost | null): Promise<LogEntry[]> =>
      ipcRenderer.invoke('git:log', cwd, host)
  },

  /**
   * Codex accounts. The same directory-per-account mechanism as Claude's, but
   * without a sign-in flow: `codex login` writes into whatever CODEX_HOME
   * points at, so `reserve` makes the directory and a pane opened in it does
   * the rest.
   */
  codexAccounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('codexAccounts:list'),
    setActive: (id: string): Promise<Account[]> =>
      ipcRenderer.invoke('codexAccounts:setActive', id),
    remove: (id: string): Promise<Account[]> => ipcRenderer.invoke('codexAccounts:remove', id),
    reserve: (): Promise<{ id: string; configDir: string }> =>
      ipcRenderer.invoke('codexAccounts:reserve'),
    commit: (id: string): Promise<Account[]> => ipcRenderer.invoke('codexAccounts:commit', id)
  },

  /**
   * Work waiting for you: pull requests, issues, Linear tickets.
   *
   * Every reply is normalised `WorkItem`s. No provider credential is part of
   * any of them — the Linear key stays in the main process, which is checked
   * with canary values rather than assumed.
   */
  tasks: {
    list: (cwd: string): Promise<TaskFetch> => ipcRenderer.invoke('tasks:list', cwd),
    approvePr: (
      cwd: string,
      number: number,
      body?: string
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('tasks:approvePr', cwd, number, body),
    linearTeams: (): Promise<LinearTeam[]> => ipcRenderer.invoke('tasks:linearTeams'),
    createLinearIssue: (input: {
      teamId: string
      title: string
      description?: string
    }): Promise<{ ok: boolean; message: string; url?: string }> =>
      ipcRenderer.invoke('tasks:createLinearIssue', input),
    pullRequests: (cwd: string, state: 'open' | 'merged' | 'all'): Promise<TaskFetch> =>
      ipcRenderer.invoke('tasks:pullRequests', cwd, state),
    prDetail: (cwd: string, number: number): Promise<PrDetail | { error: string }> =>
      ipcRenderer.invoke('tasks:prDetail', cwd, number),
    prDiff: (cwd: string, number: number): Promise<Record<string, string>> =>
      ipcRenderer.invoke('tasks:prDiff', cwd, number),
    reviewPr: (
      cwd: string,
      number: number,
      event: 'approve' | 'comment' | 'request-changes',
      body?: string
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('tasks:reviewPr', cwd, number, event, body)
  },

  /** Remote boxes: reading `~/.ssh/config` for the connect picker. */
  ssh: {
    listConfigHosts: (): Promise<SshHost[]> => ipcRenderer.invoke('ssh:listConfigHosts')
  },

  agents: {
    detect: (): Promise<AgentDef[]> => ipcRenderer.invoke('agents:detect'),
    /** Same question, asked of a remote host's PATH instead of this machine's. */
    detectRemote: (host: SshHost): Promise<AgentDef[]> =>
      ipcRenderer.invoke('agents:detectRemote', host)
  },

  /**
   * Connected services. Both calls return names, statuses and the names of the
   * variables involved — never a value. `refresh` re-reads the login shell
   * first, which is the only reason to prefer it over `list`.
   */
  integrations: {
    list: (): Promise<ProviderState[]> => ipcRenderer.invoke('integrations:list'),
    refresh: (): Promise<ProviderState[]> => ipcRenderer.invoke('integrations:refresh')
  },

  /**
   * Isolated checkouts, one per task — local, or on a remote box when `host`
   * is given.
   *
   * `baseSha` is passed on every comparison rather than looked up, so a trial
   * keeps measuring against the commit it actually started from even if the
   * branch it was cut from moves on while the agents are still working.
   */
  worktrees: {
    root: (cwd: string, host?: SshHost | null): Promise<string | null> =>
      ipcRenderer.invoke('worktrees:root', cwd, host),
    list: (cwd: string, host?: SshHost | null): Promise<Worktree[]> =>
      ipcRenderer.invoke('worktrees:list', cwd, host),
    create: (
      req: { cwd: string; branch: string; baseRef?: string; existing?: boolean },
      host?: SshHost | null
    ): Promise<{ ok: boolean; worktree?: Worktree; baseSha?: string; error?: string }> =>
      ipcRenderer.invoke('worktrees:create', req, host),
    change: (dir: string, baseSha: string, host?: SshHost | null): Promise<WorktreeChange> =>
      ipcRenderer.invoke('worktrees:change', dir, baseSha, host),
    diff: (dir: string, baseSha: string, host?: SshHost | null): Promise<string> =>
      ipcRenderer.invoke('worktrees:diff', dir, baseSha, host),
    commitAll: (
      dir: string,
      message: string,
      host?: SshHost | null
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('worktrees:commitAll', dir, message, host),
    merge: (
      cwd: string,
      branch: string,
      host?: SshHost | null
    ): Promise<{ ok: boolean; conflicts: string[]; message: string }> =>
      ipcRenderer.invoke('worktrees:merge', cwd, branch, host),
    remove: (
      cwd: string,
      dir: string,
      opts?: { force?: boolean; deleteBranch?: boolean },
      host?: SshHost | null
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('worktrees:remove', cwd, dir, opts ?? {}, host),
    prune: (cwd: string, host?: SshHost | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('worktrees:prune', cwd, host)
  },

  sessions: {
    resumable: (): Promise<ResumableSession[]> => ipcRenderer.invoke('sessions:resumable'),
    countFor: (cwd: string): Promise<number> => ipcRenderer.invoke('sessions:countFor', cwd)
  },

  /** How much of the Claude plan has been spent. Read on disk unless told otherwise. */
  usage: {
    /**
     * What every agent spent over 7, 30 or 90 days — by model, by project and
     * day by day. Read from the transcripts, so it is counted rather than
     * sampled; the money is a list-price estimate and is labelled as one.
     */
    tokens: (range: UsageRange): Promise<TokenUsage> =>
      ipcRenderer.invoke('usage:tokens', range),
    read: (opts: { fromAnthropic: boolean; session: number; week: number }): Promise<UsageReport> =>
      ipcRenderer.invoke('usage:read', opts),
    forget: (): void => ipcRenderer.send('usage:forget'),
    /** The same figures for Codex, read from its rollouts. */
    codex: (opts: { session?: number; week?: number }): Promise<UsageReport> =>
      ipcRenderer.invoke('usage:codex', opts)
  },

  /**
   * Claude accounts. Signing in is Claude Code's own flow, driven in the main
   * process; the window only ever asks to start it and hands back the code.
   */
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    setActive: (id: string): Promise<Account[]> => ipcRenderer.invoke('accounts:setActive', id),
    remove: (id: string): Promise<Account[]> => ipcRenderer.invoke('accounts:remove', id),

    beginLogin: (): Promise<LoginState> => ipcRenderer.invoke('accounts:beginLogin'),
    submitCode: (code: string): void => ipcRenderer.send('accounts:submitCode', code),
    cancelLogin: (): void => ipcRenderer.send('accounts:cancelLogin'),

    onLogin: (cb: (state: LoginState) => void): (() => void) => {
      const handler = (_e: unknown, state: LoginState): void => cb(state)
      ipcRenderer.on('accounts:login', handler)
      return () => ipcRenderer.removeListener('accounts:login', handler)
    },
    onChanged: (cb: (list: Account[]) => void): (() => void) => {
      const handler = (_e: unknown, list: Account[]): void => cb(list)
      ipcRenderer.on('accounts:changed', handler)
      return () => ipcRenderer.removeListener('accounts:changed', handler)
    }
  },

  browser: {
    /** Loopback ports with something listening, for the preview panel's chips. */
    devPorts: (): Promise<number[]> => ipcRenderer.invoke('browser:devPorts'),
    /**
     * Captures the page of a webview guest by webContentsId to PNG.
     * Downscales to <= 1600px and returns the local file path.
     */
    capture: (
      webContentsId: number
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('browser:capture', webContentsId),
    /**
     * Shortcuts pressed while the page itself had focus.
     *
     * Keys inside a <webview> go to the guest's own process and never reach
     * this window, so the main process catches the browser chords before the
     * guest sees them and sends them back here.
     */
    onKey: (cb: (chord: string) => void): (() => void) => {
      const handler = (_e: unknown, chord: string): void => cb(chord)
      ipcRenderer.on('browser:key', handler)
      return () => ipcRenderer.removeListener('browser:key', handler)
    }
  },

  /** Streak, contribution grid and code totals. Null folder counts everything. */
  stats: {
    get: (folder: string | null): Promise<Stats> => ipcRenderer.invoke('stats:get', folder)
  },

  /**
   * Voice dictation. Models are downloaded and run by the main process; the
   * renderer only ever hands over audio samples and gets text back.
   */
  stt: {
    catalog: (): Promise<SttModelDef[]> => ipcRenderer.invoke('stt:catalog'),
    installed: (): Promise<InstalledModel[]> => ipcRenderer.invoke('stt:installed'),
    usage: (): Promise<number> => ipcRenderer.invoke('stt:usage'),
    dir: (): Promise<string> => ipcRenderer.invoke('stt:dir'),

    download: (modelId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('stt:download', modelId),
    cancel: (modelId: string): void => ipcRenderer.send('stt:cancel', modelId),
    remove: (modelId: string): Promise<InstalledModel[]> =>
      ipcRenderer.invoke('stt:remove', modelId),

    load: (modelId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('stt:load', modelId),
    transcribe: (
      modelId: string,
      audio: Float32Array,
      language: string
    ): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('stt:transcribe', modelId, audio, language),
    stop: (): void => ipcRenderer.send('stt:stop'),
    state: (): Promise<SttEngineState> => ipcRenderer.invoke('stt:state'),

    onProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: DownloadProgress): void => cb(p)
      ipcRenderer.on('stt:progress', handler)
      return () => ipcRenderer.removeListener('stt:progress', handler)
    },
    onState: (cb: (s: SttEngineState) => void): (() => void) => {
      const handler = (_e: unknown, s: SttEngineState): void => cb(s)
      ipcRenderer.on('stt:state', handler)
      return () => ipcRenderer.removeListener('stt:state', handler)
    }
  },

  /**
   * Spoken alerts. The synthesiser belongs to the operating system, so the
   * renderer hands over a line of text and nothing else.
   */
  speech: {
    support: (): Promise<SpeechSupport> => ipcRenderer.invoke('speech:support'),
    voices: (): Promise<SystemVoice[]> => ipcRenderer.invoke('speech:voices'),
    refresh: (): Promise<SystemVoice[]> => ipcRenderer.invoke('speech:refresh'),
    speak: (text: string, opts: { voice?: string; rate?: number; volume?: number }): void =>
      ipcRenderer.send('speech:speak', text, opts),
    stop: (): void => ipcRenderer.send('speech:stop'),
    openVoiceSettings: (): void => ipcRenderer.send('speech:openVoiceSettings')
  },

  /**
   * Auto update. The renderer only ever reads state and asks to install; every
   * network decision stays in the main process.
   */
  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
    install: (): void => ipcRenderer.send('update:install'),
    onState: (cb: (s: UpdateState) => void): (() => void) => {
      const handler = (_e: unknown, s: UpdateState): void => cb(s)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    }
  },

  /**
   * Project memory: plain markdown in .eaonbrain/, shared with agents over MCP.
   *
   * Every call names the folder it is about. There is no "current" brain to
   * fall out of step with what is on screen.
   */
  brain: {
    open: (
      scope: BrainScope
    ): Promise<{ stats: BrainStats; registered: boolean; remote: boolean }> =>
      ipcRenderer.invoke('brain:open', scope),
    list: (scope: BrainScope): Promise<MemoryMeta[]> => ipcRenderer.invoke('brain:list', scope),
    get: (scope: BrainScope, slug: string): Promise<Memory | null> =>
      ipcRenderer.invoke('brain:get', scope, slug),
    write: (
      scope: BrainScope,
      input: { title: string; content: string; tags?: string[]; slug?: string }
    ): Promise<Memory | null> => ipcRenderer.invoke('brain:write', scope, input),
    remove: (scope: BrainScope, slug: string): Promise<boolean> =>
      ipcRenderer.invoke('brain:remove', scope, slug),
    search: (scope: BrainScope, q: string): Promise<SearchHit[]> =>
      ipcRenderer.invoke('brain:search', scope, q),
    related: (
      scope: BrainScope,
      slug: string
    ): Promise<{ backlinks: MemoryMeta[]; suggested: { meta: MemoryMeta; terms: string[] }[] }> =>
      ipcRenderer.invoke('brain:related', scope, slug),
    graph: (scope: BrainScope): Promise<BrainGraph> => ipcRenderer.invoke('brain:graph', scope),
    stats: (scope: BrainScope): Promise<BrainStats> => ipcRenderer.invoke('brain:stats', scope)
  },

  sys: {
    info: (): Promise<SysInfo> => ipcRenderer.invoke('sys:info'),
    home: (): Promise<string> => ipcRenderer.invoke('sys:home'),
    /** Whether there is room to start another agent on this machine. */
    memory: (): Promise<MemoryHeadroom> => ipcRenderer.invoke('sys:memory'),
    openExternal: (url: string): void => ipcRenderer.send('sys:openExternal', url),
    reveal: (target: string): void => ipcRenderer.send('sys:reveal', target)
  },

  win: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('win:toggleMaximize'),
    close: (): void => ipcRenderer.send('win:close'),
    onFullscreen: (cb: (isFull: boolean) => void): (() => void) => {
      const handler = (_e: unknown, v: boolean): void => cb(v)
      ipcRenderer.on('win:fullscreen', handler)
      return () => ipcRenderer.removeListener('win:fullscreen', handler)
    }
  }
}

export type EaonApi = typeof api

contextBridge.exposeInMainWorld('eaon', api)
