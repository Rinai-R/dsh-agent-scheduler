/** P2 + P3: requests, attribution, routing back to the requester, worker tools, roles. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, last, leadSaw, records, until, user } from './support/scheduler.js'
import { AGENT_RECORD, REQUEST_RECORD } from '../src/records.js'

afterEach(teardown)

/** A fork is any child that is not a worker: forks carry the lead's section, workers their own. */
const isFork = (o: GenerateOptions) => o.sessionId !== 'lead' && o.sessionId !== 'main' && JSON.stringify(o.messages[0]).includes('# Agent Scheduler\\n') && !JSON.stringify(o.messages[0]).includes('Agent Scheduler: worker')
const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
/** The system message is the first message of a request. */
const systemOf = (o: GenerateOptions) => JSON.stringify(o.messages[0])
/** Its content only: message ids differ between a read and a replayed request, the text does not. */
const systemText = (o: GenerateOptions) => JSON.stringify(o.messages[0]?.content)
const called = (o: GenerateOptions, tool: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${tool}"`))

/** A fork that creates `billing` with a task and concludes at once, without waiting for it. */
function delegatingScript(worker: (o: GenerateOptions) => Promise<string> | string = () => 'BILLING ANSWER: retries lack backoff') {
  let leadCalls = 0
  const respond = async (o: GenerateOptions) => {
    if (o.sessionId === 'lead' || o.sessionId === 'main') { leadCalls += 1; return textResponse('LEAD OK') }
    if (isWorker('billing')(o)) return textResponse(await worker(o))
    if (isFork(o)) {
      if (!called(o, 'agent_create')) return toolCallResponse('c1', 'agent_create', { name: 'billing', role: 'owns billing retries', task: 'check the retry policy' })
      return textResponse('FORK CONCLUSION: asked billing to check')
    }
    return textResponse('OTHER')
  }
  return { respond, leadCalls: () => leadCalls }
}

describe('requests', () => {
  it('a fork delegates and concludes; the worker answers the lead directly; the fork is never woken again', async () => {
    const hold = gate()
    const script = delegatingScript(async () => { await hold.promise; return 'BILLING ANSWER: retries lack backoff' })
    const { ctx, lead, adapter } = await setup(script.respond)
    install(ctx)
    lead.followup(user('look at billing retries'))
    // The conclusion does not wait for the worker, and says what is still coming.
    await until(lead, 'Its conclusion')
    expect(leadSaw(lead, 'FORK CONCLUSION')).toBe(1)
    expect(leadSaw(lead, 'Delegated, answers will come to you: r-1')).toBe(1)
    expect(leadSaw(lead, 'BILLING ANSWER')).toBe(0)
    hold.open()
    await until(lead, '[reply to r-1 from billing, asked by fork-1 for')
    expect(leadSaw(lead, 'BILLING ANSWER')).toBe(1)
    const log = lead.session.snapshotEvents()
    const forkId = forksOf(lead)[0]!
    // The agent_create call and the conclusion: the answer costs the fork no third model call.
    expect(adapter.requests.filter(r => r.sessionId === forkId)).toHaveLength(2)
    expect(adapter.requests.filter(r => r.sessionId === forkId).some(r => body(r).includes('BILLING ANSWER'))).toBe(false)
    expect(records(log, REQUEST_RECORD).find(r => r.action === 'answered')).toMatchObject({ id: 'r-1', deliveredTo: 'lead' })
    expect(records(log, AGENT_RECORD)).toEqual([expect.objectContaining({ action: 'created', name: 'billing', role: 'owns billing retries' })])
    // The worker saw its role and the request, and was not told to use send_message.
    const workerReq = adapter.requests.find(isWorker('billing'))!
    expect(body(workerReq)).toContain('[request r-1 from fork-1]')
    expect(body(workerReq)).not.toContain('Your parent agent id is')
    expect(systemOf(workerReq)).toContain('Agent Scheduler: worker')
  })

  it('agent_send from the lead: the reply comes back to the lead', async () => {
    let sent = false
    const { ctx, lead } = await setup(o => {
      if (isWorker('docs')(o)) return textResponse(body(o).includes('[request r-1 from lead]') ? 'DOCS: build is green' : 'docs ready')
      if (o.sessionId === 'lead') {
        if (!sent && body(o).includes('ask docs')) { sent = true; return toolCallResponse('s1', 'agent_send', { to: 'docs', message: 'is the build green?' }) }
        return textResponse('LEAD')
      }
      return textResponse('FORK')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'docs', role: 'docs site' })
    // The worker's first, task-less round reaches nobody.
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(scheduler.ledgerOf(lead).find('docs')!.id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await lead.whenIdle()
    expect(leadSaw(lead, 'docs ready')).toBe(0)
    lead.followup({ ...user('ask docs'), source: { kind: 'goal' } as never })
    await until(lead, '[reply to r-1 from docs]')
    expect(leadSaw(lead, 'DOCS: build is green')).toBe(1)
  })

  it('an answer reaches the lead even when the fork that asked was archived', async () => {
    const hold = gate()
    const script = delegatingScript(async () => { await hold.promise; return 'LATE ANSWER' })
    const { ctx, lead } = await setup(script.respond)
    const scheduler = install(ctx)
    lead.followup(user('look at billing retries'))
    await until(lead, 'Its conclusion')
    await scheduler.archive(lead, 'fork-1')
    hold.open()
    await until(lead, '[reply to r-1 from billing, asked by fork-1')
    expect(leadSaw(lead, 'LATE ANSWER')).toBe(1)
  })

  it('a message the user sends a worker directly is not a request and reaches nobody', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(isWorker('ops')(o) ? (last(o).includes('hello ops') ? 'OPS CHAT' : 'ops ready') : 'LEAD'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'ops', role: 'deploys' })
    const id = SessionId(scheduler.ledgerOf(lead).find('ops')!.id)
    await vi.waitFor(async () => { expect((await stored(ctx, id)).events.some(e => e.type === 'turn/end')).toBe(true) })
    await ctx.subagents.sendMessage(lead, id, [{ type: 'text', text: 'hello ops' }], { signal: new AbortController().signal })
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === id && last(r).includes('hello ops'))).toBe(true) })
    await new Promise(r => setTimeout(r, 300))
    await lead.whenIdle()
    expect(adapter.requests.filter(r => r.sessionId === 'lead')).toHaveLength(0)
  })

  it('a report in a round the user started directly reaches the lead once, and wakes no fork', async () => {
    // "hello ops" is plain chat; "tell the lead" makes the worker call report once.
    const { ctx, lead, adapter } = await setup(o => {
      if (!isWorker('ops')(o)) return textResponse('LEAD')
      if (last(o).includes('tell the lead') && !called(o, 'report')) return toolCallResponse('rp1', 'report', { summary: 'OPS REPORT: deploy is green' })
      return textResponse(last(o).includes('hello ops') ? 'OPS CHAT' : 'ops closing words')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'ops', role: 'deploys' })
    const id = SessionId(scheduler.ledgerOf(lead).find('ops')!.id)
    const ends = async () => (await stored(ctx, id)).events.filter(e => e.type === 'turn/end').length
    await vi.waitFor(async () => { expect(await ends()).toBe(1) })
    await ctx.subagents.sendMessage(lead, id, [{ type: 'text', text: 'hello ops' }], { signal: new AbortController().signal })
    await vi.waitFor(async () => { expect(await ends()).toBe(2) })
    await new Promise(r => setTimeout(r, 300))
    await lead.whenIdle()
    expect(leadSaw(lead, 'OPS CHAT')).toBe(0)
    await ctx.subagents.sendMessage(lead, id, [{ type: 'text', text: 'please tell the lead' }], { signal: new AbortController().signal })
    await until(lead, '[report from ops, not a request]')
    await new Promise(r => setTimeout(r, 300))
    await lead.whenIdle()
    expect(leadSaw(lead, 'OPS REPORT: deploy is green')).toBe(1)
    expect(leadSaw(lead, 'ops closing words')).toBe(0)
    expect(leadSaw(lead, 'OPS CHAT')).toBe(0)
    // No request was recorded for it, and no fork exists to wake.
    expect(records(lead.session.snapshotEvents(), REQUEST_RECORD)).toEqual([])
    expect(forksOf(lead)).toEqual([])
    expect(adapter.requests.filter(r => r.sessionId !== 'lead' && r.sessionId !== id)).toHaveLength(0)
  })

  it('a report in a round that answers a request is that answer only, not also a separate report', async () => {
    const { ctx, lead } = await setup(o => {
      if (isWorker('ops')(o) && body(o).includes('[request r-1') && !called(o, 'report')) return toolCallResponse('rp1', 'report', { summary: 'OPS ANSWER' })
      return textResponse(isWorker('ops')(o) ? 'ops words' : 'LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'ops', role: 'deploys', task: 'status?' })
    await until(lead, '[reply to r-1 from ops')
    await new Promise(r => setTimeout(r, 300))
    await lead.whenIdle()
    expect(leadSaw(lead, 'OPS ANSWER')).toBe(1)
    expect(leadSaw(lead, '[report from ops')).toBe(0)
  })

  it('report replaces the final message as the answer', async () => {
    const script = delegatingScript()
    const { ctx, lead } = await setup(async o => {
      if (isWorker('billing')(o) && !called(o, 'report')) return toolCallResponse('r1', 'report', { summary: 'REPORTED SUMMARY' })
      if (isWorker('billing')(o)) return textResponse('chatty final words')
      return script.respond(o)
    })
    install(ctx)
    lead.followup(user('look at billing retries'))
    await until(lead, '[reply to r-1 from billing')
    const reqs = records(lead.session.snapshotEvents(), REQUEST_RECORD)
    expect(reqs.find(r => r.action === 'answered')?.answer).toBe('REPORTED SUMMARY')
    expect(leadSaw(lead, 'chatty final words')).toBe(0)
  })

  it('a request sent after the main session restarts is answered to the lead', async () => {
    const hold = gate()
    const script = delegatingScript(async () => { await hold.promise; return 'ANSWER AFTER RESTART' })
    const { ctx } = await setup(script.respond)
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    h1.agent.followup(user('look at billing retries'))
    await vi.waitFor(() => { expect(scheduler.ledgerOf(h1.agent).openFrom(forksOf(h1.agent)[0]!)).toHaveLength(1) }, { timeout: 10_000 })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(h1.agent).requests.get('r-1')?.messageId).toBeDefined() })
    await h1.dispose()
    scheduler.forget('main')
    hold.open()
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    // The worker was released with its parent; the lead re-sends the request.
    await scheduler.send(h2.agent, 'billing', 'check the retry policy (again)')
    await until(h2.agent, '[reply to r-2 from billing]')
    expect(scheduler.ledgerOf(h2.agent).requests.get('r-2')).toMatchObject({ state: 'answered', answer: 'ANSWER AFTER RESTART', deliveredTo: 'main' })
  })
})

