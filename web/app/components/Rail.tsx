'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'

const NAV: { href: string; icon: string; label: string }[] = [
  { href: '/', icon: 'vault', label: 'Vault' },
  { href: '/graph', icon: 'graph', label: 'Graph' },
  { href: '/search', icon: 'search', label: 'Search' },
  { href: '/memory', icon: 'memory', label: 'Memory' },
  { href: '/settings', icon: 'settings', label: 'Settings' },
]

/**
 * A small, hand-drawn line-icon set for the rail (1.3px stroke, 16px box) — a
 * closed book, a link graph, a lens, a bookmark, two slider rules. Drawn here
 * rather than pulled from an icon library so the set stays the vault's own.
 */
function NavIcon({ name }: { name: string }) {
  const p = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'graph':
      return (
        <svg {...p}>
          <path d="M5.6 10.4 10.2 5.6" />
          <path d="M5.8 11.6 9.8 11.8" />
          <circle cx="4.2" cy="11.4" r="1.6" />
          <circle cx="11.6" cy="4.6" r="1.6" />
          <circle cx="11.1" cy="11.9" r="1.3" />
        </svg>
      )
    case 'search':
      return (
        <svg {...p}>
          <circle cx="6.9" cy="6.9" r="3.9" />
          <path d="M9.8 9.8 13.4 13.4" />
        </svg>
      )
    case 'memory':
      return (
        <svg {...p}>
          <path d="M4.6 2.6h6.8v10.8l-3.4-2.5-3.4 2.5z" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...p}>
          <path d="M2.6 5.6h10.8" />
          <path d="M2.6 10.4h10.8" />
          <circle cx="6" cy="5.6" r="1.6" fill="var(--space)" />
          <circle cx="10" cy="10.4" r="1.6" fill="var(--space)" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <rect x="3.6" y="2.6" width="8.8" height="10.8" rx="1.2" />
          <path d="M6.1 2.6V13.4" />
        </svg>
      )
  }
}

/** "2h ago" / "just now" / "Jun 8" from an ISO timestamp, for the last-run line. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function Rail({
  user,
  lastRunISO,
  vaultName,
}: {
  user: string
  lastRunISO: string | null
  vaultName?: string
}) {
  const pathname = usePathname()
  const lastRun = lastRunISO ? relTime(lastRunISO) : null
  return (
    <aside className="rail" aria-label="App navigation">
      <Link className="brand" href="/">
        <svg className="brandmark" viewBox="0 0 32 32" width="30" height="30" fill="none" aria-hidden="true">
          {/* an open book — your vault, a thing you actually read */}
          <path
            d="M16 8.6 C 11.5 6.1, 6.5 6.1, 3.5 7.9 L3.5 22.3 C 6.5 20.5, 11.5 20.5, 16 22.9 Z"
            fill="var(--acc)" fillOpacity="0.09" stroke="var(--acc)" strokeWidth="2" strokeLinejoin="round"
          />
          <path
            d="M16 8.6 C 20.5 6.1, 25.5 6.1, 28.5 7.9 L28.5 22.3 C 25.5 20.5, 20.5 20.5, 16 22.9 Z"
            fill="var(--acc)" fillOpacity="0.09" stroke="var(--acc)" strokeWidth="2" strokeLinejoin="round"
          />
        </svg>
        <div className="name">agentkeep</div>
      </Link>
      {vaultName ? (
        <Link className="railvault" href="/settings" title="Open or switch vault">
          <span className="railvault-dot" />
          <span className="railvault-name">{vaultName}</span>
        </Link>
      ) : null}
      <nav className="nav" aria-label="Primary">
        {NAV.map((n) => {
          const cur = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href)
          return (
            <Link
              key={n.href}
              className={cur ? 'cur' : undefined}
              href={n.href}
              aria-current={cur ? 'page' : undefined}
            >
              <span className="g">
                <NavIcon name={n.icon} />
              </span>
              <span className="t">{n.label}</span>
            </Link>
          )
        })}
      </nav>
      <div className="foot">
        <ThemeToggle />
        <div className="online">
          <span className="d" /> agent · run on demand
        </div>
        <div className="muted">
          {lastRun ? `last run ${lastRun} · ` : ''}
          {user} · your tailnet
        </div>
      </div>
    </aside>
  )
}
