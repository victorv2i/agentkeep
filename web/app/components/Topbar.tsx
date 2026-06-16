'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { captureTextAction } from '../agent/actions'

/** A transient confirmation/error shown under the capture bar. */
type Note = { kind: 'ok' | 'err'; text: string; snippet?: string }

/** Shorten a captured line so the confirmation echoes it without wrapping. */
function shorten(s: string, max = 52): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/**
 * The capture box: files raw text into the vault's inbox as the human, for your
 * connected agent to file into memory from there. ⌘K/Ctrl+K focuses it; the
 * confirmation under the bar echoes what was captured and self-dismisses.
 */
export function Topbar() {
  const [text, setText] = useState('')
  // Platform-aware shortcut label: ⌘K is a lie on Linux/Windows. Server renders
  // the mac glyph; the effect corrects it after hydration (no mismatch).
  const [shortcut, setShortcut] = useState('⌘K')
  const [note, setNote] = useState<Note | null>(null)
  const [capturing, startCapture] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  function submitCapture() {
    const value = text.trim()
    if (value === '' || capturing) return
    startCapture(async () => {
      try {
        const res = await captureTextAction(value)
        if (res.ok) {
          setText('')
          setNote({ kind: 'ok', text: 'Captured', snippet: value })
          inputRef.current?.focus() // ready for the next thought
        } else {
          setNote({ kind: 'err', text: res.error })
        }
      } catch {
        setNote({ kind: 'err', text: 'Couldn’t save that. Try again.' })
      }
    })
  }

  // ⌘K / Ctrl+K focuses the capture box — wires the badge so it's a real
  // affordance, not dead chrome. preventDefault keeps the browser's own
  // Cmd/Ctrl+K (e.g. address-bar search) from stealing it.
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform)) setShortcut('Ctrl+K')
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // A success confirmation clears itself after a few seconds so it always reads
  // as "that capture, just now" — never a stale line. Errors persist until the
  // next action so they can't be missed.
  useEffect(() => {
    if (note?.kind !== 'ok') return
    const id = setTimeout(() => setNote(null), 4500)
    return () => clearTimeout(id)
  }, [note])

  return (
    <div className="topwrap">
      <div className="top">
        <form
          className="cap"
          onSubmit={(e) => {
            e.preventDefault()
            submitCapture()
          }}
        >
          <span className="p mono">+</span>
          <input
            ref={inputRef}
            id="capture-input"
            className="capin"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Capture anything… a task, a thought, who you just met"
            aria-label="Capture to inbox"
            disabled={capturing}
          />
        </form>
        <button
          type="button"
          className="kbd"
          onClick={() => inputRef.current?.focus()}
          aria-label={`Focus capture box (${shortcut})`}
          title={`Focus capture box (${shortcut})`}
        >
          {shortcut}
        </button>
      </div>
      {note ? (
        <div className={`topnote ${note.kind}`} role="status">
          {note.kind === 'ok' ? (
            <svg className="topnote-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2.5 7.4 5.6 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
          <span className="topnote-text">
            {note.text}
            {note.snippet ? (
              <>
                {' '}
                <span className="topnote-snip">“{shorten(note.snippet)}”</span> — your agent files it from here.
              </>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  )
}
