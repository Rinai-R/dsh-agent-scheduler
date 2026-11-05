/**
 * The scheduling switch. The rule is mounted in the standard preset, so a Session that never
 * turned it on must behave as an ordinary chat, and turning it on or off takes effect from the
 * next message without touching forks and workers already there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, records, until, user } from './support/scheduler.js'
import { MODE_RECORD } from '../src/records.js'
import { runAgentsCommand, runScheduleCommand } from '../src/rule-plugin.js'
import { FORK_STATE_RECORD } from '../src/records.js'
import { preStep, Scheduler } from '../src/scheduler.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { rosterView, applyRoster, EMPTY_ROSTER } from '../src/projection.js'

afterEach(teardown)

const system = (o: { messages: readonly unknown[] }) => JSON.stringify(o.messages[0])

describe('scheduling switch', () => {
  it('off by default: the lead answers the user itself, has no scheduler section, and its worker tools still work', async () => {
    let called = false
    const { ctx, lead, adapter } = await setup(o => {
      if (o.sessionId === 'lead' && !called) { called = true; return toolCallResponse('l1', 'agent_list', {}) }
      return textResponse('PLAIN ANSWER')
    })
    install(ctx, { defaultOn: false })
    lead.followup(user('hello there'))
    await vi.waitFor(async () => { await lead.whenIdle(); expect(adapter.requests.length).toBe(2) }, { timeout: 10_000 })
    expect(forksOf(lead)).toEqual([])
    expect(adapter.requests.every(r => r.sessionId === 'lead')).toBe(true)
    expect(body(adapter.requests[0]!)).toContain('hello there')
    expect(system(adapter.requests[0]!)).not.toContain('# Agent Scheduler')
    // agent_list ran: the switch decides only who takes user messages, not whether workers exist.
    expect(body(adapter.requests[1]!)).not.toContain('Scheduling is off')
    expect(body(adapter.requests[1]!)).toContain('rosterVersion')
  })

  it('on mid-session forks the next message; off returns later messages to the lead, and an earlier fork still concludes', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK CONCLUSION'))
    const scheduler = install(ctx, { defaultOn: false })
    lead.followup(user('before'))
    await vi.waitFor(async () => { await lead.whenIdle(); expect(adapter.requests.length).toBe(1) })

    expect(runScheduleCommand(scheduler, { agent: lead, rawInput: 'on' } as never).kind).toBe('success')
    lead.followup(user('during'))
    await until(lead, 'Its conclusion')
    expect(forksOf(lead)).toHaveLength(1)
    const fork = adapter.requests.find(r => r.sessionId === forksOf(lead)[0])!
    // The fork sees the earlier plain exchange as its context, and the lead's section.
    expect(body(fork)).toContain('before')
    expect(system(fork)).toContain('# Agent Scheduler')

    expect(runScheduleCommand(scheduler, { agent: lead, rawInput: 'off' } as never).kind).toBe('success')
    const leadCalls = adapter.requests.filter(r => r.sessionId === 'lead').length
    lead.followup(user('after'))
    await vi.waitFor(async () => {
      await lead.whenIdle()
      expect(adapter.requests.filter(r => r.sessionId === 'lead').length).toBeGreaterThan(leadCalls)
    }, { timeout: 10_000 })
    expect(forksOf(lead)).toHaveLength(1)
    expect(body(adapter.requests.filter(r => r.sessionId === 'lead').at(-1)!)).toContain('after')
    expect(records(lead.session.snapshotEvents(), MODE_RECORD).map(r => r.on)).toEqual([true, false])
  })

  it('off: never rejects a step and never touches ordinary subagent children', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const scheduler = new Scheduler({ subagents: {} as never, agents: { get: () => undefined }, readLog: async () => ({ events: [], inherited: 0 }) })
    const context = createUserMessage({ content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } as never })
    const pass = async () => ({ kind: 'enter' as const, messages: [context] as never[] })
    expect((await preStep(scheduler, { agent: lead, messages: [context] as never[], step: 1 }, pass)).kind).toBe('enter')
    // A child that is not a fork or worker keeps the runtime's own notice.
    const child = { id: 'c', session: { header: { parentSession: 'lead' } }, inbox: { replace: () => { throw new Error('touched') } } }
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Your parent agent id is "lead". Use send_message.' }], source: { kind: 'user' } })
    expect(scheduler.onInserted(child as never, notice)).toBe(false)
    // The lead keeps the scheduling tools whether or not it schedules.
    expect(scheduler.takesPart(lead)).toBe(true)
    expect(scheduler.isOn(lead)).toBe(false)
  })

  it('/schedule parses on, off and a bare call, and refuses anything else', () => {
    const calls: boolean[] = []
    const fake = { setMode: (_: unknown, on: boolean) => { calls.push(on); return true }, isOn: () => false }
    const main = { session: { header: {} } }
    expect(runScheduleCommand(fake as never, { agent: main, rawInput: '' } as never).kind).toBe('success')
    expect(runScheduleCommand(fake as never, { agent: main, rawInput: ' OFF ' } as never).kind).toBe('success')
    expect(runScheduleCommand(fake as never, { agent: main, rawInput: 'maybe' } as never).kind).toBe('error')
    expect(runScheduleCommand(fake as never, { agent: { session: { header: { parentSession: 'x' } } }, rawInput: 'on' } as never).kind).toBe('error')
    expect(calls).toEqual([true, false])
  })

  it('the client view reports the switch, inferring on for logs from the retired scheduler preset', () => {
    expect(rosterView(EMPTY_ROSTER).enabled).toBe(false)
    const legacy = applyRoster(EMPTY_ROSTER, { type: 'plugin:dsh-agent-scheduler/input', ignorable: true, seq: 1, time: 1, data: { version: 1, messageId: 'm', forkId: 'f', text: 't' } } as never)
    expect(legacy.members).toHaveLength(1)
    expect(rosterView(legacy).enabled).toBe(true)
    const off = applyRoster(legacy, { type: MODE_RECORD, ignorable: true, seq: 2, time: 2, data: { version: 1, on: false } } as never)
    expect(rosterView(off).enabled).toBe(false)
  })
  it('concluded forks archive themselves, keeping their sessions; /agents archive finds nothing left', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    const scheduler = install(ctx)
    lead.followup(user('one'))
    await until(lead, 'Its conclusion')
    lead.followup(user('two'))
    await until(lead, 'Its conclusion', 2)
    const forks = forksOf(lead)
    expect(forks).toHaveLength(2)
    // Concluded forks archive themselves; the command finds nothing left and archives nothing twice.
    await vi.waitFor(() => { expect(records(lead.session.snapshotEvents(), FORK_STATE_RECORD).filter(r => r.state === 'archived').map(r => r.forkId).sort()).toEqual([...forks].sort()) })
    expect((await runAgentsCommand(scheduler, { agent: lead, rawInput: 'archive fork-1' } as never)).kind).toBe('success')
    expect(records(lead.session.snapshotEvents(), FORK_STATE_RECORD).filter(r => r.state === 'archived')).toHaveLength(2)
    expect(rosterView(scheduler.ledgerOf(lead).state).members.every(m => m.state === 'archived')).toBe(true)
    expect((await runAgentsCommand(scheduler, { agent: lead, rawInput: 'archive done' } as never)).text).toBe('No concluded fork to archive.')
    expect((await runAgentsCommand(scheduler, { agent: lead, rawInput: 'archive nobody' } as never)).kind).toBe('error')
    expect((await runAgentsCommand(scheduler, { agent: lead, rawInput: 'list' } as never)).kind).toBe('error')
  })
})
