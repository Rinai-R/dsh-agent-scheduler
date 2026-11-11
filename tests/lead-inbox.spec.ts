/**
 * The lead's inbox: answers that arrive while the lead is busy wait in a plugin record, not in
 * the runtime's queue (which the composer shows above the input as the user's own queued
 * messages). The lead takes them together when it is free, after anything the user queued; the
 * user orders, pins and holds them, or hands them over now; a restart keeps them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, leadSaw, records, until, user } from './support/scheduler.js'
import { MAIL_RECORD } from '../src/records.js'
import { applyRoster, EMPTY_ROSTER, mailPreview, rosterView, rosterSchema, rosterViewSchema, type Roster } from '../src/projection.js'
import { mailKindOf } from '../src/scheduler.js'
import { runAgentsCommand } from '../src/rule-plugin.js'
import { dropTarget, inboxLine, moveTarget } from '../src/client/inbox.js'

afterEach(teardown)

type Ctx = Awaited<ReturnType<typeof setup>>['ctx']
const exec = (agent: Agent) => ({ agent, signal: new AbortController().signal }) as never
const agentList = async (ctx: Ctx, agent: Agent) => await ctx.tools.get('agent_list', agent)!.execute({}, exec(agent)) as { inbox?: Array<Record<string, unknown>> }
const isWorker = (o: GenerateOptions) => body(o).includes('You are worker')
/** Relayed messages the lead's runtime queue holds right now (what the composer would list). */
const relaysQueued = (lead: Agent) => [...lead.inbox.nextTurn, ...lead.inbox.nextStep].filter(m => m.source.kind === 'agent-message')
const mailRecords = (events: readonly SessionEvent[]) => records(events, MAIL_RECORD)
/** The lead's user/message texts, in log order. */
const leadInputs = (lead: Agent) => lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => JSON.stringify(e.data))

/** A lead held in one long model call (`BUSY`) while workers answer. */
async function busyLead(answer: (o: GenerateOptions) => string = () => 'W ANSWER') {
  const hold = gate()
  let held = false
  const { ctx, lead, adapter } = await setup(async o => {
    if (isWorker(o)) return textResponse(answer(o))
    // Only the lead's first call: the turn the user's BUSY message opened.
    if (o.sessionId === 'lead' && !held) { held = true; await hold.promise }
    return textResponse('LEAD')
  })
  const scheduler = install(ctx, { defaultOn: false })
  lead.followup(user('BUSY: do a long thing'))
  await vi.waitFor(() => { expect(lead.status).toBe('running') })
  return { ctx, lead, adapter, scheduler, release: hold.open }
}

