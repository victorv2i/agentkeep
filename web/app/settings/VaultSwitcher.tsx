'use client'

import { useState, useTransition } from 'react'
import {
  preflightVaultAction,
  setActiveVaultAction,
  type VaultPreflightResult,
} from './actions'

type VaultPreflightOk = Extract<VaultPreflightResult, { ok: true }>

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
  const [confirm, setConfirm] = useState<VaultPreflightOk | null>(null)
  const [pending, startTransition] = useTransition()

  const commitOpen = (target: string) => {
    setError(null)
    startTransition(async () => {
      const res = await setActiveVaultAction(target)
      if (res.ok) {
        setPath('')
        setConfirm(null)
      } else {
        setError(res.error)
      }
    })
  }

  const open = (target: string) => {
    setError(null)
    setConfirm(null)
    startTransition(async () => {
      const preflight = await preflightVaultAction(target)
      if (!preflight.ok) {
        setError(preflight.error)
        return
      }
      if (preflight.needsConfirmation) {
        setConfirm(preflight)
        return
      }
      const res = await setActiveVaultAction(preflight.root)
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
            onChange={(e) => {
              setPath(e.target.value)
              setConfirm(null)
            }}
            disabled={pending}
          />
          <button className="vault-btn" type="submit" disabled={pending || path.trim() === ''}>
            {pending ? 'Checking...' : 'Open vault'}
          </button>
        </div>
        {error ? <p className="vault-error">{error}</p> : null}
      </form>

      {confirm ? (
        <div
          className="keybadge off"
          role="group"
          aria-label="Confirm opening a non-Agentkeep folder"
          style={{ marginTop: 14, display: 'block' }}
        >
          <p style={{ margin: 0, color: 'var(--ink)' }}>
            <b>This does not look like an Agentkeep vault yet.</b>
          </p>
          <p className="connect-sub sub" style={{ margin: '8px 0 0' }}>
            Folder:{' '}
            <code className="inlinecode" style={{ overflowWrap: 'anywhere' }}>
              {confirm.root}
            </code>
          </p>
          <ul className="connect-sub sub" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
            <li>
              Agentkeep will create <code className="inlinecode">.agentkeep/config.json</code>{' '}
              and a baseline commit so later edits are reversible.
            </li>
            <li>
              {confirm.hasGitRepo
                ? 'This folder is already in a git repo, so Agentkeep will not run git init.'
                : 'This folder is not a git repo, so Agentkeep will run git init first.'}
            </li>
            <li>
              {confirm.hasRootGitignore
                ? 'Your existing root .gitignore will be left unchanged.'
                : 'On that fresh git init, Agentkeep will write a root .gitignore for .obsidian/, .trash/, and rebuildable .agentkeep cache files.'}
            </li>
            <li>
              Found {confirm.markdownCount} markdown file
              {confirm.markdownCount === 1 ? '' : 's'} outside dotfolders.
            </li>
          </ul>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              className="vault-btn"
              type="button"
              disabled={pending}
              onClick={() => commitOpen(confirm.root)}
              style={{ minHeight: 34 }}
            >
              {pending ? 'Opening...' : 'Open this folder'}
            </button>
            <button
              className="kbd"
              type="button"
              disabled={pending}
              onClick={() => setConfirm(null)}
            >
              Keep current vault
            </button>
          </div>
        </div>
      ) : null}

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
        Opening a folder creates Agentkeep state inside it. If the folder is not
        already a git repo, Agentkeep runs <code className="inlinecode">git init</code>{' '}
        first, then writes a default root <code className="inlinecode">.gitignore</code>{' '}
        only when none exists. Existing <code className="inlinecode">.gitignore</code>{' '}
        files are left untouched.
      </p>
    </section>
  )
}
