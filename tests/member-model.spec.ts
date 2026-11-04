/** Per-member model: a fork or worker's own model, set from its chat composer via the main Session. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, install } from './support/scheduler.js'
import { MEMBER_MODEL_RECORD, parseMemberModel, runMemberModelCommand } from '../src/member-model.js'
import { rosterSchema, rosterView, rosterViewSchema } from '../src/projection.js'
import { memberModelCommand, memberModelLabel, memberOf } from '../src/client/index.js'

afterEach(teardown)

/** What the plugin validates with: the runtime's own call-config resolution. */
const validate = (ctx: { llm: { resolveCallConfig: (c: never) => Promise<{ provider: string; model: string; reasoningEffort?: unknown }> } }) => async (s: { provider: string; model: string; reasoningEffort?: string }) => {
  const r = await ctx.llm.resolveCallConfig(s as never)
  return { provider: r.provider, model: r.model, ...(r.reasoningEffort === undefined ? {} : { reasoningEffort: String(r.reasoningEffort) }) }
}
const isWorker = (name: string) => (o: { messages: unknown }) => body(o as never).includes(`You are worker \\"${name}\\"`)

describe('member model', () => {
  it('parses the command', () => {
    expect(parseMemberModel('hub mock-b/other high')).toEqual({ member: 'hub', selection: { provider: 'mock-b', model: 'other', reasoningEffort: 'high' } })
    expect(parseMemberModel(' fork-2 a/b/c ')).toEqual({ member: 'fork-2', selection: { provider: 'a', model: 'b/c' } })
    expect(parseMemberModel('hub default')).toEqual({ member: 'hub', selection: null })
    for (const bad of ['', 'hub', 'hub nope', 'hub /x', 'hub x/', 'hub default x', 'hub a/b c d']) expect(parseMemberModel(bad)).toBeUndefined()
  })

  it('switches one worker\'s later requests, leaves the lead and other workers alone, and goes back on default', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'hub', role: 'owns hub' })
    await scheduler.createWorker(lead, { name: 'docs', role: 'owns docs' })
    await vi.waitFor(() => { expect(adapter.requests.filter(r => isWorker('hub')(r) || isWorker('docs')(r))).toHaveLength(2) })
    const run = (rawInput: string) => runMemberModelCommand(scheduler, ctx.agents as never, { agent: lead, rawInput, attachments: [] } as never, validate(ctx))
    expect(await run('nobody mock-b/x')).toMatchObject({ kind: 'error' })
    expect(await run('hub mock-b/hub-model')).toMatchObject({ kind: 'success' })
    const state = scheduler.ledgerOf(lead).state
    expect(state.members.find(m => m.name === 'hub')!.pickedModel).toEqual({ provider: 'mock-b', model: 'hub-model' })
    expect(state.members.find(m => m.name === 'docs')!.pickedModel).toBeUndefined()
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(rosterViewSchema.parse(rosterView(state)).members.find(m => m.name === 'hub')!.pickedModel).toEqual({ provider: 'mock-b', model: 'hub-model' })

    await scheduler.send(lead, 'hub', 'next job')
    await scheduler.send(lead, 'docs', 'next job')
    await vi.waitFor(() => { expect(adapter.requests.filter(r => isWorker('hub')(r))).toHaveLength(2); expect(adapter.requests.filter(r => isWorker('docs')(r))).toHaveLength(2) })
    expect(adapter.requests.filter(isWorker('hub')).map(r => r.model)).toEqual(['lead-model', 'hub-model'])
    expect(adapter.requests.filter(isWorker('docs')).map(r => r.model)).toEqual(['lead-model', 'lead-model'])

    expect(await run('hub default')).toMatchObject({ kind: 'success' })
    expect(scheduler.ledgerOf(lead).find('hub')!.pickedModel).toBeUndefined()
    await scheduler.send(lead, 'hub', 'third job')
    await vi.waitFor(() => { expect(adapter.requests.filter(isWorker('hub'))).toHaveLength(3) })
    expect(adapter.requests.filter(isWorker('hub')).at(-1)!.model).toBe('lead-model')
    expect(lead.session.snapshotEvents().filter(e => JSON.stringify(e).includes(MEMBER_MODEL_RECORD))).toHaveLength(2)
    // The lead itself never changed model.
    expect(adapter.requests.filter(r => r.sessionId === 'lead').every(r => r.model === 'lead-model')).toBe(true)
  })

  it('a recreated member reads its own choice back from its log', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'hub', role: 'owns hub' })
    await vi.waitFor(() => { expect(adapter.requests.filter(isWorker('hub'))).toHaveLength(1) })
    const hubId = SessionId(scheduler.ledgerOf(lead).find('hub')!.id)
    // An idle worker is released; the choice is recorded while it is not live.
    await vi.waitFor(() => { expect(ctx.agents.get(hubId)).toBeUndefined() })
    expect(await runMemberModelCommand(scheduler, ctx.agents as never, { agent: lead, rawInput: 'hub mock-b/kept', attachments: [] } as never, validate(ctx))).toMatchObject({ kind: 'success' })
    // A fresh scheduler (as after a host restart) folds it back from the main log.
    scheduler.forget('lead')
    expect(scheduler.ledgerOf(lead).find('hub')!.pickedModel).toEqual({ provider: 'mock-b', model: 'kept' })
    await scheduler.send(lead, 'hub', 'after restart')
    await vi.waitFor(() => { expect(adapter.requests.filter(isWorker('hub'))).toHaveLength(2) })
    expect(adapter.requests.filter(isWorker('hub')).at(-1)!.model).toBe('kept')
  })

  it('a running member switches at its next model call, inside the same round', async () => {
    const hold = gate()
    let first = true
    const { ctx, lead, adapter } = await setup(async o => {
      if (isWorker('hub')(o) && first) { first = false; await hold.promise; return toolCallResponse('t1', 'agent_list', {}) }
      return textResponse('done')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'hub', role: 'owns hub', task: 'long job' })
    const hubId = SessionId(scheduler.ledgerOf(lead).find('hub')!.id)
    await vi.waitFor(() => { expect(ctx.agents.get(hubId)?.status).toBe('running') })
    expect(await runMemberModelCommand(scheduler, ctx.agents as never, { agent: lead, rawInput: 'hub mock-b/live high', attachments: [] } as never, validate(ctx))).toMatchObject({ kind: 'error' })
    expect(await runMemberModelCommand(scheduler, ctx.agents as never, { agent: lead, rawInput: 'hub mock-b/live', attachments: [] } as never, validate(ctx))).toMatchObject({ kind: 'success' })
    hold.open()
    await vi.waitFor(() => { expect(adapter.requests.filter(isWorker('hub'))).toHaveLength(2) })
    const [step1, step2] = adapter.requests.filter(isWorker('hub'))
    expect(step1!.model).toBe('lead-model')
    // The same round, its next model call: the switch does not wait for the round to end.
    expect(step2!.model).toBe('live')
  })

  it('client: command line, label, and member lookup', () => {
    expect(memberModelCommand('hub', null)).toBe('/agent-model hub default')
    expect(memberModelCommand('hub', { provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe('/agent-model hub p/m high')
    const groups = [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'Model M', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }]
    expect(memberModelLabel(groups, null)).toBe('默认模型')
    expect(memberModelLabel(groups, { provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe('Model M · High')
    expect(memberModelLabel(groups, { provider: 'gone', model: 'x' })).toBe('x')
    const roster = { role: null, members: [{ id: 's1', name: 'hub', kind: 'worker' as const, state: 'started', text: '' }, { id: 's2', name: 'old', kind: 'fork' as const, state: 'archived', text: '' }], openRequests: [] }
    expect(memberOf(roster, 's1')?.name).toBe('hub')
    expect(memberOf(roster, 's2')).toBeUndefined()
    expect(memberOf(undefined, 's1')).toBeUndefined()
  })
})
