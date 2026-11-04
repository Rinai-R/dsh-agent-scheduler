/** P1: the input rule and forks, over a real composition. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, teardown, text } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, records, until, user } from './support/scheduler.js'
import { appendForkModel, FORK_STATE_RECORD, forkModelOf, INPUT_RECORD } from '../src/records.js'
import { FORK_NOTICE, isMainSession, preStep, Scheduler } from '../src/scheduler.js'
import { Config, parseForkCommand, runForkCommand } from '../src/rule-plugin.js'

afterEach(teardown)

describe('input rule', () => {
  it('forks at once while the lead runs, never shows the lead the input, and records it', async () => {
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (o.sessionId === 'lead' && body(o).includes('The lead job')) await hold.promise
      return textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK CONCLUSION')
    })
    lead.followup(user('The lead job'))
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    install(ctx)
    lead.steer(user('input one'))
    lead.followup(user('input two'))
    await vi.waitFor(() => { expect(adapter.requests.filter(r => r.sessionId !== 'lead').length).toBe(2) }, { timeout: 10_000 })
    expect(lead.status).toBe('running')
    hold.open()
    await until(lead, 'Its conclusion', 2)
    const log = lead.session.snapshotEvents()
    expect(log.filter(e => e.type === 'user/message' && JSON.parse(text(e)).source?.kind === 'user').map(text).join()).not.toContain('input one')
    expect(records(log, INPUT_RECORD).map(r => [r.text, r.name])).toEqual([['input one', 'fork-1'], ['input two', 'fork-2']])
    expect(records(log, FORK_STATE_RECORD).filter(r => r.state === 'done')).toHaveLength(2)
    // A fork that concluded archives itself: it routed its one message.
    await vi.waitFor(() => { expect(records(lead.session.snapshotEvents(), FORK_STATE_RECORD).filter(r => r.state === 'archived')).toHaveLength(2) })
    const forkReq = adapter.requests.find(r => r.sessionId !== 'lead')!
    // The fork's instructions live in the system prompt, not in the user's bubble of the fork chat.
    expect(JSON.stringify(forkReq.messages[0])).toContain(JSON.stringify(FORK_NOTICE).slice(1, -1))
    const own = forkReq.messages.filter(m => m.role === 'user' && /input (one|two)/u.test(JSON.stringify(m.content))).at(-1)!
    expect(own).toBeDefined()
    expect(JSON.stringify(own.content)).not.toContain('fork of the lead')
    // The runtime's "send your result with send_message" notice is removed from the fork's first message.
    expect(body(forkReq)).not.toContain('Your parent agent id is')
  })

  it('the routing rule is in the system prompt of both the lead and its fork, which stay identical', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('add a feature'))
    await until(lead, 'Its conclusion')
    const forkReq = adapter.requests.find(r => r.sessionId !== 'lead')!
    const leadReq = adapter.requests.find(r => r.sessionId === 'lead')!
    // Same bytes in both system prompts (message ids aside), so the fork keeps the lead's cache prefix.
    expect(leadReq.messages[0]!.role).toBe('system')
    expect(JSON.stringify(leadReq.messages[0]!.content)).toBe(JSON.stringify(forkReq.messages[0]!.content))
    for (const rule of ['goes by agent_send to the worker that did it', 'agent_create with from: <owner>', 'state \\"running\\" in agent_list', 'agent_create without from']) {
      expect(JSON.stringify(leadReq.messages[0])).toContain(rule)
      expect(JSON.stringify(forkReq.messages[0])).toContain(rule)
    }
  })

  it('a conclusion carries its input into the lead, and a later fork inherits both', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD ACK' : 'FORK CONCLUSION'))
    install(ctx)
    lead.followup(user('why is billing slow'))
    await until(lead, 'Its conclusion')
    const leadReq = adapter.requests.find(r => r.sessionId === 'lead')!
    expect(body(leadReq)).toContain('The user said: why is billing slow')
    expect(body(leadReq)).toContain('FORK CONCLUSION')
    lead.followup(user('second'))
    await until(lead, 'Its conclusion', 2)
    const req = adapter.requests.find(r => r.sessionId === forksOf(lead)[1])!
    expect(body(req)).toContain('The user said: why is billing slow')
  })

  it('does not run in forks: a message to a fork stays with that fork, and the fork reports again', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('first'))
    await until(lead, 'Its conclusion')
    const forkId = forksOf(lead)[0]! as SessionId
    await ctx.subagents.sendMessage(lead, forkId, [{ type: 'text', text: 'follow up for the fork' }], { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forkId && body(r).includes('follow up for the fork'))).toBe(true) }, { timeout: 10_000 })
    await until(lead, 'Its conclusion', 2)
    expect(forksOf(lead)).toHaveLength(1)
  })

  it('at capacity a fork waits in the queue and starts when a slot frees', async () => {
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => { if (o.sessionId !== 'lead' && body(o).includes('"one"')) await hold.promise; return textResponse('X') }, 1)
    const scheduler = install(ctx)
    lead.followup(user('one'))
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forksOf(lead)[0])).toBe(true) })
    lead.followup(user('two'))
    await vi.waitFor(() => { expect(records(lead.session.snapshotEvents(), FORK_STATE_RECORD).some(r => r.state === 'queued')).toBe(true) }, { timeout: 10_000 })
    expect(scheduler.queued()).toEqual(['fork-2'])
    hold.open()
    // A finished fork leaves residency by itself, so the slot frees without anyone archiving.
    await until(lead, 'The user said: two')
    expect(records(lead.session.snapshotEvents(), FORK_STATE_RECORD).map(r => r.state)).toContain('started')
  })

  it('a message that missed insertion is handed off in pre-step and costs no model call', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    const scheduler = new Scheduler({ subagents: ctx.subagents, agents: ctx.agents, readLog: async () => ({ events: [], inherited: 0 }), defaultOn: true })
    ctx.on('agent/pre-step', (payload, next) => preStep(scheduler, payload, next))
    lead.followup(user('late'))
    await vi.waitFor(() => { expect(forksOf(lead)).toHaveLength(1) }, { timeout: 10_000 })
    expect(adapter.requests.some(r => r.sessionId === 'lead' && body(r).includes('"late"'))).toBe(false)
    expect(isMainSession(lead)).toBe(true)
  })

  it('survives a lead restart: a later report for an earlier fork still carries its input', async () => {
    const { ctx, adapter } = await setup(o => textResponse(o.sessionId === 'main' ? 'MAIN' : 'FORK'))
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    h1.agent.followup(user('before restart'))
    await until(h1.agent, 'Its conclusion')
    const forkId = forksOf(h1.agent)[0]! as SessionId
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await ctx.subagents.sendMessage(h2.agent, forkId, [{ type: 'text', text: 'again' }], { signal: new AbortController().signal })
    await until(h2.agent, 'Its conclusion', 2)
    expect(body(adapter.requests.filter(r => r.sessionId === 'main').at(-1)!).match(/The user said: before restart/gu)?.length).toBe(2)
  })
})

describe('lead wakes', () => {
  it('a first input on a fresh lead costs the lead no model call; context arrives with the first report', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('first ever'))
    await until(lead, 'Its conclusion')
    const leadReqs = adapter.requests.filter(r => r.sessionId === 'lead')
    expect(leadReqs).toHaveLength(1)
    expect(body(leadReqs[0]!)).toContain('The user said: first ever')
    expect(body(leadReqs[0]!)).toContain('runtime-context')
  })

  it('rejects a context-only first step whichever side of the listener adds the context', async () => {
    const { lead } = await setup(() => textResponse('X'))
    const scheduler = new Scheduler({ subagents: {} as never, agents: { get: () => undefined }, readLog: async () => ({ events: [], inherited: 0 }), defaultOn: true })
    const context = createUserMessage({ content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } as never })
    let reached = 0
    const pass = async () => { reached += 1; return { kind: 'enter' as const, messages: [context] as never[] } }
    expect(await preStep(scheduler, { agent: lead, messages: [context] as never[], step: 1 }, pass)).toEqual({ kind: 'reject' })
    expect(reached).toBe(0)
    expect(await preStep(scheduler, { agent: lead, messages: [], step: 1 }, pass)).toEqual({ kind: 'reject' })
    expect((await preStep(scheduler, { agent: lead, messages: [], step: 2 }, pass)).kind).toBe('enter')
  })

  it('a withheld report mid-turn does not end the lead\'s tool loop', async () => {
    const hold = gate()
    let calls = 0
    const { ctx, lead } = await setup(async o => {
      if (o.sessionId !== 'lead') return textResponse('FORK')
      calls += 1
      if (calls === 1) { await hold.promise; return toolCallResponse('c1', 'no_such_tool', {}) }
      return textResponse('LEAD END')
    })
    lead.followup(user('lead work'))
    await vi.waitFor(() => { expect(calls).toBe(1) })
    install(ctx)
    lead.steer(user('input while busy'))
    await new Promise(r => setTimeout(r, 200))
    hold.open()
    await vi.waitFor(() => { expect(calls).toBeGreaterThanOrEqual(2) }, { timeout: 10_000 })
    await lead.whenIdle()
    expect(lead.session.snapshotEvents().some(e => text(e).includes('LEAD END'))).toBe(true)
  })

  it('ordinary agent messages reach the lead untouched', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('X'))
    install(ctx)
    lead.followup(createUserMessage({ content: [{ type: 'text', text: 'goal round' }], source: { kind: 'goal' } as never }))
    await lead.whenIdle()
    expect(adapter.requests.some(r => r.sessionId === 'lead' && body(r).includes('goal round'))).toBe(true)
    expect(forksOf(lead)).toHaveLength(0)
  })
})

describe('fork model', () => {
  it('uses the lead by default, then plugin config, then the session override', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(`M ${String(o.model)}`))
    install(ctx, { configuredModel: { provider: 'mock-b', model: 'configured' } })
    lead.followup(user('a'))
    await until(lead, 'Its conclusion')
    appendForkModel(lead.session, { provider: 'mock-b', model: 'override' })
    lead.followup(user('b'))
    await until(lead, 'Its conclusion', 2)
    appendForkModel(lead.session, null)
    lead.followup(user('c'))
    await until(lead, 'Its conclusion', 3)
    const models = forksOf(lead).map(id => adapter.requests.find(r => r.sessionId === id)!.model)
    expect(models).toEqual(['configured', 'override', 'configured'])
    expect(forkModelOf(lead.session.snapshotEvents())).toBeNull()
    expect(adapter.requests.find(r => r.sessionId === 'lead')!.model).toBe('lead-model')
  })

  it('without configuration a fork keeps the lead model, system, and message prefix', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('X'))
    install(ctx)
    lead.followup(user('a'))
    await until(lead, 'Its conclusion')
    lead.followup(user('b'))
    await until(lead, 'Its conclusion', 2)
    const firstLead = adapter.requests.filter(r => r.sessionId === 'lead')[0]!
    const fork = adapter.requests.find(r => r.sessionId === forksOf(lead)[1])!
    expect(fork.model).toBe('lead-model')
    expect(JSON.stringify(fork.messages.slice(0, firstLead.messages.length))).toBe(JSON.stringify(firstLead.messages))
  })

  it('accepts an empty config, because a throw here takes the whole preset out of the menu', () => {
    expect(Config({})).toEqual({})
    expect(Config({ fork: { provider: 'a', model: 'b' } })).toMatchObject({ fork: { provider: 'a', model: 'b' } })
    expect(Config({ worker: { provider: 'a', model: 'b' }, workerPreset: 'scheduler' })).toMatchObject({ worker: { provider: 'a', model: 'b' }, workerPreset: 'scheduler' })
    expect(() => Config({ fork: { provider: 'a' } } as never)).toThrow()
    expect(() => Config({ worker: { provider: 'a' } } as never)).toThrow()
  })

  it('parses and runs /fork', async () => {
    expect(parseForkCommand('model glm/opus high')).toEqual({ provider: 'glm', model: 'opus', reasoningEffort: 'high' })
    expect(parseForkCommand(' model a/b/c ')).toEqual({ provider: 'a', model: 'b/c' })
    expect(parseForkCommand('model default')).toBeNull()
    for (const bad of ['', 'model', 'model nope', 'model /x', 'model x/', 'other a/b', 'model default x', 'model a/b c d']) expect(parseForkCommand(bad)).toBeUndefined()
    const { lead } = await setup(() => textResponse('X'))
    const run = (rawInput: string) => runForkCommand({ agent: lead, rawInput, attachments: [] } as never)
    expect(run('')).toMatchObject({ kind: 'success', text: 'Forks use the default model.' })
    expect(run('bad')).toMatchObject({ kind: 'error' })
    expect(run('model a/b')).toMatchObject({ kind: 'success' })
    expect(run('')).toMatchObject({ text: 'Forks use a/b.' })
  })
})
