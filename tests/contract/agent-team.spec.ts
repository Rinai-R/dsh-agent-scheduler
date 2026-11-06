/**
 * Agent Teams contract (src/dsh/host/agent-team.ts), against the installed experimental packages:
 * pinned and `next` both (scripts/contract.mjs moves every dsh-* devDependency). Agent Teams is
 * experimental; a failure here means the adapter must follow it, or workers stop leading Teams
 * (the plugin then leaves Agent Teams alone, warns once, and scheduling still works).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentTeam from '@deepseek-ai/dsh-experimental-agent-team'
import * as ToolAgentTeam from '@deepseek-ai/dsh-experimental-tool-agent-team'
import { features, resetWarnings } from '../../src/dsh/compat.js'
import { installWorkerTeams, TEAM_TOOLS, teamPort } from '../../src/dsh/host/index.js'
import { setup, teardown } from '../support/harness.js'
import { textResponse } from '../support/mock-adapter.js'
import { installed } from './probe.js'

afterEach(async () => { await teardown(); features.reset(); resetWarnings() })

type Teams = { roster?: { tryMembership?: unknown }; tryMembership(a: Agent): { role: string; root: Agent } | undefined; listMembers: unknown; listTasks: unknown }

async function withTeams() {
  const s = await setup(() => textResponse('X'))
  await s.ctx.plugin(AgentTeam as never, {} as never)
  await s.ctx.plugin(ToolAgentTeam as never, {} as never)
  const teams = (s.ctx as unknown as { agentTeams: Teams }).agentTeams
  // A real continuable child of the main Session: it carries a subagent/descriptor, as every worker does.
  const { messageId } = await s.ctx.subagents.startActivation({ provider: 'spawn', delivery: 'parent', childId: 'session-child' as never, label: 'w', request: { parent: s.lead, prompt: [{ type: 'text', text: 'hi' }] }, signal: new AbortController().signal } as never) as { messageId: string }
  expect(messageId).toBeTruthy()
  const child = s.ctx.agents.get('session-child' as never) as Agent
  return { ...s, teams, child }
}

describe('Agent Teams (AT1-AT4)', () => {
  it('AT1: the service resolves membership through a private roster this adapter can wrap', async () => {
    const { teams } = await withTeams()
    expect(typeof teams.roster?.tryMembership).toBe('function')
    expect(typeof teams.listMembers).toBe('function')
    expect(typeof teams.listTasks).toBe('function')
  })

  it('AT2: a child with a subagent descriptor is no member; wrapped, a worker leads its own Team', async () => {
    const { ctx, teams, lead, child } = await withTeams()
    expect(teams.tryMembership(lead)).toMatchObject({ role: 'lead' })
    // If this starts to hold natively, Agent Teams let children lead: the wrap is no longer needed.
    expect(teams.tryMembership(child)).toBeUndefined()
    installWorkerTeams(ctx, a => a === child)
    await new Promise(resolve => setTimeout(resolve, 0))
    const m = teams.tryMembership(child)!
    expect(m).toMatchObject({ role: 'lead', name: 'lead' })
    expect(m.root).toBe(child)
    // Everyone else is resolved as before.
    expect(teams.tryMembership(lead)).toMatchObject({ role: 'lead' })
    const port = teamPort(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(port.available()).toBe(true)
    expect(port.snapshot(child)).toEqual({ members: [], tasks: [] })
    expect(features.report()['agentTeams.workerLead']).toBe(true)
  })

  it('AT3: the Team tools keep the names the team guard refers to', () => {
    const code = installed('dsh-experimental-tool-agent-team')
    for (const name of TEAM_TOOLS.all) expect(code).toContain(`name: "${name}"`)
    // Tools install per member at agent/created through the service's membership check.
    expect(code).toMatch(/ctx\.agentTeams\.tryMembership\(agent\)/u)
  })

  it('AT4: Team records are log-only events named team/* that session/event reports', () => {
    const code = installed('dsh-experimental-agent-team')
    expect(code).toContain('"team/member"')
    expect(code).toContain('"team/task"')
  })

  it('without Agent Teams the adapter does nothing and says so once', async () => {
    const s = await setup(() => textResponse('X'))
    installWorkerTeams(s.ctx, () => true)
    expect(teamPort(s.ctx).available()).toBe(false)
  })
})
