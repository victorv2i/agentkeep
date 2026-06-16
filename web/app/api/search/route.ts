import { NextResponse } from 'next/server'
import { parseNote } from '@agentkeep/core'
import { getVault } from '@/lib/vault'
import { capHits, makeSnippet, type SnippetParts } from '@/app/search/snippet'

// Always hit the live index — the vault changes out of band (the agent or a
// file-only tool writes `.md` while we run; the VaultWatcher keeps the index
// fresh). Static caching would serve stale results.
export const dynamic = 'force-dynamic'

/**
 * Read-only search over the live derived index: `GET /api/search?q=<query>`.
 * Returns `{ total, hits: [{ path, title, score, snippet }] }` — hits capped
 * server-side at RESULT_CAP (30) with the honest pre-cap `total` alongside, and
 * each returned hit carries a one-line context snippet around its first match
 * (frontmatter-stripped body via parseNote; null when the body is empty or the
 * note is unreadable). Because `getVault()` starts the VaultWatcher, a note
 * written straight to the vault by an external agent shows up here without a
 * server restart — this endpoint is the proof of that seam.
 */
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (q === '') return NextResponse.json({ hits: [], total: 0 })
  const { app, indexer } = await getVault()
  const { top, total } = capHits(indexer.search(q))
  const hits = []
  for (const h of top) {
    let snippet: SnippetParts | null = null
    try {
      const r = await app.core.read(h.path)
      if (r) snippet = makeSnippet(parseNote(h.path, r.content).text, q)
    } catch {
      // Unreadable note — a title-only hit with no snippet is the honest render.
    }
    hits.push({ ...h, snippet })
  }
  return NextResponse.json({ hits, total })
}
