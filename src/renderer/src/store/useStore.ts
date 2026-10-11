import { create } from 'zustand'
import {
  type ClosedWorkspace,
  type AgentDef,
  agentKeepsSessions,
  AGENTS,
  type BoardCard,
  DEFAULT_SETTINGS,
  type GridTracks,
  HUES,
  NAME_POOL,
  PANEL_LABEL,
  type PaneKind,
  PANEL_KINDS,
  projectOf,
  type PaneSpec,
  type PaneStatus,
  type PersistedState,
  type Preset,
  type RecentFolder,
  type ResumableSession,
  type Settings,
  type SurfaceId,
  type VaultNote,
  type Workspace,
  type WorkspaceFolder
} from '@shared/types'
import { memberLabel, slugify, type Trial, type TrialMember } from '@shared/worktrees'
import { hostLabel, type SshHost } from '@shared/ssh'
import { branchNameFor, promptForWorkItem, type WorkItem } from '@shared/tasks'
import { firesOnOpen, type Automation } from '@shared/automations'
import type { DownloadProgress, InstalledModel, SttEngineState } from '@shared/stt'
import { IDLE_UPDATE_STATE, type UpdateState } from '@shared/update'
import { terminals } from '../lib/terminals'
import { forgetPane } from '../lib/speech'
import { basename, uid } from '../lib/util'

export type DockTab = 'files' | 'editor' | 'git' | 'work' | 'tools'

/**
 * A rail destination that takes the stage instead of being a workspace.
 *
 * Workspaces are *places you work*; these are places you *look things up*.
 * Keeping them off the workspace list is deliberate — opening Pull requests
 * should not leave a card in the rail you then have to close, the way opening
 * the Board does.
 */
export type StagePage = 'automations' | 'pulls' | 'pages' | 'search'

/** The workspace kinds that hold a surface rather than shells. */
/**
 * The one-per-app surfaces the rail offers as chips.
 *
 * Derived from `PANEL_KINDS`, not by excluding 'terminals' from every kind: a
 * browser is a workspace kind too, and under the old definition adding it
 * silently made it a "panel" — `openPanel` would have tried to look up a label
 * for it and the rail would have offered it as a chip. A list that says what
 * it contains cannot go wrong that way.
 */
export type PanelKind = (typeof PANEL_KINDS)[number]

export interface Notice {
  id: string
  kind: 'info' | 'attention' | 'error'
  title: string
  text: string
  at: number
  paneId?: string
  workspaceId?: string
}

export interface WizardDraft {
  step: 0 | 1 | 2
  mode: SurfaceId
  cwd: string
  layout: number
  agentId: string
  prompt: string
  presetId: string | null
  /**
   * Give every pane its own checkout instead of pointing them all at the same
   * folder. Without it, five agents told to do the same thing edit the same
   * files at the same time and produce one incoherent result.
   */
  isolate: boolean
  /**
   * Run against a remote box instead of a local folder. When set, `cwd` is a
   * path on that host, not on this machine — there is no folder browser for
   * it yet, so it is typed in.
   */
  host: SshHost | null
}

interface AppState {
  ready: boolean
  home: string
  appVersion: string
  agents: AgentDef[]

  workspaces: Workspace[]
  folders: WorkspaceFolder[]
  activeWorkspaceId: string | null
  presets: Preset[]
  recents: RecentFolder[]
  settings: Settings
  board: BoardCard[]
  vault: VaultNote[]
  dismissedResume: string[]
  /** Workspaces you closed, newest first, so one can be brought back. */
  closedTabs: ClosedWorkspace[]
  /** Brings back the most recently closed workspace, agents and all. */
  reopenClosed: () => boolean
  /** Isolated runs, keyed to the workspace that holds their panes. */
  trials: Trial[]
  /** Saved prompts with triggers. */
  automations: Automation[]

  wizard: WizardDraft | null
  railOpen: boolean
  dockOpen: boolean
  dockTab: DockTab
  dockWidth: number
  conductorOpen: boolean
  paletteOpen: boolean
  settingsOpen: boolean
  resumeOpen: boolean
  presetEditorId: string | null | 'new'
  /** Pane asked to open its find box, cleared once that pane has taken it. */
  findPaneId: string | null
  notices: Notice[]

  /** Speech models present on this machine. */
  sttInstalled: InstalledModel[]
  /** Live download progress, keyed by model id. */
  sttProgress: Record<string, DownloadProgress>
  sttEngine: SttEngineState

  /** Auto-update state, pushed from the main process. */
  update: UpdateState
  /** Version the user dismissed the card for, this session only. */
  updateDismissed: string | null

  hydrate: () => Promise<void>
  persist: () => void
  /** Writes the persisted snapshot immediately, skipping the debounce. */
  flushPersist: () => void

  setUpdate: (u: UpdateState) => void
  dismissUpdate: (version: string | null) => void

  refreshStt: () => Promise<void>
  setSttProgress: (p: DownloadProgress) => void
  setSttEngine: (s: SttEngineState) => void
  downloadModel: (modelId: string) => Promise<void>
  removeModel: (modelId: string) => Promise<void>

  openWizard: (mode: SurfaceId, preset?: Preset) => void
  updateWizard: (patch: Partial<WizardDraft>) => void
  closeWizard: () => void
  createWorkspace: (draft: WizardDraft) => void
  /**
   * The same thing, but every pane gets its own checkout first.
   *
   * Async and fallible where `createWorkspace` is neither, because it has to
   * talk to git: the folder may not be a repository, and a worktree may fail
   * to cut. Nothing is added to the rail unless every member was created, so a
   * half-made trial cannot be left on screen.
   */
  createTrial: (draft: WizardDraft) => Promise<{ ok: boolean; error?: string }>
  /** Commit a member's work, merge its branch, and clear the trial away. */
  mergeTrialMember: (
    trialId: string,
    memberId: string
  ) => Promise<{ ok: boolean; conflicts: string[]; message: string }>
  /** Throw the whole trial away, checkouts and branches with it. */
  discardTrial: (trialId: string) => Promise<void>
  /**
   * Open an isolated checkout for a pull request or issue, and a workspace on
   * it. A PR's head branch already exists and is checked out as it stands; an
   * issue has only a suggested name, so a fresh branch is cut for it.
   */
  openWorkItem: (item: WorkItem) => Promise<{ ok: boolean; error?: string }>

