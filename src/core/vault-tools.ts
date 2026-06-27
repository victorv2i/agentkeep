import { z, type ZodRawShape } from 'zod'
import { type Vault, assertVaultContentPath } from './vault.js'
import type { VaultGit } from './git.js'
import type { WriteCore } from './write-core.js'
import type { Indexer } from './indexer.js'
import { ConflictError, VaultPathError } from './errors.js'
import { captureToInbox } from './capture.js'
import { deleteNote } from './delete.js'
import { listTasks } from './task.js'
import { setFrontmatterKey } from './frontmatter.js'

/**
 * Pure, SDK-free tool layer for the BYO-agent MCP seam (DESIGN §7.5). Each tool
 * is a self-contained handler over the Phase 1–3 core. This is the LOGIC; the
 * MCP/stdio wiring lives in `src/mcp/server.ts`, so these handlers are unit-
 * testable against a real temp vault without touching the SDK or stdio.
 *
 * The point of the seam: `write_note` writes go through `WriteCore` as
 * `author:'agent'` (hash-guarded compare-and-swap, atomic, git-committed,
 * attributed `agentkeep-agent`); `capture` is a human-attributed inbox drop
 * (`author:'human'`) the agent files later — also CAS + git. That governance —
 * undo, attribution, no clobber — is exactly what a raw "agent → files" setup
 * lacks. After each mutation the handler reindexes the written file so this
 * server's own `search`/`get_backlinks` stay fresh.
 */

/** A handler result. `ok:false` never escapes a handler as a throw — it is a value. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: number }

export interface VaultTool {
  name: string
  description: string
  /** A Zod raw shape (the SDK's `registerTool` input-schema form), not `z.object`. */
  inputSchema: ZodRawShape
  handler(args: Record<string, unknown>): Promise<ToolResult>
}

export interface VaultToolsDeps {
  vault: Vault
  git: VaultGit
  core: WriteCore
  indexer: Indexer
  /**
   * Injectable clock for `remember`'s `updated` stamp (defaults to real time).
   * Tests pass a fixed Date so the suite stays deterministic.
   */
  now?: Date
}

const ok = (data: unknown): ToolResult => ({ ok: true, data })
const err = (error: string, code?: number): ToolResult => ({ ok: false, error, code })

/** Lowercase, non-alphanumerics → '-', collapsed and trimmed: 'My  Topic!!' → 'my-topic'. */
function slugifyTopic(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const MEMORY_TYPES = ['fact', 'preference', 'person', 'project'] as const

/**
 * Near-duplicate guard for `remember`. Topics get slugged into a filename, so a
 * reworded topic ("LDI team meeting summary" vs "...ultimate summary") slugs
 * differently and forks a second file — the recurring source of memory/ dupes.
 * When a topic has no exact slug match, we compare its title tokens against the
 * existing memory notes and, only on a HIGH overlap, update that note instead of
 * forking. Conservative on purpose: under-merging (two near-twins kept) is a
 * cosmetic miss; over-merging would silently overwrite a distinct memory.
 */
const DUP_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'in', 'on', 'my', 'your', 'with'])
function topicTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0 && !DUP_STOPWORDS.has(t)))
}
function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
/** At/above this title-token overlap a reworded topic updates the existing note. */
const DUP_MERGE_THRESHOLD = 0.8

