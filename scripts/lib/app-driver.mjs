/**
 * Launches the built Eaon ADE (out/) against a throwaway profile and drives it
 * over the DevTools protocol.
 *
 * This is the runtime half of the checks: the check-*.mjs scripts prove the
 * logic in isolation, this proves the logic is wired up — that the window
 * mounts, the preload bridge answers, IPC handlers reach the real modules and
 * state survives a restart. It never touches a real profile:
 *
 *   - EAON_USER_DATA_DIR points userData at a fresh temporary folder, and the
 *     legacy-name migrations stand down when it is set (src/main/profile.ts).
 *   - A state.json is always written before launch, so nothing is adopted.
 *   - Every pane the tests open runs in a temporary directory.
 *
 * Requires `npm run build` first (it runs out/main/index.js).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nextPort = 9400 + Math.floor(Math.random() * 400)

/** A minimal, valid state file. */
export function baseState(extra = {}) {
  return {
    version: 1,
    workspaces: [],
    folders: [],
    activeWorkspaceId: null,
    presets: [],
    recents: [],
    settings: {},
    board: [],
    vault: [],
    dismissedResume: [],
    ...extra
  }
}

export function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * Starts the app. `userData` may be reused across launches to test
 * persistence; `state` (object or raw string) is written only when given or
 * when the folder has no state yet.
 */
export async function launch({ userData, state, env = {}, timeoutMs = 60000 } = {}) {
  const dir = userData ?? tempDir('eaon-e2e-profile-')
  const stateFile = path.join(dir, 'state.json')
  if (state !== undefined) {
    fs.writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state))
  } else if (!fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, JSON.stringify(baseState()))
  }

  const port = nextPort++
  const electron = require('electron')
  const child = spawn(electron, [path.join(ROOT, 'out', 'main', 'index.js'), `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, ...env, EAON_USER_DATA_DIR: dir, ELECTRON_RENDERER_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))

  const deadline = Date.now() + timeoutMs
  let page = null
  while (Date.now() < deadline && !page) {
    if (child.exitCode !== null) throw new Error(`app exited early (${child.exitCode}):\n${log.slice(-3000)}`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      page = targets.find((t) => t.type === 'page' && t.url.includes('index.html') && t.webSocketDebuggerUrl)
    } catch {
      /* not listening yet */
    }
    if (!page) await sleep(300)
  }
  if (!page) {
    child.kill('SIGKILL')
    throw new Error(`no renderer within ${timeoutMs}ms:\n${log.slice(-3000)}`)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  let id = 1
  const pending = new Map()
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = id++
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000)
      pending.set(myId, (m) => {
        clearTimeout(timer)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result)
      })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  await send('Runtime.enable')

  /** Evaluates an expression (may return a promise) and hands back its value. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result?.value
  }

  /** Polls a boolean expression until true or timeout. */
  const waitFor = async (expression, ms = 15000, every = 100) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true
      } catch {
        /* page mid-navigation */
      }
      await sleep(every)
    }
    return false
  }

  const app = {
    userData: dir,
    stateFile,
    child,
    send,
    evaluate,
    waitFor,
    consoleErrors,
    log: () => log,
    /** Graceful quit through the app's own shutdown path (SIGTERM handler). */
    async quit(ms = 10000) {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      if (child.exitCode !== null) return child.exitCode
      child.kill('SIGTERM')
      const end = Date.now() + ms
      while (child.exitCode === null && child.signalCode === null && Date.now() < end) await sleep(100)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      return child.exitCode ?? child.signalCode
    },
    readState() {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    }
  }
  return app
}

/** Tiny assertion recorder shared by the e2e scripts. */
export function recorder(title) {
  const results = []
  let section = ''
  return {
    section(name) {
      section = name
      console.log(`\n${name}`)
    },
    check(label, ok, detail) {
      results.push({ section, label, ok: Boolean(ok), detail })
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`)
    },
    results,
    finish() {
      const failed = results.filter((r) => !r.ok).length
      console.log(`\n${title}: ${results.length - failed} passed, ${failed} failed`)
      return failed
    }
  }
}