  /**
   * What is actually running in a pane, as observed rather than as opened.
   * Null when nothing is: the pane falls back to a plain shell.
   */
  setPaneAgent: (paneId: string, agentId: string | null) => void
  setActiveWorkspace: (id: string) => void
  /**
   * Another tab of the project the given workspace belongs to.
   *
   * The first tab of a project works in the repository itself; every tab after
   * it gets its own git worktree on its own branch, because two agents in two
   * tabs of one project must not be able to overwrite each other's files.
   */
  openTab: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>
  /** A browser, as a tab of the same project. */
  openBrowserTab: (workspaceId: string) => void
  closeWorkspace: (id: string) => void
  /** Ends every shell in a workspace but keeps the workspace and its panes. */
  stopWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void

  /** Makes a folder and returns its id, so the caller can file something in it. */
  createFolder: (name?: string, withWorkspaceId?: string) => string
  renameFolder: (id: string, name: string) => void
  /** Removes the folder. Everything filed under it returns to the top level. */
  deleteFolder: (id: string) => void
  toggleFolder: (id: string) => void
  /** Files a workspace under a folder, or back at the top level with null. */
  moveToFolder: (workspaceId: string, folderId: string | null) => void

  addPane: (
    workspaceId: string,
    opts?: {
      agentId?: string
      command?: string | null
      cwd?: string
      /** 'preview' | 'diff' skip agent/session setup entirely — see addPane. */
      kind?: PaneKind
      /** kind: 'preview' only. */
      previewPath?: string
    }
  ) => void
  resumeSessions: (sessions: ResumableSession[]) => void
  closePane: (workspaceId: string, paneId: string) => void
  /** Drag one pane onto another and they trade places. */
  movePane: (workspaceId: string, dragId: string, dropId: string) => void
  /** Where the dividers sit. Null restores equal shares. */
  setGridTracks: (workspaceId: string, tracks: GridTracks | null) => void
  focusPane: (workspaceId: string, paneId: string) => void
  zoomPane: (workspaceId: string, paneId: string | null) => void
  patchPane: (paneId: string, patch: Partial<PaneSpec>) => void
  restartPane: (paneId: string) => void

  savePreset: (preset: Preset) => void
  deletePreset: (id: string) => void
  touchRecent: (path: string) => void

  updateSettings: (patch: Partial<Settings>) => void
  /**
   * Go to a panel, making it if it is not there yet.
   *
   * `at` names the project it should belong to. It matters for the Brain,
   * which is one per folder: without it the panel inherits the cwd of whatever
   * you happened to be in, so opening the Brain from a worktree tab would make
   * a second Brain for the same repository.
   */
  openPanel: (kind: PanelKind, at?: string) => void
  toggleRail: () => void
  toggleDock: (tab?: DockTab) => void
  setDockTab: (tab: DockTab) => void
  /** Non-workspace destination on the stage, or null for the workspace. */
  stagePage: StagePage | null
  setStagePage: (page: StagePage | null) => void
  /**
   * Hand a path to the editor and bring it forward. Set by the file tree and
   * by a search hit — which also knows the line, so the editor can land on it
   * rather than at the top of a thousand-line file.
   */
  openFileInEditor: (path: string, line?: number) => void
  /** The path the editor should open next, cleared once it has. */
  editorTarget: { path: string; line?: number } | null
  clearEditorTarget: () => void
  setDockWidth: (w: number) => void
  toggleConductor: () => void
  setPalette: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setResumeOpen: (open: boolean) => void
  setPresetEditor: (id: string | null | 'new') => void
  setFindPane: (id: string | null) => void

  notify: (n: Omit<Notice, 'id' | 'at'>) => void
  dismissNotice: (id: string) => void
  clearNotices: () => void

  /** Opens a workspace for this automation and stamps its last run. */
  runAutomation: (a: Automation) => void
  saveAutomation: (a: Automation) => void
  deleteAutomation: (id: string) => void
  saveCard: (card: BoardCard) => void
  deleteCard: (id: string) => void
  saveNote: (note: VaultNote) => void
  deleteNote: (id: string) => void
  dismissResume: (ids: string[]) => void
}

function pickNames(count: number, taken: string[]): string[] {
  const pool = NAME_POOL.filter((n) => !taken.includes(n))
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    if (pool.length) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    } else {
      out.push(`Pane ${taken.length + i + 1}`)
    }
  }
  return out
}

function makePane(name: string, cwd: string, agentId: string): PaneSpec {
  const agent = AGENTS.find((a) => a.id === agentId)
  const command = agent && agent.bin ? [agent.bin, ...agent.args].join(' ') : null
  return {
    id: uid('p_'),
    name,
    title: null,
    cwd,
    agentId,
    command,
    // Named now, before the agent has run once. The main process pins this id
    // on the first launch and reopens it on every one after, which is what
    // makes a pane come back as the conversation it was rather than a new one.
    sessionId: agentKeepsSessions(agentId) ? crypto.randomUUID() : null,
    status: 'idle',
    working: false,
    branch: null,
    contextPct: null,
    createdAt: Date.now()
  }
}

/** "Folder", then "Folder 2" — the first one does not need a number. */
function nextFolderName(existing: WorkspaceFolder[]): string {
  const taken = new Set(existing.map((f) => f.name))
  if (!taken.has('Folder')) return 'Folder'
  for (let n = 2; ; n += 1) {
    if (!taken.has(`Folder ${n}`)) return `Folder ${n}`
  }
}

/** Workspaces cycle through the identity hues so the rail stays readable. */
function nextHue(existing: Workspace[]): string {
  const counts = HUES.map((h) => existing.filter((w) => w.hue === h).length)
  const min = Math.min(...counts)
  return HUES[counts.indexOf(min)]
}

let persistTimer: number | null = null

/**
 * Opening prompts, held outside the store because they are consumed once and
 * must never be written to disk with the workspace.
 */
export const pendingPrompts = new Map<string, string>()

