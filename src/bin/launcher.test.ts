import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinkGraph, parseNote, readNote } from '../core/index.js'
import { parseLauncherArgs, initVault, seedDemoMemory, tailscaleServeArgs, tailscaleServeOffArgs } from './launcher.js'

describe('parseLauncherArgs', () => {
  it('parses init/open/serve with path and options', () => {
    expect(parseLauncherArgs(['init', '/v'])).toEqual({ cmd: 'init', path: '/v', port: 3000, tailscale: false, force: false })
    expect(parseLauncherArgs(['demo', '/v', '--force'])).toEqual({ cmd: 'demo', path: '/v', port: 3000, tailscale: false, force: true })
    expect(parseLauncherArgs(['open', '/v', '--port', '4000'])).toEqual({ cmd: 'open', path: '/v', port: 4000, tailscale: false, force: false })
    expect(parseLauncherArgs(['serve', '/v', '--tailscale'])).toEqual({ cmd: 'serve', path: '/v', port: 3000, tailscale: true, force: false })
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

describe('tailscale serve args', () => {
  it('uses localhost-only proxy targets and the matching off command', () => {
    expect(tailscaleServeArgs(4123)).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:4123'])
    expect(tailscaleServeOffArgs()).toEqual(['serve', '--https=443', 'off'])
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

describe('seedDemoMemory', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-demo-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writes three demo memory notes with valid frontmatter and a resolved wikilink', async () => {
    const paths = await seedDemoMemory(dir)

    expect(paths.sort()).toEqual([
      'memory/acme-widgets-project.md',
      'memory/demo-writing-preference.md',
      'memory/jordan-lee.md',
    ])
    await expect(stat(join(dir, 'inbox'))).resolves.toBeTruthy()

    const graph = new LinkGraph()
    for (const path of paths) {
      const raw = await readFile(join(dir, path), 'utf8')
      const parsed = readNote(raw)
      expect(parsed.data.source).toBe('Agentkeep fictional demo data')
      expect(parsed.data.title).toBeTypeOf('string')
      expect(['fact', 'preference', 'person', 'project']).toContain(parsed.data.type)
      expect(parsed.data.updated).toBe('2026-01-15')
      expect(parsed.body).toMatch(/fictional|demo|sample/i)

      const meta = parseNote(path, raw)
      graph.setNote(meta.path, meta.links)
    }

    expect(graph.getLinks('memory/jordan-lee.md')).toEqual(['memory/acme-widgets-project.md'])
    expect(graph.getBacklinks('memory/acme-widgets-project.md')).toContain('memory/jordan-lee.md')
  })

  it('refuses when memory is already populated unless forced', async () => {
    await initVault(dir)
    await writeFile(join(dir, 'memory', 'real-memory.md'), 'real memory\n', 'utf8')

    await expect(seedDemoMemory(dir)).rejects.toThrow(/--force/)
    await expect(stat(join(dir, 'memory', 'acme-widgets-project.md'))).rejects.toThrow()

    await expect(seedDemoMemory(dir, { force: true })).resolves.toHaveLength(3)
  })
})