describe('lead inbox', () => {
  it('holds answers while the lead is busy, out of the runtime queue, and hands them over together when it is free', async () => {
    const { ctx, lead, scheduler, release } = await busyLead(o => body(o).includes('task a') ? 'ANSWER A' : 'ANSWER B')
    await scheduler.createWorker(lead, { name: 'wa', role: 'a', task: 'task a' })
    await scheduler.createWorker(lead, { name: 'wb', role: 'b', task: 'task b' })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).mail).toHaveLength(2) }, { timeout: 15_000 })
    expect(lead.status).toBe('running')
    // Not in the runtime's queue: the composer's list of queued messages stays the user's own.
    expect(relaysQueued(lead)).toEqual([])
    // The lead's agent_list summarizes each: sender, request, time, the start of the text.
    const listed = (await agentList(ctx, lead)).inbox!
    expect(listed.map(m => [m.from, m.kind, m.request])).toEqual([['wa', 'reply', 'r-1'], ['wb', 'reply', 'r-2']])
    expect(listed[0]!.preview).toBe('ANSWER A')
    expect(typeof listed[0]!.at).toBe('string')
    // A worker does not see the lead's inbox.
    const wa = ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('wa')!.id))
    if (wa !== undefined) expect((await agentList(ctx, wa)).inbox).toBeUndefined()
    release()
    await until(lead, 'ANSWER B')
    // One message, both answers, in inbox order.
    const merged = leadInputs(lead).filter(t => t.includes('ANSWER A'))
    expect(merged).toHaveLength(1)
    expect(merged[0]!.indexOf('[reply to r-1 from wa]')).toBeLessThan(merged[0]!.indexOf('[reply to r-2 from wb]'))
    expect(scheduler.ledgerOf(lead).mail).toEqual([])
    expect(mailRecords(lead.session.snapshotEvents()).filter(r => r.action === 'delivered')).toEqual([expect.objectContaining({ ids: ['m-1', 'm-2'], via: 'followup' })])
    // Answered when the round ended, as before: request state does not wait for the hand-over.
    expect(scheduler.ledgerOf(lead).requests.get('r-1')?.state).toBe('answered')
  })

  it('a free lead gets an answer at once, as before', async () => {
    const { lead, ctx } = await setup(o => textResponse(isWorker(o) ? 'QUICK ANSWER' : 'LEAD'))
    const scheduler = install(ctx, { defaultOn: false })
    await scheduler.createWorker(lead, { name: 'w', role: 'w', task: 'quick' })
    await until(lead, 'QUICK ANSWER')
    expect(scheduler.ledgerOf(lead).mail).toEqual([])
  })

  it('what the user queued for the lead goes first', async () => {
    const { lead, scheduler, release } = await busyLead()
    await scheduler.createWorker(lead, { name: 'w', role: 'w', task: 'task' })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).mail).toHaveLength(1) }, { timeout: 15_000 })
    lead.followup(user('USER QUEUED THIS'))
    release()
    await until(lead, 'W ANSWER')
    const inputs = leadInputs(lead)
    expect(inputs.findIndex(t => t.includes('USER QUEUED THIS'))).toBeLessThan(inputs.findIndex(t => t.includes('W ANSWER')))
  })

  it('hold skips a message until released; pin and move order the rest; now hands one over into the running turn', async () => {
    const { ctx, lead, scheduler, release, adapter } = await busyLead(o => `ANSWER ${/task ([abc])\b/u.exec(body(o))?.[1] ?? '?'}`)
    for (const n of ['a', 'b', 'c']) await scheduler.createWorker(lead, { name: `w${n}`, role: n, task: `task ${n}` })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).mail).toHaveLength(3) }, { timeout: 15_000 })
    const run = (line: string) => runAgentsCommand(scheduler, { agent: lead, rawInput: line.replace(/^\/agents /u, '') } as never)
    const ids = () => scheduler.ledgerOf(lead).mail.map(m => m.id)
    const byFrom = (name: string) => scheduler.ledgerOf(lead).mail.find(m => m.from === scheduler.ledgerOf(lead).find(name)!.id)!.id
    const [a, b, c] = [byFrom('wa'), byFrom('wb'), byFrom('wc')]
    expect((await run(inboxLine('pin', c))).kind).toBe('success')
    expect(ids()).toEqual([c, a, b])
    await run(inboxLine('move', b, a))
    expect(ids()).toEqual([c, b, a])
    await run(inboxLine('hold', a))
    expect((await run('inbox bogus m-1')).kind).toBe('error')
    expect((await run(inboxLine('hold', 'm-99'))).text).toMatch(/no message m-99/)
    // Now: into the turn the lead is running, at its next step.
    const handed = await run(inboxLine('now', b))
    expect(handed.text).toContain(b)
    expect(mailRecords(lead.session.snapshotEvents()).at(-1)).toMatchObject({ action: 'delivered', ids: [b], via: 'steer' })
    release()
    await until(lead, 'ANSWER b')
    await until(lead, 'ANSWER c')
    // b reached the lead inside the busy turn; c when it was free; a, held, not at all.
    expect(leadSaw(lead, 'ANSWER a')).toBe(0)
    expect(scheduler.ledgerOf(lead).mail.map(m => m.id)).toEqual([a])
    const leadReqs = adapter.requests.filter(r => r.sessionId === 'lead')
    expect(leadReqs.findIndex(r => body(r).includes('ANSWER b'))).toBeLessThan(leadReqs.findIndex(r => body(r).includes('ANSWER c')))
    // Released while the lead is free: handed over at once.
    await run(inboxLine('release', a))
    await until(lead, 'ANSWER a')
    expect(scheduler.ledgerOf(lead).mail).toEqual([])
    // agent_list has nothing left to summarize.
    expect((await agentList(ctx, lead)).inbox).toEqual([])
  })

  it('keeps the inbox, with its order and holds, across a restart', async () => {
    const hold = gate()
    const opts = { provider: 'mock', model: 'lead-model' }
    let held = false
    const { ctx } = await setup(async o => {
      if (isWorker(o)) return textResponse(body(o).includes('task a') ? 'KEPT A' : 'KEPT B')
      if (o.sessionId === 'main' && !held) { held = true; await hold.promise }
      return textResponse('MAIN')
    })
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx, { defaultOn: false })
    h1.agent.followup(user('BUSY: long'))
    await vi.waitFor(() => { expect(h1.agent.status).toBe('running') })
    await scheduler.createWorker(h1.agent, { name: 'wa', role: 'a', task: 'task a' })
    await scheduler.createWorker(h1.agent, { name: 'wb', role: 'b', task: 'task b' })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(h1.agent).mail).toHaveLength(2) }, { timeout: 15_000 })
    const [a, b] = scheduler.ledgerOf(h1.agent).mail.map(m => m.id) as [string, string]
    // The user holds both and puts b first; the lead's turn ends, and nothing is handed over.
    scheduler.arrangeMail(h1.agent, 'move', b, a)
    scheduler.arrangeMail(h1.agent, 'hold', a)
    scheduler.arrangeMail(h1.agent, 'hold', b)
    hold.open()
    await h1.agent.whenIdle()
    expect(leadSaw(h1.agent, 'KEPT')).toBe(0)
    // DSH restarts.
    for (const id of ['wa', 'wb']) await ctx.agents.get(SessionId(scheduler.ledgerOf(h1.agent).find(id)!.id))?.whenIdle()
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    const back = scheduler.ledgerOf(h2.agent).mail
    expect(back.map(m => [m.id, m.held])).toEqual([[b, true], [a, true]])
    // Released after the restart: the lead takes it.
    scheduler.arrangeMail(h2.agent, 'release', a)
    await until(h2.agent, 'KEPT A')
    expect(leadSaw(h2.agent, 'KEPT B')).toBe(0)
    expect(scheduler.ledgerOf(h2.agent).mail.map(m => m.id)).toEqual([b])
  })


  it('a turn DSH cuts on shutdown hands nothing over; the lead takes its inbox when it is back', async () => {
    const hold = gate()
    const opts = { provider: 'mock', model: 'lead-model' }
    let held = false
    const { ctx } = await setup(async o => {
      if (isWorker(o)) return textResponse('AFTER RESTART')
      if (o.sessionId === 'main' && !held) {
        held = true
        await new Promise<void>((resolve, reject) => { o.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }); void hold.promise.then(resolve) })
      }
      return textResponse('MAIN')
    })
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx, { defaultOn: false })
    h1.agent.followup(user('BUSY: long'))
    await vi.waitFor(() => { expect(h1.agent.status).toBe('running') })
    await scheduler.createWorker(h1.agent, { name: 'w', role: 'w', task: 'task' })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(h1.agent).mail).toHaveLength(1) }, { timeout: 15_000 })
    await ctx.agents.get(SessionId(scheduler.ledgerOf(h1.agent).find('w')!.id))?.whenIdle()
    // DSH shutting down cancels the lead's turn: the lead goes idle, and nothing is queued for it.
    h1.agent.cancel({ kind: 'disposed' } as never)
    await h1.agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(relaysQueued(h1.agent)).toEqual([])
    expect(scheduler.ledgerOf(h1.agent).mail).toHaveLength(1)
    await h1.dispose()
    hold.open()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await until(h2.agent, 'AFTER RESTART')
    expect(leadSaw(h2.agent, 'AFTER RESTART')).toBe(1)
    expect(scheduler.ledgerOf(h2.agent).mail).toEqual([])
  })
})

