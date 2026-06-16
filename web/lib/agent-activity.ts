/**
 * Human label for a recent agent commit on the Memory page.
 *
 * A commit subject is git plumbing ("write memory/foo.md"), but the Memory page
 * ("What your agent believes") promises human titles, never raw paths. This maps
 * (commit verb, path, already-resolved note title) to a line like "Remembered
 * Payee rules". Pure and free of `server-only`/core imports so it is unit-
 * testable on its own; `vault.ts` resolves the title and calls this.
 */
export function agentActionLabel(input: { message: string; path?: string; title: string }): string {
  const msg = input.message.replace(/^agent:\s*/, '').trim()
  const verb = msg.split(/\s+/)[0]?.toLowerCase() ?? ''
  const title = input.title.trim()
  const inMemory = (input.path ?? '').startsWith('memory/')

  if (verb === 'delete' || verb === 'remove') {
    return title ? `Cleared ${title}` : 'Cleared a note'
  }
  if (inMemory) {
    return title ? `Remembered ${title}` : 'Updated a memory'
  }
  return title ? `Updated ${title}` : 'Updated a note'
}
