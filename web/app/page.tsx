import { Shell } from './components/Shell'
import { NotesClient } from './notes/NotesClient'
import { getUser, listNotes } from '@/lib/vault'

// The vault IS the app: home is the two-pane browser/editor. Always render
// against the live vault on the server (no static caching — the vault changes
// out of band as the agent works).
export const dynamic = 'force-dynamic'

export default async function VaultHome({
  searchParams,
}: {
  searchParams: Promise<{ path?: string | string[] }>
}) {
  const [user, notes, params] = await Promise.all([getUser(), listNotes(), searchParams])
  // `/?path=<vault-relative>` deep-links a note open on load (graph + search
  // navigate here). Anything non-string/empty is ignored — normal vault home.
  const raw = params.path
  const initialPath = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  return (
    <Shell user={user}>
      <NotesClient initialNotes={notes} initialPath={initialPath} />
    </Shell>
  )
}
