'use client'

import { useState, useTransition } from 'react'
import { setActiveVaultAction } from './actions'

/**
 * The Settings "Vault" section: shows the vault the app is serving, lets you open
 * any folder by absolute path, and quick-switches to a recently-opened vault.
 *
 * A self-hosted server app can't pop a native directory PICKER in the browser, so
 * an absolute-path field is the honest mechanism — labeled as such. Submitting
 * runs the `setActiveVault` server action, which validates the folder, opens it
 * (git-init + `.gitignore` so nothing of your Obsidian config is committed), and
 * swaps the live index/watcher to the new root. On success the path becomes the
 * new active vault and lands at the top of recents.
 */
export function VaultSwitcher({
  activePath,
  recentVaults,
}: {
  activePath: string
  recentVaults: string[]
}) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const open = (target: string) => {
    setError(null)
    startTransition(async () => {
      const res = await setActiveVaultAction(target)
      if (res.ok) {
        setPath('')
      } else {
        setError(res.error)
      }
    })
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    open(path)
  }

  // The recents minus the one we're already serving (no point switching to it).
  const others = recentVaults.filter((p) => p !== activePath)

  return (
    <section className="connect-sec vault-sec">
      <span className="lbl">Vault</span>

      <p className="connect-note">The vault Agentkeep is serving right now:</p>
      <div className="vault-current">
        <span className="vault-dot" />
        <code className="vault-path">{activePath}</code>
      </div>

      <form className="vault-open" onSubmit={onSubmit}>
        <label className="vault-field-lbl lbl" htmlFor="vault-path">
          Absolute path to your vault folder
        </label>
        <div className="vault-row">
          <input
            id="vault-path"
            className="vault-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="/home/you/Documents/MyVault"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={pending}
          />
          <button className="vault-btn" type="submit" disabled={pending || path.trim() === ''}>
            {pending ? 'Opening…' : 'Open vault'}
          </button>
        </div>
        {error ? <p className="vault-error">{error}</p> : null}
      </form>

      {others.length > 0 ? (
        <div className="vault-recents">
          <span className="lbl">Recent vaults</span>
          <div className="vault-recent-row">
            {others.map((p) => (
              <button
                key={p}
                type="button"
                className="vault-recent"
                onClick={() => open(p)}
                disabled={pending}
                title={p}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p className="connect-sub sub">
        Opening your existing vault git-inits it (for undo + attribution) and writes
        a <code className="inlinecode">.gitignore</code> for{' '}
        <code className="inlinecode">.obsidian/</code>, so nothing of your Obsidian
        config is ever committed. Your existing <code className="inlinecode">.gitignore</code>,
        if any, is left untouched.
      </p>
    </section>
  )
}
