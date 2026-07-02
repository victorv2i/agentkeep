import { Shell } from '../components/Shell'
import { CopyBlock } from './CopyBlock'
import { VaultSwitcher } from './VaultSwitcher'
import { getUser, getConnectFacts, getActiveVaultInfo } from '@/lib/vault'

export const dynamic = 'force-dynamic'

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(' ')
}

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

/**
 * Settings > "Connect your agent". The front door for MCP access: point
 * any MCP or file agent at this vault, one step, real commands.
 *
 * The honest model: YOUR connected agent does the reasoning over MCP. Agentkeep
 * needs no API key of its own. Give that agent the maintenance routine
 * (AGENT-ROUTINE.md) and it stores memory, files inbox captures, links notes,
 * and handles conflicts.
 *
 * Everything shown is resolved from the live environment (getConnectFacts): the
 * actual vault path and the real bin. The config snippets use each agent's
 * common MCP formats (`mcp_servers` YAML, the standard `mcpServers` JSON), so
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
  // is built + linked (pnpm exposes it via node_modules/.bin). Prefer the real
  // resolved executable path when available so spaces in checkout paths do not
  // rely on a user's PATH. A compiled JS file is invoked through node.
  const mcpCommand = binPath ? (binPath.endsWith('.js') ? 'node' : binPath) : 'agentkeep-mcp'
  const mcpArgs = binPath?.endsWith('.js') ? [binPath, vaultPath] : [vaultPath]
  const serveCommand = shellJoin([mcpCommand, ...mcpArgs])

  // Standard MCP clients read a `mcpServers` map. Let JSON.stringify do all
  // string escaping for paths, quotes, and backslashes.
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        agentkeep: {
          command: mcpCommand,
          args: mcpArgs,
          transport: 'stdio',
        },
      },
    },
    null,
    2,
  )

  // Some MCP clients read YAML under `mcp_servers:`. Double-quoted YAML scalars
  // keep spaces, quotes, and backslashes safe.
  const mcpYaml = `mcp_servers:
  agentkeep:
    command: ${yamlQuote(mcpCommand)}
    args:
${mcpArgs.map((arg) => `      - ${yamlQuote(arg)}`).join('\n')}`

  const mcpProbeScript =
    'const msgs=[{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"agentkeep-smoke",version:"0"}}},{jsonrpc:"2.0",method:"notifications/initialized",params:{}},{jsonrpc:"2.0",id:2,method:"tools/list",params:{}}];for(const m of msgs){const body=JSON.stringify(m);process.stdout.write("Content-Length: "+Buffer.byteLength(body)+"\\r\\n\\r\\n"+body)}'
  const smokeTest = `${shellJoin(['node', '-e', mcpProbeScript])} | timeout 5s ${serveCommand} | grep -E '"(capture|remember|list_notes)"'`

  return (
    <Shell user={user}>
      <div className="wrap connect">
        <header className="connect-head">
          <h1>Connect your agent</h1>
          <p className="connect-lede">
            Point the agent you already run at this vault. It reads and writes the
            same markdown through MCP, every change a reversible
            commit.
          </p>
        </header>

        {/* Open / switch the vault this app serves. */}
        <VaultSwitcher
          activePath={vaultInfo.activePath}
          recentVaults={vaultInfo.recentVaults}
        />

        <section className="connect-sec">
          <span className="lbl">Local access</span>
          <div className="keybadge off">
            <span className="keydot" />
            <span className="keytext">
              <b>No login wall:</b> Agentkeep is a local, single-user app. Anyone
              who can reach this web server can read and edit the active vault.
              Keep it on localhost or a private tailnet. Your notes and app state
              stay on this machine.
            </span>
          </div>
        </section>

        {/* The vault + the one command. */}
        <section className="connect-sec">
          <span className="lbl">This vault</span>
          <CopyBlock code={vaultPath} />
          <p className="connect-note">
            Serve MCP over stdio with one command:
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
              <b>Your connected agent does the reasoning</b>: stores memory, files
              inbox captures, links related notes, and handles conflicts. Agentkeep
              needs no key of its own.
            </span>
          </div>
          <p className="connect-note">
            Hand your agent the maintenance routine and it keeps this vault tidy,
            using only the MCP tools below.
          </p>
          <p className="connect-sub sub">
            <b>Give your agent the routine →</b>{' '}
            <code className="inlinecode">AGENT-ROUTINE.md</code> (repo root).
            Paste it as a system prompt, skill, or schedule prompt.
          </p>
        </section>

        <section className="connect-sec">
          <span className="lbl">MCP smoke test</span>
          <p className="connect-note">
            This sends an MCP initialize request and a <code className="inlinecode">tools/list</code>{' '}
            request over stdio. A working server prints tool names such as{' '}
            <code className="inlinecode">capture</code>,{' '}
            <code className="inlinecode">remember</code>, and{' '}
            <code className="inlinecode">list_notes</code>.
          </p>
          <CopyBlock code={smokeTest} label="tools/list probe" />
          <p className="connect-sub sub">
            If it fails: run <code className="inlinecode">pnpm -w build</code>,
            confirm the vault path exists, make sure your MCP client uses stdio,
            and keep server logs on stderr so stdout stays reserved for JSON-RPC.
            If your shell has no <code className="inlinecode">timeout</code>,
            omit that word and stop the command after the response.
          </p>
        </section>

        {/* YAML MCP config. */}
        <section className="connect-sec">
          <span className="lbl">YAML MCP config</span>
          <p className="connect-note">
            Add this to clients that use <code className="inlinecode">mcp_servers</code>:
          </p>
          <CopyBlock code={mcpYaml} label="mcp_servers" />
          <p className="connect-sub sub">
            Agents can also write files directly. Point one at the folder above
            and its notes re-index live. MCP gives it protected writes; the
            folder gives it the raw vault.
          </p>
          <p className="connect-sub sub">
            <b>Then give your agent the routine →</b>{' '}
            <code className="inlinecode">AGENT-ROUTINE.md</code> drops in as a
            system prompt, skill, or scheduled routine so it stores memory, files
            inbox captures, links notes, and handles conflicts.
          </p>
        </section>

        {/* JSON MCP config. */}
        <section className="connect-sec">
          <span className="lbl">JSON MCP config</span>
          <p className="connect-note">
            Add this to clients that use the standard{' '}
            <code className="inlinecode">mcpServers</code> map:
          </p>
          <CopyBlock code={mcpJson} label="mcpServers" />
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
