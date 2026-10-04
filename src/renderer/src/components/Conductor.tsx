import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize2, Mic, Minimize2, Radio, SendHorizontal, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import {
  DEFAULT_INSTRUCTION,
  buildHandoffText,
  isAgentPane,
  type HandoffResult
} from '@shared/handoff'

import { useStore } from '../store/useStore'

import { terminals } from '../lib/terminals'
import { dictation, joinText } from '../lib/dictation'
import { toggleDictation } from '../lib/voice'

export type ConductorMode = 'message' | 'handoff'
type Target = { kind: 'focused' } | { kind: 'all' } | { kind: 'pane'; id: string }

const DISPLAY_CAP = 2000

function displayText(fullText: string): string {
  if (fullText.length <= DISPLAY_CAP) return fullText
  const remaining = fullText.length - DISPLAY_CAP
  return (
    fullText.slice(0, DISPLAY_CAP) +
    `\n\n[… display truncated; ${remaining} more characters will be pasted …]`
  )
}


/**
 * One place to type into many shells, or hand off one agent's work to another.
 * The mode switcher toggles between broadcasting a typed message and packaging
 * a pane's output or diff for review.
 */
export function Conductor({ workspace }: { workspace: Workspace }): React.JSX.Element | null {
  const open = useStore((s) => s.conductorOpen)
  const toggle = useStore((s) => s.toggleConductor)
  const notify = useStore((s) => s.notify)
  const trials = useStore((s) => s.trials)


  // Mode state
  const [mode, setMode] = useState<ConductorMode>('message')

  // Message mode state
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [target, setTarget] = useState<Target>({ kind: 'focused' })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dictating, setDictating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Hand-off mode state
  const [fromPaneId, setFromPaneId] = useState<string>(() => {
    return workspace.activePaneId ?? workspace.panes[0]?.id ?? ''
  })
  const [contentKind, setContentKind] = useState<'output' | 'changes'>('output')
  const [lineCount, setLineCount] = useState<number>(80)
  const [toPaneId, setToPaneId] = useState<string>(() => {
    const active = workspace.activePaneId ?? workspace.panes[0]?.id
    const other = workspace.panes.find((p) => p.id !== active)
    return other ? other.id : ''
  })
  const [instruction, setInstruction] = useState<string>(DEFAULT_INSTRUCTION)
  const [pressEnter, setPressEnter] = useState<boolean>(false)
  const [previewResult, setPreviewResult] = useState<HandoffResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState<boolean>(false)

  // Debounced computation of handoff preview text (150ms)
  useEffect(() => {
    if (mode !== 'handoff') return
    let active = true
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const fromPane = workspace.panes.find((p) => p.id === fromPaneId)
        const fromName = fromPane?.name ?? 'pane'
        let body = ''
        if (contentKind === 'output') {
          body = terminals.readTail(fromPaneId, lineCount) ?? ''
        } else {
          const trial = trials.find((t) => t.workspaceId === workspace.id)
          const member = trial?.members.find((m) => m.paneId === fromPaneId)
          if (member && trial?.baseSha) {
            body = await window.eaon.worktrees.diff(member.path, trial.baseSha, trial.host ?? null)
          } else {
            body = 'No changes yet'
          }
        }
        if (!active) return
        const res = buildHandoffText({
          fromName,
          kind: contentKind,
          body,
          instruction
        })
        setPreviewResult(res)
      } finally {
        if (active) setPreviewLoading(false)
      }
    }, 150)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [mode, fromPaneId, contentKind, lineCount, instruction, workspace, trials])



  // Dictation into the message box appends to whatever is already typed, so
  // you can start with the keyboard and finish out loud.
  useEffect(
    () =>
      dictation.subscribe((s) =>
        setDictating(s.phase === 'listening' || s.phase === 'thinking')
      ),
    []
  )

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  if (!open) return null

  const resolve = (): string[] => {
    if (target.kind === 'all') return workspace.panes.map((p) => p.id)
    if (target.kind === 'pane') return workspace.panes.some((p) => p.id === target.id) ? [target.id] : []
    return workspace.activePaneId ? [workspace.activePaneId] : []
  }

  const targetLabel = (): string => {
    if (target.kind === 'all') return `all ${workspace.panes.length}`
    if (target.kind === 'pane') return workspace.panes.find((p) => p.id === target.id)?.name ?? 'pane'
    const active = workspace.panes.find((p) => p.id === workspace.activePaneId)
    return active ? active.name : 'no pane'
  }

  const send = (): void => {
    const body = text.trim()
    if (!body) return
    const ids = resolve()
    if (!ids.length) {
      notify({ kind: 'error', title: 'Nowhere to send', text: 'Click a pane first.' })
      return
    }
    for (const id of ids) terminals.send(id, `${body}\r`)
    setText('')
    if (ids.length > 1) {
      notify({
        kind: 'info',
        title: 'Sent to every pane',
        text: `${ids.length} sessions received the same message.`,
        workspaceId: workspace.id
      })
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') toggle()
  }

  const trial = trials.find((t) => t.workspaceId === workspace.id)
  const member = trial?.members.find((m) => m.paneId === fromPaneId)
  const hasChangesSource = Boolean(member)
  const targetPane = workspace.panes.find((p) => p.id === toPaneId)
  const targetIsAgent = isAgentPane(targetPane)
  const effectivePressEnter = targetIsAgent && pressEnter

  return (
    <div className="conductor" data-expanded={expanded || mode === 'handoff'} ref={rootRef}>
      <div className="conductor-row">
        <span className="conductor-orb" aria-hidden="true">
          <Radio size={14} />
        </span>

        <div className="conductor-modes" role="tablist">
          <button
            type="button"
            className="conductor-mode-btn"
            data-active={mode === 'message'}
            onClick={() => setMode('message')}
          >
            Message
          </button>
          <button
            type="button"
            className="conductor-mode-btn"
            data-active={mode === 'handoff'}
            onClick={() => setMode('handoff')}
          >
            Hand off
          </button>
        </div>

        {mode === 'message' && (
          <>
            <button className="conductor-target" onClick={() => setPickerOpen((v) => !v)}>
              {targetLabel()}
              <ChevronDown size={11} />
            </button>

            {!expanded && (
              <input
                className="conductor-input"
                value={text}
                autoFocus
                placeholder={`Message ${targetLabel()}…`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                aria-label="Message to send"
              />
            )}

            <button
              className="icon-btn conductor-mic"
              data-on={dictating}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                void toggleDictation({
                  sink: (chunk) => setText((prev) => joinText(prev, chunk))
                })
              }
              title={dictating ? 'Stop dictating' : 'Dictate this message'}
              aria-label={dictating ? 'Stop dictating' : 'Dictate this message'}
              aria-pressed={dictating}
            >
              <Mic size={14} />
            </button>

            <button
              className="icon-btn"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse' : 'Write a longer message'}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>

            <button className="conductor-send" onClick={send} disabled={!text.trim()} aria-label="Send">
              <SendHorizontal size={14} />
            </button>
          </>
        )}

        <button className="icon-btn conductor-close" onClick={toggle} title="Close" aria-label="Close conductor">
          <X size={14} />
        </button>
      </div>

      {mode === 'message' && expanded && (
        <textarea
          className="conductor-multi"
          value={text}
          autoFocus
          placeholder={`Message ${targetLabel()}…  Enter sends, Shift+Enter adds a line.`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label="Message to send"
        />
      )}

      {mode === 'handoff' && (
        <div className="conductor-handoff-form">
          <div className="conductor-form-row">
            <label className="conductor-field-label">
              <span className="conductor-label-text">From:</span>
              <select
                className="conductor-select"
                value={fromPaneId}
                onChange={(e) => {
                  const next = e.target.value
                  setFromPaneId(next)
                  if (toPaneId === next) {
                    const other = workspace.panes.find((p) => p.id !== next && p.status !== 'exited')
                    if (other) setToPaneId(other.id)
                  }
                }}
              >
                {workspace.panes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.status === 'exited' ? '(exited)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="conductor-field-label">
              <span className="conductor-label-text">Content:</span>
              <select
                className="conductor-select"
                value={contentKind}
                onChange={(e) => setContentKind(e.target.value as 'output' | 'changes')}
              >
                <option value="output">Recent output</option>
                <option
                  value="changes"
                  disabled={!hasChangesSource}
                  title={!hasChangesSource ? 'Changes source is only available for trial attempt panes' : undefined}
                >
                  Trial changes {!hasChangesSource ? '(trial attempts only)' : ''}
                </option>
              </select>
            </label>

            {contentKind === 'output' && (
              <label className="conductor-field-label">
                <span className="conductor-label-text">Lines:</span>
                <input
                  type="number"
                  className="conductor-number-input"
                  min={10}
                  max={400}
                  value={lineCount}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!Number.isNaN(val)) {
                      setLineCount(Math.min(400, Math.max(10, val)))
                    }
                  }}
                />
              </label>
            )}

            <label className="conductor-field-label">
              <span className="conductor-label-text">To:</span>
              <select
                className="conductor-select"
                value={toPaneId}
                onChange={(e) => setToPaneId(e.target.value)}
              >
                <option value="" disabled>Select target pane…</option>
                {workspace.panes.map((p) => {
                  const isSource = p.id === fromPaneId
                  const isExited = p.status === 'exited'
                  const disabled = isSource || isExited
                  let note = ''
                  if (isSource) note = ' (source)'
                  else if (isExited) note = ' (exited)'
                  return (
                    <option key={p.id} value={p.id} disabled={disabled}>
                      {p.name}{note}
                    </option>
                  )
                })}
              </select>
            </label>
          </div>

          <div className="conductor-form-row full">
            <label className="conductor-field-label full">
              <span className="conductor-label-text">
                Instruction (<code>&#123;from&#125;</code> is replaced with source name):
              </span>
              <textarea
                className="conductor-instruction-input"
                value={instruction}
                rows={2}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Enter instructions for reviewing agent…"
              />
            </label>
          </div>

          <div className="conductor-form-options">
            <label
              className="conductor-checkbox-label"
              title={!targetIsAgent ? 'Disabled: target is a plain shell' : undefined}
            >
              <input
                type="checkbox"
                checked={effectivePressEnter}
                disabled={!targetIsAgent}
                onChange={(e) => setPressEnter(e.target.checked)}
              />
              <span>Press Enter after pasting</span>
              {!targetIsAgent && (
                <span className="conductor-hint-warn">(disabled for shell targets)</span>
              )}
            </label>
          </div>

          <div className="conductor-preview-container">
            <div className="conductor-preview-header">
              <span>
                Preview ({previewResult ? `${previewResult.chars} characters` : 'computing…'}
                {previewResult?.truncated ? `, [omitted ${previewResult.omitted} chars]` : ''}):
              </span>
              {previewLoading && <span className="conductor-preview-loading">updating…</span>}
            </div>
            <pre className="conductor-preview-text">
              {previewResult ? displayText(previewResult.text) : 'Gathering content…'}
            </pre>
          </div>
        </div>
      )}



      {pickerOpen && (
        <div className="target-menu">
          <button
            className="menu-item"
            onClick={() => {
              setTarget({ kind: 'focused' })
              setPickerOpen(false)
            }}
          >
            The pane I am in
            {target.kind === 'focused' && <span className="kbd">on</span>}
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setTarget({ kind: 'all' })
              setPickerOpen(false)
            }}
          >
            Every pane here
            {target.kind === 'all' && <span className="kbd">on</span>}
          </button>
          <div className="menu-sep" />
          {workspace.panes.map((p) => (
            <button
              className="menu-item"
              key={p.id}
              onClick={() => {
                setTarget({ kind: 'pane', id: p.id })
                setPickerOpen(false)
              }}
            >
              {p.name}
              {target.kind === 'pane' && target.id === p.id && <span className="kbd">on</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
