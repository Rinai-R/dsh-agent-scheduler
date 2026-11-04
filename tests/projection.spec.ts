import { tmpdir } from 'node:os'
/** The client roster projection: a fold over the same records the host writes. */
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, user, until } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema, type Roster } from '../src/projection.js'
import { runForkCommand } from '../src/rule-plugin.js'

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

  it('folds the /fork model override the Agents page shows', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const run = (rawInput: string) => runForkCommand({ agent: lead, rawInput, attachments: [] } as never)
    expect(rosterView(rosterOf(lead)).forkModel).toBeNull()
    run('model mock-b/other high')
    const set = rosterOf(lead)
    expect(set.forkModel).toEqual({ provider: 'mock-b', model: 'other', reasoningEffort: 'high' })
    expect(rosterViewSchema.parse(rosterView(set)).forkModel).toEqual(set.forkModel)
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(set)))).toEqual(set)
    // The same selection again changes nothing, so the projection publishes nothing.
    const event = lead.session.snapshotEvents().at(-1)!
    expect(applyRoster(set, event)).toBe(set)
    run('model default')
    expect(rosterOf(lead).forkModel).toBeNull()
    // Malformed records are ignored; a malformed state does not validate.
    const bad = { type: 'plugin:dsh-agent-scheduler/fork-model', seq: 1, time: 1, ignorable: true, data: { version: 1, selection: { provider: 1 } } }
    expect(applyRoster(set, bad as never)).toBe(set)
    expect(() => rosterSchema.parse({ ...set, forkModel: { provider: 'a' } })).toThrow(/invalid forkModel/)
  })
})
