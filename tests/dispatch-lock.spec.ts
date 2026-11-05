/**
 * The dispatch lock: agent_create and agent_send of one main Session run one at a time, on the
 * roster version the caller read, and each user message (or reply) gets at most one worker.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { gate, setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, until, user } from './support/scheduler.js'
import { DispatchRefused, FORK_NOTICE, type Scheduler } from '../src/scheduler.js'

afterEach(teardown)

type Ctx = Awaited<ReturnType<typeof setup>>['ctx']
const exec = (agent: Agent) => ({ agent, signal: new AbortController().signal }) as never
const tool = (ctx: Ctx, name: string, agent: Agent) => ctx.tools.get(name, agent)!
const list = async (ctx: Ctx, agent: Agent) => await tool(ctx, 'agent_list', agent).execute({}, exec(agent)) as { rosterVersion: string; agents: Array<{ name: string; createdFor?: string }> }
const create = (ctx: Ctx, agent: Agent, args: Record<string, unknown>) => tool(ctx, 'agent_create', agent).execute(args, exec(agent)) as Promise<{ name: string; request?: string; rosterVersion: string }>
const send = (ctx: Ctx, agent: Agent, args: Record<string, unknown>) => tool(ctx, 'agent_send', agent).execute(args, exec(agent)) as Promise<{ request: string; rosterVersion: string }>

/** A lead with one concluded fork (fork-1) whose session is still resident for tool calls. */
async function withFork() {
  const env = await setup(() => textResponse('OK'))
  const scheduler = install(env.ctx)
  // A concluded fork is released; keep its agent object, which is all a tool call needs.
  const created = new Map<string, Agent>()
  env.ctx.on('agent/created', ({ agent }) => { created.set(agent.id, agent); return undefined })
  env.lead.followup(user('look at billing retries'))
  await until(env.lead, 'Its conclusion')
  const fork = created.get(scheduler.ledgerOf(env.lead).find('fork-1')!.id)!
  return { ...env, scheduler, fork }
}