describe('sending to a busy worker', () => {
  it('says the target is busy, steers the request into its current round, and that round answers it', async () => {
    const hold = gate()
    let firstStep = true
    const { ctx, lead } = await setup(async o => {
      if (o.sessionId === 'lead') return textResponse('LEAD OK')
      if (isWorker('hub')(o)) {
        // The worker's first round is a long tool step: a request sent meanwhile lands mid-round.
        if (firstStep) { firstStep = false; await hold.promise; return toolCallResponse('w1', 'agent_list', {}) }
        return textResponse('HUB ANSWER covering both')
      }
      return textResponse('OTHER')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'hub', role: 'owns hub', task: 'smoke test asr' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('hub')!.id))?.status).toBe('running') })
    const sent = await scheduler.send(lead, 'hub', 'then look at gpt_image')
    expect(sent).toMatchObject({ request: 'r-2', to: 'hub', queued: false, busy: true, ahead: ['r-1'] })
    expect(sent.note).toMatch(/busy with r-1.*after its current step/u)
    // A busy worker: the answer says how to run a new task beside it instead of behind it.
    expect(sent.note).toContain('agent_create with from: hub and a new worktree')
    expect(sent.note).not.toMatch(/uncommitted/u)
    // agent_list shows the backlog, so a router sees the pile before adding to it.
    const listed = await ctx.tools.get('agent_list', lead)!.execute({}, { agent: lead, signal: new AbortController().signal } as never) as { agents: Array<{ name: string; state: string; open?: number }> }
    expect(listed.agents.find(a => a.name === 'hub')).toMatchObject({ state: 'running', open: 2 })
    hold.open()
    await until(lead, '[reply to r-2 from hub]')
    const reqs = scheduler.ledgerOf(lead).requests
    // One round claimed both requests, so both get its one answer.
    expect(reqs.get('r-1')).toMatchObject({ state: 'answered', answer: 'HUB ANSWER covering both' })
    expect(reqs.get('r-2')).toMatchObject({ state: 'answered', answer: 'HUB ANSWER covering both' })
    const idle = await scheduler.send(lead, 'hub', 'one more')
    expect(idle).toMatchObject({ busy: false, queued: false, ahead: [] })
    expect(idle.note).toMatch(/idle/u)
    // Idle with nothing open: a plain send, no fork hint.
    expect(idle.note).not.toContain('agent_create')
  })
})

