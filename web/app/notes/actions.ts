'use server'

// Server actions = the ONLY bridge from the client editor to the vault. The
// core (fs + git) never reaches the browser; every load/save/list/create runs
// here on the server and funnels writes through the single WriteCore CAS.

import { revalidatePath } from 'next/cache'
import {
  listNotes,
  loadNote,
  saveNote,
  resolveTarget,
  createNoteForTarget,
  noteProvenance,
  undoNoteCommit,
  type NoteListItem,
  type LoadedNote,
  type SaveResult,
  type NoteProvenance,
  type UndoNoteResult,
} from '@/lib/vault'

export async function listNotesAction(): Promise<NoteListItem[]> {
  return listNotes()
}

export async function loadNoteAction(path: string): Promise<LoadedNote | null> {
  return loadNote(path)
}

export async function saveNoteAction(
  path: string,
  content: string,
  baseHash: string | null,
): Promise<SaveResult> {
  return saveNote(path, content, baseHash)
}

export async function resolveTargetAction(target: string): Promise<string | null> {
  return resolveTarget(target)
}

/** Create (or open if it already exists) the note a `[[wikilink]]` points at. */
export async function createNoteAction(target: string): Promise<string> {
  return createNoteForTarget(target)
}

/** Provenance for the open note: who last edited it + its recent history. */
export async function noteProvenanceAction(path: string): Promise<NoteProvenance> {
  return noteProvenance(path)
}

/**
 * Undo one agent-authored commit on a note by SHA (a new human revert commit).
 * Agent-only + re-reads the note on success, so a human's work is never silently
 * reverted and the editor's CAS stays correct. Revalidates the vault home so
 * its surfaces reflect the undo.
 */
export async function undoNoteCommitAction(path: string, sha: string): Promise<UndoNoteResult> {
  const result = await undoNoteCommit(path, sha)
  if (result.ok) {
    revalidatePath('/')
  }
  return result
}
