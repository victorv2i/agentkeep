import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pure, testable half of the `agentkeep` launcher: argument parsing + vault
 * skeleton init. No spawning here — the shell lives in `agentkeep.ts`.
 */
export interface LauncherArgs {
  cmd: 'init' | 'open' | 'serve' | 'help'
  path?: string
  port: number
  tailscale: boolean
}

const COMMANDS = new Set(['init', 'open', 'serve'])

export function parseLauncherArgs(argv: string[]): LauncherArgs {
  const args: LauncherArgs = { cmd: 'help', port: 3000, tailscale: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--port') {
      const raw = argv[++i]
      const n = Number(raw)
      if (Number.isInteger(n) && n > 0 && n <= 65535) {
        args.port = n
      } else {
        process.stderr.write(`Invalid --port ${raw ?? '(missing)'} — using ${args.port}.\n`)
      }
    } else if (a === '--tailscale') {
      args.tailscale = true
    } else {
      rest.push(a)
    }
  }
  const [cmd, path] = rest
  if (cmd !== undefined && COMMANDS.has(cmd) && path !== undefined) {
    args.cmd = cmd as LauncherArgs['cmd']
    args.path = path
  }
  return args
}

/**
 * Create the vault skeleton; never overwrite. Returns what was created.
 *
 * Just the two folders the keep loop uses: `inbox/` (captures land here) and
 * `memory/` (what `remember` writes — the headline). Each gets a `.gitkeep` so
 * the empty folder persists in the baseline snapshot. No north-star / tasks
 * scaffolding: those pages were removed in the memory-vault pivot, and the
 * tools create any folder they need on demand anyway.
 */
export async function initVault(absPath: string): Promise<string[]> {
  const created: string[] = []
  await mkdir(absPath, { recursive: true })
  for (const dir of ['inbox', 'memory']) {
    const p = join(absPath, dir)
    if (!(await exists(p))) {
      await mkdir(p)
      await writeFile(join(p, '.gitkeep'), '')
      created.push(dir + '/')
    }
  }
  return created
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