describe('worker tools', () => {
  it('uses the configured worker model unless the worker names one', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse('ready'))
    const scheduler = install(ctx, { configuredWorkerModel: { provider: 'mock-b', model: 'worker-default' } })
    await scheduler.createWorker(lead, { name: 'typed', role: 'x' })
    await scheduler.createWorker(lead, { name: 'named', role: 'y', model: { provider: 'mock', model: 'explicit' } })
    await vi.waitFor(() => { expect(adapter.requests.filter(r => isWorker('typed')(r) || isWorker('named')(r))).toHaveLength(2) })
    expect(adapter.requests.find(isWorker('typed'))!.model).toBe('worker-default')
    expect(adapter.requests.find(isWorker('named'))!.model).toBe('explicit')
  })

  it('recovers worker metadata from the log after the main Session restarts', async () => {
    const { ctx } = await setup(o => textResponse(o.sessionId === 'main' ? 'MAIN' : 'worker says hi'))
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    const cwd = mkdtempSync(join(tmpdir(), 'billing-'))
    await scheduler.createWorker(h1.agent, { name: 'billing', role: 'owns billing retries', cwd })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(h1.agent).find('billing')!.state).toBe('started') })
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    const recovered = scheduler.ledgerOf(h2.agent).find('billing')!
    expect(recovered).toMatchObject({ name: 'billing', kind: 'worker', role: 'owns billing retries', cwd })
    const list = await ctx.tools.get('agent_list', h2.agent)!.execute({}, { agent: h2.agent, signal: new AbortController().signal } as never) as { agents: Array<{ name: string; role?: string }> }
    expect(list.agents).toEqual([expect.objectContaining({ name: 'billing', role: 'owns billing retries' })])
  })

  it('from: a new worker continues another worker\'s conversation', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'A DONE'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'a', role: 'first' })
    const aId = SessionId(scheduler.ledgerOf(lead).find('a')!.id)
    await vi.waitFor(async () => { expect((await stored(ctx, aId)).events.some(e => e.type === 'turn/end')).toBe(true) })
    await scheduler.createWorker(lead, { name: 'b', role: 'second', from: 'a', task: 'continue' })
    await vi.waitFor(() => { expect(adapter.requests.some(isWorker('b'))).toBe(true) })
    const bReq = adapter.requests.find(isWorker('b'))!
    // Its seed is a's own session: a's first prompt and answer precede b's task.
    expect(body(bReq)).toContain('You are worker \\"a\\"')
    expect(body(bReq)).toContain('A DONE')
    const created = records(lead.session.snapshotEvents(), AGENT_RECORD).find(r => r.name === 'b')!
    expect(created.from).toBe(aId)
    await expect(scheduler.createWorker(lead, { name: 'c', role: 'x', from: 'nobody' })).rejects.toThrow(/no agent named/)
  })

  it('validates names, never reuses them, lists, and archives', async () => {
    const { ctx, lead } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx)
    await expect(scheduler.createWorker(lead, { name: 'Bad Name', role: 'x' })).rejects.toThrow(/kebab/)
    await expect(scheduler.createWorker(lead, { name: 'fork-3', role: 'x' })).rejects.toThrow(/reserved/)
    await scheduler.createWorker(lead, { name: 'infra', role: 'ci', cwd: '/tmp' })
    await expect(scheduler.createWorker(lead, { name: 'infra', role: 'x' })).rejects.toThrow(/taken/)
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(scheduler.ledgerOf(lead).find('infra')!.id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    const list = ctx.tools.get('agent_list', lead)!
    const listed = await list.execute({}, { agent: lead, signal: new AbortController().signal } as never) as { agents: Array<{ name: string; cwd?: string }> }
    expect(listed.agents).toEqual([expect.objectContaining({ name: 'infra', kind: 'worker', cwd: '/tmp' })])
    await scheduler.archive(lead, 'infra')
    expect(scheduler.ledgerOf(lead).find('infra')!.state).toBe('archived')
    await expect(scheduler.send(lead, 'infra', 'x')).rejects.toThrow(/archived/)
    await expect(scheduler.createWorker(lead, { name: 'infra', role: 'x' })).rejects.toThrow(/taken/)
  })

  it('keeps one active worker per directory, and frees it on archive', async () => {
    const { ctx, lead } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'wt-'))
    await scheduler.createWorker(lead, { name: 'push-a', role: 'x', cwd: dir })
    await expect(scheduler.createWorker(lead, { name: 'push-b', role: 'y', cwd: dir })).rejects.toThrow(/"push-a" already works in/)
    // Continuing a worker that has a directory needs a new one: not its directory, not none.
    await expect(scheduler.createWorker(lead, { name: 'push-c', role: 'z', from: 'push-a' })).rejects.toThrow(/give "push-c" its own new worktree/)
    const aId = SessionId(scheduler.ledgerOf(lead).find('push-a')!.id)
    await vi.waitFor(async () => { expect((await stored(ctx, aId)).events.some(e => e.type === 'turn/end')).toBe(true) })
    await expect(scheduler.createWorker(lead, { name: 'push-c', role: 'z', from: 'push-a', cwd: dir })).rejects.toThrow(/"push-a" already works in/)
    // Neither refusal recorded anything, so the name is still free.
    expect(scheduler.ledgerOf(lead).find('push-c')).toBeUndefined()
    const dir2 = mkdtempSync(join(tmpdir(), 'wt-'))
    await scheduler.createWorker(lead, { name: 'push-c', role: 'z', from: 'push-a', cwd: dir2 })
    expect(scheduler.ledgerOf(lead).find('push-c')).toMatchObject({ cwd: dir2 })
    await scheduler.archive(lead, 'push-a')
    await scheduler.createWorker(lead, { name: 'push-d', role: 'w', cwd: dir })
  })

  it('roles: the lead\'s role reaches the lead and forks with one identical system prompt; a worker has its own', async () => {
    const { ctx, lead, adapter } = await setup(o => textResponse(isFork(o) ? 'FORK' : 'X'))
    const scheduler = install(ctx)
    scheduler.setRole(lead, 'LEAD ROLE: map every requirement')
    lead.followup(user('a'))
    await until(lead, 'Its conclusion')
    await scheduler.createWorker(lead, { name: 'billing', role: 'BILLING ROLE' })
    await vi.waitFor(() => { expect(adapter.requests.some(isWorker('billing'))).toBe(true) })
    const leadReq = adapter.requests.find(r => r.sessionId === 'lead')!
    const forkReq = adapter.requests.find(isFork)!
    const workerReq = adapter.requests.find(isWorker('billing'))!
    expect(systemOf(leadReq)).toContain('LEAD ROLE')
    expect(systemText(forkReq)).toBe(systemText(leadReq))
    expect(systemOf(workerReq)).toContain('BILLING ROLE')
    expect(systemOf(workerReq)).not.toContain('LEAD ROLE')
  })

  it('a worker at capacity is queued and starts later; its task still gets answered', async () => {
    const hold = gate()
    const { ctx, lead } = await setup(async o => {
      if (isWorker('a')(o)) { await hold.promise; return textResponse('A DONE') }
      if (isWorker('b')(o)) return textResponse(body(o).includes('[request r-1 from lead]') ? 'B ANSWER' : 'b ready')
      return textResponse('LEAD')
    }, 1)
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'a', role: 'first' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('a')!.id))).toBeDefined() })
    await scheduler.createWorker(lead, { name: 'b', role: 'second', task: 'do b' })
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).find('b')!.state).toBe('queued') })
    // A finished child leaves residency by itself, so the slot frees without anyone archiving.
    hold.open()
    await until(lead, '[reply to r-1 from b]')
    expect(leadSaw(lead, 'B ANSWER')).toBe(1)
  })
})
