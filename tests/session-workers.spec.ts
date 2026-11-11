/**
 * Scheduler v2 end to end on the test composition: workers are top-level Sessions in the router's
 * workspace, reached through the persistent queue (design §2–§5, §7).
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, install, uninstall, until, user } from './support/scheduler.js'
import { testController } from './support/session-controller.js'
import { MemoryQueueStore, MessageQueue } from '../src/queue.js'
import { appendRecord, queueHost, routerOf, isMainSession } from '../src/dsh/host/index.js'
import { runAgentsCommand } from '../src/rule-plugin.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema } from '../src/projection.js'

afterEach(teardown)

const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)

/** A router (`lead`, created in a workspace directory) with the v2 scheduler mounted. */
async function v2(respond: (o: GenerateOptions) => string | Promise<string> | ReturnType<typeof toolCallResponse>, opts: { failFork?: boolean; store?: MemoryQueueStore } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'router-ws-'))
  const { ctx, adapter } = await setup(async o => {
    const r = await respond(o)
    return typeof r === 'string' ? textResponse(r) : r
  })
  // The router: a top-level Session created in the workspace.
  const lead = (await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('router'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'lead-model' } } as never)).agent
  const controller = testController(ctx, { workspace, ...(opts.failFork === undefined ? {} : { failFork: opts.failFork }) })
  const store = opts.store ?? new MemoryQueueStore()
  const queue = new MessageQueue(store, queueHost(ctx, controller.port, async id => stored(ctx, SessionId(id))))
  const scheduler = install(ctx, { defaultOn: false, sessionWorkers: controller.port, queue })
  return { ctx, lead, adapter, workspace, controller, queue, store, scheduler }
}

const routerSays = async (ctx: Context, id: string, text: string) => {
  const agent = ctx.agents.get(SessionId(id))!
  agent.followup(user(text))
  await vi.waitFor(() => { expect(agent.status).toBe('running') }).catch(() => undefined)
  await agent.whenIdle()
}

