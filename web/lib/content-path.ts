/**
 * Path guards for the web data layer.
 *
 * `Vault.resolveSafe` (core) blocks a path from escaping the vault ROOT, but it
 * still permits in-root dotfolders like `.git/`, `.obsidian/`, `.agentkeep/`.
 * The web app's load/save/provenance/undo/image actions are unauthenticated
 * (single-user self-host, often on a Tailscale tailnet), so without an extra
 * guard a caller could WRITE `.git/config` (→ remote code execution on the next
 * git op) or READ it (secret leak). These predicates restrict the web funnels to
 * ordinary vault content — and, for note edits, to markdown files only.
 *
 * Pure string logic, deliberately free of `server-only`/core imports so it is
 * unit-testable on its own (the rest of `vault.ts` cannot be imported under
 * vitest because of its `import 'server-only'`).
 */

/**
 * A vault-relative path that points at ordinary CONTENT: not absolute, no
 * traversal segment, and no hidden (dot-prefixed) segment — so `.git/`,
 * `.obsidian/`, `.agentkeep/` and dotfiles are all rejected.
 */
export function isContentPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath === '') return false
  if (relPath.startsWith('/')) return false // absolute
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (seg.startsWith('.')) return false // .git, .obsidian, .agentkeep, dotfiles
  }
  return true
}

/** A content path that is a markdown NOTE — what the editor loads and saves. */
export function isNotePath(relPath: string): boolean {
  return isContentPath(relPath) && /\.md$/i.test(relPath)
}

/**
 * Shared wikilink-resolution rule: whether `target` currently resolves to an
 * existing note in `notes`. Mirrors the core `LinkGraph`'s resolver
 * (src/core/link-graph.ts `resolve`) and the server's `resolveTarget`
 * (web/lib/vault.ts) EXACTLY, including their case-sensitivity split: a target
 * WITH a slash addresses a path directly and must match the path case-
 * sensitively (with or without `.md`); a bare target matches by basename
 * case-insensitively. Both sides of the editor — the live-preview's "is this a
 * placeholder?" styling and the click handler's actual navigation/create —
 * must agree, or a link can render as resolved while clicking it still prompts
 * to create it (or vice versa).
 */
export function isWikilinkTargetResolved(
  target: string,
  notes: Array<{ path: string; basename: string }>,
): boolean {
  const t = target.replace(/\.md$/i, '').trim()
  if (t === '') return false
  if (t.includes('/')) {
    const withExt = t.toLowerCase().endsWith('.md') ? t : `${t}.md`
    return notes.some((n) => n.path === withExt || n.path === t)
  }
  const key = t.toLowerCase()
  return notes.some((n) => n.basename.toLowerCase() === key)
}
