/**
 * Result shaping for `/api/search`: the server-side hit cap and the context
 * snippet around the first matched term. Pure string functions (no fs, no
 * index) so the API's response shape is unit-testable offline.
 */

/** Server-side cap on returned hits; the honest `total` rides alongside. */
export const RESULT_CAP = 30

/** A snippet split at the matched term so the client can emphasize exactly it. */
export interface SnippetParts {
  before: string
  match: string
  after: string
}

const BEFORE_CHARS = 60
const AFTER_CHARS = 100

/** Collapse newlines/whitespace runs to single spaces (snippets are one line). */
function flat(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * A short one-line context window around the FIRST occurrence of any query
 * term in the note body (case-insensitive; the match extends to the end of the
 * word so a prefix query highlights the whole word). When no term literally
 * appears (a fuzzy or title-only hit) it falls back to the lead of the body
 * with `match: ''` — shown without emphasis, never a fake highlight. Returns
 * null for an empty body so the client renders nothing rather than a blank.
 */
export function makeSnippet(text: string, query: string): SnippetParts | null {
  // Strip line-leading heading marks (same treatment as the memory excerpts) so
  // a snippet that starts at an H1 doesn't read "# Title …". Positions are
  // computed on this cleaned body, so match offsets stay consistent.
  const body = text.replace(/^#{1,6}\s+/gm, '').trim()
  if (body === '') return null
  const lower = body.toLowerCase()
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== '')

  // Earliest occurrence of any term wins (the "first match" of the note).
  let at = -1
  let len = 0
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i !== -1 && (at === -1 || i < at)) {
      at = i
      len = term.length
    }
  }

  if (at === -1) {
    // No literal match — honest fallback: the lead of the note, no emphasis.
    const cap = BEFORE_CHARS + AFTER_CHARS
    const lead = flat(body.slice(0, cap)).trimEnd()
    return { before: body.length > cap ? `${lead}…` : lead, match: '', after: '' }
  }

  // Extend a prefix match to the end of its word so the highlight reads whole.
  while (at + len < body.length && /[\w-]/.test(body[at + len]!)) len++

  const start = Math.max(0, at - BEFORE_CHARS)
  const end = Math.min(body.length, at + len + AFTER_CHARS)
  const before = (start > 0 ? '…' : '') + flat(body.slice(start, at)).trimStart()
  const after = flat(body.slice(at + len, end)).trimEnd() + (end < body.length ? '…' : '')
  return { before, match: body.slice(at, at + len), after }
}

/** Cap a ranked hit list at RESULT_CAP, keeping the honest pre-cap total. */
export function capHits<T>(hits: T[]): { top: T[]; total: number } {
  return { top: hits.slice(0, RESULT_CAP), total: hits.length }
}
