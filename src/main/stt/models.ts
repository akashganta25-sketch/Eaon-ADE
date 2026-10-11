import fs from 'node:fs'
import path from 'node:path'
import { app, net } from 'electron'
import {
  STT_MODELS,
  findModel,
  modelFiles,
  type DownloadProgress,
  type InstalledModel,
  type SttModelDef
} from '../../shared/stt'
import { isolatedProfile } from '../profile'

const HF = 'https://huggingface.co'

/**
 * Where downloaded speech models live. The layout mirrors what transformers.js
 * expects from a local model path — `<root>/<owner>/<name>/…` — so the
 * transcriber can point straight at this folder and never ask the network.
 */
export function modelsDir(): string {
  return path.join(app.getPath('userData'), 'speech-models')
}

/** User-data folders this app has used under previous names. Newest first. */
const LEGACY_APP_DIRS = ['ADE', 'Eaon']

/**
 * Carry downloaded models across a rename of the app.
 *
 * Renaming the app moves its user-data folder, and the models are by far the
 * most expensive thing in it — a large model is most of a gigabyte over someone
 * else's connection. `Store` already rescues `state.json` the same way; without
 * this, a rename quietly reports every model as not downloaded and asks the
 * user to fetch them all again.
 *
 * Moved rather than copied: it is the same volume, so this is a rename of a
 * directory entry rather than a gigabyte of I/O.
 */
export function migrateFromPreviousName(): void {
  // A test profile must never move a real install's models into itself.
  if (isolatedProfile()) return
  try {
    const target = modelsDir()
    if (fs.existsSync(target)) return

    for (const name of LEGACY_APP_DIRS) {
      const legacy = path.join(app.getPath('appData'), name, 'speech-models')
      if (!fs.existsSync(legacy)) continue
      if (path.resolve(legacy) === path.resolve(target)) return

      fs.mkdirSync(path.dirname(target), { recursive: true })
      try {
        fs.renameSync(legacy, target)
      } catch {
        // Different volume, or the folder is otherwise pinned. Worth the copy.
        fs.cpSync(legacy, target, { recursive: true })
      }
      return
    }
  } catch {
    /* the cost of a failed migration is a re-download, never a broken launch */
  }
}

