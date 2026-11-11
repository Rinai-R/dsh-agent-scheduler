/**
 * Scheduling off: the switch decides only whether user messages go to forks. The lead talks to
 * the user directly and keeps every worker tool, under the same dispatch lock and roster version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, forksOf, install, leadSaw, listThen, until, user } from './support/scheduler.js'
import { DispatchRefused, LEAD_NOTICE, LEAD_OFF_NOTICE } from '../src/scheduler.js'

afterEach(teardown)

type Ctx = Awaited<ReturnType<typeof setup>>['ctx']
const exec = (agent: Agent) => ({ agent, signal: new AbortController().signal }) as never
const tool = (ctx: Ctx, name: string, agent: Agent) => ctx.tools.get(name, agent)!
const list = async (ctx: Ctx, agent: Agent) => await tool(ctx, 'agent_list', agent).execute({}, exec(agent)) as { rosterVersion: string; agents: Array<{ name: string; state: string; createdFor?: string }> }
const create = (ctx: Ctx, agent: Agent, args: Record<string, unknown>) => tool(ctx, 'agent_create', agent).execute(args, exec(agent)) as Promise<{ name: string; request?: string; rosterVersion: string }>
const send = (ctx: Ctx, agent: Agent, args: Record<string, unknown>) => tool(ctx, 'agent_send', agent).execute(args, exec(agent)) as Promise<{ request: string; rosterVersion: string }>
const archive = (ctx: Ctx, agent: Agent, name: string) => tool(ctx, 'agent_archive', agent).execute({ name }, exec(agent))
const called = (o: GenerateOptions, name: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${name}"`))
const system = (o: GenerateOptions) => JSON.stringify(o.messages[0])

describe('scheduling off', () => {
  it('the lead answers the user itself, creates a worker without for, and gets its reply', async () => {
    const { ctx, lead, adapter } = await setup(o => {
      if (body(o).includes('You are worker')) return textResponse('WORKER DONE')
      if (o.sessionId === 'lead' && !called(o, 'agent_create')) return listThen(o, 'c1', 'agent_create', { name: 'docs', role: 'writes docs', task: 'write the README' })
      return textResponse('LEAD')
    })
    const scheduler = install(ctx, { defaultOn: false })
    lead.followup(user('please get the README written'))
    await until(lead, '[reply to r-1 from docs')
    // No fork: the user's words went to the lead itself, and no input card was recorded.
    expect(forksOf(lead)).toEqual([])
    const leadReqs = adapter.requests.filter(r => r.sessionId === 'lead')
    expect(body(leadReqs[0]!)).toContain('please get the README written')
    // Every session has the same section from the start, whatever the switch says (phase 2, Q0):
    // a first worker or the switch never changes the cached prefix.
    expect(system(leadReqs[0]!)).toContain('# Agent Scheduler')
    expect(system(leadReqs.at(-1)!)).toBe(system(leadReqs[0]!))
    expect(leadSaw(lead, 'WORKER DONE')).toBe(1)
    expect(scheduler.ledgerOf(lead).find('docs')).toMatchObject({ kind: 'worker', createdBy: lead.id })
    expect(scheduler.ledgerOf(lead).find('docs')?.createdFor).toBeUndefined()
  })

  it('agent_create, agent_send and agent_archive run, under the same lock and roster version', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx, { defaultOn: false })
    const v0 = (await list(ctx, lead)).rosterVersion
    const made = await create(ctx, lead, { name: 'docs', role: 'docs', task: 'first', rosterVersion: v0 })
    expect(made.request).toBe('r-1')
    // A stale or missing version is still refused, with the roster.
    await expect(create(ctx, lead, { name: 'docs-two', role: 'docs', rosterVersion: v0 })).rejects.toThrow(/roster changed/)
    await expect(send(ctx, lead, { to: 'docs', message: 'more' })).rejects.toThrow(/rosterVersion is required/)
    const sent = await send(ctx, lead, { to: 'docs', message: 'more', rosterVersion: made.rosterVersion })
    expect(sent.request).toBe('r-2')
    // for is optional here, but a named one is still checked and still gets one worker.
    await expect(create(ctx, lead, { name: 'x', role: 'x', for: 'nonsense', rosterVersion: sent.rosterVersion })).rejects.toThrow(/neither/)
    const fix = await create(ctx, lead, { name: 'fix', role: 'fixes', for: 'r-1', rosterVersion: sent.rosterVersion })
    await expect(create(ctx, lead, { name: 'fix-two', role: 'fixes', for: 'r-1', rosterVersion: fix.rosterVersion })).rejects.toThrow(/r-1 was already dispatched/)
    // Two creations racing on one version: one wins, the other gets the roster it missed.
    const v = scheduler.rosterVersion(scheduler.ledgerOf(lead))
    const raced = await Promise.allSettled([
      create(ctx, lead, { name: 'a', role: 'a', rosterVersion: v }),
      create(ctx, lead, { name: 'b', role: 'b', rosterVersion: v }),
    ])
    expect(raced.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((raced[1] as PromiseRejectedResult).reason).toBeInstanceOf(DispatchRefused)
    await vi.waitFor(async () => { await lead.whenIdle(); expect(scheduler.ledgerOf(lead).openTo(scheduler.ledgerOf(lead).find('docs')!.id)).toEqual([]) }, { timeout: 15_000 })
    await archive(ctx, lead, 'docs')
    expect(scheduler.ledgerOf(lead).find('docs')?.state).toBe('archived')
    expect(forksOf(lead)).toEqual([])
  })

  it('agent_split is not a tool any more (v2)', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    install(ctx, { defaultOn: false })
    expect(ctx.tools.get('agent_split', lead)).toBeUndefined()
  })

  it('switched back on, the lead must name what it creates for again', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx, { defaultOn: false })
    scheduler.setMode(lead, true)
    await expect(create(ctx, lead, { name: 'docs', role: 'docs', rosterVersion: (await list(ctx, lead)).rosterVersion })).rejects.toThrow(/must say what this worker is for/)
  })

  it('a fork made while on stays a fork after the switch goes off, with the session\'s own tools', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    const scheduler = install(ctx)
    lead.followup(user('hello'))
    await until(lead, 'Its reply to the user')
    scheduler.setMode(lead, false)
    const fork = { id: forksOf(lead)[0]!, session: { header: { parentSession: lead.id } } } as never
    expect(scheduler.forkNameOf(fork)).toBe('fork-1')
    // A fork is the session itself: every tool the lead has (no fork guard).
    expect(ctx.tools.get('edit', lead)).toBe(ctx.tools.get('edit', lead))
    // Its next wake still carries the fork notice (shared with the lead's on-mode section).
    lead.followup(user('plain words for the lead'))
    await vi.waitFor(async () => { await lead.whenIdle(); expect(leadSaw(lead, 'plain words for the lead')).toBe(1) })
    expect(forksOf(lead)).toHaveLength(1)
  })

  it('an ordinary subagent of the lead is still refused, on or off', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx, { defaultOn: false })
    const sub = { id: 'plain-subagent', session: { header: { parentSession: lead.id } } } as never
    for (const on of [false, true]) {
      scheduler.setMode(lead, on)
      await expect(tool(ctx, 'agent_list', lead).execute({}, exec(sub))).rejects.toThrow(/not part of scheduling/)
      await expect(create(ctx, sub, { name: 'x', role: 'x', rosterVersion: (await list(ctx, lead)).rosterVersion })).rejects.toThrow(/not part of scheduling/)
    }
  })

  it('the lead notice says the switch only decides who takes user messages', () => {
    expect(LEAD_NOTICE).toContain('decides only whether their messages go to forks')
    expect(LEAD_OFF_NOTICE).toContain('for is optional')
    expect(LEAD_OFF_NOTICE).not.toContain('work directly')
  })
})
