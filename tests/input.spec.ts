/** P1: the input rule and forks, over a real composition. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, teardown, text } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, records, until, user } from './support/scheduler.js'
import { appendForkModel, FORK_STATE_RECORD, INPUT_RECORD, workerModelOf } from '../src/records.js'
import { admitHidden, FORK_NOTICE, HANDOFF_SOURCE, isMainSession, preStep, Scheduler } from '../src/scheduler.js'
import * as RulePlugin from '../src/rule-plugin.js'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { Config, forkModelRetired, parseForkCommand, runForkCommand, runWorkerModelCommand } from '../src/rule-plugin.js'
import { inLanguage } from './support/language.js'

inLanguage('en')

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
    await until(lead, 'Its reply to the user')
    const log = lead.session.snapshotEvents()
    // Both conclusions came while the lead was busy: they waited in its inbox and reach it together.
    const merged = log.filter(e => e.type === 'user/message' && text(e).includes('Its reply to the user'))
    expect(merged).toHaveLength(1)
    expect(text(merged[0]!)).toContain('The user said: input one')
    expect(text(merged[0]!)).toContain('The user said: input two')
    // The input is logged (the composer's receipt) but shadowed: the lead reads it only inside a
    // fork's conclusion ("The user said: …"), never as a message of its own.
    const asOwn = (t: string) => JSON.stringify([{ type: 'text', text: t }])
    for (const r of adapter.requests.filter(r => r.sessionId === 'lead')) for (const m of r.messages) expect([asOwn('input one'), asOwn('input two')]).not.toContain(JSON.stringify(m.content))
    expect(log.filter(e => e.type === 'user/message' && JSON.parse(text(e)).source?.kind === 'user').map(text).join()).toContain('input one')
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
    await until(lead, 'Its reply to the user')
    const forkReq = adapter.requests.find(r => r.sessionId !== 'lead')!
    const leadReq = adapter.requests.find(r => r.sessionId === 'lead')!
    // Same bytes in both system prompts (message ids aside), so the fork keeps the lead's cache prefix.
    expect(leadReq.messages[0]!.role).toBe('system')
    expect(JSON.stringify(leadReq.messages[0]!.content)).toBe(JSON.stringify(forkReq.messages[0]!.content))
    for (const rule of ['only a follow-up to one request already given', 'even in the same files or feature', 'also when it is running or has open requests', 'each request waits in its queue and runs as a turn of its own', 'agent_create with from: <owner>', 'one worker for the whole repository or module', 'a concrete name and role for the new task', 'its own new worktree as cwd inside this workspace', 'send it to the owner instead', 'agent_create without from']) {
      expect(JSON.stringify(leadReq.messages[0])).toContain(rule)
      expect(JSON.stringify(forkReq.messages[0])).toContain(rule)
    }
    // The removed tool is never named to the model.
    expect(JSON.stringify(leadReq.messages[0])).not.toContain('agent_split')
    // No exception lets a new task queue behind a worker's uncommitted changes.
    expect(FORK_NOTICE).not.toMatch(/agent_send it|build on the owner/u)
  })

  it('a conclusion carries its input into the lead, and a later fork inherits both', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD ACK' : 'FORK CONCLUSION'))
    install(ctx)
    lead.followup(user('why is billing slow'))
    await until(lead, 'Its reply to the user')
    const leadReq = adapter.requests.find(r => r.sessionId === 'lead')!
    expect(body(leadReq)).toContain('The user said: why is billing slow')
    expect(body(leadReq)).toContain('FORK CONCLUSION')
    lead.followup(user('second'))
    await until(lead, 'Its reply to the user', 2)
    const req = adapter.requests.find(r => r.sessionId === forksOf(lead)[1])!
    expect(body(req)).toContain('The user said: why is billing slow')
  })

  it('does not run in forks: a message to a fork stays with that fork, and the fork reports again', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('first'))
    await until(lead, 'Its reply to the user')
    const forkId = forksOf(lead)[0]! as SessionId
    await ctx.subagents.sendMessage(lead, forkId, [{ type: 'text', text: 'follow up for the fork' }], { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forkId && body(r).includes('follow up for the fork'))).toBe(true) }, { timeout: 10_000 })
    await until(lead, 'Its reply to the user', 2)
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
    await until(h1.agent, 'Its reply to the user')
    const forkId = forksOf(h1.agent)[0]! as SessionId
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await ctx.subagents.sendMessage(h2.agent, forkId, [{ type: 'text', text: 'again' }], { signal: new AbortController().signal })
    await until(h2.agent, 'Its reply to the user', 2)
    expect(body(adapter.requests.filter(r => r.sessionId === 'main').at(-1)!).match(/The user said: before restart/gu)?.length).toBe(2)
  })
})

describe('lead wakes', () => {
  it('a first input on a fresh lead costs the lead no model call; context arrives with the first report', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('first ever'))
    await until(lead, 'Its reply to the user')
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
    // Scheduling off: a first step that claimed nothing is still not run on context alone.
    const off = new Scheduler({ subagents: {} as never, agents: { get: () => undefined }, readLog: async () => ({ events: [], inherited: 0 }), defaultOn: false })
    expect(await preStep(off, { agent: lead, messages: [], step: 1 }, pass)).toEqual({ kind: 'reject' })
    // But a step with the user's own words runs, on or off.
    const words = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect((await preStep(off, { agent: lead, messages: [words] as never[], step: 1 }, async () => ({ kind: 'enter' as const, messages: [words, context] as never[] }))).kind).toBe('enter')
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
  it('a fork always runs on the lead model: a config or an older /fork model record has no effect', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('X'))
    // A retired config key and a record written by an earlier version: both ignored.
    install(ctx, { configuredModel: { provider: 'mock-b', model: 'configured' } } as never)
    appendForkModel(lead.session, { provider: 'mock-b', model: 'override', reasoningEffort: 'high' })
    lead.followup(user('a'))
    await until(lead, 'Its reply to the user')
    const fork = adapter.requests.find(r => r.sessionId === forksOf(lead)[0])!
    expect(fork.model).toBe('lead-model')
    expect(fork.reasoningEffort).toBeUndefined()
  })

  it('a fork keeps the lead model, system, and message prefix', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('X'))
    install(ctx)
    lead.followup(user('a'))
    await until(lead, 'Its reply to the user')
    lead.followup(user('b'))
    await until(lead, 'Its reply to the user', 2)
    const firstLead = adapter.requests.filter(r => r.sessionId === 'lead')[0]!
    const fork = adapter.requests.find(r => r.sessionId === forksOf(lead)[1])!
    expect(fork.model).toBe('lead-model')
    expect(JSON.stringify(fork.messages.slice(0, firstLead.messages.length))).toBe(JSON.stringify(firstLead.messages))
  })

  it('accepts an empty config, because a throw here takes the whole preset out of the menu', () => {
    expect(Config({})).toEqual({})
    // The retired fork key still loads, so an existing config does not break the preset.
    expect(Config({ fork: { provider: 'a', model: 'b' } })).toMatchObject({ fork: { provider: 'a', model: 'b' } })
    expect(Config({ worker: { provider: 'a', model: 'b' }, workerPreset: 'scheduler' })).toMatchObject({ worker: { provider: 'a', model: 'b' }, workerPreset: 'scheduler' })
    expect(() => Config({ worker: { provider: 'a' } } as never)).toThrow()
  })

  it('/fork explains that forks use the lead model and records nothing', async () => {
    expect(parseForkCommand('model glm/opus high')).toEqual({ provider: 'glm', model: 'opus', reasoningEffort: 'high' })
    expect(parseForkCommand(' model a/b/c ')).toEqual({ provider: 'a', model: 'b/c' })
    expect(parseForkCommand('model default')).toBeNull()
    for (const bad of ['', 'model', 'model nope', 'model /x', 'model x/', 'other a/b', 'model default x', 'model a/b c d']) expect(parseForkCommand(bad)).toBeUndefined()
    const { lead } = await setup(() => textResponse('X'))
    const run = (rawInput: string) => runForkCommand({ agent: lead, rawInput, attachments: [] } as never)
    const before = lead.session.snapshotEvents().length
    expect(run('')).toEqual({ kind: 'success', text: forkModelRetired() })
    expect(run('model default')).toEqual({ kind: 'success', text: forkModelRetired() })
    expect(run('model a/b high')).toEqual({ kind: 'error', text: forkModelRetired() })
    expect(lead.session.snapshotEvents().length).toBe(before)
  })
})

describe('rule plugin', () => {
  it('registers every command with metadata the command runtime accepts', async () => {
    // A rejected definition (such as an empty input hint) makes the whole preset invalid, so
    // no session using it can be created. Mount the real rule plugin on the real runtime.
    const { ctx } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    const names: string[] = []
    const real = ctx.commands.register.bind(ctx.commands)
    // Through the runtime's own register, which validates (and throws on a bad definition).
    ;(ctx.commands as { register: typeof real }).register = ((definition: Parameters<typeof real>[0]) => { names.push(definition.name); return real(definition) }) as typeof real
    const errors: unknown[] = []
    ctx.on('internal/error' as never, ((error: unknown) => { errors.push(error) }) as never)
    await ctx.plugin(RulePlugin as never, {} as never)
    expect(errors).toEqual([])
    expect(names).toEqual(expect.arrayContaining(['schedule', 'agents', 'fork', 'worker', 'role', 'agent-model', 'agent-access']))
    // The exact failure seen in the GUI: an empty hint is refused by the runtime.
    expect(() => real({ definitionId: 'x/y' as never, name: 'zz', description: 'd', input: { hint: '' }, handler: () => ({ kind: 'success', text: '' }) } as never)).toThrow(/hint must not be empty/u)
  })
})

describe('worker default model', () => {
  const validator = (ctx: Parameters<typeof install>[0]) => async (s: { provider: string; model: string; reasoningEffort?: string }) => {
    const r = await ctx.llm.resolveCallConfig({ provider: s.provider, model: s.model, ...(s.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(s.reasoningEffort) }) })
    return { provider: r.provider, model: r.model, ...(s.reasoningEffort === undefined || r.reasoningEffort === undefined ? {} : { reasoningEffort: String(r.reasoningEffort) }) }
  }
  const isW = (name: string) => (r: Parameters<typeof body>[0]) => body(r).includes(`You are worker \\"${name}\\"`)

  it('/worker checks the route and the level, and the level reaches the model call', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('X'))
    const scheduler = install(ctx)
    const run = (rawInput: string) => runWorkerModelCommand({ agent: lead, rawInput, attachments: [] } as never, validator(ctx))
    expect(await run('')).toMatchObject({ kind: 'success', text: 'Workers use the default model.' })
    // A level the model does not offer, or one for a model with none, is refused before anything is recorded.
    expect(await run('model mock-b/reasoner max')).toMatchObject({ kind: 'error' })
    expect(await run('model mock-b/plain high')).toMatchObject({ kind: 'error' })
    expect(await run('bad')).toMatchObject({ kind: 'error' })
    expect(workerModelOf(lead.session.snapshotEvents())).toBeNull()
    // No level given stays "the model's default", not the default materialized.
    expect(await run('model mock-b/reasoner')).toMatchObject({ kind: 'success', text: 'Later workers use mock-b/reasoner.' })
    expect(workerModelOf(lead.session.snapshotEvents())).toEqual({ provider: 'mock-b', model: 'reasoner' })
    expect(await run('model mock-b/reasoner high')).toMatchObject({ kind: 'success', text: 'Later workers use mock-b/reasoner (high).' })
    expect(await run('')).toMatchObject({ text: 'Workers use mock-b/reasoner (high).' })
    await scheduler.createWorker(lead, { name: 'w', role: 'r' })
    await vi.waitFor(() => { expect(adapter.requests.some(isW('w'))).toBe(true) })
    const worker = adapter.requests.find(isW('w'))!
    expect([worker.model, worker.reasoningEffort]).toEqual(['reasoner', 'high'])
    expect(await run('model default')).toMatchObject({ text: 'Later workers use the default model.' })
    expect(workerModelOf(lead.session.snapshotEvents())).toBeNull()
  })

  it('the lead\'s explicit model wins, then /worker model, then the plugin config, then the runtime default', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx, { configuredWorkerModel: { provider: 'mock-b', model: 'configured' } })
    const run = (rawInput: string) => runWorkerModelCommand({ agent: lead, rawInput, attachments: [] } as never)
    await scheduler.createWorker(lead, { name: 'by-config', role: 'x' })
    await run('model mock-b/picked')
    await scheduler.createWorker(lead, { name: 'by-default', role: 'x' })
    await scheduler.createWorker(lead, { name: 'by-lead', role: 'x', model: { provider: 'mock', model: 'explicit' } })
    await run('model default')
    await scheduler.createWorker(lead, { name: 'cleared', role: 'x' })
    await vi.waitFor(() => { expect(['by-config', 'by-default', 'by-lead', 'cleared'].every(n => adapter.requests.some(isW(n)))).toBe(true) })
    const model = (n: string) => adapter.requests.find(isW(n))!.model
    expect([model('by-config'), model('by-default'), model('by-lead'), model('cleared')]).toEqual(['configured', 'picked', 'explicit', 'configured'])
    // The main session itself never changes model.
    expect(adapter.requests.filter(r => r.sessionId === 'lead').every(r => r.model === 'lead-model')).toBe(true)
  })
})

describe('composer receipt', () => {
  /** What the Web composer sends: a user message whose source carries the prompt's request id. */
  const prompt = (t: string, rpcId: string) => createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user', rpcId } as never })
  /** The browser's test for "received": a logged user/message with that request id. */
  const received = (lead: Parameters<typeof until>[0], rpcId: string) =>
    lead.session.snapshotEvents().some(e => e.type === 'user/message' && (e.data.source as { rpcId?: string }).rpcId === rpcId)
  /** The browser's test for "canceled": a splice that removes it with outcome canceled before that. */
  const canceledFirst = (lead: Parameters<typeof until>[0], rpcId: string) => {
    let inserted = false
    for (const e of lead.session.snapshotEvents()) {
      if (e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => (m.source as { rpcId?: string }).rpcId === rpcId)) inserted = true
      if (!inserted) continue
      if (e.type === 'user/message' && (e.data.source as { rpcId?: string }).rpcId === rpcId) return false
      if (e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled') return true
    }
    return false
  }

  it('logs a handed-off message as received before removing it, and the lead never reads it', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    // A first exchange gives the log its system prompt; scheduling is on from the second.
    lead.followup(user('warm up'))
    await until(lead, 'Its reply to the user')
    lead.followup(prompt('SECRET WORDS for the fork', 'rpc-1'))
    await until(lead, 'Its reply to the user', 2)
    expect(received(lead, 'rpc-1')).toBe(true)
    // The removal that follows is recorded as canceled; the browser ignores it once received.
    expect(canceledFirst(lead, 'rpc-1')).toBe(false)
    expect(records(lead.session.snapshotEvents(), INPUT_RECORD).at(-1)).toMatchObject({ text: 'SECRET WORDS for the fork', logged: true })
    // The fork has it; no lead request and no derived lead history does.
    expect(adapter.requests.some(r => r.sessionId !== 'lead' && body(r).includes('SECRET WORDS'))).toBe(true)
    const own = JSON.stringify([{ type: 'text', text: 'SECRET WORDS for the fork' }])
    for (const r of adapter.requests.filter(r => r.sessionId === 'lead')) for (const m of r.messages) expect(JSON.stringify(m.content)).not.toBe(own)
    expect(lead.session.deriveMessages().map(m => JSON.stringify(m.content))).not.toContain(own)
  })

  it('while the lead is inside a step, shadows the message with an empty node of that step', async () => {
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (o.sessionId === 'lead' && body(o).includes('long job') && !body(o).includes('agent_list')) { await hold.promise; return toolCallResponse('c1', 'agent_list', {}) }
      return textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK')
    })
    lead.followup(user('long job'))
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    install(ctx)
    lead.steer(prompt('STEERED SECRET', 'rpc-2'))
    hold.open()
    await until(lead, 'Its reply to the user')
    expect(received(lead, 'rpc-2')).toBe(true)
    // The lead's later requests keep tool call and result adjacent, and never carry the input
    // as a message of its own.
    const own = JSON.stringify([{ type: 'text', text: 'STEERED SECRET' }])
    for (const r of adapter.requests.filter(r => r.sessionId === 'lead')) for (const m of r.messages) expect(JSON.stringify(m.content)).not.toBe(own)
    const replaced = lead.session.snapshotEvents().find(e => e.type === 'developer/message' && (e.data.message.source as { kind?: string }).kind === HANDOFF_SOURCE)
    expect(replaced).toBeDefined()
  })

  it('in a session without a system prompt yet, nothing is logged and the hand-off still works', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(prompt('first ever', 'rpc-3'))
    await until(lead, 'Its reply to the user')
    expect(received(lead, 'rpc-3')).toBe(false)
    expect(records(lead.session.snapshotEvents(), INPUT_RECORD)[0]).not.toHaveProperty('logged')
    expect(admitHidden(lead.session, prompt('x', 'rpc-4'), 'n')).toBe(true)
  })
})
