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
