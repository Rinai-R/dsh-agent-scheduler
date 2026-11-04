/** Restart recovery: work a DSH restart cut off fails to the lead once, or resumes once per restart. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, forksOf, install, leadSaw, records, until, user } from './support/scheduler.js'
import { FORK_STATE_RECORD, REQUEST_RECORD } from '../src/records.js'
import { fateOf, resumeMarker, setRecoveryPolicy, traceChild, type RecoveryPolicy } from '../src/recovery.js'
import { completedRounds } from '../src/rounds.js'
import { Config as HostConfig } from '../src/index.js'

afterEach(teardown)

const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
const opts = { provider: 'mock', model: 'lead-model' }
const failedRecords = (events: readonly SessionEvent[], id: string) => records(events, REQUEST_RECORD).filter(r => r.id === id && r.action === 'failed')
let restore: (() => void) | undefined
afterEach(() => { restore?.(); restore = undefined })
const policy = (p: RecoveryPolicy) => { restore = setRecoveryPolicy(() => p) }
/**
 * DSH going away: the main Session is released, and shutdown cancels each live child as
 * `disposed` (in one test process the children would otherwise keep running).
 */
async function shutDown(ctx: Awaited<ReturnType<typeof setup>>['ctx'], main: { dispose(): Promise<void> }, children: readonly string[]) {
  for (const id of children) {
    const child = ctx.agents.get(SessionId(id))
    if (child === undefined) continue
    child.cancel({ kind: 'disposed' })
    await child.whenIdle()
  }
  await main.dispose()
}
/** Block like a model call in flight; a cancellation ends it the way a real provider does. */
const inFlight = (o: GenerateOptions, until: Promise<void>) => new Promise<void>((resolve, reject) => {
  if (o.signal?.aborted === true) { reject(new Error('aborted')); return }
  o.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  void until.then(resolve)
})

/** A main Session `main` with a worker `w` cut off in the middle of r-1 by a restart. */
async function cutWorker(workerAfterRestart: (o: GenerateOptions) => string | Promise<string> = () => 'W DONE') {
  const hold = gate()
  let restarted = false
  const { ctx, adapter } = await setup(async o => {
    if (o.sessionId === 'main') return textResponse('MAIN')
    if (isWorker('w')(o)) {
      if (!restarted) { await inFlight(o, hold.promise); return textResponse('never') }
      return textResponse(await workerAfterRestart(o))
    }
    return textResponse('X')
  })
  const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
  const scheduler = install(ctx)
  await scheduler.createWorker(h1.agent, { name: 'w', role: 'works', task: 'do the long thing' })
  const wId = SessionId(scheduler.ledgerOf(h1.agent).find('w')!.id)
  await vi.waitFor(() => { expect(adapter.requests.some(isWorker('w'))).toBe(true) })
  // DSH goes away mid-round.
  await shutDown(ctx, h1, [wId])
  hold.open()
  scheduler.forget('main')
  restarted = true
  const resume = async () => {
    const h = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    return h
  }
  return { ctx, adapter, scheduler, wId, resume }
}

