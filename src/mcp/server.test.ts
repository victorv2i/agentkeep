import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openVault, type Agentkeep } from '../core/index.js'
import { Indexer } from '../core/indexer.js'
import { startMcpServer } from './server.js'

const EXPECTED = ['capture', 'delete_note', 'get_backlinks', 'list_notes', 'list_tasks', 'read_note', 'remember', 'search', 'write_note']

let dir: string
let ak: Agentkeep
let indexer: Indexer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-mcp-'))
  ak = await openVault(dir)
  await ak.core.write('notes/beta.md', '# Beta\n\nThe widgets note.\n', { author: 'human', baseHash: null })
  indexer = new Indexer(ak.vault)
  await indexer.reindexAll()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('startMcpServer', () => {
  it('registers all nine seam tools (no transport)', async () => {
    const { server, close } = await startMcpServer({ vault: ak.vault, git: ak.git, core: ak.core, indexer }, { connectStdio: false })
    try {
      // McpServer keeps registered tools in a private map; assert via the SDK
      // listTools over an in-memory transport rather than reaching into internals.
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      await server.connect(serverT)
      const client = new Client({ name: 'test', version: '0.0.0' })
      await client.connect(clientT)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED.slice().sort())
      // metadata carried through
      for (const t of tools) expect(typeof t.description).toBe('string')
      await client.close()
    } finally {
      await close()
    }
  })

  it('round-trips a tool call over an in-memory transport (offline): read_note', async () => {
    const { server, close } = await startMcpServer({ vault: ak.vault, git: ak.git, core: ak.core, indexer }, { connectStdio: false })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientT)
    try {
      const res = await client.callTool({ name: 'read_note', arguments: { path: 'notes/beta.md' } })
      expect(res.isError).toBeFalsy()
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text
      const payload = JSON.parse(text) as { content: string; hash: string }
      expect(payload.content).toContain('The widgets note.')
      expect(payload.hash).toBeTruthy()
    } finally {
      await client.close()
      await close()
    }
  })

  it('maps a handler conflict to an MCP tool error (isError) over the transport', async () => {
    const { server, close } = await startMcpServer({ vault: ak.vault, git: ak.git, core: ak.core, indexer }, { connectStdio: false })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientT)
    try {
      // stale baseHash → handler returns {ok:false,409} → server marks isError
      const res = await client.callTool({
        name: 'write_note',
        arguments: { path: 'notes/beta.md', content: 'clobber\n', baseHash: 'not-the-hash' },
      })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text
      expect(text).toMatch(/conflict|409/i)
      // file untouched
      const onDisk = await ak.core.read('notes/beta.md')
      expect(onDisk!.content).toContain('The widgets note.')
    } finally {
      await client.close()
      await close()
    }
  })

  it('maps an UNEXPECTED thrown error (not a handled {ok:false}) to isError, not a rejected call', async () => {
    const { server, close } = await startMcpServer({ vault: ak.vault, git: ak.git, core: ak.core, indexer }, { connectStdio: false })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientT)
    try {
      // Simulate a repo mid-merge (git.ts's mutation-time preflight throws
      // GitStateError, a raw throw the vault-tools handler does NOT catch) so
      // the SDK wiring — not the handler — is what must turn this into a
      // structured isError result instead of a JSON-RPC failure/rejection.
      await mkdir(join(dir, '.git'), { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, '.git', 'MERGE_HEAD'), 'deadbeef\n')

      const res = await client.callTool({
        name: 'write_note',
        arguments: { path: 'notes/new-during-merge.md', content: 'during a merge\n' },
      })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text
      const payload = JSON.parse(text) as { error: string; code?: number }
      expect(payload.error).toMatch(/merge/i)
    } finally {
      await client.close()
      await close()
    }
  })

  it('write_note over the transport commits as agentkeep-agent', async () => {
    const { server, close } = await startMcpServer({ vault: ak.vault, git: ak.git, core: ak.core, indexer }, { connectStdio: false })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientT)
    try {
      const res = await client.callTool({
        name: 'write_note',
        arguments: { path: 'notes/agent-made.md', content: '# Made by the agent\n' },
      })
      expect(res.isError).toBeFalsy()
      const last = await ak.git.lastCommit('notes/agent-made.md')
      expect(last?.authorName).toBe('agentkeep-agent')
    } finally {
      await client.close()
      await close()
    }
  })
})
