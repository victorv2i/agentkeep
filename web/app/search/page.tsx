import { stat } from 'node:fs/promises'
import { parseNote } from '@agentkeep/core'
import { Shell } from '../components/Shell'
import { getUser, getVault } from '@/lib/vault'
import { SearchClient, type RecentNote } from './SearchClient'

export const dynamic = 'force-dynamic'

/**
 * The most recently modified notes (by mtime), for the pre-query hint state.
 * Stats every markdown path but only READS the few winners for their titles —
 * cheap, and honest about recency (file mtime, not git).
 */
async function recentNotes(limit = 5): Promise<RecentNote[]> {
  const { app } = await getVault()
  const stamped: { path: string; mtime: number }[] = []
  for (const p of await app.vault.listMarkdown()) {
    try {
      const abs = await app.vault.resolveSafe(p)
      stamped.push({ path: p, mtime: (await stat(abs)).mtimeMs })
    } catch {
      // unstattable/raced file — skip it
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime)
  const items: RecentNote[] = []
  for (const { path: p } of stamped.slice(0, limit)) {
    let title = (p.split('/').pop() ?? p).replace(/\.md$/i, '')
    try {
      const r = await app.core.read(p)
      if (r) title = parseNote(p, r.content).title
    } catch {
      // unreadable — the basename is the honest fallback title
    }
    items.push({ path: p, title })
  }
  return items
}

export default async function SearchPage() {
  const [user, recent] = await Promise.all([getUser(), recentNotes()])
  return (
    <Shell user={user}>
      <div className="wrap">
        <h1 className="searchtitle">Search</h1>
        <SearchClient recent={recent} />
      </div>
    </Shell>
  )
}
