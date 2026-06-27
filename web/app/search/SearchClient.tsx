'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import './search.css'

interface Snippet {
  before: string
  match: string
  after: string
}

interface Hit {
  path: string
  title: string
  score: number
  snippet: Snippet | null
}

/** A recent note for the pre-query hint state (computed server-side by mtime). */
export interface RecentNote {
  path: string
  title: string
}

/** Top-level folder as an honest "kind" label (inbox / notes / tasks …). */
function kindOf(path: string): string {
  const top = path.includes('/') ? path.split('/')[0]! : ''
  return top === '' ? 'vault' : top
}

/**
 * Live search over `GET /api/search?q=…` (the same derived index the agent
 * reads). Debounced; results render by human TITLE — never the path — with
 * the source folder as a calm kind label, a context snippet with the matched
 * term emphasized, and an honest count when the server caps the list. Opens
 * in the vault editor via `/?path=<path>` (the same deep-link the graph uses).
 */
export function SearchClient({ recent }: { recent: RecentNote[] }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState(0)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const reqId = useRef(0)

  useEffect(() => {
    const query = q.trim()
    if (query === '') {
      setHits([])
      setTotal(0)
      setSearched(false)
      setError(null)
      return
    }
    const id = ++reqId.current
    setError(null)
    // 110ms: long enough to coalesce a keystroke burst, short enough that the
    // debounce (not the ~3ms API) never reads as latency.
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        if (!res.ok) throw new Error(`Search failed with ${res.status}`)
        const data = (await res.json()) as { hits: Hit[]; total: number }
        // Ignore a stale response if a newer keystroke already fired.
        if (id !== reqId.current) return
        setHits(data.hits)
        setTotal(data.total)
        setSearched(true)
        setError(null)
      } catch {
        if (id !== reqId.current) return
        setHits([])
        setTotal(0)
        setSearched(true)
        setError('Search could not load. Check the vault and try again.')
      }
    }, 110)
    return () => clearTimeout(t)
  }, [q, retryKey])

  return (
    <div className="search">
      <input
        className="searchin"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your vault…"
        aria-label="Search your vault"
        autoFocus
      />
      {q.trim() === '' ? (
        <>
          <p className="searchhint">Type to search titles and note text across your vault.</p>
          {recent.length > 0 ? (
            <>
              <p className="sr-recent">Recent notes</p>
              <ul className="searchres">
                {recent.map((n) => (
                  <li key={n.path}>
                    <Link className="searchres-item" href={`/?path=${encodeURIComponent(n.path)}`}>
                      <span className="sr-title">{n.title}</span>
                      <span className="sr-kind">{kindOf(n.path)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : error ? (
        <div className="searcherror" role="status" aria-live="polite">
          <p>{error}</p>
          <button type="button" onClick={() => setRetryKey((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : hits.length > 0 ? (
        <>
          <p className="sr-count">
            {hits.length < total
              ? `${hits.length} of ${total} matches`
              : total === 1
                ? '1 match'
                : `${total} matches`}
          </p>
          <ul className="searchres">
            {hits.map((h) => (
              <li key={h.path}>
                <Link
                  className="searchres-item sr-col"
                  href={`/?path=${encodeURIComponent(h.path)}`}
                >
                  <span className="sr-top">
                    <span className="sr-title">{h.title}</span>
                    <span className="sr-kind">{kindOf(h.path)}</span>
                  </span>
                  {h.snippet ? (
                    <span className="sr-snippet">
                      {h.snippet.before}
                      {h.snippet.match !== '' ? (
                        <em className="sr-match">{h.snippet.match}</em>
                      ) : null}
                      {h.snippet.after}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : searched ? (
        <p className="searchhint">No matches.</p>
      ) : null}
    </div>
  )
}
