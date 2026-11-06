/**
 * Workers lead their own Agent Team (src/dsh/host/agent-team.ts), and who may form a team
 * follows the role and the scheduling switch (src/team-guard.ts). Runs on the real experimental
 * Agent Teams service and tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import AgentTeam from '@deepseek-ai/dsh-experimental-agent-team'
import * as ToolAgentTeam from '@deepseek-ai/dsh-experimental-tool-agent-team'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, install, until, user } from './support/scheduler.js'
import { installWorkerTeams, isMainSession, teamPort } from '../src/dsh/host/index.js'
import { teamGuard } from '../src/team-guard.js'
import type { Scheduler } from '../src/scheduler.js'

afterEach(teardown)

type Ctx = Awaited<ReturnType<typeof setup>>['ctx']
const called = (o: GenerateOptions, name: string) => o.messages.filter(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${name}"`)).length
const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)

/** A composition with Agent Teams mounted and the scheduler wired as the rule plugin wires it. */
async function teamSetup(respond: Parameters<typeof setup>[0], deps: Parameters<typeof install>[1] = { defaultOn: false }) {
  const s = await setup(respond)
  await s.ctx.plugin(AgentTeam as never, { maxMembers: 8 } as never)
  await s.ctx.plugin(ToolAgentTeam as never, { freshProvider: 'spawn', forkProvider: 'fork' } as never)
  const scheduler = install(s.ctx, { ...deps, team: teamPort(s.ctx) })
  s.ctx.tools.guard(teamGuard({ isMain: isMainSession, isOn: a => scheduler.isOn(a), forkName: a => scheduler.forkNameOf(a), isWorker: a => scheduler.isWorker(a) }))
  installWorkerTeams(s.ctx, a => scheduler.isWorker(a))
  teamPort(s.ctx).watch(id => { scheduler.onTeamRecord(id) })
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ...s, scheduler }
}
const tools = (ctx: Ctx, agent: Agent) => ['spawn_teammate', 'send_message', 'team_task_create', 'agent_send'].filter(n => ctx.tools.get(n, agent) !== undefined)
const membership = (ctx: Ctx, agent: Agent) => (ctx as unknown as { agentTeams: { tryMembership(a: Agent): { role: string; root: Agent } | undefined } }).agentTeams.tryMembership(agent)
const worker = (ctx: Ctx, scheduler: Scheduler, lead: Agent, name: string) => ctx.agents.get(scheduler.ledgerOf(lead).find(name)!.id as never) as Agent | undefined

