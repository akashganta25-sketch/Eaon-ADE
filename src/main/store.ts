import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type PersistedState } from '../shared/types'
import { isolatedProfile } from './profile'
import { normalizeState } from '../shared/state'

const STATE_VERSION = 1

function emptyState(): PersistedState {
  return {
    version: STATE_VERSION,
    workspaces: [],
    folders: [],
    activeWorkspaceId: null,
    presets: [],
    recents: [],
    settings: { ...DEFAULT_SETTINGS },
    board: [],
    vault: [],
    dismissedResume: []
  }
}

/**
 * Single JSON document in the app's user-data folder. Writes go to a temp file
 * first so a crash mid-save can never leave a truncated state behind.
 */
export class Store {
  private file: string
  private cache: PersistedState | null = null
  private writeTimer: NodeJS.Timeout | null = null

  constructor(dir: string = app.getPath('userData')) {
    this.file = path.join(dir, 'state.json')
    this.migrateFromPreviousName()
  }

  /**
   * The app has been renamed more than once, and each name meant a different
   * user-data folder. Carry the newest surviving one across so a rename never
   * reads as "all my workspaces vanished". Newest first.
   */
  private migrateFromPreviousName(): void {
    // A throwaway test profile must never adopt a real person's workspaces.
    if (isolatedProfile()) return
    const LEGACY_NAMES = ['ADE', 'Eaon']
    try {
      if (fs.existsSync(this.file)) return
      for (const name of LEGACY_NAMES) {
        const legacy = path.join(app.getPath('appData'), name, 'state.json')
        if (!fs.existsSync(legacy)) continue
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.copyFileSync(legacy, this.file)
        return
      }
    } catch {
      /* a failed migration just means starting fresh */
    }
  }

  get path(): string {
    return this.file
  }

  load(): PersistedState {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      // No file yet: a first launch, not a problem.
      this.cache = emptyState()
      return this.cache
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const base = emptyState()
      const clean = normalizeState(parsed)
      this.cache = {
        ...base,
        ...clean,
        settings: { ...base.settings, ...(clean.settings ?? {}) },
        version: STATE_VERSION
      }
    } catch (err) {
      /*
       * A file that is there but cannot be read as state.
       *
       * Starting empty is the only way to open, but the very next save would
       * replace the file — and with it every workspace somebody had — with
       * that empty state. Keep the original beside it first, so whatever went
       * wrong (a hand edit, a disk fault, a newer build's format) costs a
       * restore rather than the data.
       */
      this.preserveUnreadable(err)
      this.cache = emptyState()
    }
    return this.cache
  }

  /** Copies an unreadable state file aside so the next save cannot destroy it. */
  private preserveUnreadable(err: unknown): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const aside = `${this.file}.unreadable-${stamp}`
      fs.copyFileSync(this.file, aside)
      console.error(
        `[eaon] state.json could not be read (${err instanceof Error ? err.message : String(err)}); ` +
          `kept a copy at ${aside} and started fresh`
      )
    } catch {
      /* nothing more can be done; starting fresh is still better than not starting */
    }
  }

  /** Debounced so rapid UI updates collapse into one disk write. */
  save(next: PersistedState): void {
    // Anything arriving over IPC is untrusted shape-wise; never cache junk
    // that a later load would then have to throw away.
    if (!next || typeof next !== 'object') return
    this.cache = { ...next, version: STATE_VERSION }
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (!this.cache) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      // A failed save must never take the app down — but it must not vanish
      // without a trace either, or "my workspaces did not come back" has no
      // cause anyone can find.
      console.error('[eaon] could not save state:', err instanceof Error ? err.message : err)
    }
  }

  reset(): PersistedState {
    this.cache = emptyState()
    this.flush()
    return this.cache
  }
}
