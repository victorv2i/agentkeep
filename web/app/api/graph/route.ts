import { NextResponse } from 'next/server'
import { getGraph } from '@/lib/vault'

// Always hit the live index — the vault changes out of band (the agent or a
// file-only tool writes `.md` while we run; the VaultWatcher keeps the index
// fresh). Static caching would serve a stale graph.
export const dynamic = 'force-dynamic'

/**
 * Read-only graph of the whole vault: `GET /api/graph` →
 * `{ nodes: [{ id, title, group, degree }], links: [{ source, target }] }`.
 * Nodes are every indexed note plus a placeholder node per uncreated
 * `[[target]]`; links are the deduped wikilink edges. Feeds the /graph canvas.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(await getGraph())
}
