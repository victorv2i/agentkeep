#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openVault } from '../core/index.js'
import { Indexer } from '../core/indexer.js'
import { startMcpServer } from '../mcp/server.js'

/**
 * CLI entry for the BYO-agent MCP seam: `agentkeep-mcp <vault-path>` (or
 * `AGENTKEEP_VAULT=<path>`). Opens the vault (git-init + baseline snapshot if
 * fresh), builds the derived index, then serves the seam tools over stdio so any
 * MCP client can drive the vault under the daemon's governance.
 */
export async function resolveMcpVaultRoot(rawArg?: string, envVault = process.env.AGENTKEEP_VAULT): Promise<string> {
  const raw = rawArg ?? envVault
  if (!raw || raw.trim() === '') {
    throw new Error(
      'usage: agentkeep-mcp <vault-path>   (or set AGENTKEEP_VAULT)\n' +
        'Create a vault skeleton first with: agentkeep init <vault-path>',
    )
  }
  const root = resolve(raw)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      throw new Error(`Vault path is not a directory: ${root}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Vault path does not exist: ${root}\n` +
          `Create it first with: agentkeep init ${root}`,
      )
    }
    throw err
  }
  return root
}

async function main(): Promise<void> {
  let root: string
  try {
    root = await resolveMcpVaultRoot(process.argv[2])
  } catch (err) {
    process.stderr.write(`agentkeep-mcp: ${(err as Error).message}\n`)
    process.exitCode = 2
    return
  }

  const { vault, git, core } = await openVault(root)
  const indexer = new Indexer(vault)
  await indexer.reindexAll()

  await startMcpServer({ vault, git, core, indexer })
  // stdio transport keeps the process alive; logging goes to stderr so it never
  // corrupts the stdout JSON-RPC stream the MCP client reads.
  process.stderr.write(`agentkeep-mcp: serving vault ${vault.root} over stdio\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`agentkeep-mcp: fatal: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
