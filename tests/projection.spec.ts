/** The client roster projection: a fold over the same records the host writes. */
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, user, until } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, type RosterView } from '../src/projection.js'

afterEach(teardown)

const rosterOf = (lead: Parameters<typeof until>[0]): RosterView =>
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

    scheduler.createWorker(lead, { name: 'billing', role: 'owns billing', cwd: '/tmp/billing' })
    const after = rosterOf(lead)
    expect(after.members).toContainEqual(expect.objectContaining({ name: 'billing', kind: 'worker', state: 'started', role: 'owns billing', cwd: '/tmp/billing' }))
  })
})
