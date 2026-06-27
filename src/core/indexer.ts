import { Vault } from './vault.js'
import { readFileOrNull } from './atomic.js'
import { parseNote } from './parse.js'
import { LinkGraph } from './link-graph.js'
import { SearchIndex } from './search-index.js'
import type { SearchHit } from './search-index.js'

/**
 * Ties parse + search + link-graph over a Vault into the derived index. This
 * index is a disposable cache: `reindexAll()` reconstructs it entirely from the
 * markdown files on disk (the rebuildable-from-files guarantee), so it is never a
 * source of truth. `reindexFile`/`removeFile` keep it live for single changes.
 */
export class Indexer {
  private graph = new LinkGraph()
  private search_ = new SearchIndex()

  constructor(private vault: Vault) {}

  /** Full rebuild from `vault.listMarkdown()`. Discards all prior index state. */
  async reindexAll(): Promise<void> {
    this.graph = new LinkGraph()
    this.search_ = new SearchIndex()
    for (const relPath of await this.vault.listMarkdown()) {
      try {
        const abs = await this.vault.resolveSafe(relPath)
        const raw = await readFileOrNull(abs)
        if (raw === null) continue // raced deletion during a full scan — skip
        const meta = parseNote(relPath, raw)
        this.graph.setNote(relPath, meta.links)
        this.search_.upsert(meta)
      } catch (err) {
        // A single unindexable file (e.g. malformed YAML frontmatter — common in
        // real Obsidian vaults) must not abort the whole rebuild. Skip it so the
        // rest of the vault stays searchable and the index is reconstructable.
        console.warn(`agentkeep: skipped unindexable ${relPath}:`, (err as Error).message)
      }
    }
  }

  /** Reindex a single file. If it no longer exists on disk, treat as a removal. */
  async reindexFile(relPath: string): Promise<void> {
    try {
      const abs = await this.vault.resolveSafe(relPath)
      const raw = await readFileOrNull(abs)
      if (raw === null) {
        this.removeFile(relPath)
        return
      }
      const meta = parseNote(relPath, raw)
      this.graph.setNote(relPath, meta.links)
      this.search_.upsert(meta)
    } catch (err) {
      // Same guard as reindexAll: a direct caller (CLI/MCP) must not get a throw
      // on one bad file. Since this is an incremental refresh, remove any stale
      // prior entry for this path before skipping it.
      this.removeFile(relPath)
      console.warn(`agentkeep: skipped unindexable ${relPath}:`, (err as Error).message)
    }
  }

  /** Drop a note from search and the link graph. */
  removeFile(relPath: string): void {
    this.graph.removeNote(relPath)
    this.search_.remove(relPath)
  }

  search(query: string): SearchHit[] {
    return this.search_.search(query)
  }

  getBacklinks(relPath: string): string[] {
    return this.graph.getBacklinks(relPath)
  }

  getLinks(relPath: string): string[] {
    return this.graph.getLinks(relPath)
  }

  /** All indexed note paths, sorted (for deterministic graph scans). */
  notePaths(): string[] {
    return this.graph.notePaths()
  }

  /** Uncreated `[[targets]]` across the vault (deduped) — graph placeholders. */
  getPlaceholders(): string[] {
    return this.graph.getPlaceholders()
  }

  /** A note's raw unresolved targets — its edges to placeholder nodes. */
  getUnresolved(relPath: string): string[] {
    return this.graph.getUnresolved(relPath)
  }
}