function dirFor(m: SttModelDef): string {
  // Repos come from our own catalogue, but a stray "..'" would escape the
  // store, so the join is checked rather than trusted.
  const target = path.join(modelsDir(), m.repo)
  if (!target.startsWith(modelsDir() + path.sep)) throw new Error('bad model path')
  return target
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** A model counts as installed only when every file it needs is present. */
export function inspect(m: SttModelDef): InstalledModel {
  const root = dirFor(m)
  const files = modelFiles(m)
  let bytes = 0
  let complete = true
  for (const rel of files) {
    const n = sizeOf(path.join(root, rel))
    if (n === 0) complete = false
    bytes += n
  }
  let installedAt = 0
  try {
    installedAt = fs.statSync(root).mtimeMs
  } catch {
    complete = false
  }
  return { id: m.id, repo: m.repo, bytes, complete, installedAt }
}

export function listInstalled(): InstalledModel[] {
  return STT_MODELS.map(inspect).filter((r) => r.bytes > 0)
}

export function usage(): number {
  return listInstalled().reduce((n, m) => n + m.bytes, 0)
}

export function isReady(modelId: string): boolean {
  const m = findModel(modelId)
  return m ? inspect(m).complete : false
}

/** Absolute path a loaded model is read from. */
export function pathFor(modelId: string): string | null {
  const m = findModel(modelId)
  return m ? dirFor(m) : null
}

export function remove(modelId: string): void {
  const m = findModel(modelId)
  if (!m) return
  const root = dirFor(m)
  fs.rmSync(root, { recursive: true, force: true })
  // Leaving "onnx-community/" behind after its last model is just litter.
  const owner = path.dirname(root)
  try {
    if (owner !== modelsDir() && fs.readdirSync(owner).length === 0) fs.rmdirSync(owner)
  } catch {
    /* an owner folder that will not go is harmless */
  }
}

interface TreeEntry {
  type: string
  path: string
  size?: number
  lfs?: { size?: number }
}

/**
 * Ask the repo how big its files really are before committing the user to a
 * download. Also catches a renamed or missing precision early, with a message
 * that says which file, instead of a 404 halfway through.
 */
async function resolveManifest(m: SttModelDef): Promise<{ rel: string; size: number }[]> {
  const wanted = modelFiles(m)
  const url = `${HF}/api/models/${m.repo}/tree/main?recursive=true`
  let entries: TreeEntry[]
  try {
    const res = await net.fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    entries = (await res.json()) as TreeEntry[]
  } catch (err) {
    // No listing means no sizes, but the download itself can still work.
    return wanted.map((rel) => ({ rel, size: 0 }))
  }

  const byPath = new Map<string, number>()
  for (const e of entries) {
    if (e.type !== 'file') continue
    byPath.set(e.path, e.lfs?.size ?? e.size ?? 0)
  }

  const missing = wanted.filter((rel) => !byPath.has(rel))
  if (missing.length) {
    throw new Error(`${m.repo} no longer publishes ${missing.join(', ')}`)
  }
  return wanted.map((rel) => ({ rel, size: byPath.get(rel) ?? 0 }))
}

const inFlight = new Map<string, AbortController>()

export function cancel(modelId: string): void {
  inFlight.get(modelId)?.abort()
}

export function isDownloading(modelId: string): boolean {
  return inFlight.has(modelId)
}

/**
 * Fetch every file a model needs, reporting progress as it goes.
 *
 * Each file lands on a `.part` and is renamed only once it is whole, so a
 * cancelled or crashed download can never leave something that looks installed.
 */
export async function download(
  modelId: string,
  onProgress: (p: DownloadProgress) => void
): Promise<void> {
  const m = findModel(modelId)
  if (!m) throw new Error(`Unknown model ${modelId}`)
  if (inFlight.has(modelId)) return

  const controller = new AbortController()
  inFlight.set(modelId, controller)
  const root = dirFor(m)

  try {
    const manifest = await resolveManifest(m)
    const total = manifest.reduce((n, f) => n + f.size, 0) || m.size

    // Files already whole from an earlier run are counted, not re-fetched.
    let received = 0
    for (const f of manifest) {
      const have = sizeOf(path.join(root, f.rel))
      if (have > 0 && (f.size === 0 || have === f.size)) received += have
    }
    onProgress({ modelId, received, total, file: '', done: false })

    for (const f of manifest) {
      const dest = path.join(root, f.rel)
      const have = sizeOf(dest)
      if (have > 0 && (f.size === 0 || have === f.size)) continue

      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const part = `${dest}.part`
      const url = `${HF}/${m.repo}/resolve/main/${f.rel}?download=true`

      const res = await net.fetch(url, { signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`${f.rel}: ${res.status} ${res.statusText}`)

      const out = fs.createWriteStream(part)
      const reader = res.body.getReader()
      let fileGot = 0
      // Progress is reported at most ~20x/sec; a 400 MB file otherwise floods
      // the renderer with thousands of identical-looking frames.
      let lastTick = 0

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => out.once('drain', resolve))
          }
          fileGot += value.byteLength
          const now = Date.now()
          if (now - lastTick > 50) {
            lastTick = now
            onProgress({ modelId, received: received + fileGot, total, file: f.rel, done: false })
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve())
          out.on('error', reject)
        })
      } catch (err) {
        out.destroy()
        fs.rmSync(part, { force: true })
        throw err
      }

      fs.renameSync(part, dest)
      received += fileGot
      onProgress({ modelId, received, total, file: f.rel, done: false })
    }

    onProgress({ modelId, received: total, total, file: '', done: true })
  } catch (err) {
    const aborted = controller.signal.aborted
    // A cancel is a choice, not a failure — take the partial files with us.
    if (aborted) remove(modelId)
    onProgress({
      modelId,
      received: 0,
      total: 0,
      file: '',
      done: true,
      error: aborted ? 'Cancelled' : String(err instanceof Error ? err.message : err)
    })
    if (!aborted) throw err
  } finally {
    inFlight.delete(modelId)
  }
}
