/**
 * Foam-style in-memory link graph with Obsidian basename resolution. Pure: no
 * filesystem access — the indexer feeds it `(path, linkTargets)` pairs.
 *
 * A note's outgoing wikilink *targets* (e.g. `B`, `notes/Deep`) are resolved to
 * concrete note paths the Obsidian way: by basename (no extension) or by a full
 * relative path (with or without `.md`). A target with no matching note is a
 * first-class **placeholder** and resolves automatically once the target note is
 * added. Edges are derived on read from the stored targets + the set of existing
 * notes, so add/remove on either end stays consistent with no stale edges.
 */
export class LinkGraph {
  /** path -> its outgoing wikilink targets (deduped, order-stable). */
  private targets = new Map<string, string[]>()
  /** basename(no ext, lowercased) -> set of note paths with that basename. */
  private byBasename = new Map<string, Set<string>>()

  /** Insert or replace a note and its outgoing link targets. */
  setNote(path: string, linkTargets: string[]): void {
    if (this.targets.has(path)) this.unindexBasename(path)
    const deduped: string[] = []
    const seen = new Set<string>()
    for (const t of linkTargets) {
      const v = t.trim()
      if (v && !seen.has(v)) { seen.add(v); deduped.push(v) }
    }
    this.targets.set(path, deduped)
    this.indexBasename(path)
  }

  /** Remove a note entirely (its outgoing edges and its node). */
  removeNote(path: string): void {
    if (!this.targets.has(path)) return
    this.unindexBasename(path)
    this.targets.delete(path)
  }

  /** Resolved outgoing link target paths for `path` (existing notes only). */
  getLinks(path: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const t of this.targets.get(path) ?? []) {
      const resolved = this.resolve(t)
      if (resolved && !seen.has(resolved)) { seen.add(resolved); out.push(resolved) }
    }
    return out
  }

  /** Raw outgoing targets of `path` that no existing note satisfies (deduped). */
  getUnresolved(path: string): string[] {
    const out: string[] = []
    for (const t of this.targets.get(path) ?? []) {
      if (!this.resolve(t)) out.push(t)
    }
    return out
  }

  /** Paths of existing notes that link TO `path` (deduped). */
  getBacklinks(path: string): string[] {
    const out: string[] = []
    for (const [source, ts] of this.targets) {
      if (source === path) continue
      if (ts.some((t) => this.resolve(t) === path)) out.push(source)
    }
    return out
  }

  /** All existing note paths (graph nodes), sorted — for deterministic scans. */
  notePaths(): string[] {
    return [...this.targets.keys()].sort()
  }

  /** Targets that no existing note satisfies (uncreated `[[notes]]`), deduped. */
  getPlaceholders(): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const ts of this.targets.values()) {
      for (const t of ts) {
        if (!this.resolve(t) && !seen.has(t)) { seen.add(t); out.push(t) }
      }
    }
    return out
  }

  /** Resolve a wikilink target to an existing note path, or null (placeholder). */
  private resolve(target: string): string | null {
    // Full-path match first: a slash-bearing target addresses a path directly.
    if (target.includes('/')) {
      const withExt = target.toLowerCase().endsWith('.md') ? target : `${target}.md`
      if (this.targets.has(withExt)) return withExt
      if (this.targets.has(target)) return target
      return null
    }
    // Basename match (Obsidian default). One existing note wins; ambiguity
    // (multiple basenames) is resolved deterministically by sorted-first path —
    // shortest-unique-path refinement is a later concern, not Phase 2's contract.
    const key = stripMd(target).toLowerCase()
    const set = this.byBasename.get(key)
    if (!set || set.size === 0) return null
    if (set.size === 1) return [...set][0]!
    return [...set].sort()[0]!
  }

  private indexBasename(path: string): void {
    const key = basenameKey(path)
    let set = this.byBasename.get(key)
    if (!set) { set = new Set(); this.byBasename.set(key, set) }
    set.add(path)
  }

  private unindexBasename(path: string): void {
    const key = basenameKey(path)
    const set = this.byBasename.get(key)
    if (set) { set.delete(path); if (set.size === 0) this.byBasename.delete(key) }
  }
}

function stripMd(s: string): string {
  return s.replace(/\.md$/i, '')
}

function basenameKey(path: string): string {
  const base = path.split('/').pop() ?? path
  return stripMd(base).toLowerCase()
}