describe('session workers (v2)', () => {
  it('agent_create makes a top-level Session in the router\'s workspace; a router task comes back as the answer', async () => {
    const { ctx, lead, workspace, controller, scheduler } = await v2(o => isWorker('hub')(o) ? 'HUB DID IT' : 'LEAD')
    const wt = join(workspace, 'worktrees', 'hub__x')
    mkdirSync(wt, { recursive: true })
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'develops hub', cwd: wt, task: 'do the thing' })
    const worker = ctx.agents.get(SessionId(made.id))!
    // Top-level, created in the workspace (its write root), owned by the router.
    expect(worker.session.header.parentSession).toBeUndefined()
    expect(worker.session.header.cwd).toBe(workspace)
    expect(routerOf(worker)).toBe('router')
    expect(isMainSession(worker)).toBe(false)
    expect(controller.titles.get(made.id)).toBe('hub · develops hub')
    const member = scheduler.ledgerOf(lead).members.get(made.id)!
    expect(member).toMatchObject({ kind: 'worker', session: true, worktrees: [wt], state: 'started' })
    // The answer reaches the router's inbox as [reply to r-1 from hub].
    await until(lead, '[reply to r-1 from hub]')
    expect(scheduler.ledgerOf(lead).state.requests.find(r => r.id === 'r-1')).toMatchObject({ state: 'answered', answer: 'HUB DID IT' })
  })

  it('a session made for a worker whose name was taken meanwhile is archived, not left blank in the sidebar', async () => {
    const { lead, scheduler, controller } = await v2(() => 'OK')
    // Two creations race for one name: both pass the first check; the second loses after its session exists.
    const port = controller.port
    const create = port.create.bind(port)
    let raced = false
    port.create = async spec => {
      const made = await create(spec)
      // Meanwhile (another surface, a restart's refold) the name becomes taken in the router's log.
      if (!raced) { raced = true; appendRecord(lead.session, 'plugin:dsh-agent-scheduler/agent' as never, { version: 1, action: 'created', id: 'session-other', name: 'twin', role: 'first', by: lead.id, at: new Date().toISOString() } as never); scheduler.forget('router') }
      return made
    }
    await expect(scheduler.createWorker(lead, { name: 'twin', role: 'second' })).rejects.toThrow(/twin/u)
    expect(controller.archived).toHaveLength(1)
    expect(scheduler.ledgerOf(lead).state.members.filter(m => m.name === 'twin').map(m => m.id)).toEqual(['session-other'])
  })

  it('refuses a worktree outside the router\'s workspace, with the reason', async () => {
    const { lead, scheduler } = await v2(() => 'X')
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    await expect(scheduler.createWorker(lead, { name: 'out', role: 'r', cwd: elsewhere })).rejects.toThrow(/outside this router's workspace.*could not write there/su)
  })

  it('the user chatting with the worker directly pushes nothing; report shares it', async () => {
    let shared = false
    const { ctx, lead, scheduler, adapter } = await v2(o => {
      if (!isWorker('hub')(o) && o.sessionId !== 'router') {
        // The worker session (its first message carries "You are worker" only in the intro).
      }
      if (o.sessionId === 'router') return 'LEAD'
      if (body(o).includes('PLEASE SHARE') && !shared) { shared = true; return toolCallResponse('c1', 'report', { summary: 'we decided X (details in my session around the last turn)' }) }
      return 'WORKER CHAT'
    })
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(made.id))?.status).toBe('idle') })
    // The intro (no task) was a queued message too; it answers nobody. Let it settle first.
    await new Promise(resolve => setTimeout(resolve, 100))
    const routerCalls = () => adapter.requests.filter(r => r.sessionId === 'router').length
    const before = routerCalls()
    await routerSays(ctx, made.id, 'just chatting with you')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(routerCalls()).toBe(before)
    expect(lead.session.snapshotEvents().some(e => JSON.stringify(e.data).includes('WORKER CHAT'))).toBe(false)
    await routerSays(ctx, made.id, 'PLEASE SHARE this with the router')
    await until(lead, '[report from hub, not a request]')
    expect(lead.session.snapshotEvents().some(e => JSON.stringify(e.data).includes('we decided X'))).toBe(true)
  })

  it('requests to one worker queue up in order, each a turn of its own; a second producer interleaves in arrival order', async () => {
    const hold = gate()
    const seen: string[] = []
    const { ctx, lead, scheduler, queue } = await v2(async o => {
      if (o.sessionId === 'router') return 'LEAD'
      const last = body(o)
      const m = /\[request (r-\d+)[^\]]*\]|FEISHU-\d/gu
      const ids = [...last.matchAll(m)].map(x => x[0])
      const newest = ids.at(-1) ?? ''
      seen.push(newest)
      if (newest.includes('r-1')) await hold.promise
      return `done ${newest}`
    })
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r', task: 'first' })
    await vi.waitFor(() => { expect(seen.some(s => s.includes('r-1'))).toBe(true) })
    await scheduler.send(lead, 'hub', 'second')
    await queue.enqueue({ target: made.id, producer: { kind: 'feishu', id: 'chat:1' }, dedupeKey: 'msg-1', text: 'FEISHU-1 from a chat' })
    await scheduler.send(lead, 'hub', 'third')
    expect(queue.messagesTo(made.id).map(m => m.request ?? m.producer.kind)).toEqual(['r-1', 'r-2', 'feishu', 'r-3'])
    hold.open()
    await until(lead, '[reply to r-3 from hub]')
    const order = seen.filter(s => s !== '')
    expect(order.map(s => s.replace(/\[request (r-\d+).*/u, '$1'))).toEqual(['r-1', 'r-2', 'FEISHU-1', 'r-3'])
    void ctx
  })

  it('a restart in the middle of a delivery recovers: the worker gets it once, the router gets the answer', async () => {
    const store = new MemoryQueueStore()
    const { ctx, lead, scheduler, controller } = await v2(o => o.sessionId === 'router' ? 'LEAD' : 'ANSWER AFTER RESTART', { store })
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(made.id))?.status).toBe('idle') })
    // A message written to the queue whose delivery never happened (the process died right after).
    const queued = await store.putMessage({ qid: 'q-crash', target: made.id, seq: 99, producer: { kind: 'router', id: 'router', session: 'router' }, dedupeKey: 'r-9', text: '[request r-9 from lead]\nafter the crash', mode: 'turn', state: 'queued', attempts: 1, createdAt: new Date().toISOString(), inboxMessageId: 'lost-id', request: 'r-9' })
    void queued
    appendRecord(lead.session, 'plugin:dsh-agent-scheduler/request', { version: 1, action: 'sent', id: 'r-9', from: 'router', to: made.id, text: 'after the crash', qid: 'q-crash' })
    scheduler.forget('router')
    uninstall(scheduler)
    await controller.release(made.id)
    // The restarted queue: same store, a fresh process.
    const queue2 = new MessageQueue(store, queueHost(ctx, controller.port, async id => stored(ctx, SessionId(id))))
    const scheduler2 = install(ctx, { defaultOn: false, sessionWorkers: controller.port, queue: queue2 }, { tools: false })
    void scheduler2
    await queue2.recover()
    await until(lead, '[reply to r-9 from hub]')
    const log = await stored(ctx, SessionId(made.id))
    expect(log.events.filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('after the crash'))).toHaveLength(1)
  })

  it('a worker resident while its router is not: its reply waits, and the router\'s roster is not replaced by an empty fold', async () => {
    const store = new MemoryQueueStore()
    const hold = gate()
    const { ctx, lead, scheduler, controller } = await v2(async o => { if (o.sessionId === 'router') return 'LEAD'; if (body(o).includes('SLOW')) await hold.promise; return 'LATE ANSWER' }, { store })
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r', task: 'SLOW one' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(made.id))?.status).toBe('running') })
    // The router goes away (released), the worker keeps running and finishes.
    const routerHandle = ctx.agents.get(SessionId('router'))!
    await routerHandle.whenIdle()
    await (routerHandle as unknown as { ctx: { fiber: { dispose(): Promise<void> } } }).ctx?.fiber?.dispose?.().catch(() => undefined)
    scheduler.forget('router')
    hold.open()
    await vi.waitFor(() => { expect(store.messages().find(m => m.request === 'r-1')?.state).toBe('answered') })
    // Nothing folded for the absent router stands in for its roster.
    expect((scheduler as unknown as { ledgers: Map<string, unknown> }).ledgers.has('router')).toBe(false)
    expect(store.messages().find(m => m.request === 'r-1')?.replied).toBeUndefined()
    void controller
  })

  it('a v1 subagent worker finishes what it has, refuses new work, and converts on the user\'s command', async () => {
    const { ctx, lead, scheduler, controller } = await v2(o => o.sessionId === 'router' ? 'LEAD' : 'OLD WORKER ANSWER')
    // An old (v1) worker: a subagent child of the router, made before the upgrade.
    const plain = install(ctx, { defaultOn: false }, { tools: false })
    await plain.createWorker(lead, { name: 'old', role: 'legacy', task: 'warm up' })
    await until(lead, '[reply to r-1 from old]')
    plain.forget('router')
    scheduler.forget('router')
    await expect(scheduler.send(lead, 'old', 'new work')).rejects.toThrow(/old \(subagent\) kind.*\/agents convert old/su)
    const out = await runAgentsCommand(scheduler, { agent: lead, rawInput: 'convert old' } as never)
    expect(out).toMatchObject({ kind: 'success' })
    const ledger = scheduler.ledgerOf(lead)
    const now = ledger.find('old')!
    expect(now).toMatchObject({ session: true, state: 'started' })
    expect(ledger.state.members.find(m => m.convertedTo === now.id)).toMatchObject({ state: 'archived', name: 'old-v1' })
    // The converted worker carries the old conversation (fork), and is a top-level Session.
    const converted = ctx.agents.get(SessionId(now.id))!
    expect(converted.session.header.parentSession).toBeUndefined()
    expect(JSON.stringify(converted.session.snapshotEvents())).toContain('OLD WORKER ANSWER')
    expect(controller.created).toContain(now.id)
    await scheduler.send(lead, 'old', 'now it works')
    await until(lead, '[reply to r-2 from old]')
  })

  it('upgrade with an old worker still mid-request: it answers into the inbox under v2, its answer is not lost, and convert waits', async () => {
    const hold = gate()
    const { ctx, lead, scheduler } = await v2(async o => {
      if (o.sessionId === 'router') return 'LEAD'
      if (body(o).includes('slow legacy job')) { await hold.promise; return 'LEGACY ANSWER' }
      return 'OK'
    })
    // v1: an old worker gets a request it is still working on when the plugin upgrades.
    const plain = install(ctx, { defaultOn: false }, { tools: false })
    await plain.createWorker(lead, { name: 'old', role: 'legacy', task: 'slow legacy job' })
    plain.forget('router')
    scheduler.forget('router')
    // Under v2: the open request is still open, convert refuses while it is owed, and new work is refused.
    expect(scheduler.ledgerOf(lead).openTo(scheduler.ledgerOf(lead).find('old')!.id).map(r => r.id)).toEqual(['r-1'])
    expect(await runAgentsCommand(scheduler, { agent: lead, rawInput: 'convert old' } as never)).toMatchObject({ kind: 'error', text: expect.stringMatching(/still working/u) })
    await expect(scheduler.send(lead, 'old', 'more')).rejects.toThrow(/old \(subagent\) kind/u)
    // It finishes: the answer reaches the lead once, and the request is closed.
    hold.open()
    await until(lead, '[reply to r-1 from old]')
    await lead.whenIdle()
    expect(JSON.stringify(lead.session.snapshotEvents()).split('LEGACY ANSWER').length - 1).toBeGreaterThanOrEqual(1)
    expect(scheduler.ledgerOf(lead).openTo(scheduler.ledgerOf(lead).find('old')!.id)).toEqual([])
    // Then convert works and the old one is archived, not half-alive.
    expect(await runAgentsCommand(scheduler, { agent: lead, rawInput: 'convert old' } as never)).toMatchObject({ kind: 'success' })
    const ledger = scheduler.ledgerOf(lead)
    const old = ledger.state.members.find(m => m.name === 'old-v1')!
    expect(old).toMatchObject({ state: 'archived' })
    void ctx
  })

  it('agent_split and agent_merge are gone as tools; their old records still fold', async () => {
    const { ctx, lead } = await v2(() => 'X')
    expect(ctx.tools.get('agent_split', lead)).toBeUndefined()
    expect(ctx.tools.get('agent_merge', lead)).toBeUndefined()
    expect(ctx.tools.get('agent_create', lead)).toBeDefined()
  })
})

