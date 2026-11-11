/**
 * The main Session released while the scheduler awaits (DSH shutting down, or the Session closed):
 * nothing is written to it afterwards. DSH ≥ 0.2.2 refuses such an append (`cannot append outside
 * a SessionStore`); 0.2.1 took it into a log nobody owned. Either way the reopened log must stay
 * whole, and what was skipped is settled from the logs when the Session comes back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, forksOf, install, records, until, user } from './support/scheduler.js'
import { AGENT_RECORD, FORK_STATE_RECORD, REQUEST_RECORD } from '../src/records.js'
import { isLive } from '../src/dsh/host/index.js'

afterEach(teardown)

const opts = { provider: 'mock', model: 'lead-model' }
const contiguous = (events: readonly SessionEvent[]) => events.every((e, i) => Number(e.seq) === i)

/** A composition whose `drainChildren` returns only once `held` opens, after `hold()`. */
async function heldDrain(respond: Parameters<typeof setup>[0]) {
  const held = gate()
  const draining = gate()
  let holding = false
  const { ctx, adapter } = await setup(respond)
  const subagents = ctx.subagents
  const logs: string[] = []
  const scheduler = install(ctx, {
    subagents: {
      startActivation: subagents.startActivation.bind(subagents),
      sendMessage: (...a) => subagents.sendMessage(...a),
      interrupt: (...a) => subagents.interrupt(...a),
      // The drain completes, but its await returns only after the test released the main Session.
      drainChildren: async (...a) => {
        const drained = await subagents.drainChildren(...a)
        if (holding) { draining.open(); await held.promise }
        return drained
      },
    },
    log: message => { logs.push(message) },
  })
  const h = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
  return { ctx, adapter, scheduler, h, held, draining, logs, hold: () => { holding = true } }
}

describe('a main session released while the scheduler awaits', () => {
  it('a fork that concluded is not archived into a released lead: no write, no throw, the reopened log is whole', async () => {
    const { ctx, scheduler, h, held, draining, logs, hold } = await heldDrain(async o => textResponse(o.sessionId === 'main' ? 'MAIN' : 'ROUTED'))
    const main: Agent = h.agent
    hold()
    main.followup(user('route this'))
    // The fork concludes; retire waits in drainChildren.
    await until(main, 'Its reply to the user')
    await draining.promise
    const forkId = forksOf(main)[0]!
    expect(scheduler.ledgerOf(main).members.get(forkId)?.state).toBe('done')
    // DSH releases the main Session while the drain is pending.
    await h.dispose()
    scheduler.forget('main')
    expect(isLive(main, ctx.agents)).toBe(false)
    const before = (await stored(ctx, SessionId('main'))).events.length
    held.open()
    await vi.waitFor(() => { expect(logs.some(l => l.includes('main session main was released'))).toBe(true) })
    await new Promise(r => setTimeout(r, 50))
    // Nothing reached the stored log after the release, and the released object took nothing either.
    const after = (await stored(ctx, SessionId('main'))).events
    expect(after).toHaveLength(before)
    expect(contiguous(after)).toBe(true)
    expect(records(main.session.snapshotEvents(), FORK_STATE_RECORD).some(r => r.state === 'archived')).toBe(false)
    expect(logs.filter(l => l.includes('was released'))).toHaveLength(1)
    // It opens again, whole; the fork is still `done` and the lead can archive it now.
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    expect(contiguous(h2.agent.session.snapshotEvents())).toBe(true)
    expect(scheduler.ledgerOf(h2.agent).members.get(forkId)?.state).toBe('done')
    expect(await scheduler.archiveConcluded(h2.agent)).toEqual(['fork-1'])
    expect(records(h2.agent.session.snapshotEvents(), FORK_STATE_RECORD).at(-1)).toMatchObject({ forkId, state: 'archived' })
  })

  it('an archive that was draining when the lead was released fails nothing into it and tells no one', async () => {
    const { ctx, scheduler, h, held, draining, logs, hold } = await heldDrain(async o => {
      if (o.sessionId === 'main') return textResponse('MAIN')
      return textResponse(body(o).includes('[request r-2') ? 'TWO' : 'ONE')
    })
    const main: Agent = h.agent
    await scheduler.createWorker(main, { name: 'w', role: 'works', task: 'one' })
    await until(main, '[reply to r-1 from w]')
    const wId = scheduler.ledgerOf(main).find('w')!.id
    const before = records(main.session.snapshotEvents(), REQUEST_RECORD).length
    hold()
    const archiving = scheduler.archive(main, 'w')
    await draining.promise
    await h.dispose()
    scheduler.forget('main')
    held.open()
    await expect(archiving).resolves.toBeUndefined()
    expect(logs.some(l => l.includes('was released'))).toBe(true)
    const events = main.session.snapshotEvents()
    expect(records(events, REQUEST_RECORD)).toHaveLength(before)
    expect(records(events, AGENT_RECORD).some(r => r.action === 'archived')).toBe(false)
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    expect(contiguous(h2.agent.session.snapshotEvents())).toBe(true)
    expect(scheduler.ledgerOf(h2.agent).members.get(wId)?.state).toBe('started')
  })

  it('a reopened main is a different agent: the released one is not live, the new one is', async () => {
    const { ctx, h, scheduler } = await heldDrain(async () => textResponse('MAIN'))
    scheduler.setRole(h.agent, 'leads')
    expect(isLive(h.agent, ctx.agents)).toBe(true)
    await h.dispose()
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    expect(isLive(h.agent, ctx.agents)).toBe(false)
    expect(isLive(h2.agent, ctx.agents)).toBe(true)
  })
})
