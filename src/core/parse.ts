import { readNote } from './frontmatter.js'

export interface NoteMeta {
  /** Vault-relative path of the note (the graph + search key). */
  path: string
  /** frontmatter `title` ?? first `# H1` ?? basename without extension. */
  title: string
  /** frontmatter `tags` (array or comma-string) ∪ inline `#tag`, deduped. */
  tags: string[]
  /** Normalized wikilink TARGETS (no alias/heading/block/embed-prefix), deduped, in order. */
  links: string[]
  /** Frontmatter-stripped body, for full-text search. */
  text: string
}

// Obsidian-style wikilink: optional `!` embed prefix, then `[[ target (#heading)
// (^block) (|alias) ]]`. We only keep the bare target. The remark plugin
// (@portaljs/remark-wiki-link@1.2.0) crashes on every wikilink against the
// current mdast-util-from-markdown, so we extract targets with this focused
// regex instead.
// Phase 2 decision: `[[...]]` inside inline/fenced code is intentionally NOT
// excluded here (regex tradeoff; acceptable — worst case is a spurious link
// placeholder). Revisit if false links from code blocks become a problem.
// The target class excludes `[` as well as `]` ([^[\]]): an Obsidian link
// target never contains a bracket, and excluding `[` makes a run of `[[[[…`
// fail fast at each start instead of rescanning to the end (O(n) not O(n^2)).
const WIKILINK_RE = /!?\[\[([^[\]]+?)\]\]/g
// Inline `#tag`: a `#` not preceded by a word char (so `foo#bar` is not a tag),
// followed by a tag char run. Allows nested tags like `proj/sub`. Excludes pure
// numerics so `#1` (a heading-ish anchor in prose) is not treated as a tag.
const INLINE_TAG_RE = /(?<![\w/#])#([A-Za-z0-9_][\w/-]*)/g
const FIRST_H1_RE = /^#\s+(.+?)\s*$/m

/** Strip a wikilink inner to its bare target: drop `|alias`, `#heading`, `^block`. */
function targetOf(inner: string): string {
  let t = inner.split('|', 1)[0] ?? inner // alias
  t = t.split('#', 1)[0] ?? t // heading anchor
  t = t.split('^', 1)[0] ?? t // block anchor
  return t.trim()
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

function pushUnique(out: string[], seen: Set<string>, value: string): void {
  if (value && !seen.has(value)) {
    seen.add(value)
    out.push(value)
  }
}

function normalizeFrontmatterTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter(Boolean)
  return []
}

/** Parse a note's raw markdown into the metadata the index layer consumes. */
export function parseNote(relPath: string, raw: string): NoteMeta {
  const { data, body } = readNote(raw)

  const fmTitle = typeof data.title === 'string' ? data.title.trim() : ''
  const h1 = body.match(FIRST_H1_RE)?.[1]?.trim()
  const title = fmTitle || h1 || basenameNoExt(relPath)

  const tags: string[] = []
  const tagSeen = new Set<string>()
  for (const t of normalizeFrontmatterTags(data.tags)) pushUnique(tags, tagSeen, t)
  for (const m of body.matchAll(INLINE_TAG_RE)) pushUnique(tags, tagSeen, m[1]!)

  const links: string[] = []
  const linkSeen = new Set<string>()
  for (const m of body.matchAll(WIKILINK_RE)) pushUnique(links, linkSeen, targetOf(m[1]!))

  return { path: relPath, title, tags, links, text: body }
}
