import { Shell } from '../components/Shell'
import { CopyBlock } from './CopyBlock'
import { VaultSwitcher } from './VaultSwitcher'
import { getUser, getConnectFacts, getActiveVaultInfo } from '@/lib/vault'

export const dynamic = 'force-dynamic'

/**
 * Settings → "Connect your agent". The front door for the BYO-agent seam: point
 * a Hermes / OpenClaw / any MCP or file agent at this vault, one step, real commands.
 *
 * The honest model: YOUR connected agent does the reasoning over MCP — Agentkeep
 * needs no API key of its own. Give that agent the maintenance routine
 * (AGENT-ROUTINE.md) and it maintains the vault + writes the brief.
 *
 * Everything shown is resolved from the live environment (getConnectFacts) — the
 * actual vault path and the real bin. The config snippets use each agent's
 * verified format (Hermes `mcp_servers` YAML, the standard `mcpServers` JSON), so
 * a copy-paste lands working, not a placeholder.
 */
export default async function SettingsPage() {
  const [user, facts, vaultInfo] = await Promise.all([
    getUser(),
    getConnectFacts(),
    getActiveVaultInfo(),
  ])
  const { vaultPath, binPath } = facts

  // The command an MCP client spawns. `agentkeep-mcp` is on PATH once the package
  // is built + linked (pnpm exposes it via node_modules/.bin); otherwise we fall
  // back to invoking the built file directly, which always works from the repo.
  const launcher = binPath && binPath.endsWith('.js') ? `node ${binPath}` : 'agentkeep-mcp'
  const serveCommand = `${launcher} ${vaultPath}`

  // OpenClaw reads the standard `mcpServers` map from `openclaw.json`.
  const mcpServersJson = (extra: string) =>
    `{
  "mcpServers": {
    "agentkeep": {
      "command": "${launcher.split(' ')[0]}",
      "args": [${launcher.includes(' ') ? `"${binPath}", ` : ''}"${vaultPath}"]${extra}
    }
  }
}`

  const openClawJson = mcpServersJson(',\n      "transport": "stdio"')

  // Hermes reads `~/.hermes/config.yaml` under `mcp_servers:` (stdio: command +
  // args). This is the real shape from the installed Hermes config + docs/mcp.md.
  const hermesYaml = `mcp_servers:
  agentkeep:
    command: ${launcher.split(' ')[0]}
    args: [${launcher.includes(' ') ? `"${binPath}", ` : ''}"${vaultPath}"]`

  const hermesCli = launcher.includes(' ')
    ? `hermes mcp add agentkeep --command node --args ${binPath} ${vaultPath}`
    : `hermes mcp add agentkeep --command agentkeep-mcp --args ${vaultPath}`

  return (
    <Shell user={user}>
      <div className="wrap connect">
        <header className="connect-head">
          <h1>Connect your agent</h1>
          <p className="connect-lede">
            Point the agent you already run at this vault. It reads and writes the
            same markdown through one governed seam, every change a reversible
            commit.
          </p>
        </header>

        {/* Open / switch the vault this app serves. */}
        <VaultSwitcher
          activePath={vaultInfo.activePath}
          recentVaults={vaultInfo.recentVaults}
        />

        {/* The vault + the one command. */}
        <section className="connect-sec">
          <span className="lbl">This vault</span>
          <CopyBlock code={vaultPath} />
          <p className="connect-note">
            Serve the seam over stdio with one command:
          </p>
          <CopyBlock code={serveCommand} />
          {binPath ? (
            <p className="connect-sub sub">
              Launcher:{' '}
              <code className="inlinecode">{binPath}</code>
            </p>
          ) : (
            <p className="connect-sub sub">
              Build it first: <code className="inlinecode">pnpm -w build</code>.
              That produces the <code className="inlinecode">agentkeep-mcp</code>{' '}
              command this vault is served with.
            </p>
          )}
        </section>

        {/* Reasoning = the connected agent. Agentkeep needs no key of its own. */}
        <section className="connect-sec">
          <span className="lbl">Reasoning</span>
          <div className="keybadge on">
            <span className="keydot" />
            <span className="keytext">
              <b>Your connected agent does the reasoning</b>: drafts, links, the
              morning brief. Agentkeep needs no key of its own.
            </span>
          </div>
          <p className="connect-note">
            Hand your agent the maintenance routine and it keeps this vault tidy +
            writes the brief, using only the MCP tools below.
          </p>
          <p className="connect-sub sub">
            <b>Give your agent the routine →</b>{' '}
            <code className="inlinecode">AGENT-ROUTINE.md</code> (repo root).
            Paste it as a system prompt or Hermes skill.
          </p>
        </section>

        {/* Hermes — the primary / home agent. */}
        <section className="connect-sec">
          <span className="lbl">Hermes</span>
          <p className="connect-note">
            The home agent. Agentkeep is built for Hermes first. Add to{' '}
            <code className="inlinecode">~/.hermes/config.yaml</code>, then run{' '}
            <code className="inlinecode">hermes chat</code>:
          </p>
          <CopyBlock code={hermesYaml} label="mcp_servers" />
          <p className="connect-note">Or register it from the CLI:</p>
          <CopyBlock code={hermesCli} />
          <p className="connect-sub sub">
            Hermes can also write files directly. Point it at the folder above and
            its notes re-index live (no restart). MCP gives it the governed seam;
            the folder gives it the raw vault.
          </p>
          <p className="connect-sub sub">
            <b>Then give Hermes the routine →</b>{' '}
            <code className="inlinecode">AGENT-ROUTINE.md</code> drops in as a
            skill at{' '}
            <code className="inlinecode">~/.hermes/skills/agentkeep-keeper/SKILL.md</code>{' '}
            and schedules with{' '}
            <code className="inlinecode">hermes cron create &apos;0 7 * * *&apos;</code>{' '}
            so it files your inbox and writes the morning brief.
          </p>
        </section>

        {/* OpenClaw — also supported. */}
        <section className="connect-sec">
          <span className="lbl">OpenClaw</span>
          <p className="connect-note">
            Add to <code className="inlinecode">openclaw.json</code> under{' '}
            <code className="inlinecode">mcpServers</code>:
          </p>
          <CopyBlock code={openClawJson} label="mcpServers" />
        </section>

        {/* File-only path. */}
        <section className="connect-sec">
          <span className="lbl">Or any file-only agent</span>
          <p className="connect-note">
            No MCP needed. Point any agent that reads and writes files at{' '}
            <code className="inlinecode">{vaultPath}</code>. Write plain
            markdown, drop captures in <code className="inlinecode">inbox/</code>,
            use <code className="inlinecode">[[wikilinks]]</code>. Agentkeep watches
            the folder and re-indexes live. The frontmatter + folder conventions
            are in <code className="inlinecode">SPEC.md</code> at the repo root.
          </p>
        </section>

        <p className="connect-foot sub">
          Theme: Reading Room · Library Green. This page is about connecting; the look
          is fixed for now.
        </p>
      </div>
    </Shell>
  )
}