describe('restart recovery, option A (default: fail)', () => {
  it('fails the cut-off request once and tells the lead once, also across a second restart', async () => {
    const { ctx, scheduler, adapter, wId, resume } = await cutWorker()
    const before = adapter.requests.filter(isWorker('w')).length
    const h2 = await resume()
    await until(h2.agent, '[request r-1 to w failed: interrupted by a DSH restart')
    expect(scheduler.ledgerOf(h2.agent).requests.get('r-1')).toMatchObject({ state: 'failed' })
    expect(failedRecords(h2.agent.session.snapshotEvents(), 'r-1')).toHaveLength(1)
    // The worker is not woken: no token is spent after the restart.
    await new Promise(r => setTimeout(r, 300))
    expect(adapter.requests.filter(isWorker('w')).length).toBe(before)
    expect((await stored(ctx, wId)).events.filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('resumed after a DSH restart'))).toHaveLength(0)
    // Second restart: nothing left to do.
    await shutDown(ctx, h2, [wId])
    scheduler.forget('main')
    const h3 = await resume()
    await new Promise(r => setTimeout(r, 300))
    await h3.agent.whenIdle()
    expect(failedRecords(h3.agent.session.snapshotEvents(), 'r-1')).toHaveLength(1)
    expect(leadSaw(h3.agent, '[request r-1 to w failed')).toBe(1)
    // The worker itself still works: a new request is answered.
    await scheduler.send(h3.agent, 'w', 'again')
    await until(h3.agent, '[reply to r-2 from w]')
  })

  it('a fork cut off before concluding does not stay "running": it fails and the lead is told', async () => {
    const hold = gate()
    const { ctx, adapter } = await setup(async o => {
      if (o.sessionId === 'main') return textResponse('MAIN')
      await inFlight(o, hold.promise)
      return textResponse('late')
    })
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    h1.agent.followup(user('route this please'))
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forksOf(h1.agent)[0])).toBe(true) }, { timeout: 10_000 })
    await shutDown(ctx, h1, forksOf(h1.agent))
    hold.open()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await until(h2.agent, 'fork-1 was interrupted by a DSH restart')
    expect(scheduler.ledgerOf(h2.agent).find('fork-1')).toMatchObject({ state: 'failed' })
    expect(records(h2.agent.session.snapshotEvents(), FORK_STATE_RECORD).filter(r => r.state === 'failed')).toHaveLength(1)
    expect(leadSaw(h2.agent, 'The user said: route this please')).toBe(1)
  })

  it('a session that handed off a message with an attachment recovers the same way', async () => {
    const hold = gate()
    const { ctx, adapter } = await setup(async o => {
      if (o.sessionId === 'main') return textResponse('MAIN')
      if (body(o).includes('look at this screenshot')) await inFlight(o, hold.promise)
      return textResponse('FORK DONE')
    })
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    // A first exchange writes the system prompt, so the next hand-off is logged as the user's own message.
    h1.agent.followup(user('first'))
    await until(h1.agent, 'Its conclusion')
    const image = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    h1.agent.followup({ ...user('look at this screenshot'), content: [{ type: 'text', text: 'look at this screenshot' }, image] } as never)
    await vi.waitFor(() => { expect(forksOf(h1.agent)).toHaveLength(2) }, { timeout: 10_000 })
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forksOf(h1.agent)[1])).toBe(true) }, { timeout: 10_000 })
    expect(records(h1.agent.session.snapshotEvents(), 'plugin:dsh-agent-scheduler/input').at(-1)).toMatchObject({ logged: true })
    await shutDown(ctx, h1, forksOf(h1.agent))
    hold.open()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await until(h2.agent, 'fork-2 was interrupted by a DSH restart')
    // Only fork-2 was cut; fork-1 had concluded and is left alone. The logged user message is not
    // taken for new input: no fork is created for it on resume.
    expect(scheduler.ledgerOf(h2.agent).find('fork-1')!.state).not.toBe('failed')
    expect(scheduler.ledgerOf(h2.agent).find('fork-2')).toMatchObject({ state: 'failed' })
    expect(forksOf(h2.agent)).toHaveLength(2)
  })
})

