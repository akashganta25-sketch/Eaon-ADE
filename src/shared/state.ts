/**
 * Shape repair for a state file read back from disk.
 *
 * `state.json` is ours, but it is a file on somebody's disk: it can be edited
 * by hand, written by an older or newer build, or restored from a backup. The
 * renderer walks it without checking — `workspace.panes.map(...)` — so one
 * field of the wrong type used to throw inside hydrate and leave the window
 * stuck before it ever drew anything.
 *
 * This is deliberately conservative. It never invents data and never drops a
 * record that has the minimum needed to be shown (an object with a string
 * id); it only replaces values that cannot possibly be used — a list that is
 * not a list, a workspace whose panes are not an array — with the empty value
 * the rest of the app already treats as "nothing here". No runtime imports, so
 * both processes and the check scripts can load it.
 */
import type { PersistedState } from './types'

type Loose = Record<string, unknown>

const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Keeps only object entries that carry a non-empty string id. */
function records<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((v) => isObj(v) && typeof v.id === 'string' && v.id.length > 0) as T[]
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Every list field the app reads straight off persisted state. */
const RECORD_LISTS = ['folders', 'presets', 'board', 'vault', 'trials', 'automations'] as const

/** A workspace with the fields the renderer dereferences made safe to walk. */
function workspace(w: Loose): Loose {
  return {
    ...w,
    panes: records(w.panes),
    name: typeof w.name === 'string' ? w.name : 'Workspace',
    cwd: typeof w.cwd === 'string' ? w.cwd : ''
  }
}

export function normalizeState(input: unknown): Partial<PersistedState> {
  if (!isObj(input)) throw new Error('state is not an object')
  const out: Loose = { ...input }

  out.workspaces = records<Loose>(input.workspaces).map(workspace)

  for (const key of RECORD_LISTS) {
    if (key in input) out[key] = records(input[key])
  }

  // Recents are keyed by path, not id.
  out.recents = Array.isArray(input.recents)
    ? input.recents.filter((r) => isObj(r) && typeof r.path === 'string')
    : []
  out.dismissedResume = strings(input.dismissedResume)
  if ('closedTabs' in input) {
    // Each one carries a whole workspace, which reopening walks like any other.
    out.closedTabs = Array.isArray(input.closedTabs)
      ? input.closedTabs
          .filter((c) => isObj(c) && isObj(c.workspace) && typeof c.workspace.id === 'string')
          .map((c) => ({ ...c, workspace: workspace(c.workspace as Loose) }))
      : []
  }

  out.activeWorkspaceId = typeof input.activeWorkspaceId === 'string' ? input.activeWorkspaceId : null
  out.settings = isObj(input.settings) ? input.settings : {}

  return out as Partial<PersistedState>
}
