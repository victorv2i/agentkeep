import MiniSearch from 'minisearch'
import type { NoteMeta } from './parse.js'

export interface SearchHit {
  path: string
  title: string
  score: number
}

interface IndexedDoc {
  id: string
  title: string
  tags: string
  text: string
}

/**
 * Incremental full-text search over notes, backed by MiniSearch. A thin wrapper
 * keyed by note path: `upsert` adds or replaces, `remove` discards, `search`
 * returns ranked hits with the title boosted. Part of the derived, rebuildable
 * index — never a source of truth.
 */
export class SearchIndex {
  private mini = new MiniSearch<IndexedDoc>({
    idField: 'id',
    fields: ['title', 'tags', 'text'],
    storeFields: ['title'],
    searchOptions: {
      // Title hits outrank body hits; tags sit between. Prefix + fuzzy give
      // forgiving incremental search.
      boost: { title: 3, tags: 2, text: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  })

  /** Add a note, or replace it if already indexed (no duplicate documents). */
  upsert(meta: NoteMeta): void {
    const doc: IndexedDoc = {
      id: meta.path,
      title: meta.title,
      tags: meta.tags.join(' '),
      text: meta.text,
    }
    if (this.mini.has(meta.path)) this.mini.replace(doc)
    else this.mini.add(doc)
  }

  /** Remove a note from the index. No-op if it was never indexed. */
  remove(path: string): void {
    if (this.mini.has(path)) this.mini.discard(path)
  }

  /** Ranked search hits (highest score first). */
  search(query: string): SearchHit[] {
    return this.mini
      .search(query)
      .map((r) => ({ path: r.id as string, title: (r as { title?: string }).title ?? '', score: r.score }))
  }
}
