import { readNote } from './frontmatter.js'

/**
 * Display-title derivation, in one shared place — the no-slop bar made code:
 * the UI shows human titles, never raw paths/slugs. Frontmatter `title` wins,
 * else the first `# H1`, else the filename is humanized
 * (`daily-loop-2026-06-10` → `Daily loop, 2026-06-10`). Quick captures
 * (`cap_<hex>`) never show the hex: they become `Capture, <date>` from
 * frontmatter `created` or the caller-supplied mtime. Pure and deterministic —
 * no `Date.now()`; dates only come from the note or the caller.
 */

const FIRST_H1_RE = /^#\s+(.+?)\s*$/m
const CAPTURE_BASENAME_RE = /^cap_[0-9a-fA-F]+$/
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/g
// Trailing date split: `daily-loop-2026-06-10` → (`daily-loop`, `2026-06-10`).
const TRAILING_DATE_RE = /^(.+?)[-_ ]+(\d{4}-\d{2}-\d{2})$/

export interface DisplayTitleOpts {
  /** File mtime — the capture-date fallback when frontmatter `created` is absent. */
  mtime?: Date
}

/** True when a basename (no `.md`) is a content-derived quick-capture id (`cap_<hex>`). */
export function isCaptureBasename(basename: string): boolean {
  return CAPTURE_BASENAME_RE.test(basename)
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

/** `YYYY-MM-DD` (UTC) from an ISO string or a YAML-coerced Date; undefined otherwise. */
function isoDay(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string') return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  return undefined
}

function spacify(segment: string): string {
  return segment.replace(/[-_\s]+/g, ' ')
}

/** Hyphens/underscores → spaces, first letter up. Embedded dates stay intact;
 * the rest is never downcased (acronyms and proper nouns survive). */
function humanizeWords(name: string): string {
  // Walk date/non-date segments so `2026-06-10` keeps its hyphens while every
  // other hyphen/underscore becomes a space.
  let out = ''
  let last = 0
  for (const m of name.matchAll(ISO_DATE_RE)) {
    out += spacify(name.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  out += spacify(name.slice(last))
  const flat = out.replace(/ +/g, ' ').trim()
  return flat === '' ? flat : flat.charAt(0).toUpperCase() + flat.slice(1)
}

function humanizeBasename(name: string): string {
  // A trailing date reads best set off with a comma: `Daily loop, 2026-06-10`.
  const dated = name.match(TRAILING_DATE_RE)
  if (dated) {
    const words = humanizeWords(dated[1]!)
    return words === '' ? dated[2]! : `${words}, ${dated[2]!}`
  }
  return humanizeWords(name)
}

/**
 * The human display title for a note. `raw` is the note's full markdown
 * (frontmatter + body) when the caller has it; omit it (or pass null) to title
 * from the filename alone. `opts.mtime` dates an otherwise undatable capture.
 */
export function displayTitle(
  relPath: string,
  raw?: string | null,
  opts?: DisplayTitleOpts,
): string {
  let created: unknown
  if (raw != null) {
    const { data, body } = readNote(raw)
    const fmTitle = typeof data.title === 'string' ? data.title.trim() : ''
    if (fmTitle !== '') return fmTitle
    const h1 = body.match(FIRST_H1_RE)?.[1]?.trim()
    if (h1) return h1
    created = data.created
  }
  const base = basenameNoExt(relPath)
  if (isCaptureBasename(base)) {
    const day = isoDay(created) ?? (opts?.mtime ? isoDay(opts.mtime) : undefined)
    return day ? `Capture, ${day}` : 'Capture'
  }
  return humanizeBasename(base)
}
