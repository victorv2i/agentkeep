import { describe, it, expect } from 'vitest'
import { MockMaker, getMaker } from './maker.js'
import { newId } from './ids.js'
import type { Op } from './proposal.js'

function opKinds(ops: Op[]): string[] {
  return ops.map((o) => o.kind)
}

describe('getMaker', () => {
  it('always returns the deterministic MockMaker (BYO-agent — the in-app maker never reasons)', () => {
    expect(getMaker()).toBeInstanceOf(MockMaker)
  })
})

describe('MockMaker.propose (deterministic, no LLM)', () => {
  it('files an open task for a normal capture and a done task for an already-closed one', async () => {
    const inbox = [
      { path: 'inbox/cap_1.md', text: 'email Sam about the invoice' },
      { path: 'inbox/cap_2.md', text: 'replied to Mira' },
    ]
    const proposals = await new MockMaker().propose({ inbox, tasks: [] })
    expect(proposals).toHaveLength(2)

    // proposal 1: open task + delete the capture
    const p1 = proposals[0]!
    expect(opKinds(p1.ops)).toEqual(['writeTask', 'deleteNote'])
    const w1 = p1.ops.find((o) => o.kind === 'writeTask')!
    if (w1.kind !== 'writeTask') throw new Error('unreachable')
    expect(w1.task.status).toBe('inbox')
    // an open task isn't closed, so no closer is recorded
    expect(w1.task.closedBy).toBeUndefined()
    expect(w1.task.title).toBe('email Sam about the invoice')
    expect(w1.task.source).toBe('inbox/cap_1.md')
    expect(w1.task.id).toBe(newId('t', 'inbox/cap_1.md'))
    const d1 = p1.ops.find((o) => o.kind === 'deleteNote')!
    if (d1.kind !== 'deleteNote') throw new Error('unreachable')
    expect(d1.path).toBe('inbox/cap_1.md')
    expect(p1.source).toBe('inbox/cap_1.md')

    // proposal 2: a "replied to ..." capture is already done (loop closed)
    const p2 = proposals[1]!
    expect(opKinds(p2.ops)).toEqual(['writeTask', 'deleteNote'])
    const w2 = p2.ops.find((o) => o.kind === 'writeTask')!
    if (w2.kind !== 'writeTask') throw new Error('unreachable')
    expect(w2.task.status).toBe('done')
    // the agent is the one closing this loop → recorded, so the brief can
    // honestly attribute it ("closed by your agent")
    expect(w2.task.closedBy).toBe('agent')
    expect(w2.task.title).toBe('replied to Mira')
  })

  it('uses the first line as the title and marks a checkmark/"done" capture as done', async () => {
    const inbox = [
      { path: 'inbox/cap_3.md', text: '✓ booked the dentist\nextra detail line' },
      { path: 'inbox/cap_4.md', text: 'done filing taxes' },
      { path: 'inbox/cap_5.md', text: 'buy milk' },
    ]
    const proposals = await new MockMaker().propose({ inbox, tasks: [] })
    const statuses = proposals.map((p) => {
      const w = p.ops.find((o) => o.kind === 'writeTask')
      return w && w.kind === 'writeTask' ? w.task.status : undefined
    })
    expect(statuses).toEqual(['done', 'done', 'inbox'])
    const titles = proposals.map((p) => {
      const w = p.ops.find((o) => o.kind === 'writeTask')
      return w && w.kind === 'writeTask' ? w.task.title : undefined
    })
    // first line only, checkmark stripped
    expect(titles).toEqual(['booked the dentist', 'done filing taxes', 'buy milk'])
  })

  it('is deterministic — same inbox yields identical proposals', async () => {
    const inbox = [{ path: 'inbox/cap_x.md', text: 'a thing' }]
    const a = await new MockMaker().propose({ inbox, tasks: [] })
    const b = await new MockMaker().propose({ inbox, tasks: [] })
    expect(a).toEqual(b)
  })
})
