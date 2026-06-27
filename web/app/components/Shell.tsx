import path from 'node:path'
import { Rail } from './Rail'
import { Topbar } from './Topbar'
import { lastAgentRunISO, getActiveVaultInfo } from '@/lib/vault'

/** The app shell: left rail + topbar, with the page content slotted in <main>. */
export async function Shell({
  user,
  children,
}: {
  user: string
  children: React.ReactNode
}) {
  const [lastRunISO, vaultInfo] = await Promise.all([lastAgentRunISO(), getActiveVaultInfo()])
  // The folder name of the active vault — a quiet "you're looking at THIS vault"
  // marker in the rail (full path lives on Settings).
  const vaultName = path.basename(vaultInfo.activePath)
  return (
    <div className="app">
      <a className="skiplink" href="#main-content">
        Skip to main content
      </a>
      <Rail user={user} lastRunISO={lastRunISO} vaultName={vaultName} />
      <main id="main-content" tabIndex={-1}>
        <Topbar />
        {children}
      </main>
    </div>
  )
}
