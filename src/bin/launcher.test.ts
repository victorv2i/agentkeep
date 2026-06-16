import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLauncherArgs, initVault } from './launcher.js'

describe('parseLauncherArgs', () => {
  it('parses init/open/serve with path and options', () => {
    expect(parseLauncherArgs(['init', '/v'])).toEqual({ cmd: 'init', path: '/v', port: 3000, tailscale: false })
    expect(parseLauncherArgs(['open', '/v', '--port', '4000'])).toEqual({ cmd: 'open', path: '/v', port: 4000, tailscale: false })
    expect(parseLauncherArgs(['serve', '/v', '--tailscale'])).toEqual({ cmd: 'serve', path: '/v', port: 3000, tailscale: true })
  })
  it('falls back to 3000 on invalid or out-of-range --port', () => {
    expect(parseLauncherArgs(['open', '/v', '--port', 'abc']).port).toBe(3000)
    expect(parseLauncherArgs(['open', '/v', '--port', '70000']).port).toBe(3000)
    expect(parseLauncherArgs(['open', '/v', '--port']).port).toBe(3000)
  })
  it('returns help for no/unknown command or missing path', () => {
    expect(parseLauncherArgs([]).cmd).toBe('help')
    expect(parseLauncherArgs(['bogus']).cmd).toBe('help')
    expect(parseLauncherArgs(['open']).cmd).toBe('help')
  })
})

describe('initVault', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-launch-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('creates the inbox + memory skeleton without clobbering existing files', async () => {
    const created = await initVault(dir)
    expect(created).toEqual(['inbox/', 'memory/'])
    expect((await stat(join(dir, 'inbox'))).isDirectory()).toBe(true)
    expect((await stat(join(dir, 'memory'))).isDirectory()).toBe(true)
    // .gitkeep persists the otherwise-empty folders in the baseline snapshot
    expect(await readFile(join(dir, 'memory/.gitkeep'), 'utf8')).toBe('')
    // no vestigial pre-pivot scaffolding (the north-star / tasks pages are gone)
    await expect(stat(join(dir, 'north-star.md'))).rejects.toThrow()
    await expect(stat(join(dir, 'tasks'))).rejects.toThrow()
    const again = await initVault(dir)
    expect(again).toEqual([])
  })
})
