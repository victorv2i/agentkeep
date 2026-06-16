import { WriteCore } from './write-core.js'
import { readNote } from './frontmatter.js'
import { newId } from './ids.js'

export interface Goal {
  id: string
  text: string
}

const BULLET_RE = /^[-*]\s+(.+?)\s*$/
const H2_RE = /^##\s+(.+?)\s*$/

/**
 * Read the one pinned `north-star.md` (DESIGN §5: projects/goals collapse to a
 * single pinned file weighting "what matters") and extract its goals. Goals are
 * the body's TOP-LEVEL markdown list items (`- ` / `* `) and `## ` headings —
 * the two ways a human naturally writes a short goals file. Frontmatter is
 * ignored (split off with `readNote`); a plain prose paragraph is not a goal.
 *
 * `id = newId('goal', text)` — content-derived and stable, so the brief's
 * "what matters" mapping is deterministic across runs. Goals are deduped by text
 * (the same goal written twice is one goal), order preserved. A missing file
 * yields `{ goals: [] }` (no north-star yet is normal, not an error).
 */
export async function readNorthStar(core: WriteCore): Promise<{ goals: Goal[] }> {
  const r = await core.read('north-star.md')
  if (r === null) return { goals: [] }
  const { body } = readNote(r.content)

  const goals: Goal[] = []
  const seen = new Set<string>()
  for (const line of body.split('\n')) {
    const text = (line.match(BULLET_RE)?.[1] ?? line.match(H2_RE)?.[1])?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    goals.push({ id: newId('goal', text), text })
  }
  return { goals }
}