describe('a worker leads its own Agent Team', () => {
  it('gets the Team tools, forms a team, gets its teammate\'s answer, and answers the lead with it', async () => {
    const { ctx, lead, scheduler } = await teamSetup(o => {
      if (isWorker('tw')(o)) {
        if (called(o, 'spawn_teammate') === 0) return toolCallResponse('s1', 'spawn_teammate', { name: 'helper', description: 'computes', prompt: 'HELPER: compute the number' })
        if (body(o).includes('HELPER ANSWER 42')) return textResponse('TEAM SUMMARY: the helper says 42')
        return toolCallResponse(`w${called(o, 'wait_agent')}`, 'wait_agent', { timeoutMs: 10_000 })
      }
      if (body(o).includes('HELPER: compute')) return textResponse('HELPER ANSWER 42')
      return textResponse('LEAD')
    })
    await scheduler.createWorker(lead, { name: 'tw', role: 'leads a team', task: 'get the number from a helper' })
    await until(lead, 'TEAM SUMMARY: the helper says 42')
    const wId = scheduler.ledgerOf(lead).find('tw')!.id
    // The worker had the Team tools: it called spawn_teammate, and the Team recorded the teammate.
    const wLog = (await stored(ctx, wId as never)).events
    const members = wLog.filter(e => e.type === 'team/member').map(e => (e.data as { member: { id: string; name: string; phase: string } }).member)
    expect(members.map(m => [m.name, m.phase])).toEqual([['helper', 'provisioning'], ['helper', 'active']])
    // The team lives in the worker's own log, not the main Session's.
    expect(lead.session.snapshotEvents().some(e => e.type === 'team/member')).toBe(false)
    // The teammate is the worker's child: its answer went to the worker, never to the lead.
    expect(JSON.stringify(wLog)).toContain('HELPER ANSWER 42')
    expect(JSON.stringify(lead.session.snapshotEvents())).not.toContain('HELPER ANSWER 42')
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'answered', answer: 'TEAM SUMMARY: the helper says 42' })
    // The teammate's own log holds its answer: it is a real child session of the worker.
    expect(JSON.stringify((await stored(ctx, members[0]!.id as never)).events)).toContain('HELPER ANSWER 42')
    // A worker is a Team Lead while it is resident; its teammate is no worker of ours.
    const w = worker(ctx, scheduler, lead, 'tw')
    if (w !== undefined) expect(membership(ctx, w)).toMatchObject({ role: 'lead' })
    expect(scheduler.ledgerOf(lead).find('helper')).toBeUndefined()
    // The Agents page copy of the worker's team.
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).state.teams?.[wId]?.members.map(m => m.name)).toEqual(['helper']) })
  })

  it('a worker that ends its turn before its teammate answers answers the lead only with its summary', async () => {
    const { ctx, lead, scheduler, adapter } = await teamSetup(async o => {
      if (isWorker('tw')(o)) {
        if (called(o, 'spawn_teammate') === 0) return toolCallResponse('s1', 'spawn_teammate', { name: 'slow', description: 'slow', prompt: 'SLOW: take your time' })
        if (body(o).includes('SLOW ANSWER')) return textResponse('FINAL SUMMARY with SLOW ANSWER')
        return textResponse('PARTIAL: waiting for slow')
      }
      if (body(o).includes('SLOW: take your time')) { await new Promise(r => setTimeout(r, 400)); return textResponse('SLOW ANSWER') }
      return textResponse('LEAD')
    })
    await scheduler.createWorker(lead, { name: 'tw', role: 'leads', task: 'get it done' })
    await until(lead, 'FINAL SUMMARY with SLOW ANSWER')
    expect(JSON.stringify(lead.session.snapshotEvents())).not.toContain('[reply to r-1 from tw]\\nPARTIAL')
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'answered', answer: 'FINAL SUMMARY with SLOW ANSWER' })
    expect(adapter.requests.some(r => body(r).includes('PARTIAL'))).toBe(true)
    void ctx
  })

  it('who may form a team: lead only while scheduling is off; forks never; teammates never', async () => {
    const { ctx, lead, scheduler } = await teamSetup(() => textResponse('OK'))
    const guard = teamGuard({ isMain: isMainSession, isOn: a => scheduler.isOn(a), forkName: a => scheduler.forkNameOf(a), isWorker: a => scheduler.isWorker(a) })
    // The lead is a Team Lead natively.
    expect(membership(ctx, lead)).toMatchObject({ role: 'lead' })
    expect(guard({ name: 'spawn_teammate', agent: lead })).toBeUndefined()
    scheduler.setMode(lead, true)
    expect(guard({ name: 'spawn_teammate', agent: lead })).toMatch(/Scheduling is on/)
    // Its existing team keeps everything else.
    for (const name of ['send_message', 'list_agents', 'team_task_update', 'interrupt_agent', 'wait_agent']) expect(guard({ name, agent: lead })).toBeUndefined()
    // A fork: every Team tool refused.
    lead.followup(user('route this'))
    await until(lead, 'Its conclusion')
    const forkId = scheduler.ledgerOf(lead).state.members.find(m => m.kind === 'fork')!.id
    const fork = { id: forkId, session: { header: { parentSession: lead.id } } } as never
    expect(guard({ name: 'list_agents', agent: fork })).toMatch(/is a fork/)
    // Something that is neither the lead nor a worker: no teammates of its own.
    const other = { id: 'x', session: { header: { parentSession: 'some-worker' } } } as never
    expect(guard({ name: 'spawn_teammate', agent: other })).toMatch(/do not nest/)
    // Non-Team tools are not this guard's business.
    expect(guard({ name: 'agent_create', agent: lead })).toBeUndefined()
  })

  it('a refusal reaches the lead as a tool error while scheduling is on', async () => {
    const { lead, scheduler } = await teamSetup(o => {
      if (o.sessionId === 'lead' && called(o, 'spawn_teammate') === 0) return toolCallResponse('t1', 'spawn_teammate', { name: 'r', description: 'r', prompt: 'p' })
      return textResponse('LEAD DONE')
    }, { defaultOn: false })
    scheduler.setMode(lead, false)
    // Off: the lead's own team, natively.
    lead.followup(user('form a team'))
    await vi.waitFor(async () => { await lead.whenIdle(); expect(JSON.stringify(lead.session.snapshotEvents())).toContain('team/member') }, { timeout: 15_000 })
  })
})

describe('Agent Teams adapter degrades', () => {
  it('without Agent Teams nothing is installed and nothing throws', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx, { defaultOn: false })
    expect(() => { installWorkerTeams(ctx, a => scheduler.isWorker(a)) }).not.toThrow()
    expect(tools(ctx, lead)).not.toContain('spawn_teammate')
  })
})