/**
 * Workspaces whose `onOpen` automations have already been dealt with.
 *
 * Kept here rather than in the store because it is not state anyone should see
 * or persist — it exists only to stop a trigger firing twice, and "twice" is
 * measured per run of the app. Flipping between two workspaces all afternoon
 * fires each one's automations once.
 *
 * A workspace an automation *created* is added the moment it appears, which is
 * what stops the obvious loop: the new workspace has the same folder as the
 * automation that opened it, so without this, clicking it would run the
 * automation again, and again.
 */
const openHandled = new Set<string>()

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  home: '',
  // Placeholder until hydrate() reads the real one from the main process.
  appVersion: '1.0.0',
  agents: AGENTS,

  workspaces: [],
  folders: [],
  activeWorkspaceId: null,
  presets: [],
  recents: [],
  settings: { ...DEFAULT_SETTINGS },
  board: [],
  vault: [],
  dismissedResume: [],
  closedTabs: [],
  trials: [],
  automations: [],

  wizard: null,
  railOpen: true,
  dockOpen: false,
  dockTab: 'editor',
  editorTarget: null,
  stagePage: null,
  dockWidth: 460,
  // Closed on launch. It floats over the bottom row, so it has to be asked for
  // (⌘J) rather than turn up in front of your terminals every time.
  conductorOpen: false,
  paletteOpen: false,
  settingsOpen: false,
  resumeOpen: false,
  presetEditorId: null,
  findPaneId: null,
  notices: [],

  sttInstalled: [],
  sttProgress: {},
  sttEngine: { kind: 'idle' },

  update: { ...IDLE_UPDATE_STATE },
  updateDismissed: null,

  async hydrate() {
    const [saved, info, agents] = await Promise.all([
      window.eaon.state.load(),
      window.eaon.sys.info(),
      window.eaon.agents.detect()
    ])

    // The terminal font default changed with the brand. Move anyone who never
    // chose their own onto it; leave a real preference alone.
    const savedSettings = { ...(saved.settings ?? {}) }
    const LEGACY_FONT = '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, monospace'
    if (savedSettings.fontFamily === LEGACY_FONT) {
      savedSettings.fontFamily = DEFAULT_SETTINGS.fontFamily
    }
    // Same for the cursor: the default used to be a thin bar, and a terminal
    // should look like a terminal. Anyone still on the old default moves over.
    if (savedSettings.cursorStyle === 'bar') {
      savedSettings.cursorStyle = DEFAULT_SETTINGS.cursorStyle
    }
    // And the cell height, which is what the block cursor is measured against.
    if (savedSettings.lineHeight === 1.35) {
      savedSettings.lineHeight = DEFAULT_SETTINGS.lineHeight
    }

    const folders = saved.folders ?? []
    const folderIds = new Set(folders.map((f) => f.id))

    // Panes are restored as empty shells; their processes died with the app.
    const workspaces = (saved.workspaces ?? []).map((w) => ({
      ...w,
      // Saved before workspaces had kinds: everything back then held shells.
      kind: w.kind ?? ('terminals' as const),
      /*
       * A workspace filed under a folder that is no longer there comes back to
       * the top level. Without this it would be filed somewhere unreachable and
       * read as gone — the one way a folder could lose you a session.
       */
      folderId: w.folderId && folderIds.has(w.folderId) ? w.folderId : null,
      // Absent on anything saved before the dividers could be moved, which
      // reads the same as never having moved one.
      grid: w.grid ?? null,
      zoomedPaneId: null,
      panes: w.panes.map((p) => ({
        ...p,
        status: 'idle' as PaneStatus,
        working: false,
        contextPct: null,
        title: null,
        /*
         * Panes saved before this existed are given an id now rather than
         * having one guessed for them. Their previous conversation was never
         * named, and picking the most recent transcript in the folder would be
         * a coin toss the moment two panes share one — a pane silently
         * adopting somebody else's conversation is far worse than starting
         * clean. From this launch on, each one keeps what it is given.
         */
        sessionId: p.sessionId ?? (agentKeepsSessions(p.agentId) ? crypto.randomUUID() : null)
      }))
    }))

    set({
      ready: true,
      home: info.home,
      appVersion: info.version,
      agents,
      workspaces,
      folders,
      activeWorkspaceId: workspaces.some((w) => w.id === saved.activeWorkspaceId)
        ? saved.activeWorkspaceId
        : (workspaces[0]?.id ?? null),
      presets: saved.presets ?? [],
      recents: saved.recents ?? [],
      settings: { ...DEFAULT_SETTINGS, ...savedSettings },
      board: saved.board ?? [],
      vault: saved.vault ?? [],
      dismissedResume: saved.dismissedResume ?? [],
      closedTabs: saved.closedTabs ?? [],
      trials: saved.trials ?? [],
      automations: saved.automations ?? []
    })

    void get().refreshStt()
  },

  async refreshStt() {
    set({ sttInstalled: await window.eaon.stt.installed() })
  },

  setSttProgress(p) {
    set({ sttProgress: { ...get().sttProgress, [p.modelId]: p } })
    if (p.done) void get().refreshStt()
  },

  setSttEngine(sttEngine) {
    set({ sttEngine })
  },

  async downloadModel(modelId) {
    const res = await window.eaon.stt.download(modelId)
    await get().refreshStt()
    if (!res.ok && res.error && res.error !== 'Cancelled') {
      get().notify({ kind: 'error', title: 'Download failed', text: res.error })
      return
    }
    if (res.ok) {
      // First model down: make it the one dictation uses, so the feature works
      // without a second trip into settings.
      if (!get().settings.voiceModelId) get().updateSettings({ voiceModelId: modelId })
    }
  },

  async removeModel(modelId) {
    const installed = await window.eaon.stt.remove(modelId)
    set({ sttInstalled: installed })
    if (get().settings.voiceModelId === modelId) {
      const next = installed.find((m) => m.complete)
      get().updateSettings({ voiceModelId: next?.id ?? '' })
    }
  },

  persist() {
    if (persistTimer !== null) window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(() => get().flushPersist(), 400)
  },

  /*
   * Writes the snapshot now rather than on the debounce.
   *
   * The debounce is right while somebody is working and wrong at the one
   * moment that matters: rename a workspace and quit straight away, and the
   * rename was still sitting in the timer when the window went. Called on the
   * way out — the main process asks for it before quitting, and the page asks
   * for it itself when it is closed or reloaded.
   */
  flushPersist() {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer)
      persistTimer = null
    }
    const s = get()
    // Nothing has been read yet, so there is nothing of ours to write — and
    // writing the empty placeholder would replace what is on disk.
    if (!s.ready) return
    const snapshot: PersistedState = {
      version: 1,
      workspaces: s.workspaces,
      folders: s.folders,
      activeWorkspaceId: s.activeWorkspaceId,
      presets: s.presets,
      recents: s.recents,
      settings: s.settings,
      board: s.board,
      vault: s.vault,
      dismissedResume: s.dismissedResume,
      closedTabs: s.closedTabs,
      trials: s.trials,
      automations: s.automations
    }
    window.eaon.state.save(snapshot)
  },

  openWizard(mode, preset) {
    const s = get()
    set({
      wizard: {
        step: 0,
        mode,
        cwd: preset?.cwd ?? s.recents[0]?.path ?? s.home,
        layout: preset?.layout ?? (mode === 'swarm' ? 4 : 1),
        agentId: preset?.agentId ?? s.settings.defaultAgentId,
        prompt: preset?.prompt ?? '',
        presetId: preset?.id ?? null,
        isolate: false,
        host: null
      }
    })
  },

  updateWizard(patch) {
    const w = get().wizard
    if (!w) return
    set({ wizard: { ...w, ...patch } })
  },

  closeWizard() {
    set({ wizard: null })
  },

  createWorkspace(draft) {
    const s = get()
    const names = pickNames(draft.layout, s.workspaces.flatMap((w) => w.panes.map((p) => p.name)))
    const workspace: Workspace = {
      id: uid('w_'),
      name: (draft.host ? hostLabel(draft.host) : basename(draft.cwd)) || 'Workspace',
      cwd: draft.cwd,
      kind: 'terminals',
      hue: nextHue(s.workspaces),
      layout: draft.layout,
      panes: names.map((n) => makePane(n, draft.cwd, draft.agentId)),
      // Equal shares until a divider is dragged.
      grid: null,
      activePaneId: null,
      zoomedPaneId: null,
      folderId: null,
      createdAt: Date.now(),
      host: draft.host
    }
    workspace.activePaneId = workspace.panes[0]?.id ?? null
    if (draft.prompt.trim() && draft.agentId !== 'shell') {
      pendingPrompts.set(workspace.id, draft.prompt.trim())
    }

    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null,
      wizard: null
    })
    // A remote path is not a local folder to suggest back in the picker.
    if (!draft.host) get().touchRecent(draft.cwd)
    get().persist()
  },

  async createTrial(draft) {
    const s = get()
    const host = draft.host ?? null
    const root = await window.eaon.worktrees.root(draft.cwd, host)
    if (!root) {
      return {
        ok: false,
        error: host
          ? 'That path is not a git repository on the remote host, so there is nothing to isolate.'
          : 'That folder is not a git repository, so there is nothing to isolate.'
      }
    }

    const count = Math.max(1, draft.layout)
    const slug = slugify(draft.prompt || basename(draft.cwd), 'trial')
    // Two trials of the same prompt in one afternoon must not collide on a
    // branch name, and the user should still be able to read what it was.
    const stamp = Date.now().toString(36).slice(-4)
    const baseRef = (await window.eaon.git.branch(root, host)) ?? 'HEAD'

    const members: TrialMember[] = []
    let baseSha = ''

    for (let i = 0; i < count; i++) {
      const label = memberLabel(i)
      const branch = `eaon/${slug}-${stamp}/${label.toLowerCase()}`
      const made = await window.eaon.worktrees.create({ cwd: root, branch }, host)
      if (!made.ok || !made.worktree) {
        // Undo the ones already cut. A half-made trial on screen would be
        // worse than none: some agents isolated, some not, no way to tell.
        for (const done of members) {
          await window.eaon.worktrees.remove(
            root,
            done.path,
            { force: true, deleteBranch: true },
            host
          )
        }
        return { ok: false, error: made.error ?? 'Could not create a worktree.' }
      }
      baseSha = made.baseSha ?? baseSha
      members.push({
        id: uid('tm_'),
        agentId: draft.agentId,
        label,
        branch,
        path: made.worktree.path,
        paneId: null
      })
    }

    const names = pickNames(count, s.workspaces.flatMap((w) => w.panes.map((p) => p.name)))
    const panes = members.map((m, i) => makePane(names[i], m.path, draft.agentId))
    members.forEach((m, i) => {
      m.paneId = panes[i].id
    })

    const workspace: Workspace = {
      id: uid('w_'),
      name: `${(host ? hostLabel(host) : basename(draft.cwd)) || 'Workspace'} · trial`,
      cwd: draft.cwd,
      kind: 'terminals',
      hue: nextHue(s.workspaces),
      layout: count,
      panes,
      grid: null,
      activePaneId: panes[0]?.id ?? null,
      zoomedPaneId: null,
      folderId: null,
      createdAt: Date.now(),
      host
    }

    const trial: Trial = {
      id: uid('t_'),
      workspaceId: workspace.id,
      prompt: draft.prompt.trim(),
      repoRoot: root,
      baseSha,
      baseRef,
      members,
      winnerId: null,
      createdAt: Date.now(),
      host
    }

    if (draft.prompt.trim() && draft.agentId !== 'shell') {
      pendingPrompts.set(workspace.id, draft.prompt.trim())
    }

    set({
      workspaces: [...s.workspaces, workspace],
      trials: [...s.trials, trial],
      activeWorkspaceId: workspace.id,
      stagePage: null,
      wizard: null
    })
    if (!host) get().touchRecent(draft.cwd)
    get().persist()
    return { ok: true }
  },

  async mergeTrialMember(trialId, memberId) {
    const trial = get().trials.find((t) => t.id === trialId)
    const member = trial?.members.find((m) => m.id === memberId)
    if (!trial || !member) {
      return { ok: false, conflicts: [], message: 'That attempt is no longer here.' }
    }
    const host = trial.host ?? null

    // Agents routinely stop with the work saved but not committed, and a
    // branch in that state cannot be merged at all.
    const subject = trial.prompt.split('\n')[0].slice(0, 60) || 'Trial'
    const committed = await window.eaon.worktrees.commitAll(
      member.path,
      `${subject} (${member.label})`,
      host
    )
    if (!committed.ok) {
      return { ok: false, conflicts: [], message: committed.error ?? 'Could not commit the work.' }
    }

    const merged = await window.eaon.worktrees.merge(trial.repoRoot, member.branch, host)
    if (!merged.ok) return merged

    set({
      trials: get().trials.map((t) => (t.id === trialId ? { ...t, winnerId: memberId } : t))
    })
    get().persist()
    return merged
  },

  setPaneAgent(paneId, agentId) {
    const next = agentId ?? 'shell'
    const s = get()
    let touched = false
    const workspaces = s.workspaces.map((w) => {
      if (!w.panes.some((p) => p.id === paneId && p.agentId !== next)) return w
      touched = true
      return { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, agentId: next } : p)) }
    })
    // Only when it actually changed: this arrives on a timer, and rewriting
    // state on every tick would persist and re-render for nothing.
    if (!touched) return
    set({ workspaces })
    get().persist()
  },

  openBrowserTab(workspaceId) {
    const s = get()
    const from = s.workspaces.find((w) => w.id === workspaceId)
    if (!from) return
    const project = projectOf(from)
    const workspace: Workspace = {
      id: uid('w_'),
      kind: 'browser',
      name: 'Browser',
      // The project's folder, so the tab sits with its siblings and a local
      // dev server started in one of them is what this points at.
      cwd: from.cwd,
      hue: nextHue(s.workspaces),
      layout: 0,
      panes: [],
      grid: null,
      activePaneId: null,
      zoomedPaneId: null,
      folderId: from.folderId,
      projectRoot: project,
      createdAt: Date.now(),
      host: from.host ?? null
    }
    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null
    })
    get().persist()
  },

  async openTab(workspaceId) {
    const s = get()
    const from = s.workspaces.find((w) => w.id === workspaceId)
    if (!from) return { ok: false, error: 'That workspace is gone.' }

    // A tab is another set of agents in the same project, in the same folder,
    // on the same branch. Not its own checkout: a project is on one branch,
    // and git will not check one branch out into two worktrees anyway — the
    // only way to have both would be a detached HEAD per tab, which makes
    // committing from a tab a two-step dance for no gain.
    const project = projectOf(from)

    /*
     * A tab closed by mistake comes back instead of a blank one appearing.
     *
     * Closing a tab and immediately opening one is what somebody does the
     * moment they realise — so that is treated as the undo it plainly is, and
     * the agents come back with their conversations rather than as empty
     * terminals next to the work that was lost. Only for this project, and
     * only the one closed most recently; anything older needs asking for.
     */
    const restorable = s.closedTabs.find((c) => projectOf(c.workspace) === project)
    if (restorable) {
      set({
        workspaces: [...s.workspaces, restorable.workspace],
        closedTabs: s.closedTabs.filter((c) => c !== restorable),
        activeWorkspaceId: restorable.workspace.id,
        stagePage: null
      })
      get().persist()
      return { ok: true }
    }

    const siblings = s.workspaces.filter(
      (w) => w.kind === 'terminals' && projectOf(w) === project
    )

    const names = pickNames(1, s.workspaces.flatMap((w) => w.panes.map((p) => p.name)))
    const pane = makePane(names[0], from.cwd, s.settings.defaultAgentId)
    const workspace: Workspace = {
      id: uid('w_'),
      name: `${basename(project)} ${siblings.length + 1}`,
      cwd: from.cwd,
      kind: 'terminals',
      hue: nextHue(s.workspaces),
      layout: 1,
      panes: [pane],
      grid: null,
      activePaneId: pane.id,
      zoomedPaneId: null,
      folderId: from.folderId,
      projectRoot: project,
      createdAt: Date.now(),
      host: from.host ?? null
    }

    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null
    })
    get().persist()
    return { ok: true }
  },

  async openWorkItem(item) {
    const s = get()
    const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    // Which repository this belongs to is the workspace you are looking at —
    // work items are fetched for that repo in the first place.
    const cwd = active?.cwd ?? s.home
    const host = active?.host ?? null

    const root = await window.eaon.worktrees.root(cwd, host)
    if (!root) {
      return { ok: false, error: 'This workspace is not a git repository, so there is nothing to check out.' }
    }

    const branch = item.branch ?? branchNameFor(item)
    const made = await window.eaon.worktrees.create(
      { cwd: root, branch, existing: item.branchExists },
      host
    )
    if (!made.ok || !made.worktree) {
      return { ok: false, error: made.error ?? 'Could not open a checkout.' }
    }

    const names = pickNames(1, s.workspaces.flatMap((w) => w.panes.map((p) => p.name)))
    const pane = makePane(names[0], made.worktree.path, s.settings.defaultAgentId)
    const workspaceId = uid('w_')
    // The whole point of "send this to an agent" is that the agent starts
    // briefed rather than at a cold shell. Same guard the wizard's own
    // opening prompt uses: a plain shell has nothing to read it.
    if (s.settings.defaultAgentId !== 'shell') {
      pendingPrompts.set(workspaceId, promptForWorkItem(item))
    }
    const workspace: Workspace = {
      id: workspaceId,
      // The ref is what you were looking at in the list, so it is what the
      // rail should say — a slugified branch name would be a worse label for
      // the same thing.
      name: `${item.ref} ${item.title}`.slice(0, 48),
      cwd: made.worktree.path,
      kind: 'terminals',
      hue: nextHue(s.workspaces),
      layout: 1,
      panes: [pane],
      grid: null,
      activePaneId: pane.id,
      zoomedPaneId: null,
      folderId: null,
      createdAt: Date.now(),
      host
    }

    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null
    })
    get().persist()
    return { ok: true }
  },

  async discardTrial(trialId) {
    const trial = get().trials.find((t) => t.id === trialId)
    if (!trial) return
    const host = trial.host ?? null

    for (const m of trial.members) {
      // Force, because a losing attempt is dirty by definition — that is what
      // makes it an attempt rather than a branch.
      await window.eaon.worktrees.remove(
        trial.repoRoot,
        m.path,
        { force: true, deleteBranch: true },
        host
      )
    }
    await window.eaon.worktrees.prune(trial.repoRoot, host)

    set({ trials: get().trials.filter((t) => t.id !== trialId) })
    get().closeWorkspace(trial.workspaceId)
  },

  setActiveWorkspace(id) {
    // Picking a workspace means "show me that workspace", so it leaves Settings
    // — and any rail destination, which is laid over the workspace the same way.
    set({ activeWorkspaceId: id, settingsOpen: false, stagePage: null })
    get().persist()

    // First time this workspace has been opened this session: run anything
    // waiting on its folder. Guarded so returning to it later is just a
    // workspace switch, not another run.
    if (openHandled.has(id)) return
    openHandled.add(id)
    const s = get()
    const workspace = s.workspaces.find((w) => w.id === id)
    // A remote folder is a path on another machine; matching it against a
    // local automation's folder would be a coincidence, not the same place.
    if (!workspace || workspace.host) return
    for (const a of s.automations.filter((x) => firesOnOpen(x, workspace.cwd))) {
      get().runAutomation(a)
    }
  },

  closeWorkspace(id) {
    const s = get()
    const target = s.workspaces.find((w) => w.id === id)
    target?.panes.forEach((p) => {
      terminals.dispose(p.id)
      forgetPane(p.id)
    })
    const rest = s.workspaces.filter((w) => w.id !== id)
    /*
     * Remembered on the way out, so closing one by accident is recoverable.
     *
     * The whole workspace is kept rather than a summary of it: each pane still
     * carries the command and session id its agent was launched with, and the
     * main process resumes a conversation from exactly those. Ten is enough to
     * undo a mistake and few enough that it cannot grow into the state file.
     */
    const closedTabs = target
      ? [{ workspace: target, closedAt: Date.now() }, ...s.closedTabs].slice(0, 10)
      : s.closedTabs
    set({
      workspaces: rest,
      closedTabs,
      activeWorkspaceId: s.activeWorkspaceId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeWorkspaceId,
      notices: s.notices.filter((n) => n.workspaceId !== id)
    })
    get().persist()
  },

  /**
   * Brings back the workspace you closed last.
   *
   * Its panes go back with the command and session id they had, so the agents
   * pick their conversations up rather than starting empty beside them — the
   * ids were removed from the store when it closed, so putting them back
   * cannot collide with anything.
   *
   * Returns whether there was anything to bring back, so a keystroke that
   * found nothing can say so instead of appearing to do nothing.
   */
  reopenClosed() {
    const s = get()
    const [last, ...rest] = s.closedTabs
    if (!last) return false
    set({
      workspaces: [...s.workspaces, last.workspace],
      closedTabs: rest,
      activeWorkspaceId: last.workspace.id,
      stagePage: null
    })
    get().persist()
    return true
  },

  /**
   * Stop the agents, keep the workspace.
   *
   * The panes stay on screen showing where each one got to, which is the whole
   * point: closing the workspace also stops everything, but takes the record of
   * what happened with it. This is the version you reach for when you want the
   * machine back and the transcripts still in front of you.
   */
  stopWorkspace(id) {
    const target = get().workspaces.find((w) => w.id === id)
    if (!target) return
    // Marked here rather than waiting for each shell's exit to come back, so
    // the rail stops claiming they are running the moment you ask.
    target.panes.forEach((p) => {
      terminals.stop(p.id)
      forgetPane(p.id)
    })
  },

  renameWorkspace(id, name) {
    const clean = name.trim()
    // An empty name would leave a nameless row you could no longer identify or
    // rename back, so a blank rename is simply not one.
    if (!clean) return
    set({
      workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name: clean } : w))
    })
    get().persist()
  },

  createFolder(name, withWorkspaceId) {
    const s = get()
    const folder: WorkspaceFolder = {
      id: uid('f_'),
      name: (name ?? '').trim() || nextFolderName(s.folders),
      collapsed: false,
      createdAt: Date.now()
    }
    set({
      folders: [...s.folders, folder],
      workspaces: withWorkspaceId
        ? s.workspaces.map((w) => (w.id === withWorkspaceId ? { ...w, folderId: folder.id } : w))
        : s.workspaces
    })
    get().persist()
    return folder.id
  },

  renameFolder(id, name) {
    const clean = name.trim()
    if (!clean) return
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) })
    get().persist()
  },

  /**
   * Deleting a folder is only ever deleting the grouping.
   *
   * Everything inside comes back to the top level. A folder that could take
   * four running agents with it would be a thing you hesitate before clicking,
   * and there is nothing here worth hesitating over.
   */
  deleteFolder(id) {
    const s = get()
    set({
      folders: s.folders.filter((f) => f.id !== id),
      workspaces: s.workspaces.map((w) => (w.folderId === id ? { ...w, folderId: null } : w))
    })
    get().persist()
  },

  toggleFolder(id) {
    set({
      folders: get().folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f))
    })
    get().persist()
  },

  moveToFolder(workspaceId, folderId) {
    const s = get()
    if (folderId && !s.folders.some((f) => f.id === folderId)) return
    const target = s.workspaces.find((w) => w.id === workspaceId)
    if (!target || target.folderId === folderId) return

    set({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, folderId } : w)),
      // Dropping something into a folder that is shut would look like losing it.
      folders: folderId
        ? s.folders.map((f) => (f.id === folderId ? { ...f, collapsed: false } : f))
        : s.folders
    })
    get().persist()
  },

  addPane(workspaceId, opts) {
    const s = get()
    // The Board has no shells to add one to.
    if (s.workspaces.find((w) => w.id === workspaceId)?.kind !== 'terminals') return
    set({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const taken = s.workspaces.flatMap((x) => x.panes.map((p) => p.name))
        const [name] = pickNames(1, taken)
        const pane =
          opts?.kind && opts.kind !== 'terminal'
            ? // A preview or diff pane has nothing to spawn — it is a surface,
              // not a shell — so it skips makePane's agent/session machinery
              // entirely rather than constructing one it will never use.
              {
                id: uid('p_'),
                kind: opts.kind,
                name,
                title: null,
                cwd: opts?.cwd ?? w.cwd,
                agentId: 'shell',
                command: null,
                sessionId: null,
                status: 'idle' as const,
                working: false,
                branch: null,
                contextPct: null,
                createdAt: Date.now(),
                previewPath: opts.kind === 'preview' ? (opts.previewPath ?? null) : null
              }
            : makePane(name, opts?.cwd ?? w.cwd, opts?.agentId ?? s.settings.defaultAgentId)
        if (opts?.command !== undefined && (!opts?.kind || opts.kind === 'terminal')) {
          pane.command = opts.command
        }
        return { ...w, panes: [...w.panes, pane], activePaneId: pane.id, layout: w.panes.length + 1 }
      })
    })
    get().persist()
  },

  resumeSessions(sessions) {
    if (!sessions.length) return
    const s = get()
    const taken = s.workspaces.flatMap((w) => w.panes.map((p) => p.name))
    const names = pickNames(sessions.length, taken)
    const cwd = sessions[0].cwd || s.home
    const panes = sessions.map((session, i) => {
      const pane = makePane(names[i], session.cwd || cwd, 'shell')
      pane.command = session.command
      pane.title = session.label
      return pane
    })
    const workspace: Workspace = {
      id: uid('w_'),
      kind: 'terminals',
      name: `Resumed ${basename(cwd) || 'sessions'}`,
      cwd,
      hue: nextHue(s.workspaces),
      layout: panes.length,
      panes,
      // Equal shares until a divider is dragged.
      grid: null,
      activePaneId: panes[0].id,
      zoomedPaneId: null,
      folderId: null,
      createdAt: Date.now()
    }
    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null,
      resumeOpen: false
    })
    get().touchRecent(cwd)
    get().persist()
  },

  /**
   * Swaps two panes over, which is what dragging one onto another does.
   *
   * They trade places rather than one pushing the other along. In a grid where
   * every cell is filled, inserting would shuffle everything after it and move
   * panes nobody touched; trading moves exactly the two you meant.
   *
   * The order of `panes` is the order on screen, so this is the whole change —
   * the numbering, the layout and what gets saved all read from it.
   */
  movePane(workspaceId, dragId, dropId) {
    if (dragId === dropId) return
    const s = get()
    set({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const from = w.panes.findIndex((p) => p.id === dragId)
        const to = w.panes.findIndex((p) => p.id === dropId)
        if (from < 0 || to < 0) return w
        const panes = w.panes.slice()
        ;[panes[from], panes[to]] = [panes[to], panes[from]]
        return { ...w, panes }
      })
    })
    get().persist()
  },

  /** Where a divider was let go. Null puts every share back to equal. */
  setGridTracks(workspaceId, tracks) {
    const s = get()
    set({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, grid: tracks } : w))
    })
    get().persist()
  },

  closePane(workspaceId, paneId) {
    terminals.dispose(paneId)
    forgetPane(paneId)
    const s = get()
    set({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panes = w.panes.filter((p) => p.id !== paneId)
        return {
          ...w,
          panes,
          layout: Math.max(1, panes.length),
          activePaneId: w.activePaneId === paneId ? (panes[0]?.id ?? null) : w.activePaneId,
          zoomedPaneId: w.zoomedPaneId === paneId ? null : w.zoomedPaneId
        }
      }),
      notices: s.notices.filter((n) => n.paneId !== paneId)
    })
    get().persist()
  },

  focusPane(workspaceId, paneId) {
    terminals.acknowledge(paneId)
    terminals.focus(paneId)
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === workspaceId ? { ...w, activePaneId: paneId } : w
      ),
      notices: get().notices.filter((n) => n.paneId !== paneId)
    })
  },

  zoomPane(workspaceId, paneId) {
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === workspaceId ? { ...w, zoomedPaneId: paneId } : w
      )
    })
  },

  patchPane(paneId, patch) {
    set({
      workspaces: get().workspaces.map((w) => {
        if (!w.panes.some((p) => p.id === paneId)) return w
        return { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
      })
    })
  },

  restartPane(paneId) {
    const s = get()
    const workspace = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!pane) return
    get().patchPane(paneId, { status: 'idle', working: false, contextPct: null, title: null })
    // The registry does the swap: the pane component mounted once and will not
    // mount again, so it cannot re-attach the replacement terminal itself.
    terminals.restart(
      paneId,
      pane.cwd,
      {
        command: pane.command,
        agentId: pane.agentId,
        sessionId: pane.sessionId,
        host: workspace?.host
      },
      get().settings
    )
  },

  savePreset(preset) {
    const s = get()
    const exists = s.presets.some((p) => p.id === preset.id)
    set({
      presets: exists ? s.presets.map((p) => (p.id === preset.id ? preset : p)) : [...s.presets, preset]
    })
    get().persist()
  },

  deletePreset(id) {
    set({ presets: get().presets.filter((p) => p.id !== id) })
    get().persist()
  },

  touchRecent(path) {
    if (!path) return
    const s = get()
    const rest = s.recents.filter((r) => r.path !== path)
    const entry: RecentFolder = {
      path,
      name: basename(path) || path,
      lastOpened: Date.now(),
      sessions: s.recents.find((r) => r.path === path)?.sessions ?? 0
    }
    set({ recents: [entry, ...rest].slice(0, 12) })
    window.eaon.sessions.countFor(path).then((count) => {
      set({
        recents: get().recents.map((r) => (r.path === path ? { ...r, sessions: count } : r))
      })
    })
    get().persist()
  },

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    terminals.applySettings(settings)
    get().persist()
  },

  /**
   * Open the Board, Vault or Brain as its own entry in the rail.
   *
   * Opening one again brings it forward rather than stacking up duplicates.
   * How "again" is judged depends on the kind — see below.
   */
  openPanel(kind, at) {
    const s = get()
    const source = s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null
    /*
     * `at` first: the caller knows which project it means.
     *
     * Otherwise the *project* of the workspace you are in, not its own folder.
     * A worktree tab's folder is not the repository — so keying off it gave the
     * same repository a second Brain per worktree, each pointed at a checkout
     * that has no `.eaonbrain` in it at all.
     */
    const cwd = at || (source ? projectOf(source) : '') || s.recents[0]?.path || s.home
    // Wearing the colour of the folder it was opened from is what makes the
    // rail read as one project rather than a flat list.
    const hue = source?.hue ?? nextHue(s.workspaces)

    /*
     * A brain belongs to its folder; the others do not.
     *
     * The Board and the Vault hold the same contents whichever folder you came
     * from — they live in `state.json`, not beside the code — so one of each is
     * right and re-aiming it costs nothing. A brain *is* the folder's
     * `.eaonbrain`, so re-aiming the single tab at a second folder silently
     * turns the first project's Brain into the second's, and the two can never
     * be open at once. Each folder gets its own instead.
     */
    const perFolder = kind === 'brain'
    const existing = s.workspaces.find((w) => w.kind === kind && (!perFolder || w.cwd === cwd))
    if (existing) {
      set({
        workspaces: s.workspaces.map((w) => (w.id === existing.id ? { ...w, cwd, hue } : w)),
        activeWorkspaceId: existing.id,
        // As in the branch below. A stage page outranks the workspace on the
        // stage, so leaving one showing meant that going to a panel you had
        // already opened looked like a click that did nothing.
        stagePage: null,
        settingsOpen: false
      })
      get().persist()
      return
    }

    const workspace: Workspace = {
      id: uid('w_'),
      kind,
      // With one per folder, the folder is the part that tells them apart.
      name: perFolder
        ? `${PANEL_LABEL[kind]} · ${basename(cwd) || cwd}`
        : PANEL_LABEL[kind],
      cwd,
      hue,
      layout: 0,
      panes: [],
      // Equal shares until a divider is dragged.
      grid: null,
      activePaneId: null,
      zoomedPaneId: null,
      folderId: null,
      createdAt: Date.now()
    }
    set({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      stagePage: null,
      settingsOpen: false
    })
    get().persist()
  },
  toggleRail() {
    set({ railOpen: !get().railOpen })
  },
  toggleDock(tab) {
    const s = get()
    if (tab && (!s.dockOpen || s.dockTab !== tab)) set({ dockOpen: true, dockTab: tab })
    else set({ dockOpen: !s.dockOpen })
  },
  /** Switching tabs inside the dock never closes it — only the toggle does. */
  setDockTab(tab) {
    set({ dockOpen: true, dockTab: tab })
  },
  setStagePage(page) {
    set({ stagePage: page })
  },
  openFileInEditor(path, line) {
    set({ dockOpen: true, dockTab: 'editor', editorTarget: { path, line } })
  },
  clearEditorTarget() {
    set({ editorTarget: null })
  },
  setDockWidth(w) {
    set({ dockWidth: Math.min(880, Math.max(320, w)) })
  },
  toggleConductor() {
    set({ conductorOpen: !get().conductorOpen })
  },
  setPalette(open) {
    set({ paletteOpen: open })
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },
  setResumeOpen(open) {
    set({ resumeOpen: open })
  },
  setPresetEditor(id) {
    set({ presetEditorId: id })
  },
  setFindPane(id) {
    set({ findPaneId: id })
  },

  setUpdate(update) {
    // A newer version supersedes an earlier dismissal, so the card can return.
    const previous = get().update
    const changedVersion = update.version && update.version !== previous.version
    set({ update, ...(changedVersion ? { updateDismissed: null } : {}) })
  },
  dismissUpdate(version) {
    set({ updateDismissed: version })
  },

  notify(n) {
    const notice: Notice = { ...n, id: uid('n_'), at: Date.now() }
    set({ notices: [notice, ...get().notices].slice(0, 40) })
  },
  dismissNotice(id) {
    set({ notices: get().notices.filter((n) => n.id !== id) })
  },
  clearNotices() {
    set({ notices: [] })
  },

  runAutomation(a) {
    // The same path the setup wizard takes. `createWorkspace` attaches the
    // prompt through pendingPrompts, so the agent is handed it once its shell
    // is up — an automation is a remembered launch, not a second mechanism.
    get().createWorkspace({
      step: 2,
      mode: 'grid',
      cwd: a.cwd,
      layout: 1,
      agentId: a.agentId,
      prompt: a.prompt,
      presetId: null,
      isolate: false,
      host: null
    })
    // createWorkspace makes the new workspace active, so this is its id.
    const created = get().activeWorkspaceId
    if (created) openHandled.add(created)
    get().saveAutomation({ ...a, lastRunAt: Date.now() })
  },
  saveAutomation(a) {
    const s = get()
    const exists = s.automations.some((x) => x.id === a.id)
    set({
      automations: exists
        ? s.automations.map((x) => (x.id === a.id ? a : x))
        : [a, ...s.automations]
    })
    get().persist()
  },
  deleteAutomation(id) {
    set({ automations: get().automations.filter((a) => a.id !== id) })
    get().persist()
  },
  saveCard(card) {
    const s = get()
    const exists = s.board.some((c) => c.id === card.id)
    set({ board: exists ? s.board.map((c) => (c.id === card.id ? card : c)) : [card, ...s.board] })
    get().persist()
  },
  deleteCard(id) {
    set({ board: get().board.filter((c) => c.id !== id) })
    get().persist()
  },
  saveNote(note) {
    const s = get()
    const exists = s.vault.some((n) => n.id === note.id)
    set({ vault: exists ? s.vault.map((n) => (n.id === note.id ? note : n)) : [note, ...s.vault] })
    get().persist()
  },
  deleteNote(id) {
    set({ vault: get().vault.filter((n) => n.id !== id) })
    get().persist()
  },
  dismissResume(ids) {
    set({ dismissedResume: [...new Set([...get().dismissedResume, ...ids])].slice(-200) })
    get().persist()
  }
}))

/** Convenience selector — the workspace currently shown in the stage. */
export function useActiveWorkspace(): Workspace | null {
  return useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { useStore: typeof useStore }).useStore = useStore
}
