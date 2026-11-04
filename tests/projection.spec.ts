import { tmpdir } from 'node:os'
/** The client roster projection: a fold over the same records the host writes. */
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, user, until } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema, type Roster } from '../src/projection.js'

afterEach(teardown)

const rosterOf = (lead: Parameters<typeof until>[0]): Roster =>
  lead.session.snapshotEvents().reduce(applyRoster, EMPTY_ROSTER)

describe('roster projection', () => {
  it('shows forks, requests, workers and the role the sidebar draws', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    const scheduler = install(ctx)
    scheduler.setRole(lead, 'LEAD ROLE: map every requirement')
    lead.followup(user('why is billing slow'))
    await until(lead, 'Its conclusion')
    const view = rosterOf(lead)
    expect(view.role).toBe('LEAD ROLE: map every requirement')
    expect(view.members).toEqual([expect.objectContaining({ name: 'fork-1', kind: 'fork', state: 'done', text: 'why is billing slow' })])

    await scheduler.createWorker(lead, { name: 'billing', role: 'owns billing', cwd: tmpdir() })
    const after = rosterOf(lead)
    expect(after.members).toContainEqual(expect.objectContaining({ name: 'billing', kind: 'worker', state: 'started', role: 'owns billing', cwd: tmpdir() }))
    // The host's ledger and the client's projection are one fold.
    expect(scheduler.ledgerOf(lead).state).toEqual(after)
    // Persisted state and the wire copy both pass their real validation; garbage does not.
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(after)))).toEqual(after)
    const wire = rosterView(after)
    expect(rosterViewSchema.parse(wire)).toBe(wire)
    expect(rosterView(after)).toBe(wire)
    expect(wire.members.every(m => !('settledThrough' in m))).toBe(true)
    expect(() => rosterSchema.parse({ role: null, members: [{ id: 1 }], requests: [] })).toThrow(/invalid member/)
  })
})