describe('lead inbox fold and helpers', () => {
  const ev = (seq: number, data: Record<string, unknown>) => ({ seq, type: MAIL_RECORD, ignorable: true, time: 1000 + seq, data: { version: 1, ...data } }) as unknown as SessionEvent
  const fold = (...events: SessionEvent[]): Roster => events.reduce(applyRoster, EMPTY_ROSTER)

  it('orders pinned first, moves, holds, and drops what was delivered', () => {
    let state = fold(
      ev(1, { action: 'queued', id: 'm-1', from: 's1', kind: 'reply', request: 'r-1', text: '[reply to r-1 from a]\nA' }),
      ev(2, { action: 'queued', id: 'm-2', from: 's2', kind: 'report', text: 'B' }),
      ev(3, { action: 'queued', id: 'm-3', from: 's3', kind: 'failure', request: 'r-3', text: 'C' }),
      ev(4, { action: 'pinned', id: 'm-3' }),
      ev(5, { action: 'moved', id: 'm-2', before: 'm-1' }),
      ev(6, { action: 'held', id: 'm-1' }),
    )
    expect(rosterView(state).inbox!.map(m => [m.id, m.pinned ?? false, m.held ?? false])).toEqual([['m-3', true, false], ['m-2', false, false], ['m-1', false, true]])
    expect(state.mailCount).toBe(3)
    // A queued message seen twice (a replayed record) is kept once; an unknown id changes nothing.
    expect(applyRoster(state, ev(7, { action: 'queued', id: 'm-1', from: 's1', kind: 'reply', text: 'again' }))).toBe(state)
    expect(applyRoster(state, ev(8, { action: 'pinned', id: 'm-9' }))).toBe(state)
    state = applyRoster(state, ev(9, { action: 'delivered', ids: ['m-3', 'm-2'], via: 'followup' }))
    expect(state.mail!.map(m => m.id)).toEqual(['m-1'])
    expect(state.delivered).toEqual({ count: 2, at: 1009, requests: ['r-3'] })
    // State and view both validate (they are persisted and sent to the client).
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(state)))).toBeTruthy()
    expect(rosterViewSchema.parse(JSON.parse(JSON.stringify(rosterView(state))))).toBeTruthy()
    // Malformed records are ignored.
    expect(applyRoster(state, ev(10, { action: 'queued', id: 'm-5', from: 's', kind: 'nonsense', text: 'x' }))).toBe(state)
  })

  it('previews a message in one line without its header', () => {
    expect(mailPreview('[reply to r-1 from a, asked by fork-2 for "x"]\nline one\n\n  line two')).toBe('line one line two')
    expect(mailPreview('The user said: hi\nfork-1 handled it.')).toBe('The user said: hi fork-1 handled it.')
    expect(mailPreview('x'.repeat(130))).toBe(`${'x'.repeat(120)}…`)
    expect(mailKindOf('[reply to r-12 from a]\nok')).toEqual({ kind: 'reply', request: 'r-12' })
    expect(mailKindOf('[request r-3 to b failed: archived]')).toEqual({ kind: 'failure', request: 'r-3' })
    expect(mailKindOf('[reply to r-3 from a, asked by fork-1 for "x"]\n')).toEqual({ kind: 'reply', request: 'r-3' })
    expect(mailKindOf('The user said: hi')).toEqual({ kind: 'conclusion' })
    expect(mailKindOf('[report from a, not a request]\nx')).toEqual({ kind: 'report' })
  })

  it('moves one place within its group, and drags only within it', () => {
    const items = [
      { id: 'p1', pinned: true as const }, { id: 'p2', pinned: true as const }, { id: 'u1' }, { id: 'u2' }, { id: 'u3' },
    ].map(m => ({ from: 's', kind: 'reply' as const, text: '', at: 0, ...m }))
    expect(moveTarget(items, 'p1', -1)).toBeUndefined()
    expect(moveTarget(items, 'p1', 1)).toBe('end')
    expect(moveTarget(items, 'p2', 1)).toBeUndefined()
    expect(moveTarget(items, 'u2', -1)).toBe('u1')
    expect(moveTarget(items, 'u1', 1)).toBe('u3')
    expect(moveTarget(items, 'u2', 1)).toBe('end')
    expect(dropTarget(items, 'u3', 'u1')).toBe('u1')
    expect(dropTarget(items, 'u1', 'u2')).toBe('u3')
    expect(dropTarget(items, 'u1', 'u3')).toBe('end')
    expect(dropTarget(items, 'u1', 'p1')).toBeUndefined()
    expect(inboxLine('move', 'm-1')).toBe('/agents inbox move m-1 end')
    expect(inboxLine('now', 'all')).toBe('/agents inbox now all')
  })
})

