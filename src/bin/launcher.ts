import { mkdir, readdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pure, testable half of the `agentkeep` launcher: argument parsing + vault
 * skeleton init. No spawning here, the shell lives in `agentkeep.ts`.
 */
export interface LauncherArgs {
  cmd: 'init' | 'demo' | 'open' | 'serve' | 'help'
  path?: string
  port: number
  tailscale: boolean
  force: boolean
}

const COMMANDS = new Set(['init', 'demo', 'open', 'serve'])

export function parseLauncherArgs(argv: string[]): LauncherArgs {
  const args: LauncherArgs = { cmd: 'help', port: 3000, tailscale: false, force: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--port') {
      const raw = argv[++i]
      const n = Number(raw)
      if (Number.isInteger(n) && n > 0 && n <= 65535) {
        args.port = n
      } else {
        process.stderr.write(`Invalid --port ${raw ?? '(missing)'}, using ${args.port}.\n`)
      }
    } else if (a === '--tailscale') {
      args.tailscale = true
    } else if (a === '--force') {
      args.force = true
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
 * `memory/` (what `remember` writes, the headline). Each gets a `.gitkeep` so
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

const DEMO_UPDATED = '2026-01-15'
const DEMO_SOURCE = 'Agentkeep fictional demo data'

interface DemoMemoryNote {
  path: string
  title: string
  type: 'fact' | 'preference' | 'person' | 'project'
  body: string
}

const DEMO_MEMORY_NOTES: DemoMemoryNote[] = [
  {
    path: 'memory/acme-widgets-project.md',
    title: 'Acme Widgets Project',
    type: 'project',
    body:
      'Acme Widgets is a fictional demo project for an inspectable memory vault.\n\n' +
      'The current goal is a clickable prototype for inventory handoffs. Jordan Lee is the sample product contact. See [[memory/jordan-lee]].\n',
  },
  {
    path: 'memory/jordan-lee.md',
    title: 'Jordan Lee',
    type: 'person',
    body:
      'Jordan Lee is a fictional product lead for [[memory/acme-widgets-project]].\n\n' +
      'They prefer short status notes with decisions, blockers, and the next owner.\n',
  },
  {
    path: 'memory/demo-writing-preference.md',
    title: 'Demo Writing Preference',
    type: 'preference',
    body:
      'For this demo vault, keep memory notes brief, sourced, and linked to related notes.\n\n' +
      'Use [[memory/acme-widgets-project]] when discussing the sample project.\n',
  },
]

function renderDemoMemoryNote(note: DemoMemoryNote): string {
  return (
    '---\n' +
    `source: ${DEMO_SOURCE}\n` +
    `title: ${note.title}\n` +
    `type: ${note.type}\n` +
    `updated: "${DEMO_UPDATED}"\n` +
    '---\n\n' +
    note.body
  )
}

export interface SeedDemoMemoryOpts {
  force?: boolean
}

/**
 * Add three obviously fake memory notes to a new or empty vault.
 * Existing `memory/` content is treated as real user data unless --force is set.
 */
export async function seedDemoMemory(absPath: string, opts: SeedDemoMemoryOpts = {}): Promise<string[]> {
  await initVault(absPath)
  const memoryDir = join(absPath, 'memory')
  const entries = await readdir(memoryDir, { withFileTypes: true })
  const populated = entries.some((entry) => entry.name !== '.gitkeep')
  if (populated && !opts.force) {
    throw new Error(
      'Refusing to write demo memory: memory/ already contains notes or other files. Re-run with --force to add the fictional demo notes anyway.',
    )
  }

  for (const note of DEMO_MEMORY_NOTES) {
    await writeFile(join(absPath, note.path), renderDemoMemoryNote(note), 'utf8')
  }
  return DEMO_MEMORY_NOTES.map((note) => note.path)
}

export function tailscaleServeArgs(port: number): string[] {
  return ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]
}

export function tailscaleServeOffArgs(): string[] {
  return ['serve', '--https=443', 'off']
}

export interface WaitForHttpReadyOpts {
  timeoutMs?: number
  intervalMs?: number
  shouldStop?: () => boolean
}

export async function waitForHttpReady(url: string, opts: WaitForHttpReadyOpts = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (opts.shouldStop?.()) return false
    const remaining = deadline - Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, remaining))) })
      if (res.status < 500) return true
    } catch {
      // Not listening yet, keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))))
  }
  return false
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
