/**
 * Regressions found in review: each case reproduces a defect of the earlier implementation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, leadSaw, records, until, user } from './support/scheduler.js'
import { FORK_STATE_RECORD, REQUEST_RECORD } from '../src/records.js'

afterEach(teardown)

const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
const goal = (t: string) => ({ ...user(t), source: { kind: 'goal' } as never })

describe('review regressions', () => {
  it('an answer carries the worker\'s words, not the runtime\'s settlement notice', async () => {
    let sent = false
    const { ctx, lead } = await setup(o => {
      if (isWorker('docs')(o)) return textResponse(body(o).includes('[request r-1 from lead]') ? 'DOCS: build is green' : 'docs ready')
      if (o.sessionId === 'lead' && !sent && body(o).includes('ask docs')) { sent = true; return toolCallResponse('s1', 'agent_send', { to: 'docs', message: 'is the build green?' }) }
      return textResponse('LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'docs', role: 'docs site' })
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(scheduler.ledgerOf(lead).find('docs')!.id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await lead.whenIdle()
    lead.followup(goal('ask docs'))
    await until(lead, '[reply to r-1 from docs]')
    const answered = records(lead.session.snapshotEvents(), REQUEST_RECORD).find(r => r.action === 'answered')!
    expect(answered.answer).toBe('DOCS: build is green')
    expect(leadSaw(lead, 'Background subagent')).toBe(0)
  })

  it('a request claimed by a round still running is not answered with an earlier round\'s words', async () => {
    const leadBusy = gate()
    const secondRound = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (isWorker('w')(o)) {
        if (body(o).includes('[request r-2')) { await secondRound.promise; return textResponse('ANSWER TWO') }
        return textResponse(body(o).includes('[request r-1') ? 'ANSWER ONE' : 'ready')
      }
      if (o.sessionId === 'lead' && body(o).includes('hold the lead')) await leadBusy.promise
      return textResponse('LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'w', role: 'x', task: 'first' })
    const wId = SessionId(scheduler.ledgerOf(lead).find('w')!.id)
    // r-1 is answered in w's first round; keep the lead busy so the settlement waits in its inbox.
    lead.followup(goal('hold the lead'))
    await vi.waitFor(async () => { expect((await stored(ctx, wId)).events.filter(e => e.type === 'turn/end')).toHaveLength(1) })
    await vi.waitFor(() => { expect(ctx.agents.get(wId)).toBeUndefined() })
    await scheduler.send(lead, 'w', 'second')
    // w's second round has claimed r-2 and is still running when the lead reads the settlement.
    await vi.waitFor(() => { expect(adapter.requests.some(r => isWorker('w')(r) && body(r).includes('[request r-2'))).toBe(true) })
    leadBusy.open()
    await vi.waitFor(() => { expect(leadSaw(lead, '[reply to r-1 from w]')).toBe(1) })
    await lead.whenIdle()
    expect(scheduler.ledgerOf(lead).requests.get('r-2')?.state).toBe('sent')
    secondRound.open()
    await until(lead, '[reply to r-2 from w]')
    expect(scheduler.ledgerOf(lead).requests.get('r-2')).toMatchObject({ state: 'answered', answer: 'ANSWER TWO' })
  })

  it('an archived fork stays archived after the main session restarts', async () => {
    const { ctx } = await setup(o => textResponse(o.sessionId === 'main' ? 'MAIN' : 'FORK'))
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    h1.agent.followup(user('one'))
    await until(h1.agent, 'Its conclusion')
    await scheduler.archive(h1.agent, 'fork-1')
    expect(records(h1.agent.session.snapshotEvents(), FORK_STATE_RECORD).at(-1)).toMatchObject({ state: 'archived' })
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    expect(scheduler.ledgerOf(h2.agent).find('fork-1')!.state).toBe('archived')
    expect(forksOf(h2.agent)).toHaveLength(1)
  })

  it('a drain with nothing queued does not stop later queued work from draining', async () => {
    const hold = gate()
    const { ctx, lead } = await setup(async o => { if (o.sessionId !== 'lead' && body(o).includes('"one"')) await hold.promise; return textResponse('X') }, 1)
    const scheduler = install(ctx)
    await scheduler.drain()
    lead.followup(user('one'))
    await vi.waitFor(() => { expect(forksOf(lead)).toHaveLength(1) })
    lead.followup(user('two'))
    await vi.waitFor(() => { expect(scheduler.queued()).toEqual(['fork-2']) }, { timeout: 10_000 })
    hold.open()
    await until(lead, 'The user said: two')
  })

  // An instant worker finishes before its start returns: the runtime then sends no settlement
  // notice, or steers it into a lead step that is already ending. Attribution must not need it.
  for (let run = 1; run <= 5; run += 1) {
    it(`a worker answering before its start returns still answers its task (run ${run})`, async () => {
      const called = (o: GenerateOptions, tool: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${tool}"`))
      const isFork = (o: GenerateOptions) => o.sessionId !== 'lead' && body(o).includes('You are a fork of the lead')
      const { ctx, lead } = await setup(o => {
        if (o.sessionId === 'lead') return textResponse('LEAD OK')
        if (isWorker('billing')(o)) return called(o, 'report') ? textResponse('chatty') : toolCallResponse('r1', 'report', { summary: 'REPORTED' })
        if (isFork(o)) {
          return called(o, 'agent_create') ? textResponse('FORK FINAL') : toolCallResponse('c1', 'agent_create', { name: 'billing', role: 'r', task: 't' })
        }
        return textResponse('OTHER')
      })
      install(ctx)
      lead.followup(user('look at billing retries'))
      await until(lead, 'Its conclusion')
      await until(lead, '[reply to r-1 from billing')
      expect(leadSaw(lead, 'FORK FINAL')).toBe(1)
      expect(records(lead.session.snapshotEvents(), REQUEST_RECORD).find(r => r.action === 'answered')).toMatchObject({ id: 'r-1', answer: 'REPORTED' })
    })
  }

  it('archiving an agent mid-round fails the request it was working on, and says so to the requester', async () => {
    const slow = gate()
    const { ctx, lead } = await setup(async o => {
      if (isWorker('slow')(o)) { if (body(o).includes('[request r-1')) await slow.promise; return textResponse('late words') }
      return textResponse('LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'slow', role: 'x', task: 'take your time' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('slow')!.id))?.status).toBe('running') })
    await scheduler.archive(lead, 'slow')
    slow.open()
    await until(lead, '[request r-1 to slow failed')
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'failed' })
    expect(leadSaw(lead, 'late words')).toBe(0)
  })

  it('archiving a worker still waiting for a slot fails its task and never starts it', async () => {
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (isWorker('a')(o)) await hold.promise
      return textResponse(isWorker('b')(o) ? 'B RAN' : 'X')
    }, 1)
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'a', role: 'first' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('a')!.id))).toBeDefined() })
    expect((await scheduler.createWorker(lead, { name: 'b', role: 'second', task: 'do b' })).queued).toBe(true)
    await scheduler.archive(lead, 'b')
    expect(scheduler.queued()).toEqual([])
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'failed' })
    hold.open()
    await until(lead, '[request r-1 to b failed')
    await new Promise(r => setTimeout(r, 300))
    expect(adapter.requests.some(isWorker('b'))).toBe(false)
  })

  it('a request that fails reaches the lead directly and does not wake the fork that asked', async () => {
    const hold = gate()
    const called = (o: GenerateOptions, tool: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${tool}"`))
    const { ctx, lead, adapter } = await setup(async o => {
      if (o.sessionId === 'lead') return textResponse('LEAD')
      if (isWorker('billing')(o)) { await hold.promise; return textResponse('never heard') }
      return called(o, 'agent_create') ? textResponse('CONCLUDED') : toolCallResponse('c1', 'agent_create', { name: 'billing', role: 'r', task: 't' })
    })
    const scheduler = install(ctx)
    lead.followup(user('look at billing retries'))
    await until(lead, 'Its conclusion')
    // Archiving waits for the cut-off round; this mock's gate ignores the abort a real request honors.
    const archiving = scheduler.archive(lead, 'billing')
    hold.open()
    await archiving
    await until(lead, '[request r-1 to billing failed')
    expect(leadSaw(lead, 'asked by fork-1')).toBe(1)
    // One conclusion for one input, and the fork made only its two original model calls.
    expect(leadSaw(lead, 'Its conclusion')).toBe(1)
    expect(adapter.requests.filter(r => r.sessionId === forksOf(lead)[0])).toHaveLength(2)
  })
})
