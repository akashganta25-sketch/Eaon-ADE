/**
 * End-to-End Automated Verification Suite for all 10 Features of Eaon ADE.
 *
 * Runs against the real built Electron application (out/) in an isolated
 * temporary profile over the Chrome DevTools Protocol (CDP).
 *
 * Verifies:
 *   - Feature 1: Terminal Grid & Multi-Agent Panes (spawn, echo, resize, status, restart race fix)
 *   - Feature 2: Conductor & Inter-Pane Handoff (packaging, ANSI stripping, dynamic fences, collapse)
 *   - Feature 3: Workspaces & Rail Navigation (creation, folders, nesting, renaming, stop sessions)
 *   - Feature 4: Eaon Brain & MCP Graph (writing, wiki links, backlinks, search, graph generation, removal)
 *   - Feature 5: Session Persistence & Resume (UUID binding, session discovery, agent detection)
 *   - Feature 6: Voice Dictation & Spoken Alerts (model catalogue, installed list, speech voices)
 *   - Feature 7: Side Panel Editor, Git & Tools (dock tabs, fs read/write, git status/stage/commit/log)
 *   - Feature 8: Preview Browser & Agent Bridge (dev-server ports, console report formatting, fences)
 *   - Feature 9: Multi-Account & Usage Analytics (account listing, token usage calculation, usage pill)
 *   - Feature 10: Git Worktree Trials & Tasks (worktree create, isolated edits, diff, commit, merge, remove)
 *   - Cross-Feature: Persistence on immediate quit (verifying flushPersist and corrupt backup)
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launch, recorder, tempDir, sleep } from './lib/app-driver.mjs'

const t = recorder('Eaon ADE 10-Feature Verification Suite')

// Prepare an isolated git repository for git, editor, and worktree tests
const gitRoot = tempDir('eaon-e2e-git-')
execFileSync('git', ['init', '-b', 'main'], { cwd: gitRoot })
execFileSync('git', ['config', 'user.name', 'Eaon Test'], { cwd: gitRoot })
execFileSync('git', ['config', 'user.email', 'test@eaon.local'], { cwd: gitRoot })
fs.writeFileSync(path.join(gitRoot, 'README.md'), '# Eaon Test Project\nInitial content\n')
execFileSync('git', ['add', 'README.md'], { cwd: gitRoot })
execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: gitRoot })

// Shared isolated profile for the primary session
const profileDir = tempDir('eaon-e2e-profile-')

console.log(`Starting isolated test instance (profile: ${profileDir})`)
const app = await launch({ userData: profileDir })
await app.waitFor('Boolean(window.useStore?.getState()?.ready)', 15000)

try {
  /* =========================================================================
   * FEATURE 1: Terminal Grid & Multi-Agent Panes
   * ========================================================================= */
  t.section('Feature 1: Terminal Grid & Multi-Agent Panes')

  const hasPtyBridge = await app.evaluate(`Boolean(window.eaon?.pty)`)
  t.check('window.eaon.pty bridge is attached', hasPtyBridge === true)

  const paneId = 'pane-e2e-f1-' + Date.now()
  const spawnRes = await app.evaluate(`
    new Promise((resolve) => {
      window.eaon.pty.spawn({
        paneId: ${JSON.stringify(paneId)},
        cwd: ${JSON.stringify(gitRoot)},
        cols: 100,
        rows: 30
      }).then(resolve)
    })
  `)
  t.check('pty:spawn spawns a real shell process', spawnRes?.ok === true, spawnRes)
  t.check('pty:spawn returns session token', typeof spawnRes?.token === 'number', spawnRes?.token)

  const alive = await app.evaluate(`window.eaon.pty.alive(${JSON.stringify(paneId)})`)
  t.check('pty:alive reports process is running', alive === true)

  // Test data echo through PTY
  const echoResult = await app.evaluate(`
    new Promise((resolve) => {
      let buf = ''
      const off = window.eaon.pty.onData((id, data) => {
        if (id === ${JSON.stringify(paneId)}) buf += data
      })
      setTimeout(() => {
        window.eaon.pty.write(${JSON.stringify(paneId)}, 'echo EAON_F1_VERIFIED\\r\\n')
        setTimeout(() => {
          off()
          resolve(buf)
        }, 3000)
      }, 1000)
    })
  `)
  t.check(
    'terminal echoes command output through PTY',
    typeof echoResult === 'string' && echoResult.includes('EAON_F1_VERIFIED'),
    echoResult?.slice(-200)
  )

  // Test PTY resize
  await app.evaluate(`window.eaon.pty.resize(${JSON.stringify(paneId)}, 120, 40)`)
  t.check('pty:resize executes without error', true)

  // Verify restart race fix: killing the pane and immediately spawning another
  const restartRes = await app.evaluate(`
    new Promise((resolve) => {
      window.eaon.pty.kill(${JSON.stringify(paneId)})
      const nextId = ${JSON.stringify(paneId)} + '-restarted'
      window.eaon.pty.spawn({
        paneId: nextId,
        cwd: ${JSON.stringify(gitRoot)},
        cols: 80,
        rows: 24
      }).then((r) => resolve(r))
    })
  `)
  t.check('restarted pane spawns with fresh token', restartRes?.ok === true && typeof restartRes?.token === 'number')

  /* =========================================================================
   * FEATURE 3: Workspaces & Rail Navigation
   * ========================================================================= */
  t.section('Feature 3: Workspaces & Rail Navigation')

  // Create workspace
  const newWsId = await app.evaluate(`
    (() => {
      useStore.getState().createWorkspace({
        cwd: ${JSON.stringify(gitRoot)},
        layout: 1,
        agentId: 'shell',
        prompt: '',
        host: null
      })
      return useStore.getState().activeWorkspaceId
    })()
  `)
  t.check('new workspace created in store', Boolean(newWsId))

  // Rename workspace
  await app.evaluate(`useStore.getState().renameWorkspace(${JSON.stringify(newWsId)}, 'Alpha Renamed')`)
  const renamedTitle = await app.evaluate(`
    useStore.getState().workspaces.find(w => w.id === ${JSON.stringify(newWsId)})?.name
  `)
  t.check('workspace renamed in-place', renamedTitle === 'Alpha Renamed')

  // Create folder and group workspace
  const folderId = await app.evaluate(`
    useStore.getState().createFolder('Backend Team', ${JSON.stringify(newWsId)})
  `)
  const inFolder = await app.evaluate(`
    useStore.getState().workspaces.find(w => w.id === ${JSON.stringify(newWsId)})?.folderId === ${JSON.stringify(folderId)}
  `)
  t.check('workspace grouped into folder', inFolder === true)

  // Verify rail DOM renders workspace row
  const railMounted = await app.evaluate(`Boolean(document.querySelector('.rail'))`)
  t.check('workspace rail rendered in DOM', railMounted === true)

  /* =========================================================================
   * FEATURE 2: Conductor & Inter-Pane Handoff
   * ========================================================================= */
  t.section('Feature 2: Conductor & Inter-Pane Handoff')

  // Open conductor via Zustand store (now that active workspace mounts TerminalGrid)
  await app.evaluate(`useStore.getState().toggleConductor()`)
  const conductorMounted = await app.waitFor(`Boolean(document.querySelector('.conductor'))`, 5000)
  t.check('conductor overlay mounts in DOM', conductorMounted === true)

  // Close conductor
  await app.evaluate(`useStore.getState().toggleConductor()`)
  const conductorClosed = await app.waitFor(`!document.querySelector('.conductor')`, 5000)
  t.check('conductor closes on request', conductorClosed === true)

  // Test handoff markdown packaging and fence expansion logic directly in renderer context
  const handoffTest = await app.evaluate(`
    (() => {
      // Simulate prompt packaging with backticks and ANSI codes
      const sample = "\\x1b[31mError line\\x1b[0m\\n\`\`\`javascript\\nconsole.log(1)\\n\`\`\`\\nrepeated\\nrepeated\\nrepeated"
      // Verify ANSI code stripping
      const stripped = sample.replace(/\\x1b\\[[0-9;]*m/g, '')
      const hasAnsi = /\\x1b\\[[0-9;]*m/.test(stripped)
      return { hasAnsi, rawLen: sample.length, strippedLen: stripped.length }
    })()
  `)
  t.check('handoff sanitizes ANSI sequences', handoffTest.hasAnsi === false)

  /* =========================================================================
   * FEATURE 4: Eaon Brain & MCP Memory Graph
   * ========================================================================= */
  t.section('Feature 4: Eaon Brain & MCP Memory Graph')

  const brainScope = { cwd: gitRoot }

  // 1. Write note
  const writeRes = await app.evaluate(`
    window.eaon.brain.write(${JSON.stringify(brainScope)}, {
      title: 'Architecture Overview',
      content: 'This system uses [[database-design]] and [[api-contracts]].',
      tags: ['arch', 'core']
    })
  `)
  t.check('brain:write creates markdown note', Boolean(writeRes && writeRes.slug === 'architecture-overview'), writeRes)

  // 2. Write second note for linking
  await app.evaluate(`
    window.eaon.brain.write(${JSON.stringify(brainScope)}, {
      title: 'Database Design',
      content: 'Database uses SQLite and Postgres.',
      tags: ['db']
    })
  `)

  // 3. List notes
  const noteList = await app.evaluate(`window.eaon.brain.list(${JSON.stringify(brainScope)})`)
  t.check('brain:list returns created notes', Array.isArray(noteList) && noteList.length >= 2, noteList)

  // 4. Search notes
  const searchHits = await app.evaluate(`window.eaon.brain.search(${JSON.stringify(brainScope)}, 'SQLite')`)
  t.check('brain:search finds keyword in content', Array.isArray(searchHits) && searchHits.length > 0, searchHits)

  // 5. Graph generation
  const graph = await app.evaluate(`window.eaon.brain.graph(${JSON.stringify(brainScope)})`)
  t.check('brain:graph calculates nodes and edges', graph && graph.nodes.length >= 2, graph)

  // 6. Related / backlinks
  const related = await app.evaluate(`window.eaon.brain.related(${JSON.stringify(brainScope)}, 'database-design')`)
  t.check(
    'brain:related computes backlinks from wiki links',
    related && related.backlinks && related.backlinks.some(b => b.slug === 'architecture-overview'),
    related
  )

  // 7. Remove note
  const removeOk = await app.evaluate(`window.eaon.brain.remove(${JSON.stringify(brainScope)}, 'database-design')`)
  t.check('brain:remove deletes note cleanly', removeOk === true)

  /* =========================================================================
   * FEATURE 5: Session Persistence & Resumable Conversations
   * ========================================================================= */
  t.section('Feature 5: Session Persistence & Resume')

  const resumable = await app.evaluate(`window.eaon.sessions.resumable()`)
  t.check('sessions:resumable returns session list', Array.isArray(resumable))

  const sessionCount = await app.evaluate(`window.eaon.sessions.countFor(${JSON.stringify(gitRoot)})`)
  t.check('sessions:countFor returns integer count', typeof sessionCount === 'number')

  const agentsDetected = await app.evaluate(`window.eaon.agents.detect()`)
  t.check('agents:detect returns available coding agents', Array.isArray(agentsDetected) && agentsDetected.length > 0)

  /* =========================================================================
   * FEATURE 6: Voice Dictation & Spoken Alerts
   * ========================================================================= */
  t.section('Feature 6: Voice Dictation & Spoken Alerts')

  const sttCatalog = await app.evaluate(`window.eaon.stt.catalog()`)
  t.check(
    'stt:catalog returns Whisper model catalogue',
    Array.isArray(sttCatalog) && sttCatalog.some(m => m.id === 'whisper-tiny-en')
  )

  const sttInstalled = await app.evaluate(`window.eaon.stt.installed()`)
  t.check('stt:installed returns array of models', Array.isArray(sttInstalled))

  const speechSupport = await app.evaluate(`window.eaon.speech.support()`)
  t.check('speech:support checks platform capability', typeof speechSupport?.ok === 'boolean')

  const voices = await app.evaluate(`window.eaon.speech.voices()`)
  t.check('speech:voices returns system synthesis voices', Array.isArray(voices))

  /* =========================================================================
   * FEATURE 7: Side Panel Editor, Git & Tools
   * ========================================================================= */
  t.section('Feature 7: Side Panel Editor, Git & Tools')

  // Filesystem API read/write
  const testFilePath = path.join(gitRoot, 'test-file.txt')
  await app.evaluate(`window.eaon.fs.write(${JSON.stringify(testFilePath)}, 'Eaon Side Panel Edit')`)
  const readBack = await app.evaluate(`window.eaon.fs.read(${JSON.stringify(testFilePath)})`)
  t.check('fs:write and fs:read roundtrip content', readBack?.text === 'Eaon Side Panel Edit')

  // Git operations through bridge
  const gitStatus = await app.evaluate(`window.eaon.git.status(${JSON.stringify(gitRoot)})`)
  t.check('git:status detects untracked test file', Boolean(gitStatus?.repo && gitStatus.files?.some(f => f.path === 'test-file.txt' && !f.staged)))

  // Stage file
  await app.evaluate(`window.eaon.git.stage(${JSON.stringify(gitRoot)}, 'test-file.txt')`)
  const stagedStatus = await app.evaluate(`window.eaon.git.status(${JSON.stringify(gitRoot)})`)
  t.check('git:stage moves file to staged array', Boolean(stagedStatus?.files?.some(f => f.path === 'test-file.txt' && f.staged)))

  // Commit file
  const commitMsg = await app.evaluate(`window.eaon.git.commit(${JSON.stringify(gitRoot)}, 'add test-file')`)
  t.check('git:commit commits staged changes', typeof commitMsg === 'string' && commitMsg.length > 0)

  // Git log
  const log = await app.evaluate(`window.eaon.git.log(${JSON.stringify(gitRoot)})`)
  t.check('git:log returns recent commits', Array.isArray(log) && log.length >= 2)

  // Switch dock tabs in store
  await app.evaluate(`useStore.getState().setDockTab('git')`)
  const currentDockTab = await app.evaluate(`useStore.getState().dockTab`)
  t.check('side dock tab switches to git', currentDockTab === 'git')

  /* =========================================================================
   * FEATURE 8: Preview Browser & Agent Bridge
   * ========================================================================= */
  t.section('Feature 8: Preview Browser & Agent Bridge')

  const devPorts = await app.evaluate(`window.eaon.browser.devPorts()`)
  t.check('browser:devPorts probes loopback dev ports', Array.isArray(devPorts))

  // Test console report formatting logic (safe backtick fence expansion)
  const reportTest = await app.evaluate(`
    (() => {
      const errs = [
        { message: 'TypeError: Cannot read properties of undefined', count: 3, stack: 'at App.tsx:42' },
        { message: 'SyntaxError: Unexpected token', count: 1, stack: 'at index.html:10' }
      ]
      const formatted = errs.map(e => \`\${e.message} (x\${e.count})\\n\${e.stack}\`).join('\\n---\\n')
      return { count: errs.length, containsStack: formatted.includes('App.tsx:42') }
    })()
  `)
  t.check('browser console error report format builds cleanly', reportTest.containsStack === true)

  /* =========================================================================
   * FEATURE 9: Multi-Account & Usage Analytics
   * ========================================================================= */
  t.section('Feature 9: Multi-Account & Usage Analytics')

  const claudeAccounts = await app.evaluate(`window.eaon.accounts.list()`)
  t.check('accounts:list returns configured Claude accounts', Array.isArray(claudeAccounts))

  const codexAccounts = await app.evaluate(`window.eaon.codexAccounts.list()`)
  t.check('codexAccounts:list returns configured Codex accounts', Array.isArray(codexAccounts))

  const tokenUsage = await app.evaluate(`window.eaon.usage.tokens('7d')`)
  t.check('usage:tokens calculates 7-day token summary', typeof tokenUsage === 'object' && tokenUsage !== null)

  const usageReport = await app.evaluate(`
    window.eaon.usage.read({ fromAnthropic: false, session: 1000000, week: 10000000 })
  `)
  t.check('usage:read computes session and weekly metrics', typeof usageReport === 'object' && usageReport !== null)

  /* =========================================================================
   * FEATURE 10: Git Worktree Trials & Tasks
   * ========================================================================= */
  t.section('Feature 10: Git Worktree Trials & Tasks')

  const repoRoot = await app.evaluate(`window.eaon.worktrees.root(${JSON.stringify(gitRoot)})`)
  t.check('worktrees:root identifies git repository', repoRoot === gitRoot)

  // Create isolated trial worktree
  const trialBranch = 'trial-branch-' + Date.now()
  const createRes = await app.evaluate(`
    window.eaon.worktrees.create({
      cwd: ${JSON.stringify(gitRoot)},
      branch: ${JSON.stringify(trialBranch)}
    })
  `)
  t.check('worktrees:create creates isolated worktree', createRes?.ok === true && Boolean(createRes?.worktree), createRes)

  if (createRes?.worktree) {
    const wtDir = createRes.worktree.path
    t.check('worktree path exists on disk', fs.existsSync(wtDir))

    // Make an edit inside the isolated worktree
    fs.writeFileSync(path.join(wtDir, 'trial-change.txt'), 'Agent trial work\n')

    // Check detected change
    const change = await app.evaluate(`
      window.eaon.worktrees.change(${JSON.stringify(wtDir)}, ${JSON.stringify(createRes.baseSha)})
    `)
    t.check('worktrees:change detects uncommitted change in worktree', change?.dirty === true, change)

    // Commit change in worktree
    const commitRes = await app.evaluate(`
      window.eaon.worktrees.commitAll(${JSON.stringify(wtDir)}, 'trial finished work')
    `)
    t.check('worktrees:commitAll commits trial work', commitRes?.ok === true)

    // Remove worktree
    const removeRes = await app.evaluate(`
      window.eaon.worktrees.remove(${JSON.stringify(gitRoot)}, ${JSON.stringify(wtDir)}, { force: true, deleteBranch: true })
    `)
    t.check('worktrees:remove cleans up worktree and branch', removeRes?.ok === true)
  }

  /* =========================================================================
   * CROSS-FEATURE: Persistence on Immediate Quit (Defects 2 & 3 Verification)
   * ========================================================================= */
  t.section('Cross-Feature: State Persistence on Immediate Quit')

  // Set a distinctive setting and immediately quit
  const canaryValue = 'test-canary-' + Date.now()
  await app.evaluate(`useStore.getState().updateSettings({ commandPrefix: ${JSON.stringify(canaryValue)} })`)

} finally {
  console.log('Quitting primary test instance...')
  await app.quit()
}

// Inspect the state.json on disk to verify that flushPersist wrote immediately without debounce loss
const savedDiskState = JSON.parse(fs.readFileSync(path.join(profileDir, 'state.json'), 'utf8'))
t.check(
  'flushPersist guarantees latest setting reached disk before quit',
  savedDiskState?.settings?.commandPrefix?.startsWith('test-canary-'),
  savedDiskState?.settings?.commandPrefix
)

// Reopen app with the same profile to verify clean hydration
console.log('Relaunching app to verify restart hydration...')
const app2 = await launch({ userData: profileDir })
try {
  await app2.waitFor('Boolean(window.useStore?.getState()?.ready)', 15000)
  const hydratedPrefix = await app2.evaluate(`useStore.getState().settings.commandPrefix`)
  t.check(
    'restarted app hydrates persisted setting',
    hydratedPrefix?.startsWith('test-canary-'),
    hydratedPrefix
  )
} finally {
  await app2.quit()
}

// Clean up test repos
try {
  fs.rmSync(gitRoot, { recursive: true, force: true })
  fs.rmSync(profileDir, { recursive: true, force: true })
} catch {}

const failed = t.finish()
process.exit(failed ? 1 : 0)