export function createVaultTools(deps: VaultToolsDeps): VaultTool[] {
  const { vault, git, core, indexer } = deps

  return [
    {
      name: 'search',
      description: 'Full-text search the vault. Returns ranked notes (path, title, score), best first.',
      inputSchema: { query: z.string().describe('Search terms.') },
      async handler(args) {
        return ok(indexer.search(String(args.query ?? '')))
      },
    },

    {
      name: 'read_note',
      description: 'Read one note by vault-relative path. Returns its raw markdown and content hash (use the hash as baseHash to write_note safely). Not-found is a value, not an error.',
      inputSchema: { path: z.string().describe('Vault-relative path, e.g. notes/foo.md.') },
      async handler(args) {
        const path = String(args.path ?? '')
        try {
          assertVaultContentPath(path) // don't let the agent read .git/config etc.
          const r = await core.read(path)
          if (r === null) return err(`Note not found: ${path}`, 404)
          return ok({ content: r.content, hash: r.hash })
        } catch (e) {
          if (e instanceof VaultPathError) return err(e.message, 400)
          throw e
        }
      },
    },

    {
      name: 'write_note',
      description: 'Create or update a note as the agent (hash-guarded, atomic, git-committed, attributed agentkeep-agent). Pass baseHash from a prior read_note to update; omit it to create. A stale baseHash returns a 409 conflict (your write is rejected, never clobbers).',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. notes/foo.md.'),
        content: z.string().describe('Full raw markdown to write.'),
        baseHash: z
          .string()
          .optional()
          .describe('The hash from a prior read_note. Omit to create a new note (expect-create).'),
      },
      async handler(args) {
        const path = String(args.path ?? '')
        const content = String(args.content ?? '')
        const baseHash = typeof args.baseHash === 'string' ? args.baseHash : null
        try {
          const r = await core.write(path, content, { author: 'agent', baseHash })
          // keep the live index current so a follow-up search/get_backlinks sees it
          await indexer.reindexFile(path)
          return ok({ hash: r.hash, commit: r.commit })
        } catch (e) {
          if (e instanceof ConflictError) return err(e.message, e.httpStatus) // 409, no throw
          if (e instanceof VaultPathError) return err(e.message, 400)
          throw e
        }
      },
    },

    {
      name: 'list_notes',
      description: 'List every markdown note in the vault (vault-relative paths, sorted).',
      inputSchema: {},
      async handler() {
        return ok(await vault.listMarkdown())
      },
    },

    {
      name: 'list_tasks',
      description: 'List every task (sharded JSON from tasks/). Returns the task objects.',
      inputSchema: {},
      async handler() {
        return ok(await listTasks(vault))
      },
    },

    {
      name: 'get_backlinks',
      description: 'List notes that link to the given note (incoming [[wikilinks]]).',
      inputSchema: { path: z.string().describe('Vault-relative path of the target note.') },
      async handler(args) {
        return ok(indexer.getBacklinks(String(args.path ?? '')))
      },
    },

    {
      name: 'capture',
      description: 'Capture raw text into the inbox as a new note. The quickest way to hand the vault a thought; the agent files it later. Returns the new path and id. Committed as a human-attributed inbox drop; you file it later as the agent.',
      inputSchema: { text: z.string().describe('The raw text to capture.') },
      async handler(args) {
        const res = await captureToInbox(core, String(args.text ?? ''), { createdISO: new Date().toISOString() })
        // keep the live index current so a follow-up search finds it
        await indexer.reindexFile(res.path)
        return ok({ path: res.path, id: res.id })
      },
    },

    {
      name: 'remember',
      description:
        'Store one durable memory as the agent: upserts memory/<slugified-topic>.md (CAS-guarded, atomic, git-committed, attributed agentkeep-agent). The tool OWNS the whole file — frontmatter (title, type, source, updated) and body are fully replaced on every call, so re-remembering a topic supersedes the old memory cleanly. Frontmatter: title keeps the human topic; type defaults to "fact"; source records where you learned it; updated is stamped today. Wikilink related notes in the content so the memory joins the graph.',
      inputSchema: {
        topic: z.string().describe('The memory topic — slugified into memory/<slug>.md.'),
        content: z.string().describe('The memory body, plain markdown. [[Wikilink]] related notes.'),
        type: z.enum(MEMORY_TYPES).optional().describe('Kind of memory (default "fact").'),
        source: z.string().optional().describe('Where this was learned (free text).'),
      },
      async handler(args) {
        const topic = String(args.topic ?? '').trim()
        const content = String(args.content ?? '').trim()
        const slug = slugifyTopic(topic)
        if (slug === '') return err('remember needs a non-empty topic.', 400)
        if (content === '') return err('remember needs non-empty content.', 400)
        const type = MEMORY_TYPES.includes(args.type as never) ? String(args.type) : 'fact'
        const source = typeof args.source === 'string' && args.source.trim() !== '' ? args.source.trim() : null
        const updated = (deps.now ?? new Date()).toISOString().slice(0, 10)

        // Compose the whole document via the format-preserving frontmatter
        // writer (it force-quotes the date so the YAML-1.1 read side keeps it a
        // string). The leading newline leaves a blank line between the closing
        // fence and the body. `title` keeps the human topic — the UI shows
        // titles, never the slug.
        let doc = `\n${content}\n`
        doc = setFrontmatterKey(doc, 'title', topic)
        doc = setFrontmatterKey(doc, 'type', type)
        if (source !== null) doc = setFrontmatterKey(doc, 'source', source)
        doc = setFrontmatterKey(doc, 'updated', updated)

        const exactPath = `memory/${slug}.md`
        try {
          // Pick the upsert target: the exact slug if it already exists; otherwise,
          // if a reworded topic already has a near-duplicate memory note, update
          // THAT note instead of forking a second file. Only a high title-token
          // overlap redirects (see DUP_MERGE_THRESHOLD), so distinct topics stay
          // separate; replacing the whole file matches remember's own contract.
          let path = exactPath
          let merged = false
          if ((await core.read(exactPath)) === null) {
            const want = topicTokens(topic)
            let best: { path: string; sim: number } | null = null
            for (const hit of indexer.search(topic)) {
              if (!hit.path.startsWith('memory/') || hit.path === exactPath) continue
              const sim = tokenJaccard(want, topicTokens(hit.title))
              if (sim >= DUP_MERGE_THRESHOLD && (best === null || sim > best.sim)) best = { path: hit.path, sim }
            }
            if (best) { path = best.path; merged = true }
          }
          // Upsert: the current hash (or expect-create) is the CAS base. A write
          // that races a concurrent edit surfaces as an honest 409, never a clobber.
          const current = await core.read(path)
          const r = await core.write(path, doc, { author: 'agent', baseHash: current?.hash ?? null })
          await indexer.reindexFile(path)
          return ok(merged ? { path, hash: r.hash, commit: r.commit, merged } : { path, hash: r.hash, commit: r.commit })
        } catch (e) {
          if (e instanceof ConflictError) return err(e.message, e.httpStatus)
          if (e instanceof VaultPathError) return err(e.message, 400)
          throw e
        }
      },
    },

    {
      name: 'delete_note',
      description: 'Delete one note by vault-relative path as the agent (git rm + commit attributed agentkeep-agent). Use it to clear an inbox/ capture once you have filed it into a task or note, so the inbox empties. The removal is one commit, so it is git-reversible (git revert, or the web Undo) — it is not a destructive erase. A missing path returns a 404 result (a value, not an error); a path that escapes the vault returns 400.',
      inputSchema: { path: z.string().describe('Vault-relative path to delete, e.g. inbox/cap_x.md.') },
      async handler(args) {
        const path = String(args.path ?? '')
        try {
          const r = await deleteNote(core, path)
          if (!r.ok) return err(`Note not found: ${path}`, 404) // nothing to delete, no throw
          // drop it from the live index so search/backlinks/brief stop surfacing it
          indexer.removeFile(path)
          return ok({ ok: true, commit: r.commit })
        } catch (e) {
          if (e instanceof VaultPathError) return err(e.message, 400) // traversal/escape, no throw
          throw e
        }
      },
    },
  ]
}
