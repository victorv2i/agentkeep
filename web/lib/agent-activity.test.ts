import { describe, it, expect } from 'vitest'
import { agentActionLabel } from './agent-activity'

// The Memory page ("What your agent believes") must show human action lines,
// never raw git subjects like "write memory/foo.md" or a duplicated path.

describe('agentActionLabel', () => {
  it('labels a memory write as "Remembered <title>"', () => {
    expect(
      agentActionLabel({ message: 'write memory/payee-rules.md', path: 'memory/payee-rules.md', title: 'Payee rules' }),
    ).toBe('Remembered Payee rules')
  })

  it('strips an "agent:" prefix from the commit subject', () => {
    expect(agentActionLabel({ message: 'agent: write memory/x.md', path: 'memory/x.md', title: 'X' })).toBe(
      'Remembered X',
    )
  })

  it('labels a delete as "Cleared <title>"', () => {
    expect(agentActionLabel({ message: 'delete inbox/cap_1.md', path: 'inbox/cap_1.md', title: 'Capture' })).toBe(
      'Cleared Capture',
    )
  })

  it('labels a non-memory write as "Updated <title>"', () => {
    expect(agentActionLabel({ message: 'write notes/foo.md', path: 'notes/foo.md', title: 'Foo' })).toBe('Updated Foo')
  })

  it('never emits a raw path: uses a generic line when the title is empty', () => {
    const a = agentActionLabel({ message: 'write memory/foo.md', path: 'memory/foo.md', title: '' })
    const b = agentActionLabel({ message: 'delete x.md', path: 'x.md', title: '' })
    expect(a).toBe('Updated a memory')
    expect(b).toBe('Cleared a note')
    expect(a).not.toContain('/')
    expect(b).not.toContain('/')
  })
})
