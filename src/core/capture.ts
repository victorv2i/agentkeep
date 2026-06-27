import { WriteCore } from './write-core.js'
import { setFrontmatterKey } from './frontmatter.js'
import { newId } from './ids.js'
import { ConflictError } from './errors.js'

/**
 * Fixed placeholder timestamp for a capture with no caller-supplied `createdISO`.
 * Kept deterministic (NOT `new Date()`) so the written bytes are stable for
 * tests; real callers (web/CLI) always pass `opts.createdISO`.
 */
const DEFAULT_CREATED = '1970-01-01T00:00:00.000Z'

export interface CaptureOpts {
  /** ISO timestamp for the `created` frontmatter key. Caller-provided. */
  createdISO?: string
}

export interface CaptureResult {
  path: string
  id: string
}

/**
 * Capture raw text into the inbox as one markdown file (`inbox/<id>.md`). The id
 * is content-derived (`newId('cap', text)`) so the same text maps to the same
 * inbox file. Written through the WriteCore as `author:'human'` with
 * `baseHash:null` (expect-create) — capture is always a human action, never the
 * agent. Frontmatter (`id`, `created`, `type: capture`) is built with the
 * format-preserving `setFrontmatterKey` (the only sanctioned frontmatter writer).
 * If the content-derived file already exists, capture is idempotent: return the
 * same `{path,id}` without changing the existing capture's timestamp/body.
 */
export async function captureToInbox(
  core: WriteCore,
  text: string,
  opts?: CaptureOpts,
): Promise<CaptureResult> {
  const id = newId('cap', text)
  const path = `inbox/${id}.md`
  const created = opts?.createdISO ?? DEFAULT_CREATED

  let content = text.endsWith('\n') ? text : text + '\n'
  content = setFrontmatterKey(content, 'id', id)
  content = setFrontmatterKey(content, 'created', created)
  content = setFrontmatterKey(content, 'type', 'capture')

  if ((await core.read(path)) !== null) return { path, id }
  try {
    await core.write(path, content, { author: 'human', baseHash: null })
  } catch (err) {
    if (err instanceof ConflictError && (await core.read(path)) !== null) return { path, id }
    throw err
  }
  return { path, id }
}
