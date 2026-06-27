import Link from 'next/link'
import { Shell } from '../components/Shell'
import {
  getUser,
  getMemoryNotes,
  getKeeperLoopSummary,
  type MemoryNote,
} from '@/lib/vault'

export const dynamic = 'force-dynamic'

// Group order is fixed; 'other' (notes under memory/ without a known type) is
// always last with an honest "untyped" label. Empty groups are omitted.
const GROUPS: { type: MemoryNote['type']; label: string }[] = [
  { type: 'fact', label: 'Facts' },
  { type: 'preference', label: 'Preferences' },
  { type: 'person', label: 'People' },
  { type: 'project', label: 'Projects' },
  { type: 'other', label: 'Untyped' },
]

/** ISO date → "Jun 10" (or the raw string if unparseable — never invent). */
function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function shortDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * "What your agent believes" — the plain markdown under memory/, grouped by
 * type, plus the agent's recent commits. This page only SHOWS what is on disk
 * and in git: no ranking, no recall scoring — retrieval is your agent's job;
 * the vault is the readable store.
 */
export default async function MemoryPage() {
  const [user, notes, keeper] = await Promise.all([
    getUser(),
    getMemoryNotes(),
    getKeeperLoopSummary(),
  ])
  const activity = keeper.recentActivity

  const grouped = GROUPS.map((g) => ({
    ...g,
    notes: notes.filter((n) => n.type === g.type),
  })).filter((g) => g.notes.length > 0)

  return (
    <Shell user={user}>
      <div className="wrap">
        <h1 className="hi">What your agent believes</h1>
        <p className="sub">
          Every memory is a plain markdown note under <code>memory/</code>, written by your
          agent&rsquo;s <code>remember</code> tool, editable by you, every change a git commit.
        </p>

        <section className="memgroup" aria-labelledby="keeper-loop-title">
          <h2 id="keeper-loop-title" className="memhead mono">
            Daily keeper loop
          </h2>
          <ul className="memlist">
            <li className="memact">
              <span className="memmeta mono">Inbox</span>
              <span className="memactmsg">
                {keeper.inboxCount === 0
                  ? 'No captures waiting.'
                  : `${keeper.inboxCount} capture${keeper.inboxCount === 1 ? '' : 's'} waiting to be filed.`}
              </span>
            </li>
            <li className="memact">
              <span className="memmeta mono">Last run</span>
              <span className="memactmsg">
                {keeper.lastAgentRunISO
                  ? shortDateTime(keeper.lastAgentRunISO)
                  : 'No agent-authored commit yet.'}
              </span>
            </li>
            <li className="memact">
              <span className="memmeta mono">Brief</span>
              {keeper.latestBrief ? (
                <Link
                  className="memactmsg"
                  href={`/?path=${encodeURIComponent(keeper.latestBrief.path)}`}
                  title={keeper.latestBrief.path}
                >
                  {keeper.latestBrief.title}
                  {keeper.latestBrief.excerpt ? ` - ${keeper.latestBrief.excerpt}` : ''}
                </Link>
              ) : (
                <span className="memactmsg">No brief note found yet.</span>
              )}
            </li>
            <li className="memact">
              <span className="memmeta mono">Recent</span>
              {activity[0] ? (
                activity[0].path ? (
                  <Link
                    className="memactmsg"
                    href={`/?path=${encodeURIComponent(activity[0].path)}`}
                    title={activity[0].path}
                  >
                    {activity[0].action}
                  </Link>
                ) : (
                  <span className="memactmsg">{activity[0].action}</span>
                )
              ) : (
                <span className="memactmsg">No recent agent activity yet.</span>
              )}
            </li>
          </ul>
          <p className="memempty">
            Next step: ask your connected agent to{' '}
            <code>run the Agentkeep memory-keeper routine</code>. It files inbox
            captures, updates <code>memory/</code>, links related notes, and writes
            the brief when your routine asks for one.{' '}
            <Link className="connect-link" href="/settings">
              Connect or schedule it
            </Link>
          </p>
        </section>

        {grouped.length === 0 ? (
          <div className="memempty">
            Your agent hasn&rsquo;t written any memory yet. Point it at this vault; the{' '}
            <code>remember</code> MCP tool stores durable facts, preferences, people, and projects
            as notes under <code>memory/</code>.{' '}
            <Link className="connect-link" href="/settings">
              Connect your agent →
            </Link>
          </div>
        ) : (
          grouped.map((g) => (
            <section key={g.type} className="memgroup">
              <h2 className="memhead mono">{g.label}</h2>
              <ul className="memlist">
                {g.notes.map((n) => (
                  <li key={n.path}>
                    <Link className="memrow" href={`/?path=${encodeURIComponent(n.path)}`}>
                      <span className="memtitle">{n.title}</span>
                      {n.excerpt !== '' && n.excerpt !== n.title ? (
                        <span className="memex">{n.excerpt}</span>
                      ) : null}
                      <span className="memmeta mono">
                        {n.updated ? `updated ${n.updated}` : ''}
                        {n.updated && n.source ? ' · ' : ''}
                        {n.source ? `from ${n.source}` : ''}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {activity.length > 0 ? (
          <section className="memgroup">
            <h2 className="memhead mono">Recent agent activity</h2>
            <ul className="memlist">
              {activity.map((a) => (
                <li key={a.sha} className="memact">
                  <span className="memmeta mono">{shortDate(a.date)}</span>
                  {a.path ? (
                    <Link
                      className="memactmsg"
                      href={`/?path=${encodeURIComponent(a.path)}`}
                      title={a.path}
                    >
                      {a.action}
                    </Link>
                  ) : (
                    <span className="memactmsg">{a.action}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Shell>
  )
}
