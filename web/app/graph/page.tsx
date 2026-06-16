import { Shell } from '../components/Shell'
import { getUser } from '@/lib/vault'
import { GraphClient } from './GraphClient'

export const dynamic = 'force-dynamic'

/**
 * The vault graph — a full-viewport force-directed map of notes, memory, and
 * their wikilinks. All rendering/interaction lives in the client component;
 * it fetches the live payload from /api/graph on mount.
 */
export default async function GraphPage() {
  const user = await getUser()
  return (
    <Shell user={user}>
      <GraphClient />
    </Shell>
  )
}
