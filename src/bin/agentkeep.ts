#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'
import {
  parseLauncherArgs,
  initVault,
  seedDemoMemory,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  waitForHttpReady,
} from './launcher.js'

/**
 * The one-line `agentkeep` launcher (self-host model, runs from the repo
 * checkout). Wraps what the README walks people through by hand: build the web
 * app, start it on a vault, optionally expose it over the tailnet.
 */
const HELP = `agentkeep: self-hosted vault launcher (runs from the repo checkout)

  agentkeep init <path>               create a vault skeleton (inbox/, memory/)
  agentkeep demo <path> [--force]     add fictional demo memory notes
  agentkeep open <path> [--port N]    build (if needed) + serve the web app on this vault
  agentkeep serve <path> --tailscale  open + expose over your tailnet via 'tailscale serve'

Point your agent at the same vault with: agentkeep-mcp <path>
`

// dist/bin/agentkeep.js to repo root is two levels up
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function main(): Promise<void> {
  const args = parseLauncherArgs(process.argv.slice(2))
  if (args.cmd === 'help') {
    process.stdout.write(HELP)
    process.exitCode = 1
    return
  }
  const vault = resolve(args.path!)

  if (args.cmd === 'init') {
    const created = await initVault(vault)
    process.stdout.write(
      created.length ? `Created ${created.join(', ')} in ${vault}\n` : `Vault already initialized: ${vault}\n`,
    )
    return
  }

  if (args.cmd === 'demo') {
    const written = await seedDemoMemory(vault, { force: args.force })
    process.stdout.write(`Wrote ${written.length} fictional demo memory notes in ${join(vault, 'memory')}\n`)
    return
  }

  // open / serve: ensure the web app is built, then start it on this vault.
  const webDir = join(repoRoot, 'web')
  // The web app ships only with the git checkout, not the npm package (which is
  // the MCP server + bins). If web/ is absent, this is an npm install, point the
  // user at the checkout instead of failing on a confusing build error.
  const webExists = await stat(webDir).then(() => true, () => false)
  if (!webExists) {
    process.stderr.write(
      'The Agentkeep web app runs from a git checkout, not the npm package.\n' +
        '  git clone https://github.com/victorv2i/agentkeep && cd agentkeep\n' +
        '  pnpm install && pnpm -w build && node dist/bin/agentkeep.js open <vault>\n' +
        'The `agentkeep-mcp <vault>` server works from npm, point your agent at that.\n',
    )
    process.exitCode = 1
    return
  }
  const built = await stat(join(webDir, '.next')).then(() => true, () => false)
  if (!built) {
    process.stdout.write('First run: building the web app…\n')
    const b = spawnSync('pnpm', ['--filter', '@agentkeep/web', 'build'], { cwd: repoRoot, stdio: 'inherit' })
    if (b.status !== 0) {
      process.stderr.write('Build failed.\n')
      process.exitCode = 1
      return
    }
  }

  process.stdout.write(`Serving vault ${vault} on http://localhost:${args.port}\n`)
  // Invoke the next bin directly (not via `pnpm start --`) so the port flag
  // always reaches `next start` regardless of pnpm's arg forwarding.
  const child = spawn(join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(args.port), '-H', '127.0.0.1'], {
    cwd: webDir,
    env: { ...process.env, AGENTKEEP_VAULT: vault },
    stdio: 'inherit',
  })

  let childExited = false
  let tailscaleActive = false
  const cleanupTailscale = () => {
    if (!tailscaleActive) return
    tailscaleActive = false
    const off = spawnSync('tailscale', tailscaleServeOffArgs(), { stdio: 'ignore' })
    if (off.error || off.status !== 0) {
      process.stderr.write("Could not clean up 'tailscale serve --https=443 off'. You may need to run it manually.\n")
    }
  }
  const shutdown = (signal: NodeJS.Signals) => {
    cleanupTailscale()
    if (!child.killed) child.kill(signal)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  child.on('error', (err) => {
    process.stderr.write(
      `Could not start the web app (is the repo built? try 'pnpm install && pnpm --filter @agentkeep/web build'): ${err.message}\n`,
    )
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    childExited = true
    cleanupTailscale()
    process.exitCode = code ?? 0
  })

  if (args.cmd === 'serve' && args.tailscale) {
    process.stdout.write('Waiting for the local web app before enabling Tailscale Serve…\n')
    const ready = await waitForHttpReady(`http://127.0.0.1:${args.port}/`, { shouldStop: () => childExited })
    if (!ready) {
      if (!childExited) {
        process.stderr.write("Local web app did not become ready; not running 'tailscale serve'. Serving locally only.\n")
      }
      return
    }
    const ts = spawnSync('tailscale', tailscaleServeArgs(args.port), { stdio: 'inherit' })
    if (ts.error || ts.status !== 0) {
      process.stderr.write("Could not run 'tailscale serve'. Is Tailscale installed and up? Serving locally only.\n")
    } else {
      tailscaleActive = true
      process.stdout.write("Tailscale Serve is active; Agentkeep will remove the HTTPS 443 route when the app exits.\n")
    }
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n')
  process.exitCode = 1
})
