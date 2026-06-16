import type { Proposal } from './proposal.js'
import type { Task } from './task.js'
import { newId } from './ids.js'

/** What the maker sees: the current inbox + existing tasks. */
export interface MakerInput {
  inbox: { path: string; text: string }[]
  tasks: Task[]
}

/**
 * The maker turns the inbox + tasks into PROPOSALS (never applies them). It is a
 * deterministic in-app baseline (no LLM, what every test uses), not the moat:
 * the real intelligence is the user's CONNECTED agent driving the vault over MCP
 * with AGENT-ROUTINE.md, which needs no key of Agentkeep's own.
 */
export interface Maker {
  propose(input: MakerInput): Promise<Proposal[]>
}

/**
 * Fixed placeholder timestamp for mock-created tasks. Deterministic (NOT
 * `new Date()`) so proposals are stable for tests. The real maker / loop can
 * carry the capture's own `created` later.
 */
const MOCK_CREATED = '1970-01-01T00:00:00.000Z'

// "Already closed a loop" heuristics (tiny + documented): a capture whose first
// line starts with a checkmark glyph, or with the word done/replied/sent/closed.
// Such captures get filed as `status:'done'` — the brief's "loops closed" count.
const CHECKMARK_RE = /^\s*[✓✔☑]\s*/
const ALREADY_DONE_RE = /^(done|replied|sent|closed)\b/i

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim()
}

/**
 * Deterministic, NO-LLM maker. For each inbox item it emits ONE proposal that
 * "files the capture": a `writeTask` op (title = first line, source = inbox
 * path, deterministic id) plus a `deleteNote` op removing the inbox file. If the
 * capture looks already-done, the task is filed `status:'done'` (loop closed).
 * This is what the whole test suite uses — no network, fully reproducible.
 */
export class MockMaker implements Maker {
  async propose(input: MakerInput): Promise<Proposal[]> {
    return input.inbox.map((item) => {
      const raw = firstLine(item.text)
      const done = CHECKMARK_RE.test(raw) || ALREADY_DONE_RE.test(raw)
      const title = raw.replace(CHECKMARK_RE, '').trim()
      const task: Task = {
        id: newId('t', item.path),
        title,
        status: done ? 'done' : 'inbox',
        // The agent IS the one closing this loop, so record it — that's what
        // lets the brief honestly say "closed by your agent" for this task.
        ...(done ? { closedBy: 'agent' as const } : {}),
        created: MOCK_CREATED,
        source: item.path,
      }
      return {
        id: newId('p', item.path),
        summary: done ? `Close: ${title}` : `File: ${title}`,
        rationale: done
          ? 'This capture reads as an already-closed loop, so I filed it as done.'
          : 'Filed this capture as a task in the inbox column.',
        source: item.path,
        ops: [
          { kind: 'writeTask', task },
          { kind: 'deleteNote', path: item.path },
        ],
      }
    })
  }
}

/**
 * The in-app maker — always the deterministic MockMaker. Agentkeep is BYO-agent:
 * the real reasoning is the user's connected agent driving the vault over MCP +
 * AGENT-ROUTINE.md, never anything Agentkeep runs itself.
 */
export function getMaker(): Maker {
  return new MockMaker()
}
