#!/usr/bin/env node
import { openVault } from '../core/index.js'
import { Indexer } from '../core/indexer.js'
import { startMcpServer } from '../mcp/server.js'

/**
 * CLI entry for the BYO-agent MCP seam: `agentkeep-mcp <vault-path>` (or
 * `AGENTKEEP_VAULT=<path>`). Opens the vault (git-init + baseline snapshot if
 * fresh), builds the derived index, then serves the seam tools over stdio so any
 * MCP client can drive the vault under the daemon's governance.
 */
async function main(): Promise<void> {
  const root = process.argv[2] ?? process.env.AGENTKEEP_VAULT
  if (!root) {
    process.stderr.write('usage: agentkeep-mcp <vault-path>   (or set AGENTKEEP_VAULT)\n')
    process.exit(2)
  }

  const { vault, git, core } = await openVault(root)
  const indexer = new Indexer(vault)
  await indexer.reindexAll()

  await startMcpServer({ vault, git, core, indexer })
  // stdio transport keeps the process alive; logging goes to stderr so it never
  // corrupts the stdout JSON-RPC stream the MCP client reads.
  process.stderr.write(`agentkeep-mcp: serving vault ${vault.root} over stdio\n`)
}

main().catch((err) => {
  process.stderr.write(`agentkeep-mcp: fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
