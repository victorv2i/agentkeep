'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { autocompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { extendedMarkdownLanguage } from './editor/wikilink-lang'
import { livePreview, type WikiLinkParts } from './editor/live-preview'
import { wikiLinkCompletion } from './editor/wikilink-complete'
import { inkEditorTheme } from './editor/theme'
import { isWikilinkTargetResolved } from '@/lib/content-path'
import {
  listNotesAction,
  loadNoteAction,
  saveNoteAction,
  resolveTargetAction,
  createNoteAction,
  noteProvenanceAction,
  undoNoteCommitAction,
} from './actions'
import type { NoteListItem, NoteProvenance } from '@/lib/vault'

type SaveState = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'error'
type SaveOutcome = 'saved' | 'unchanged' | 'conflict' | 'error' | 'stale'

interface OpenNote {
  path: string
  title: string
  content: string
  /** baseHash for the CAS — the hash this content was loaded at. */
  hash: string
  backlinks: NoteListItem[]
}

export function NotesClient({
  initialNotes,
  initialPath,
}: {
  initialNotes: NoteListItem[]
  /** Optional `/?path=<vault-relative>` deep-link target to open on load. */
  initialPath?: string
}) {
  const router = useRouter()
  const [notes, setNotes] = useState<NoteListItem[]>(initialNotes)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<OpenNote | null>(null)
  const [doc, setDoc] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  // Provenance for the OPEN note (who last edited + recent history) — drives the
  // "agent edited" badge and the History/Undo panel. Null until loaded.
  const [prov, setProv] = useState<NoteProvenance | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [undoingSha, setUndoingSha] = useState<string | null>(null)
  // An unresolved `[[wikilink]]` the user clicked — shown as a calm in-theme
  // inline prompt (themed), never a native window.confirm dialog.
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const [memoryEditArmed, setMemoryEditArmed] = useState<Record<string, true>>({})
  const [draftCopied, setDraftCopied] = useState(false)

  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savePromise = useRef<Promise<SaveOutcome> | null>(null)
  const mountedRef = useRef(true)
  // Latest doc/hash the save loop reads (avoids stale closures in the timer).
  const docRef = useRef('')
  const openRef = useRef<OpenNote | null>(null)
  const saveStateRef = useRef<SaveState>('saved')
  docRef.current = doc
  openRef.current = open
  saveStateRef.current = saveState

  const setSaveStatus = useCallback((next: SaveState) => {
    saveStateRef.current = next
    if (mountedRef.current) setSaveState(next)
  }, [])

  // A synchronous ref to the note list so the live-preview can style resolved vs
  // placeholder links without an await per render. Refreshed with the note list.
  // `isWikilinkTargetResolved` is the SAME rule the server's resolveTarget (and
  // the core LinkGraph) uses, so a slash-bearing target like `[[folder/Foo]]`
  // never shows as resolved here while the click handler (resolveTargetAction)
  // finds nothing, or vice versa.
  const notesForResolveRef = useRef(notes)
  notesForResolveRef.current = notes
  const isResolved = useCallback((target: string) => {
    return isWikilinkTargetResolved(target, notesForResolveRef.current)
  }, [])

  const notesRef = useRef(notes)
  notesRef.current = notes
  const getCompletionNotes = useCallback(
    () => notesRef.current.map((n) => ({ basename: n.basename, title: n.title })),
    [],
  )

  // Scroll the live editor to the line that hosts a `#heading` or `^block-id`.
  const scrollToAnchor = useCallback(
    (content: string, anchor: NonNullable<WikiLinkParts['anchor']>) => {
      const view = cmRef.current?.view
      if (!view) return
      const lines = content.split('\n')
      const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const wanted = slug(anchor.value)
      let lineNo = -1
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (anchor.kind === 'heading') {
          const m = /^#{1,6}\s+(.*)$/.exec(line)
          if (m && slug(m[1]!) === wanted) { lineNo = i; break }
        } else {
          // A block anchor `^id` sits at the END of the line it tags.
          if (new RegExp(`\\^${anchor.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line)) {
            lineNo = i
            break
          }
        }
      }
      if (lineNo < 0) return
      const pos = view.state.doc.line(lineNo + 1).from
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
      })
    },
    [],
  )

  const refreshNotes = useCallback(async () => {
    setNotes(await listNotesAction())
  }, [])

  // Save through the CAS. On conflict we DO NOT clobber: keep the user's text,
  // flip to the conflict state. Backlinks/title refresh on a clean save.
  const doSave = useCallback(
    async ({ updateUi = true }: { updateUi?: boolean } = {}): Promise<SaveOutcome> => {
      for (;;) {
        if (savePromise.current) {
          const first = await savePromise.current
          const cur = openRef.current
          if (
            first !== 'conflict' &&
            first !== 'error' &&
            cur &&
            docRef.current !== cur.content &&
            saveStateRef.current !== 'conflict'
          ) {
            continue
          }
          return first
        }

        const run = (async (): Promise<SaveOutcome> => {
          const cur = openRef.current
          if (!cur) return 'unchanged'
          const content = docRef.current
          if (content === cur.content) {
            if (updateUi) setSaveStatus('saved')
            return 'unchanged'
          }
          if (saveStateRef.current === 'conflict') return 'conflict'

          if (updateUi) setSaveStatus('saving')
          let res
          try {
            res = await saveNoteAction(cur.path, content, cur.hash)
          } catch {
            // A non-conflict failure: keep the buffer and surface a retry affordance.
            if (openRef.current?.path !== cur.path) return 'stale'
            if (updateUi) setSaveStatus('error')
            else saveStateRef.current = 'error'
            return 'error'
          }

          // The note may have been switched while saving — ignore a stale response.
          if (openRef.current?.path !== cur.path) return 'stale'

          if (res.ok) {
            let reloaded: Awaited<ReturnType<typeof loadNoteAction>> | undefined
            if (updateUi) {
              try {
                reloaded = await loadNoteAction(cur.path)
              } catch {
                // The save succeeded; a stale title/backlink refresh should not
                // turn it into a failed save.
              }
            }
            const nextOpen: OpenNote = {
              ...cur,
              content,
              hash: res.hash,
              title: reloaded?.title ?? cur.title,
              backlinks: reloaded?.backlinks ?? cur.backlinks,
            }
            openRef.current = nextOpen
            if (updateUi && mountedRef.current) {
              setOpen((o) => (o && o.path === cur.path ? nextOpen : o))
              setSaveStatus(docRef.current === content ? 'saved' : 'unsaved')
              try {
                await refreshNotes()
              } catch {
                // The editor buffer is saved; list refresh can recover next load.
              }
              void noteProvenanceAction(cur.path)
                .then((p) => {
                  if (openRef.current?.path === cur.path) setProv(p)
                })
                .catch(() => {
                  // Provenance is secondary to keeping the edit saved.
                })
            } else if (docRef.current === content) {
              saveStateRef.current = 'saved'
            }
            return 'saved'
          }

          // ConflictError: the file changed under us (likely the agent). Surface it,
          // keep the buffer — the user reloads to merge, never silently overwritten.
          if (updateUi) setSaveStatus('conflict')
          else saveStateRef.current = 'conflict'
          return 'conflict'
        })()

        savePromise.current = run
        let result: SaveOutcome
        try {
          result = await run
        } finally {
          if (savePromise.current === run) savePromise.current = null
        }
        const cur = openRef.current
        if (
          result !== 'conflict' &&
          result !== 'error' &&
          cur &&
          docRef.current !== cur.content &&
          saveStateRef.current !== 'conflict'
        ) {
          continue
        }
        return result
      }
    },
    [refreshNotes, setSaveStatus],
  )

  const flushBeforeLeaving = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const cur = openRef.current
    if (!cur || docRef.current === cur.content) return true
    const result = await doSave()
    return result === 'saved' || result === 'unchanged'
  }, [doSave])

  const openNote = useCallback(
    async (
      path: string,
      anchor?: WikiLinkParts['anchor'],
      opts: { discardCurrent?: boolean } = {},
    ) => {
      if (!opts.discardCurrent) {
        const canLeave = await flushBeforeLeaving()
        if (!canLeave) return false
      }
      const loaded = await loadNoteAction(path)
      if (!loaded) {
        // Vanished (e.g. deleted out of band) — drop it from the list.
        await refreshNotes()
        return false
      }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      const nextOpen = {
        path: loaded.path,
        title: loaded.title,
        content: loaded.content,
        hash: loaded.hash,
        backlinks: loaded.backlinks,
      }
      openRef.current = nextOpen
      docRef.current = loaded.content
      setOpen(nextOpen)
      setDoc(loaded.content)
      setSaveStatus('saved')
      setCreateTarget(null)
      // Load provenance for the badge + history panel. Don't block the editor on
      // it: clear stale provenance, then fill it in when it lands (ignore a
      // response for a note we've since navigated away from).
      setProv(null)
      setHistoryOpen(false)
      void noteProvenanceAction(loaded.path)
        .then((p) => {
          if (openRef.current?.path === loaded.path) setProv(p)
        })
        .catch(() => {
          if (openRef.current?.path === loaded.path) setProv(null)
        })
      // `[[Note#Heading]]` / `[[Note^block]]`: after the note's content lands,
      // scroll the editor to the matching line. The CodeMirror view is mounted
      // by the next paint, so defer one frame.
      if (anchor) {
        const target = anchor
        requestAnimationFrame(() => scrollToAnchor(loaded.content, target))
      }
      return true
    },
    [flushBeforeLeaving, refreshNotes, scrollToAnchor, setSaveStatus],
  )

  const onChange = useCallback((value: string) => {
    setDoc(value)
    docRef.current = value
    const cur = openRef.current
    if (!cur) return
    setSaveStatus(saveStateRef.current === 'conflict' ? 'conflict' : value === cur.content ? 'saved' : 'unsaved')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    // Debounced autosave; a conflict pauses autosave until the user reloads.
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      if (saveStateNotConflict()) void doSave()
    }, 1200)
  }, [doSave, setSaveStatus])

  // Read latest save state without a dep (the timer closure is created fresh).
  const saveStateNotConflict = () => saveStateRef.current !== 'conflict'

  // Clicking a `[[wikilink]]` (or `![[embed]]`): open it if it resolves —
  // scrolling to its `#heading`/`^block` anchor if present — else surface an
  // in-theme inline prompt to create it (no native dialog). (The alias, if any,
  // doesn't change which note we navigate to.)
  const onWikiLinkClick = useCallback(
    async (parts: WikiLinkParts) => {
      const resolved = await resolveTargetAction(parts.target)
      if (resolved) {
        await openNote(resolved, parts.anchor)
        return
      }
      setCreateTarget(parts.target)
    },
    [openNote],
  )
  const onWikiLinkClickRef = useRef(onWikiLinkClick)
  onWikiLinkClickRef.current = onWikiLinkClick

  // Clicking a plain markdown `[text](url)` link. External (`http(s)`/`mailto:`)
  // opens in a new tab; an internal/relative target resolves like a wikilink
  // (open the note, or prompt to create it).
  const onMarkdownLinkClick = useCallback(
    async (url: string) => {
      if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      // Relative/internal: strip a hash anchor, decode `%20`, resolve by basename.
      const hash = url.indexOf('#')
      const target = decodeURIComponent((hash === -1 ? url : url.slice(0, hash)).replace(/\.md$/i, ''))
      const anchor = hash === -1 ? null : { kind: 'heading' as const, value: url.slice(hash + 1) }
      const resolved = await resolveTargetAction(target)
      if (resolved) {
        await openNote(resolved, anchor)
        return
      }
      setCreateTarget(target)
    },
    [openNote],
  )
  const onMarkdownLinkClickRef = useRef(onMarkdownLinkClick)
  onMarkdownLinkClickRef.current = onMarkdownLinkClick

  // Confirm/cancel the inline create-prompt.
  const confirmCreate = useCallback(async () => {
    const target = createTarget
    if (!target) return
    setCreateTarget(null)
    const path = await createNoteAction(target)
    await refreshNotes()
    await openNote(path)
  }, [createTarget, openNote, refreshNotes])

  const copyDraft = useCallback(async () => {
    const text = docRef.current
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setDraftCopied(true)
    window.setTimeout(() => setDraftCopied(false), 2200)
  }, [])

  // Undo ONE agent-authored commit on the open note. The server reverts that
  // commit (a new human commit), re-reads the note (fresh content + hash so the
  // CAS stays correct), and returns the refreshed provenance. We swap the buffer
  // to the reverted content and refresh the panel. Offered only on agent rows.
  const undoCommit = useCallback(
    async (sha: string) => {
      const cur = openRef.current
      if (!cur || undoingSha) return
      setUndoingSha(sha)
      try {
        const res = await undoNoteCommitAction(cur.path, sha)
        // Ignore a response for a note we've navigated away from.
        if (openRef.current?.path !== cur.path) return
        if (!res.ok) {
          // Stale/agent-only guard tripped — refresh provenance so the panel
          // reflects reality, surface nothing scary.
          const p = await noteProvenanceAction(cur.path)
          if (openRef.current?.path === cur.path) setProv(p)
          return
        }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = null
        openRef.current = {
          path: cur.path,
          content: res.note.content,
          hash: res.note.hash,
          title: res.note.title,
          backlinks: res.note.backlinks,
        }
        docRef.current = res.note.content
        setOpen((o) =>
          o && o.path === cur.path
            ? {
                ...o,
                content: res.note.content,
                hash: res.note.hash,
                title: res.note.title,
                backlinks: res.note.backlinks,
              }
            : o,
        )
        setDoc(res.note.content)
        setSaveStatus('saved')
        setProv(res.provenance)
        await refreshNotes()
      } finally {
        setUndoingSha(null)
      }
    },
    [refreshNotes, setSaveStatus, undoingSha],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      mountedRef.current = false
      if (
        openRef.current &&
        docRef.current !== openRef.current.content &&
        saveStateRef.current !== 'conflict'
      ) {
        void doSave({ updateUi: false })
      }
    }
  }, [doSave])

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      const cur = openRef.current
      if (!cur || docRef.current === cur.content) return
      event.preventDefault()
      event.returnValue = ''
    }

    function onPageHide() {
      if (
        openRef.current &&
        docRef.current !== openRef.current.content &&
        saveStateRef.current !== 'conflict'
      ) {
        void doSave({ updateUi: false })
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [doSave])

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!target || target.closest('.cm-editor')) return
      const anchor = target as HTMLAnchorElement
      if (anchor.target && anchor.target !== '_self') return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const cur = openRef.current
      if (!cur || docRef.current === cur.content) return

      event.preventDefault()
      void (async () => {
        const saved = await flushBeforeLeaving()
        if (saved) router.push(`${url.pathname}${url.search}${url.hash}`)
      })()
    }

    document.addEventListener('click', onDocumentClick, true)
    return () => document.removeEventListener('click', onDocumentClick, true)
  }, [flushBeforeLeaving, router])

  // Deep-link: `/?path=<vault-relative path>` opens that note on load (the
  // graph view and search results navigate here). The server page passes the
  // param down as `initialPath`; each distinct value is handled once. A bad or
  // vanished path falls through to the normal vault home (openNote already
  // drops missing notes; a hostile path rejects server-side — swallow it).
  const handledInitialPath = useRef<string | null>(null)
  useEffect(() => {
    if (!initialPath || handledInitialPath.current === initialPath) return
    handledInitialPath.current = initialPath
    openNote(initialPath).catch(() => {
      // VaultPathError etc. from the server action — ignore, keep the home calm.
    })
  }, [initialPath, openNote])

  const extensions = useMemo(
    () => [
      extendedMarkdownLanguage(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      autocompletion({ override: [wikiLinkCompletion(getCompletionNotes)] }),
      livePreview({
        onWikiLink: (parts) => {
          void onWikiLinkClickRef.current(parts)
        },
        onMarkdownLink: (url) => {
          void onMarkdownLinkClickRef.current(url)
        },
        isResolved,
        getView: () => cmRef.current?.view ?? null,
        getTitle: () => openRef.current?.title ?? '',
      }),
      inkEditorTheme(),
    ],
    [getCompletionNotes, isResolved],
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (q === '') return notes
    return notes.filter((n) => n.title.toLowerCase().includes(q))
  }, [notes, filter])
  const memoryGuardActive = open ? open.path.startsWith('memory/') && !memoryEditArmed[open.path] : false

  return (
    <div className={open ? 'notes has-open' : 'notes'}>
      <aside className="notelist">
        <input
          className="notefilter"
          type="text"
          placeholder="Filter notes"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter notes"
        />
        <div className="notelist-scroll">
          {filtered.length > 0 ? (
            filtered.map((n) => (
              <button
                key={n.path}
                type="button"
                className={open?.path === n.path ? 'noteitem cur' : 'noteitem'}
                title={n.tooltip}
                onClick={() => void openNote(n.path)}
              >
                {n.title}
              </button>
            ))
          ) : (
            <div className="noteempty" role="status">
              {notes.length === 0 ? 'No notes yet.' : 'No notes match that filter.'}
            </div>
          )}
        </div>
      </aside>

      <section className="editorpane">
        {createTarget ? (
          <div className="createprompt" role="group" aria-label="Create note">
            <span className="cp-text">
              “{createTarget}” isn’t a note yet. Create it?
            </span>
            <span className="cp-acts">
              <button type="button" className="cp-ok" onClick={() => void confirmCreate()}>
                Create
              </button>
              <button type="button" className="cp-no" onClick={() => setCreateTarget(null)}>
                Cancel
              </button>
            </span>
          </div>
        ) : null}
        {open ? (
          <>
            <header className="editorhead">
              <h1>{open.title}</h1>
              {prov?.lastAuthor === 'agent' ? (
                <span
                  className="provbadge agent"
                  title="The agent made the most recent change to this note."
                >
                  agent edited
                  {prov.lastEditISO ? (
                    <span className="provtime"> · {relativeTime(prov.lastEditISO)}</span>
                  ) : null}
                </span>
              ) : null}
              {prov && prov.history.length > 0 ? (
                <button
                  type="button"
                  className={historyOpen ? 'histbtn open' : 'histbtn'}
                  onClick={() => setHistoryOpen((v) => !v)}
                  aria-expanded={historyOpen}
                  aria-label="Note history"
                >
                  History
                </button>
              ) : null}
              <SaveBadge
                state={saveState}
                onLoadDisk={() => void openNote(open.path, null, { discardCurrent: true })}
                onCopyDraft={() => void copyDraft()}
                onRetry={() => void doSave()}
              />
            </header>
            {historyOpen && prov ? (
              <HistoryPanel
                prov={prov}
                undoingSha={undoingSha}
                onUndo={(sha) => void undoCommit(sha)}
                onClose={() => setHistoryOpen(false)}
              />
            ) : null}
            {saveState === 'conflict' ? (
              <div className="conflictnote" role="status" aria-live="polite">
                This note changed on disk. Keep editing, copy your draft, or load
                the disk version.{' '}
                <button type="button" onClick={() => void copyDraft()}>
                  {draftCopied ? 'Draft copied' : 'Copy my draft'}
                </button>
                <button type="button" onClick={() => void openNote(open.path, null, { discardCurrent: true })}>
                  Load disk version (discards your draft)
                </button>
              </div>
            ) : null}
            {saveState === 'error' ? (
              <div className="savenote error">
                Save failed. Your text is still here.{' '}
                <button type="button" onClick={() => void doSave()}>
                  Retry save
                </button>
              </div>
            ) : null}
            {memoryGuardActive ? (
              <div id="memory-edit-guard" className="memoryguard" role="note">
                <span className="memoryguard-text">
                  <strong>Agent-owned memory.</strong> Corrections here change what your
                  agent will rely on.
                </span>
                <button
                  type="button"
                  onClick={() => setMemoryEditArmed((armed) => ({ ...armed, [open.path]: true }))}
                >
                  Correct memory
                </button>
              </div>
            ) : null}
            <div className="editorbox">
              <CodeMirror
                ref={cmRef}
                value={doc}
                onChange={onChange}
                onBlur={() => {
                  if (saveStateNotConflict()) void doSave()
                }}
                extensions={extensions}
                basicSetup={false}
                theme="none"
                height="100%"
                editable={!memoryGuardActive}
                readOnly={memoryGuardActive}
                aria-describedby={memoryGuardActive ? 'memory-edit-guard' : undefined}
              />
            </div>
            {open.backlinks.length > 0 ? (
              <div className="backlinks">
                <div className="backlinks-lbl">
                  <span className="dot" />
                  <span className="lbl">
                    Linked from · {open.backlinks.length}
                  </span>
                </div>
                {open.backlinks.map((b) => (
                  <button
                    key={b.path}
                    type="button"
                    className="backlink"
                    onClick={() => void openNote(b.path)}
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="editorempty">
            <div className="ee-card">
              <span className="ee-star" aria-hidden="true">
                <svg width="46" height="12" viewBox="0 0 46 12" fill="none">
                  <path d="M2 6H18" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                  <path d="M28 6H44" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                  <path d="M23 2.5 26 6 23 9.5 20 6Z" fill="currentColor" />
                </svg>
              </span>
              <p className="ee-title">Your vault</p>
              <p className="ee-sub">
                {notes.length === 0
                  ? 'Your vault is empty. Capture something above, or connect your agent.'
                  : 'Pick a note.'}
              </p>
              <div className="ee-links">
                <a className="ee-link" href="/settings">Connect your agent →</a>
                <a className="ee-link" href="/memory">What it believes →</a>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a date — calm, no seconds. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A human action label for a note-history row (the path is always the open note). */
function historyAction(message: string): string {
  const m = message.replace(/^(agent|human):\s*/, '').trim()
  const verb = m.split(/\s+/)[0]?.toLowerCase()
  if (verb === 'write') return 'Wrote this note'
  if (verb === 'delete') return 'Removed this note'
  if (verb === 'revert') return 'Reverted a change'
  return m
}

function HistoryIcon({ name }: { name: 'close' | 'undo' }) {
  const p = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'close') {
    return (
      <svg {...p}>
        <path d="M3.7 3.7 10.3 10.3" />
        <path d="M10.3 3.7 3.7 10.3" />
      </svg>
    )
  }
  return (
    <svg {...p}>
      <path d="M4.1 5.4H1.9V3.2" />
      <path d="M4 5.4A4.2 4.2 0 1 1 3 9.5" />
    </svg>
  )
}

/**
 * The open note's recent commit history with per-row author chips. Each
 * agent-authored row gets an Undo button (reverts THAT commit as a new human
 * commit — itself reversible); human rows are read-only, so a human's own change
 * is never offered up for a silent revert. Calm + out of the way (an affordance,
 * not a wall); the 7-char sha is a muted detail, never the primary UI.
 */
function HistoryPanel({
  prov,
  undoingSha,
  onUndo,
  onClose,
}: {
  prov: NoteProvenance
  undoingSha: string | null
  onUndo: (sha: string) => void
  onClose: () => void
}) {
  return (
    <div className="histpanel" role="region" aria-label="Note history">
      <div className="histhead">
        <span className="histlbl">History · {prov.history.length}</span>
        <button type="button" className="histclose" onClick={onClose} aria-label="Close history">
          <HistoryIcon name="close" />
        </button>
      </div>
      <div className="histrows">
        {prov.history.map((h) => {
          const isAgent = h.author === 'agent'
          const busy = undoingSha === h.sha
          return (
            <div className="histrow" key={h.sha}>
              <span className={isAgent ? 'authchip agent' : 'authchip human'}>
                {isAgent ? 'agent' : 'you'}
              </span>
              <div className="histbody">
                <div className="histmsg">{historyAction(h.message)}</div>
                <div className="histmeta">
                  {relativeTime(h.dateISO)} · <span className="histsha">{h.sha.slice(0, 7)}</span>
                </div>
              </div>
              {isAgent ? (
                <button
                  type="button"
                  className="histundo"
                  onClick={() => onUndo(h.sha)}
                  disabled={undoingSha !== null}
                  aria-busy={busy}
                >
                  <HistoryIcon name="undo" />
                  {busy ? 'Undoing...' : 'Undo'}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SaveBadge({
  state,
  onLoadDisk,
  onCopyDraft,
  onRetry,
}: {
  state: SaveState
  onLoadDisk: () => void
  onCopyDraft: () => void
  onRetry: () => void
}) {
  const map: Record<SaveState, string> = {
    saved: 'Saved',
    saving: 'Saving…',
    unsaved: 'Unsaved',
    conflict: 'Changed elsewhere',
    error: 'Save failed',
  }
  if (state === 'conflict') {
    return (
      <span className="savestatus" role="status" aria-live="polite" aria-atomic="true">
        <span className="savebadge conflict">{map[state]}</span>
        <button type="button" className="savebadge conflict-action" onClick={onCopyDraft}>
          Copy my draft
        </button>
        <button type="button" className="savebadge conflict-action danger" onClick={onLoadDisk}>
          Load disk
        </button>
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="savestatus" role="status" aria-live="polite" aria-atomic="true">
        <button type="button" className="savebadge error" onClick={onRetry}>
          {map[state]} · Retry
        </button>
      </span>
    )
  }
  return (
    <span className="savestatus" role="status" aria-live="polite" aria-atomic="true">
      <span className={`savebadge ${state}`}>{map[state]}</span>
    </span>
  )
}
