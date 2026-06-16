import { createHash } from 'node:crypto'

/**
 * Deterministic id helper: `<prefix>_<8 hex>` where the hex is the first 8 chars
 * of `sha256(seed)`. Derived from content/seed — NEVER `Date.now()` /
 * `Math.random()` — so ids are stable across runs and tests can assert on them.
 * Collisions are content-based (same seed → same id is intentional: capturing
 * the identical text twice maps to the same inbox file, not a duplicate).
 */
export function newId(prefix: string, seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8)
  return `${prefix}_${hex}`
}