describe('the dispatch lock', () => {
  it('serializes two creations racing on one version: one succeeds, one is refused with the roster it missed', async () => {
    const { ctx, lead, scheduler } = await withFork()
    const v = (await list(ctx, lead)).rosterVersion
    await create(ctx, lead, { name: 'docs', role: 'docs', for: 'fork-1', rosterVersion: v })
    const { rosterVersion } = await list(ctx, lead)
    // Two callers read the same version, then both create.
    const results = await Promise.allSettled([
      scheduler.createWorker(lead, { name: 'billing', role: 'owns billing', rosterVersion }),
      scheduler.createWorker(lead, { name: 'billing-retries', role: 'owns billing retries', rosterVersion }),
    ])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    const refused = (results[1] as PromiseRejectedResult).reason as DispatchRefused
    expect(refused).toBeInstanceOf(DispatchRefused)
    expect(refused.message).toContain('roster changed')
    expect(refused.roster.workers.map(w => w.name)).toEqual(['docs', 'billing'])
    expect(refused.roster.recent[0]).toMatchObject({ name: 'billing', by: 'lead' })
    expect(scheduler.ledgerOf(lead).find('billing-retries')).toBeUndefined()
  })

  it('refuses a stale rosterVersion and a missing one, for agent_create and agent_send', async () => {
    const { ctx, lead, fork } = await withFork()
    const stale = (await list(ctx, lead)).rosterVersion
    const made = await create(ctx, fork, { name: 'docs', role: 'docs', rosterVersion: stale })
    expect(made.rosterVersion).not.toBe(stale)
    await expect(send(ctx, lead, { to: 'docs', message: 'hi', rosterVersion: stale })).rejects.toThrow(/roster changed/)
    await expect(send(ctx, lead, { to: 'docs', message: 'hi' })).rejects.toThrow(/rosterVersion is required: call agent_list first/)
    await expect(create(ctx, lead, { name: 'x', role: 'x', for: 'fork-1' })).rejects.toThrow(/rosterVersion is required/)
    // The version a dispatch returns is current: chaining on it works.
    await expect(send(ctx, lead, { to: 'docs', message: 'hi', rosterVersion: made.rosterVersion })).resolves.toMatchObject({ to: 'docs' })
    const listed = await list(ctx, lead)
    expect(listed.agents).toEqual([expect.objectContaining({ name: 'docs', createdFor: 'fork-1' })])
  })

  it('refuses a second creation for the same input and names where it went, fork or lead', async () => {
    const { ctx, lead, fork, scheduler } = await withFork()
    const first = await create(ctx, fork, { name: 'billing', role: 'owns billing', task: 'check retries', rosterVersion: (await list(ctx, fork)).rosterVersion })
    expect(first.request).toBe('r-1')
    // The same fork woken again: refused, though its version is current.
    const again = create(ctx, fork, { name: 'billing-review', role: 'reviews billing', rosterVersion: first.rosterVersion })
    await expect(again).rejects.toThrow(/fork-1 was already dispatched at .* to billing \(r-1\) by fork-1/)
    // The lead acting on fork-1's conclusion: the same refusal.
    await expect(create(ctx, lead, { name: 'billing-two', role: 'r', for: 'fork-1', rosterVersion: first.rosterVersion })).rejects.toThrow(/already dispatched .* to billing/)
    // The lead must say what it creates for.
    await expect(create(ctx, lead, { name: 'billing-two', role: 'r', rosterVersion: first.rosterVersion })).rejects.toThrow(/must say what this worker is for/)
    await expect(create(ctx, lead, { name: 'billing-two', role: 'r', for: 'nonsense', rosterVersion: first.rosterVersion })).rejects.toThrow(/neither/)
    // A reply is its own input: one worker for r-1 is allowed, a second is not.
    await expect(create(ctx, lead, { name: 'billing-fix', role: 'fixes', for: 'r-1', rosterVersion: first.rosterVersion })).resolves.toMatchObject({ name: 'billing-fix' })
    await expect(create(ctx, lead, { name: 'billing-fix2', role: 'fixes', for: 'r-1', rosterVersion: scheduler.rosterVersion(scheduler.ledgerOf(lead)) })).rejects.toThrow(/r-1 was already dispatched/)
  })

  it('makes the lead wait behind a dispatch in progress', async () => {
    const env = await setup(() => textResponse('OK'))
    const hold = gate()
    const order: string[] = []
    const subagents = env.ctx.subagents
    const scheduler: Scheduler = install(env.ctx, {
      subagents: {
        startActivation: (async (...a: Parameters<typeof subagents.startActivation>) => { order.push('start'); await hold.promise; return subagents.startActivation(...a) }) as typeof subagents.startActivation,
        sendMessage: (...a: Parameters<typeof subagents.sendMessage>) => subagents.sendMessage(...a),
        interrupt: (...a: Parameters<typeof subagents.interrupt>) => subagents.interrupt(...a),
        drainChildren: (...a: Parameters<typeof subagents.drainChildren>) => subagents.drainChildren(...a),
      },
    })
    const { lead } = env
    const v = scheduler.rosterVersion(scheduler.ledgerOf(lead))
    const creating = scheduler.createWorker(lead, { name: 'billing', role: 'r', rosterVersion: v }).then(r => { order.push('created'); return r })
    // The lead read the roster before the creation recorded anything, and dispatches meanwhile.
    const sending = scheduler.send(lead, 'billing', 'more', { rosterVersion: v }).then(() => order.push('sent'), (e: Error) => { order.push('refused'); return e })
    await new Promise(r => setTimeout(r, 30))
    expect(order).toEqual(['start'])
    hold.open()
    await creating
    const refusal = await sending
    expect(order).toEqual(['start', 'created', 'refused'])
    expect((refusal as DispatchRefused).roster.workers.map(w => w.name)).toEqual(['billing'])
  })

  it('releases the lock when a dispatch throws', async () => {
    const { lead, scheduler } = await withFork()
    const v = scheduler.rosterVersion(scheduler.ledgerOf(lead))
    await expect(scheduler.createWorker(lead, { name: 'Bad Name', role: 'r', rosterVersion: v })).rejects.toThrow(/lower-kebab-case/)
    await expect(scheduler.send(lead, 'nobody', 'x', { rosterVersion: v })).rejects.toThrow(/no agent named/)
    await expect(scheduler.exclusive(lead.id, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(scheduler.createWorker(lead, { name: 'ok', role: 'r', rosterVersion: v })).resolves.toMatchObject({ name: 'ok' })
  })

  it('tells a fork not to work when it cannot delegate', () => {
    expect(FORK_NOTICE).toContain('not even when agent_create or agent_send is refused or scheduling is off')
    expect(FORK_NOTICE).toContain('rosterVersion')
    expect(FORK_NOTICE).toContain('at most one worker for your message')
  })
})
