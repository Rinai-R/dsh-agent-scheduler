/** Review marks: a member's latest report is unread until the user opens it (`/agents seen`). */
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema, type Roster } from '../src/projection.js'
import { appendAgent, appendForkState, appendInput, appendRequest, appendSeen } from '../src/records.js'
import { reviewOf, unread } from '../src/review.js'
import { runAgentsCommand } from '../src/rule-plugin.js'
import { reviewMarkOf, reviewSummary, seenLine } from '../src/client/index.js'
import { inLanguage } from './support/language.js'

inLanguage('en')

afterEach(teardown)

type Lead = Awaited<ReturnType<typeof setup>>['lead']
const rosterOf = (lead: Lead): Roster => lead.session.snapshotEvents().reduce(applyRoster, EMPTY_ROSTER)
const member = (lead: Lead, id: string) => rosterOf(lead).members.find(m => m.id === id)!

describe('review marks in the fold', () => {
  it('marks an answer, a failure, a fork conclusion and a failed start; seen clears; a new report revives', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const s = lead.session
    appendAgent(s, { action: 'created', id: 'w1', name: 'docs', role: 'docs' })
    expect(member(lead, 'w1').reportedAt).toBeUndefined()
    appendRequest(s, { action: 'sent', id: 'r-1', from: 'lead', to: 'w1', text: 'q' })
    expect(reviewOf(member(lead, 'w1'))).toBeUndefined()
    appendRequest(s, { action: 'answered', id: 'r-1', answer: 'a' })
    expect(reviewOf(member(lead, 'w1'))).toBe('reported')

    // Seen clears it, and the mark stays cleared through a full refold (a restart).
    appendSeen(s, { agent: 'w1' })
    expect(member(lead, 'w1').seenAt).toEqual(expect.any(Number))
    expect(reviewOf(member(lead, 'w1'))).toBeUndefined()
    const saved = rosterSchema.parse(JSON.parse(JSON.stringify(rosterOf(lead))))
    expect(reviewOf(saved.members.find(m => m.id === 'w1')!)).toBeUndefined()
    // A second seen with nothing new is a no-op for the fold.
    const before = rosterOf(lead)
    appendSeen(s, { agent: 'w1' })
    expect(applyRoster(before, s.snapshotEvents().at(-1)!)).toBe(before)

    // A failed request revives it as red; a later success turns it green again.
    appendRequest(s, { action: 'sent', id: 'r-2', from: 'lead', to: 'w1', text: 'q2' })
    appendRequest(s, { action: 'failed', id: 'r-2', detail: 'boom' })
    expect(member(lead, 'w1')).toMatchObject({ reportFailed: true })
    expect(member(lead, 'w1').seenAt).toBeUndefined()
    expect(reviewOf(member(lead, 'w1'))).toBe('failed')
    appendRequest(s, { action: 'sent', id: 'r-3', from: 'lead', to: 'w1', text: 'q3' })
    appendRequest(s, { action: 'answered', id: 'r-3', answer: 'ok' })
    expect(reviewOf(member(lead, 'w1'))).toBe('reported')
    // Restarting the worker (`started`) keeps the unread report and any seen mark.
    appendAgent(s, { action: 'started', id: 'w1', name: 'docs' })
    expect(reviewOf(member(lead, 'w1'))).toBe('reported')

    // A worker that failed to start is a red report on its own.
    appendAgent(s, { action: 'failed', id: 'w2', name: 'infra', detail: 'no such dir' })
    expect(reviewOf(member(lead, 'w2'))).toBe('failed')

    // A fork's conclusion is a report; a fork that failed is a red one; queued/started are not.
    appendInput(s, { messageId: 'm1', forkId: 'f1', text: 'why', name: 'fork-1' })
    appendForkState(s, { forkId: 'f1', state: 'started' })
    expect(reviewOf(member(lead, 'f1'))).toBeUndefined()
    appendForkState(s, { forkId: 'f1', state: 'done' })
    expect(reviewOf(member(lead, 'f1'))).toBe('reported')
    // Retiring itself right after does not read or re-stamp the report.
    const at = member(lead, 'f1').reportedAt
    appendForkState(s, { forkId: 'f1', state: 'archived' })
    expect(member(lead, 'f1')).toMatchObject({ state: 'archived', reportedAt: at })
    expect(reviewOf(member(lead, 'f1'))).toBe('reported')
    appendInput(s, { messageId: 'm2', forkId: 'f2', text: 'how', name: 'fork-2' })
    appendForkState(s, { forkId: 'f2', state: 'failed', detail: 'quota' })
    expect(reviewOf(member(lead, 'f2'))).toBe('failed')

    // The wire copy carries the fields and validates; a malformed one does not.
    const wire = rosterView(rosterOf(lead))
    expect(rosterViewSchema.parse(JSON.parse(JSON.stringify(wire)))).toEqual(wire)
    expect(() => rosterSchema.parse({ ...rosterOf(lead), members: [{ ...member(lead, 'w1'), seenAt: 'x' }] })).toThrow(/member seenAt/)
  })

  it('does not mark what archiving failed: the user did that', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const s = lead.session
    appendAgent(s, { action: 'created', id: 'w1', name: 'docs' })
    appendRequest(s, { action: 'sent', id: 'r-1', from: 'lead', to: 'w1', text: 'q' })
    appendAgent(s, { action: 'archived', id: 'w1', name: 'docs' })
    appendRequest(s, { action: 'failed', id: 'r-1', detail: 'docs was archived before answering' })
    expect(reviewOf(member(lead, 'w1'))).toBeUndefined()
  })
})

