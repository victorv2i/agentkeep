// `[[` autocomplete: when the user types `[[` (and an optional partial), offer
// the vault's note basenames/titles. Sourced from a synchronous snapshot the
// client keeps fresh (the note list comes from a server action). Inserts the
// basename + closing `]]` (Obsidian basename links).
//
// A CompletionSource triggered on /\[\[[^\]]*$/, built from CodeMirror's public
// autocomplete API.

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export interface CompletionNote {
  basename: string
  title: string
}

/** A CompletionSource over a live getter of the vault's notes. */
export function wikiLinkCompletion(getNotes: () => CompletionNote[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match an open `[[` with whatever's been typed after it on this line.
    const match = context.matchBefore(/\[\[[^\]\n]*/)
    if (!match || match.from === match.to) return null
    const from = match.from + 2 // insert/replace starts right after `[[`
    const options = getNotes().map((n) => ({
      label: n.basename,
      // Show the human title as the detail when it differs from the basename.
      detail: n.title !== n.basename ? n.title : undefined,
      // Insert basename + close the link; cursor lands after `]]`.
      apply: `${n.basename}]]`,
      type: 'class' as const,
    }))
    return { from, options, filter: true, validFor: /^[^\]\n]*$/ }
  }
}
