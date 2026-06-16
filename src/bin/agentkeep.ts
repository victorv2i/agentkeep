#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'
import { parseLauncherArgs, initVault } from './launcher.js'

/**
 * The one-line `agentkeep` launcher (self-host model — runs from the repo
 * checkout). Wraps what the README walks people through by hand: build the web
 * app, start it on a vault, optionally expose it over the tailnet.
 */
const HELP = `agentkeep — self-hosted vault launcher (runs from the repo checkout)

  agentkeep init <path>               create a vault skeleton (inbox/, tasks/, north-star.md)
  agentkeep open <path> [--port N]    build (if needed) + serve the web app on this vault
  agentkeep serve <path> --tailscale  open + expose over your tailnet via 'tailscale serve'

Point your agent at the same vault with: agentkeep-mcp <path>
`

// dist/bin/agentkeep.js → repo root is two levels up
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

  // open / serve: ensure the web app is built, then start it on this vault.
  const webDir = join(repoRoot, 'web')
  // The web app ships only with the git checkout, not the npm package (which is
  // the MCP seam + bins). If web/ is absent, this is an npm install — point the
  // user at the checkout instead of failing on a confusing build error.
  const webExists = await stat(webDir).then(() => true, () => false)
  if (!webExists) {
    process.stderr.write(
      'The Agentkeep web app runs from a git checkout, not the npm package.\n' +
        '  git clone https://github.com/victorv2i/agentkeep && cd agentkeep\n' +
        '  pnpm install && pnpm -w build && node dist/bin/agentkeep.js open <vault>\n' +
        'The `agentkeep-mcp <vault>` seam DOES work from npm — point your agent at that.\n',
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

  if (args.cmd === 'serve' && args.tailscale) {
    const ts = spawnSync('tailscale', ['serve', '--bg', '--https=443', `http://127.0.0.1:${args.port}`], {
      stdio: 'inherit',
    })
    if (ts.error || ts.status !== 0) {
      process.stderr.write("Could not run 'tailscale serve' — is Tailscale installed and up? Serving locally only.\n")
    }
  }

  process.stdout.write(`Serving vault ${vault} on http://localhost:${args.port}\n`)
  // Invoke the next bin directly (not via `pnpm start --`) so the port flag
  // always reaches `next start` regardless of pnpm's arg forwarding.
  const child = spawn(join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(args.port)], {
    cwd: webDir,
    env: { ...process.env, AGENTKEEP_VAULT: vault },
    stdio: 'inherit',
  })
  child.on('error', (err) => {
    process.stderr.write(
      `Could not start the web app (is the repo built? try 'pnpm install && pnpm --filter @agentkeep/web build'): ${err.message}\n`,
    )
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 0
  })
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n')
  process.exitCode = 1
})
