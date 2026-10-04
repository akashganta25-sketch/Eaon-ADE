import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize2, Mic, Minimize2, Radio, SendHorizontal, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { DEFAULT_INSTRUCTION } from '@shared/handoff'

import { useStore } from '../store/useStore'
import { terminals } from '../lib/terminals'
import { dictation, joinText } from '../lib/dictation'
import { toggleDictation } from '../lib/voice'

export type ConductorMode = 'message' | 'handoff'
type Target = { kind: 'focused' } | { kind: 'all' } | { kind: 'pane'; id: string }

/**
 * One place to type into many shells, or hand off one agent's work to another.
 * The mode switcher toggles between broadcasting a typed message and packaging
 * a pane's output or diff for review.
 */
export function Conductor({ workspace }: { workspace: Workspace }): React.JSX.Element | null {
  const open = useStore((s) => s.conductorOpen)
  const toggle = useStore((s) => s.toggleConductor)
  const notify = useStore((s) => s.notify)

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

        {mode === 'message' ? (
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
        ) : (
          <div className="conductor-handoff-state-holder" style={{ display: 'none' }}>
            {/* References state to ensure clean TypeScript compilation in Step 6.7 prior to Step 6.8 controls */}
            <span>{fromPaneId}{setFromPaneId.name}{contentKind}{setContentKind.name}{lineCount}{setLineCount.name}{toPaneId}{setToPaneId.name}{instruction}{setInstruction.name}{String(pressEnter)}{setPressEnter.name}</span>
          </div>
        )}

        <button className="icon-btn" onClick={toggle} title="Close" aria-label="Close conductor">
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
