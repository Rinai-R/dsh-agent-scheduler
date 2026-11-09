/**
 * No empty lead turn: when the scheduler takes a turn's message away (a hand-off to a fork, or a
 * runtime settlement notice whose answers it already put in the lead's inbox), the lead must not
 * be called on DSH's context snapshots alone. DSH's time context (`dsh-time-context`, prepended to
 * agent/pre-step) adds a timestamp to any step after a quiet spell; the lead then answered "your
 * message seems empty" (session-7ac73885, scheduling off). The turn DSH opened on the wake is left
 * with no step at all, which the chat renders as nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, forksOf, install, leadSaw, until, user } from './support/scheduler.js'

afterEach(teardown)

const isWorker = (o: GenerateOptions) => body(o).includes('You are worker')

/** As dsh-time-context does after a quiet spell: a snapshot appended to every step it wraps. */
function timeContext(ctx: Context): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const text = `Time sampled while preparing turn ${payload.turn}, step ${payload.step}`
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] } as never })] }
  }, { prepend: true })
}

/** Every step of the lead's log, with the user messages it took (context snapshots marked). */
function steps(events: readonly SessionEvent[]): Array<{ turn: number; step: number; inputs: string[] }> {
  const out: Array<{ turn: number; step: number; inputs: string[] }> = []
  let open = false
  for (const e of events) {
    if (e.type === 'step/start') { open = true; out.push({ turn: (e.data as { turn: number }).turn, step: (e.data as { step: number }).step, inputs: [] }) }
    if (e.type === 'step/end') open = false
    // A hand-off logs the user's words outside any step (the composer's receipt), shadowed for the lead.
    if (e.type === 'user/message' && open) {
      const source = (e.data as { source?: { kind?: string; form?: string } }).source
      out.at(-1)!.inputs.push(source?.form === 'snapshot' ? 'context' : String(source?.kind))
    }
  }
  return out
}

/** Model calls the lead made whose new user input was only context (what read as an "empty message"). */
const contextOnlyCalls = (events: readonly SessionEvent[]) => steps(events).filter(s => s.step === 1 && s.inputs.length > 0 && s.inputs.every(i => i === 'context'))

describe('no empty lead turn', () => {
  it('scheduling off: a settlement notice the scheduler emptied does not call the lead on a timestamp', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(isWorker(o) ? 'WORKER ANSWER' : 'LEAD'))
    timeContext(ctx)
    const scheduler = install(ctx, { defaultOn: false })
    await scheduler.createWorker(lead, { name: 'w', role: 'w', task: 'task' })
    await until(lead, '[reply to r-1 from w]')
    // The runtime's settlement notice can land after the answer was already delivered: give it time.
    await vi.waitFor(async () => {
      await lead.whenIdle()
      expect(lead.session.snapshotEvents().filter(e => e.type === 'turn/start').length).toBeGreaterThanOrEqual(2)
    }, { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await lead.whenIdle()
    const events = lead.session.snapshotEvents()
    expect(contextOnlyCalls(events)).toEqual([])
    // The answer still reached the lead, once.
    expect(leadSaw(lead, '[reply to r-1 from w]')).toBe(1)
    // The lead made exactly one model call: the one answering the reply.
    expect(adapter.requests.filter(r => r.sessionId === 'lead').length).toBe(1)
  })

  it('scheduling on: N messages handed to forks leave no lead model call on context alone, and each reaches its fork', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK DONE'))
    timeContext(ctx)
    install(ctx)
    for (const n of [1, 2, 3]) {
      lead.followup(user(`message ${n}`))
      await until(lead, `The user said: message ${n}`)
    }
    const events = lead.session.snapshotEvents()
    expect(contextOnlyCalls(events)).toEqual([])
    expect(forksOf(lead)).toHaveLength(3)
    // Every lead model call answered a fork's conclusion.
    const leadCalls = adapter.requests.filter(r => r.sessionId === 'lead')
    expect(leadCalls.length).toBeGreaterThan(0)
    for (const r of leadCalls) expect(body(r)).toContain('The user said: message')
    // No step of the lead took a user's own words (they went to forks).
    expect(steps(events).some(s => s.inputs.includes('user'))).toBe(false)
  })

  it('a real message to the lead with scheduling off is still answered', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('LEAD ANSWER'))
    timeContext(ctx)
    install(ctx, { defaultOn: false })
    lead.followup(user('hello lead'))
    await until(lead, 'hello lead')
    expect(adapter.requests.filter(r => r.sessionId === 'lead' && body(r).includes('hello lead'))).toHaveLength(1)
    expect(lead.session.snapshotEvents().some(e => e.type === 'assistant/message' && JSON.stringify(e.data).includes('LEAD ANSWER'))).toBe(true)
  })
})