describe('queue service for source plugins', () => {
  it('a second producer enqueues through the published service and hears its own replies', async () => {
    const { provideQueue, QUEUE_SERVICE } = await import('../src/dsh/host/index.js')
    const { ctx, lead, scheduler, queue } = await v2(o => o.sessionId === 'router' ? 'LEAD' : 'ANSWERED FOR FEISHU')
    const off = provideQueue(ctx, queue)
    const service = (globalThis as Record<symbol, any>)[QUEUE_SERVICE]
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r' })
    const replies: Array<{ state: string; text?: string }> = []
    service.onReply('feishu', (r: { state: string; text?: string }) => { replies.push(r) })
    await expect(service.enqueue({ target: made.id, producer: { kind: 'router', id: 'x' }, dedupeKey: 'k', text: 't' })).rejects.toThrow(/scheduler's own/)
    const first = await service.enqueue({ target: made.id, producer: { kind: 'feishu', id: 'chat:1' }, dedupeKey: 'm-1', text: 'from feishu' })
    expect((await service.enqueue({ target: made.id, producer: { kind: 'feishu', id: 'chat:1' }, dedupeKey: 'm-1', text: 'again' })).duplicate).toBe(true)
    await vi.waitFor(() => { expect(replies).toEqual([expect.objectContaining({ state: 'answered', text: 'ANSWERED FOR FEISHU' })]) })
    expect(service.status(first.qid)).toBe('answered')
    off()
    expect((globalThis as Record<symbol, unknown>)[QUEUE_SERVICE]).toBeUndefined()
  })
})

describe('projection v12 → v13', () => {
  it('a v12 log (subagent workers, a split, a merge) folds unchanged, and v13 fields round-trip', () => {
    const at = (seq: number, type: string, data: object) => ({ seq, type, ignorable: true, time: 1000 + seq, data: { version: 1, ...data } }) as never
    const v12 = [
      at(1, 'plugin:dsh-agent-scheduler/agent', { action: 'created', id: 'A', name: 'hub', role: 'hub', cwd: '/w/hub', by: 'router' }),
      at(2, 'plugin:dsh-agent-scheduler/agent', { action: 'renamed', id: 'A', name: 'hub-asr', previousName: 'hub', role: 'asr', area: 'hub' }),
      at(3, 'plugin:dsh-agent-scheduler/agent', { action: 'created', id: 'B', name: 'hub-image', role: 'image', cwd: '/w/img', from: 'A', area: 'hub', by: 'router' }),
      at(4, 'plugin:dsh-agent-scheduler/request', { action: 'sent', id: 'r-1', from: 'router', to: 'B', text: 't', messageId: 'm1' }),
      at(5, 'plugin:dsh-agent-scheduler/request', { action: 'answered', id: 'r-1', answer: 'ok', deliveredTo: 'router' }),
      at(6, 'plugin:dsh-agent-scheduler/merge', { action: 'requested', id: 'mg-1', absorbed: 'B', survivor: 'A', request: '' }),
      at(7, 'plugin:dsh-agent-scheduler/merge', { action: 'settled', id: 'mg-1' }),
      at(8, 'plugin:dsh-agent-scheduler/merge', { action: 'merged', id: 'mg-1', name: 'hub' }),
    ]
    const state = v12.reduce(applyRoster, EMPTY_ROSTER)
    expect(state.members.find(m => m.id === 'A')).toMatchObject({ name: 'hub', kind: 'worker' })
    expect(state.members.find(m => m.id === 'A')?.session).toBeUndefined()
    expect(state.members.find(m => m.id === 'B')).toMatchObject({ state: 'archived', mergedInto: 'A' })
    const v13 = [...v12,
      at(9, 'plugin:dsh-agent-scheduler/agent', { action: 'created', id: 'C', name: 'docs', role: 'docs', session: true, worktrees: ['/w/docs'], cwd: '/w/docs', by: 'router' }),
      at(10, 'plugin:dsh-agent-scheduler/request', { action: 'sent', id: 'r-2', from: 'router', to: 'C', text: 't', qid: 'q-1' }),
      at(11, 'plugin:dsh-agent-scheduler/agent', { action: 'archived', id: 'A', name: 'hub', convertedTo: 'C' }),
    ].reduce(applyRoster, EMPTY_ROSTER)
    const back = rosterSchema.parse(JSON.parse(JSON.stringify(v13)))
    expect(back.members.find(m => m.id === 'C')).toMatchObject({ session: true, worktrees: ['/w/docs'] })
    expect(back.members.find(m => m.id === 'A')).toMatchObject({ convertedTo: 'C', state: 'archived' })
    expect(back.requests.find(r => r.id === 'r-2')?.qid).toBe('q-1')
  })
})

void createUserMessage
void (null as unknown as Agent)
