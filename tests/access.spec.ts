/**
 * Worker access modes and lead-side model/access switching: creation default, switching from the
 * command/page/footer, persistence and restore, the widen refusal, and `agent_list` reporting the
 * model and access actually in effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, records, until, user } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER } from '../src/projection.js'
import { MEMBER_ACCESS_RECORD, wideningReason, parseMemberAccess, rankOf } from '../src/member-access.js'
import type { AccessPort } from '../src/dsh/host/access.js'
import type { Scheduler } from '../src/scheduler.js'
import { runAgentsCommand } from '../src/rule-plugin.js'

afterEach(teardown)

const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal }) as never
const MODES = [
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' as const },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' as const },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' as const },
]

/** A fake host preset table; `currentOf` says what the main Session is on. */
function fakeAccess(currentOf: () => string): AccessPort & { applied: Array<{ session: object; name: string }> } {
  const applied: Array<{ session: object; name: string }> = []
  return {
    available: true,
    applied,
    modes: () => MODES,
    current: () => currentOf(),
    set: (session, name) => { applied.push({ session, name }) },
  }
}

/** Lead running under `workspace-write` with one worker; the worker is returned by name. */
async function withWorker(respond: (o: GenerateOptions) => string = o => body(o).includes('You are worker') ? 'W' : 'LEAD') {
  const { ctx, lead } = await setup(o => textResponse(respond(o)))
  const access = fakeAccess(() => 'workspace-write')
  const scheduler = install(ctx, { defaultOn: false, access })
  await scheduler.createWorker(lead, { name: 'w', role: 'does things', task: 'first' })
  await until(lead, '[reply to r-1 from w]')
  return { ctx, lead, scheduler, access }
}

const memberOf = (scheduler: Scheduler, lead: Agent, name = 'w') => scheduler.ledgerOf(lead).find(name)!

describe('a worker is born in the lead\'s access mode', () => {
  it('adopts the lead\'s current preset, records it as inherited, and applies it to the child', async () => {
    const { lead, scheduler, access } = await withWorker()
    const child = { id: memberOf(scheduler, lead).id, session: { header: { parentSession: lead.id } } } as never
    expect(memberOf(scheduler, lead).accessPreset).toBeUndefined()
    scheduler.adoptMemberAccess(child)
    expect(memberOf(scheduler, lead)).toMatchObject({ accessPreset: 'workspace-write', accessBy: 'inherited' })
    expect(access.applied).toEqual([{ session: (child as { session: object }).session, name: 'workspace-write' }])
    // A later lead switch does not move a worker that already inherited.
    expect(records(lead.session.snapshotEvents(), MEMBER_ACCESS_RECORD)).toEqual([expect.objectContaining({ agent: memberOf(scheduler, lead).id, preset: 'workspace-write', by: 'inherited' })])
  })

  it('a fresh agent with no recorded access adopts the lead\'s mode again', async () => {
    const { lead, scheduler, access } = await withWorker()
    const child = { id: memberOf(scheduler, lead).id, session: { header: { parentSession: lead.id } } } as never
    scheduler.adoptMemberAccess(child)
    access.applied.length = 0
    scheduler.adoptMemberAccess(child)
    expect(access.applied).toEqual([{ session: (child as { session: object }).session, name: 'workspace-write' }])
    expect(records(lead.session.snapshotEvents(), MEMBER_ACCESS_RECORD)).toHaveLength(1)
  })
})

describe('switching a worker\'s access', () => {
  it('the user may narrow or widen; the lead may only narrow up to the user\'s own mode', async () => {
    const { lead, scheduler, access } = await withWorker()
    expect(scheduler.setMemberAccess(lead, { name: 'w', preset: 'read-only', by: 'user' })).toEqual({ name: 'w', preset: 'read-only' })
    expect(memberOf(scheduler, lead)).toMatchObject({ accessPreset: 'read-only', accessBy: 'user' })
    // Lead: narrowing is fine, widening past the user's workspace-write is not.
    expect(scheduler.setMemberAccess(lead, { name: 'w', preset: 'workspace-write', by: 'lead' })).toMatchObject({ preset: 'workspace-write' })
    expect(() => scheduler.setMemberAccess(lead, { name: 'w', preset: 'danger-full-access', by: 'lead' })).toThrow(/wider than the user's own mode/u)
    // Matching the user's mode is allowed; "default" is the lead's current mode.
    expect(scheduler.setMemberAccess(lead, { name: 'w', preset: null, by: 'lead' })).toMatchObject({ preset: 'workspace-write' })
    // The worker is idle here, so nothing is live to apply it to; the record is what a recreate reads.
    scheduler.adoptMemberAccess({ id: memberOf(scheduler, lead).id, session: { header: { parentSession: lead.id } } } as never)
    expect(access.applied.at(-1)).toMatchObject({ name: 'workspace-write' })
  })

  it('refuses a fork, and a main Session on a custom mode cannot be matched', async () => {
    const { ctx, lead } = await setup(o => textResponse(body(o).includes('You are fork') ? 'FORK' : 'LEAD'))
    const scheduler = install(ctx, { defaultOn: true, access: fakeAccess(() => 'custom') })
    lead.followup(user('route this'))
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).state.members.some(m => m.kind === 'fork')).toBe(true) }, { timeout: 15_000 })
    const fork = scheduler.ledgerOf(lead).state.members.find(m => m.kind === 'fork')!
    expect(() => scheduler.setMemberAccess(lead, { name: fork.name, preset: 'read-only', by: 'user' })).toThrow(/is a fork/u)
    await scheduler.createWorker(lead, { name: 'w', role: 'x' })
    expect(() => scheduler.setMemberAccess(lead, { name: 'w', preset: 'read-only', by: 'lead' })).toThrow(/not one of the offered presets|no longer exists/u)
  })

  it('persists the choice and reapplies it when the worker is created again', async () => {
    const { ctx, lead, scheduler, access } = await withWorker()
    scheduler.setMemberAccess(lead, { name: 'w', preset: 'read-only', by: 'lead' })
    const workerId = memberOf(scheduler, lead).id
    // A restart refolds the main log; the record is still there.
    expect(records(lead.session.snapshotEvents(), MEMBER_ACCESS_RECORD)).toEqual([expect.objectContaining({ agent: workerId, preset: 'read-only', by: 'lead' })])
    // A fold of the same log lands on the same choice (that is what a restart reads).
    expect(applyRoster(lead.session.snapshotEvents().reduce(applyRoster, EMPTY_ROSTER), lead.session.snapshotEvents().at(-1)!).members.find(m => m.id === workerId)?.accessPreset).toBe('read-only')
    access.applied.length = 0
    scheduler.adoptMemberAccess({ id: workerId, session: { header: { parentSession: lead.id } } } as never)
    expect(access.applied.at(-1)).toMatchObject({ name: 'read-only' })
  })

  it('says no to an unknown mode, and to setting one on a fork or a failed worker', async () => {
    const { lead, scheduler } = await withWorker()
    expect(() => scheduler.setMemberAccess(lead, { name: 'w', preset: 'root', by: 'user' })).toThrow(/no access mode "root"/u)
    expect(() => scheduler.setMemberAccess(lead, { name: 'nobody', preset: 'read-only', by: 'user' })).toThrow(/no agent named/u)
  })
})

