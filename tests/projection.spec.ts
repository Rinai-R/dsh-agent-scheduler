import { tmpdir } from 'node:os'
/** The client roster projection: a fold over the same records the host writes. */
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, user, until } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema, type Roster } from '../src/projection.js'
import { runWorkerModelCommand } from '../src/rule-plugin.js'
import { appendForkModel } from '../src/records.js'

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
    expect(view.members).toEqual([expect.objectContaining({ name: 'fork-1', kind: 'fork', text: 'why is billing slow' })])
    expect(['done', 'archived']).toContain(view.members[0]!.state)

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
    expect(() => rosterSchema.parse({ enabled: null, role: null, forkModel: null, members: [{ id: 1 }], requests: [] })).toThrow(/invalid member/)
  })

  it('ignores /fork model records: forks have no model of their own', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const before = rosterOf(lead)
    appendForkModel(lead.session, { provider: 'mock-b', model: 'other', reasoningEffort: 'high' })
    expect(applyRoster(before, lead.session.snapshotEvents().at(-1)!)).toBe(before)
    expect(rosterView(rosterOf(lead)).forkModel).toBeNull()
    // A state saved with an override by an earlier version still parses; the view drops it.
    const old = { ...rosterOf(lead), forkModel: { provider: 'mock-b', model: 'other' } }
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual(old)
    expect(rosterView(old).forkModel).toBeNull()
    expect(() => rosterSchema.parse({ ...old, forkModel: { provider: 'a' } })).toThrow(/invalid forkModel/)
  })
  it('folds the /worker model default the Agents page shows', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const run = (rawInput: string) => runWorkerModelCommand({ agent: lead, rawInput, attachments: [] } as never)
    expect(rosterView(rosterOf(lead)).workerModel).toBeNull()
    await run('model mock-b/reasoner high')
    const set = rosterOf(lead)
    expect(set.workerModel).toEqual({ provider: 'mock-b', model: 'reasoner', reasoningEffort: 'high' })
    expect(set.forkModel).toBeNull()
    expect(rosterViewSchema.parse(rosterView(set)).workerModel).toEqual(set.workerModel)
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(set)))).toEqual(set)
    expect(applyRoster(set, lead.session.snapshotEvents().at(-1)!)).toBe(set)
    // A state saved before the field existed still parses.
    const { workerModel: _, ...old } = set
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual(old)
    expect(() => rosterSchema.parse({ ...set, workerModel: { provider: 'a' } })).toThrow(/invalid forkModel/)
    await run('model default')
    expect(rosterOf(lead).workerModel).toBeNull()
  })

})
