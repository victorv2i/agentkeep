<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png" />
  <img alt="Agentkeep: your agent's memory, as a vault you can read" src="docs/banner.png" />
</picture>

A self-hosted, MIT, Obsidian-compatible markdown vault your agent keeps,
and you can open, read, and correct.

</div>

<br/>

![What your agent believes](docs/memory.png)

<br/>

## What it is

Your agent accumulates memory. Usually it lives in an opaque store you can't see or fix: SQLite vectors, a black-box SaaS. Agentkeep gives that memory a home you own.

Point your agent at the vault over an MCP seam and its memory becomes plain markdown notes under `memory/`. A web app shows **what your agent believes**, the whole vault as a **graph**, and a focused markdown editor with live `[[wikilinks]]`. Governed writes through MCP or the web app are content-hash guarded and git-committed, so the two of you can edit the same vault safely. Raw file-only agents can still write markdown, but they bypass that write-core. You own the files. Nothing to export, no lock-in.

It is deliberately not magic. Agentkeep **stores and shows** memory; it does no embeddings and no recall ranking. Retrieving the right memory at the right moment is your agent's job. The point is that you can read, trust, and correct what your agent believes, in files you own.

## A look around

<p align="center">
  <img src="docs/editor.png" alt="The editor" width="49%" />
  <img src="docs/graph.png" alt="The graph" width="49%" />
</p>

An Obsidian-friendly editor with live `[[wikilinks]]`, backlinks, and per-note provenance; and a force-directed graph of the whole vault. A warm "reading room" in light and dark:

![Dark mode](docs/memory-dark.png)

## How it works

1. **Connect your agent** (Hermes, OpenClaw, or any MCP or file agent) to the vault.
2. **It writes memory.** Durable facts, preferences, people, and projects land as plain markdown via the `remember` tool; quick captures drop into `inbox/` for it to file.
3. **You read and correct it.** Open the Memory page to see what your agent believes, fix anything stale or wrong, and watch the graph of linked notes grow.

Every MCP/web write, agent or human, goes through a content-hash compare-and-swap, an atomic write, and a git commit. That governed path never clobbers and every change is reversible (`git revert`, or the in-app undo). File-only writes are ordinary filesystem edits; use them when you need raw access, and prefer MCP when you want attribution and conflict protection.

## Features

- **Plain markdown, Obsidian-compatible.** `[[wikilinks]]`, backlinks, per-task JSON. Opens your existing Obsidian vault as-is.
- **The Memory page.** "What your agent believes," grouped by type, each note with its source and git provenance.
- **A force-directed graph** of the whole vault, with memory notes highlighted.
- **An Obsidian-friendly editor** with live preview.
- **Safe two-driver editing.** A content-hash compare-and-swap plus git provenance keeps agent and human edits from colliding.
- **Bring your own agent.** Agentkeep ships no API key of its own; your connected agent does the reasoning over MCP.
- **Self-hosted and yours.** MIT, runs in any browser, installs as a PWA, and exposes over Tailscale for every device.

## Quickstart

Requires Node 22+ and pnpm.

```bash
git clone https://github.com/victorv2i/agentkeep
cd agentkeep
pnpm install
pnpm -w build          # builds the core + the agentkeep / agentkeep-mcp bins

# create a fresh vault (or point at your existing Obsidian vault)
node dist/bin/agentkeep.js init ~/MyVault

# run the web app
node dist/bin/agentkeep.js open ~/MyVault                # http://localhost:3000
node dist/bin/agentkeep.js serve ~/MyVault --tailscale   # ...and over your tailnet
```

The published `@agentkeep/core` package contains the core library and MCP seam. It does not bundle the Next.js web app; use this git checkout for `open` / `serve`. If those web commands are run from an npm-only install, they fail with checkout instructions instead of pretending the web app is present.

`open` serves on localhost only. To reach it from your other devices, run `serve --tailscale` and let the tailnet be the auth boundary; the web app has no login of its own, so never expose the raw port on an untrusted network. `serve --tailscale` starts the local app first, waits for it to answer, then installs the Tailscale Serve route; on normal exit it removes the HTTPS 443 route again. If the process is killed hard, clean up with `tailscale serve --https=443 off`.

`open` works on an existing Obsidian vault as-is. It installs as a PWA (add to home screen); there is deliberately no service worker, because a live vault should never serve stale offline state.

## Connect your agent

Point the agent you already run at the vault. **Settings → Connect** in the app generates copy-paste config with your real vault path filled in. The shapes:

**Hermes** (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  agentkeep:
    command: agentkeep-mcp
    args: ["/path/to/vault"]
```

**Any MCP client** (the standard `mcpServers` map):

```json
{ "mcpServers": { "agentkeep": { "command": "agentkeep-mcp", "args": ["/path/to/vault"] } } }
```

**Any file-only agent:** read and write markdown in the vault folder. This is raw filesystem access: no content-hash guard, no automatic Agentkeep git attribution, and no MCP tool error values. The web app re-indexes external markdown changes while it is running. The frontmatter and folder conventions are in [`SPEC.md`](./SPEC.md).

Then hand your agent the memory-keeper routine in [`AGENT-ROUTINE.md`](./AGENT-ROUTINE.md), a paste-in system prompt or skill. After each session (or on a schedule) it stores durable memory with `remember`, files your inbox, and wikilinks notes into the graph, using only the nine MCP tools.

## The MCP seam

`agentkeep-mcp <vault-path>` serves nine tools over stdio, each governed by the write-core:

`search` · `read_note` · `write_note` · `list_notes` · `list_tasks` · `get_backlinks` · `capture` · `remember` · `delete_note`

See [`SPEC.md`](./SPEC.md) for the full tool and file reference.

## Develop

```bash
pnpm test          # offline, deterministic
pnpm typecheck
pnpm --filter web typecheck
```

## License

MIT.