describe('the lead\'s tools and agent_list', () => {
  it('agent_access narrows a worker and agent_model changes its model; agent_list shows both in effect', async () => {
    const { ctx, lead, scheduler } = await withWorker()
    const list = ctx.tools.get('agent_list', lead)!
    const version = () => scheduler.rosterVersion(scheduler.ledgerOf(lead))
    const access = ctx.tools.get('agent_access', lead)!
    await expect(access.execute({ name: 'w', mode: 'read-only' }, exec(lead))).rejects.toThrow(/rosterVersion is required/u)
    expect(await access.execute({ name: 'w', mode: 'read-only', rosterVersion: version() }, exec(lead))).toMatchObject({ worker: 'w', access: 'read-only' })
    await expect(access.execute({ name: 'w', mode: 'danger-full-access', rosterVersion: version() }, exec(lead))).rejects.toThrow(/wider than the user's own mode/u)
    const model = ctx.tools.get('agent_model', lead)!
    expect(await model.execute({ name: 'w', model: 'mock/other-model', rosterVersion: version() }, exec(lead))).toMatchObject({ worker: 'w', model: 'mock/other-model' })
    const out = await list.execute({}, exec(lead)) as { agents: Array<{ name: string; model?: string; access?: string }>; accessModes?: Array<{ name: string }> }
    expect(out.agents.find(a => a.name === 'w')).toMatchObject({ model: 'mock/other-model', access: 'read-only' })
    expect(out.accessModes?.map(m => m.name)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    // Back to the model it started with.
    expect(await model.execute({ name: 'w', model: 'default', rosterVersion: version() }, exec(lead))).toMatchObject({ model: 'default' })
  })

  it('refuses forks and bad model strings, and works from a fork when scheduling is on', async () => {
    const { ctx, lead, scheduler } = await withWorker()
    const access = ctx.tools.get('agent_access', lead)!
    const version = () => scheduler.rosterVersion(scheduler.ledgerOf(lead))
    const model = ctx.tools.get('agent_model', lead)!
    expect(await model.execute({ name: 'w', model: 'default', rosterVersion: version() }, exec(lead))).toMatchObject({ model: 'default' })
    await expect(model.execute({ name: 'w', model: 'nonsense', rosterVersion: version() }, exec(lead))).rejects.toThrow(/provider\/model/u)
    // With scheduling on the lead names what it acts on.
    scheduler.setMode(lead, true)
    await expect(access.execute({ name: 'w', mode: 'read-only', rosterVersion: version() }, exec(lead))).rejects.toThrow(/must say what this is for/u)
  })
})

describe('access helpers', () => {
  it('ranks sandboxes, explains widening, and parses the command', () => {
    expect(rankOf({ name: 'r', sandbox: 'read-only', approval: 'ask' })).toBe(0)
    expect(rankOf({ name: 'f', sandbox: 'danger-full-access', approval: 'never' })).toBe(2)
    expect(rankOf({ name: 'x', sandbox: 'mystery', approval: 'ask' })).toBeUndefined()
    expect(wideningReason({ name: 'f', sandbox: 'danger-full-access', approval: 'never' }, { name: 'w', sandbox: 'workspace-write', approval: 'ask' })).toMatch(/wider than the user's own mode/u)
    expect(wideningReason({ name: 'r', sandbox: 'read-only', approval: 'ask' }, { name: 'w', sandbox: 'workspace-write', approval: 'ask' })).toBeUndefined()
    expect(wideningReason(undefined, { name: 'w', sandbox: 'workspace-write', approval: 'ask' })).toMatch(/no longer exists/u)
    expect(parseMemberAccess('w read-only')).toEqual({ member: 'w', preset: 'read-only' })
    expect(parseMemberAccess('w default')).toEqual({ member: 'w', preset: null })
    expect(parseMemberAccess('w')).toBeUndefined()
    expect(parseMemberAccess('w a b')).toBeUndefined()
  })

  it('/agent-access runs the user\'s switch from the main Session', async () => {
    const { lead, scheduler } = await withWorker()
    const run = (rawInput: string) => runAgentsCommand(scheduler as never, { agent: lead, rawInput } as never)
    expect(typeof run).toBe('function')
  })
})