describe('restart recovery, option B (resume)', () => {
  it('continues the request in the worker\'s session once, with the note, and the answer reaches the lead', async () => {
    policy({ onInterrupted: 'resume', maxResumes: 2 })
    const { scheduler, adapter, resume } = await cutWorker(() => 'RESUMED ANSWER')
    const h2 = await resume()
    await until(h2.agent, '[reply to r-1 from w]')
    expect(scheduler.ledgerOf(h2.agent).requests.get('r-1')).toMatchObject({ state: 'answered', answer: 'RESUMED ANSWER' })
    const resumed = adapter.requests.filter(isWorker('w')).at(-1)!
    expect(body(resumed)).toContain(resumeMarker('r-1', 1).replace(/"/gu, '\\"'))
    expect(body(resumed)).toContain('git status')
    expect(failedRecords(h2.agent.session.snapshotEvents(), 'r-1')).toHaveLength(0)
  })

  it('does not deliver the note twice across restarts, and fails once the limit is reached', async () => {
    policy({ onInterrupted: 'resume', maxResumes: 1 })
    let calls = 0
    const block = gate()
    const { ctx, scheduler, wId, resume } = await cutWorker(async o => { calls += 1; await inFlight(o, block.promise); return 'never' })
    // Restart 1: the note is delivered and the resumed round starts, then DSH goes away again.
    const h2 = await resume()
    await vi.waitFor(() => { expect(calls).toBe(1) }, { timeout: 10_000 })
    await shutDown(ctx, h2, [wId])
    block.open()
    scheduler.forget('main')
    // Restart 2: the limit (1) is used up, so the request fails and no second note is sent.
    const h3 = await resume()
    await until(h3.agent, '[request r-1 to w failed: interrupted by a DSH restart, not completed; resend it if it still matters (resumed 1 time, the limit)')
    const notes = (await stored(ctx, wId)).events.filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('resumed after a DSH restart'))
    expect(notes).toHaveLength(1)
    expect(failedRecords(h3.agent.session.snapshotEvents(), 'r-1')).toHaveLength(1)
    // Restart 3: nothing more.
    await shutDown(ctx, h3, [wId])
    scheduler.forget('main')
    const h4 = await resume()
    await new Promise(r => setTimeout(r, 300))
    await h4.agent.whenIdle()
    expect(failedRecords(h4.agent.session.snapshotEvents(), 'r-1')).toHaveLength(1)
    expect(leadSaw(h4.agent, '[request r-1 to w failed')).toBe(1)
  })
})

describe('reading a crashed log', () => {
  const ev = (seq: number, type: string, data: object) => ({ type, seq, time: 0, data }) as unknown as SessionEvent
  const msg = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

  it('an interrupted closer marks the claimed request cut by the restart', () => {
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', msg('m1', '[request r-1 from lead]\nbuild it')),
      ev(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ]
    expect(fateOf({ id: 'r-1', messageId: 'm1' }, completedRounds(events, 0), traceChild(events))).toEqual({ kind: 'cut', messageId: 'm1', byRestart: true })
  })

  it('a round the user stopped is not resumed; a message still in the inbox is pending; an unknown one is lost', () => {
    const stopped = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', msg('m1', '[request r-1 from lead]\nx')),
      ev(2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(fateOf({ id: 'r-1', messageId: 'm1' }, completedRounds(stopped, 0), traceChild(stopped))).toMatchObject({ kind: 'cut', byRestart: false })
    const waiting = [ev(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg('m2', '[request r-2 from lead]\ny')] })]
    expect(fateOf({ id: 'r-2', messageId: 'm2' }, [], traceChild(waiting))).toMatchObject({ kind: 'pending' })
    expect(fateOf({ id: 'r-3' }, [], traceChild(waiting))).toEqual({ kind: 'lost' })
  })

  it('a resume note already delivered stands for the request', () => {
    // As delivered: the runtime puts "Agent <id> sent a message: " in a block of its own first.
    const note = { id: 'n1', role: 'user', content: [{ type: 'text', text: 'Agent main sent a message: ' }, { type: 'text', text: `${resumeMarker('r-1', 1)}\ncheck first` }], source: { kind: 'agent-message' } }
    const events = [
      ev(0, 'turn/start', { turn: 1 }),
      ev(1, 'user/message', msg('m1', '[request r-1 from lead]\nx')),
      ev(2, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
      ev(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [note] }),
      ev(4, 'turn/start', { turn: 2 }),
      ev(5, 'user/message', note),
      ev(6, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const trace = traceChild(events)
    expect(trace.resumes.get('r-1')?.get(1)).toBe('n1')
    expect(fateOf({ id: 'r-1', messageId: 'm1' }, completedRounds(events, 3), trace)).toEqual({ kind: 'answered' })
  })
})

describe('the option', () => {
  it('lives on the host row as a volatile field (what settings forms list), default fail', () => {
    const schema = HostConfig as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }
    expect(schema.dict.recovery!.meta.volatile).toBe(true)
    const parsed = (HostConfig as unknown as (v: unknown) => { recovery: { get(): RecoveryPolicy } })({})
    expect(parsed.recovery.get()).toEqual({ onInterrupted: 'fail', maxResumes: 2 })
    expect(() => (HostConfig as unknown as (v: unknown) => unknown)({ recovery: { onInterrupted: 'forever' } })).toThrow()
  })

  it('a round the scheduler itself interrupted fails at once and is not resumed later', async () => {
    policy({ onInterrupted: 'resume', maxResumes: 2 })
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (isWorker('w')(o)) { await inFlight(o, hold.promise); return textResponse('never') }
      return textResponse('LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'w', role: 'works', task: 'long' })
    // Mid-call, so the round has taken the request in.
    await vi.waitFor(() => { expect(adapter.requests.some(isWorker('w'))).toBe(true) })
    scheduler.interrupt(lead, 'w')
    await until(lead, '[request r-1 to w failed: w\'s round ended (aborted)')
    await scheduler.recover(lead)
    expect(failedRecords(lead.session.snapshotEvents(), 'r-1')).toHaveLength(1)
  })
})