describe('review mark priority', () => {
  const m = (f: object) => ({ id: 'x', name: 'x', kind: 'worker', state: 'started', text: '', ...f }) as never
  const waits = new Map([['x', { pendingInteraction: { kind: 'permission' } }]])
  it('yellow beats red beats green, read or not; read without a prompt is nothing', () => {
    expect(reviewMarkOf(m({ reportedAt: 1, reportFailed: true }), waits)).toBe('approval')
    expect(reviewMarkOf(m({ reportedAt: 1, seenAt: 2 }), waits)).toBe('approval')
    expect(reviewMarkOf(m({}), waits)).toBe('approval')
    expect(reviewMarkOf(m({ reportedAt: 1, reportFailed: true }), new Map())).toBe('failed')
    expect(reviewMarkOf(m({ reportedAt: 1 }), undefined)).toBe('reported')
    expect(reviewMarkOf(m({ reportedAt: 1, seenAt: 1 }), undefined)).toBeUndefined()
    expect(reviewMarkOf(m({}), undefined)).toBeUndefined()
    expect(unread({ reportedAt: 5 })).toBe(true)
  })
  it('counts marks and takes the most urgent tone; reportsOnly ignores prompts', () => {
    const rows = [m({ id: 'a', reportedAt: 1 }), m({ id: 'b', reportedAt: 1, reportFailed: true }), m({ id: 'x' }), m({ id: 'c', reportedAt: 1, seenAt: 2 })]
    expect(reviewSummary(rows, waits)).toEqual({ n: 3, tone: 'approval' })
    expect(reviewSummary(rows, waits, true)).toEqual({ n: 2, tone: 'failed' })
    expect(reviewSummary([], waits)).toEqual({ n: 0, tone: undefined })
    expect(seenLine('s-1')).toBe('/agents seen s-1')
  })
})

describe('/agents seen', () => {
  it('records one seen for an unread report, by name or id, and nothing otherwise', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    const scheduler = install(ctx)
    const run = (rawInput: string) => runAgentsCommand(scheduler, { agent: lead, rawInput } as never)
    appendAgent(lead.session, { action: 'failed', id: 'w9', name: 'research', detail: 'bad dir' })
    expect(reviewOf(scheduler.ledgerOf(lead).find('research')!)).toBe('failed')
    expect(await run('seen research')).toMatchObject({ kind: 'success', text: 'Marked research as read.' })
    expect(reviewOf(scheduler.ledgerOf(lead).find('research')!)).toBeUndefined()
    const count = lead.session.snapshotEvents().length
    expect(await run('seen w9')).toMatchObject({ kind: 'success', text: 'Nothing new from w9.' })
    expect(lead.session.snapshotEvents().length).toBe(count)
    expect(await run('seen nobody')).toMatchObject({ kind: 'error' })
    expect(await run('seen')).toMatchObject({ kind: 'error', text: expect.stringContaining('seen <name>') })
    // `seen all` reads every unread report at once (an old log has them all unread).
    appendAgent(lead.session, { action: 'failed', id: 'w8', name: 'ops', detail: 'x' })
    appendAgent(lead.session, { action: 'failed', id: 'w7', name: 'qa', detail: 'y' })
    scheduler.forget(lead.id) // refold: these records were appended behind the ledger's back
    expect(await run('seen all')).toMatchObject({ kind: 'success', text: 'Marked every report as read.' })
    expect(scheduler.ledgerOf(lead).state.members.filter(m => reviewOf(m) !== undefined)).toHaveLength(0)
    expect(await run('seen all')).toMatchObject({ kind: 'success', text: 'Nothing unread.' })
    // The host ledger and the client projection agree.
    expect(scheduler.ledgerOf(lead).state).toEqual(rosterOf(lead))
  })
})
