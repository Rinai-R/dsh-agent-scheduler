/** Phase 2 Q3: the session dock and the inbox card that replaced the Agents page and the deck. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { composerBounds, dockLine, dockModel, rowOpenLine, dockStore, dockSummary, inboxCardModel, inboxLine, type DockRoster } from '../src/client/dock.js'
import { applyRoster, EMPTY_ROSTER, rosterView } from '../src/projection.js'
import { runAgentsCommand, runScheduleCommand } from '../src/rule-plugin.js'
import { MemoryQueueStore, MessageQueue } from '../src/queue.js'
import { queueHost } from '../src/dsh/host/index.js'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, until } from './support/scheduler.js'
import { testController } from './support/session-controller.js'
import { ownFile } from './contract/probe.js'

afterEach(teardown)

const worker = (id: string, name: string, more: Record<string, unknown> = {}) => ({ id, name, kind: 'worker' as const, state: 'started', text: 'role', role: 'role', session: true as const, ...more })
const roster = (more: Partial<DockRoster> = {}): DockRoster => ({ enabled: false, members: [], openRequests: [], ...more })

describe('dock model', () => {
  it('shows only with workers, a parent, or waiting replies', () => {
    expect(dockModel(undefined, undefined, undefined, 'me').visible).toBe(false)
    expect(dockModel(roster(), undefined, undefined, 'me').visible).toBe(false)
    // Forks and archived workers alone do not count.
    expect(dockModel(roster({ members: [{ id: 'f', name: 'fork-1', kind: 'fork', state: 'done', text: 'x' }, worker('a', 'gone', { state: 'archived' })] }), undefined, undefined, 'me').visible).toBe(false)
    expect(dockModel(roster({ members: [worker('w', 'hub')] }), undefined, undefined, 'me').visible).toBe(true)
    expect(dockModel(roster({ owner: { router: 'R', name: 'me-name' } }), undefined, undefined, 'me').visible).toBe(true)
    expect(dockModel(roster({ inbox: [{ id: 'm-1', from: 'w', kind: 'reply', text: 'x', at: 1 }] }), undefined, undefined, 'me').visible).toBe(true)
  })

  it('rows carry the dot, the current request, unread and queued counts, and whether they are session workers', () => {
    const r = roster({
      enabled: true,
      members: [worker('w1', 'hub', { reportedAt: 5 }), worker('w2', 'docs', { session: undefined }), worker('w3', 'idle-one')],
      openRequests: [
        { id: 'r-1', from: 'me', to: 'w1', text: '[request r-1 from lead]\n## Goal\nFix the crash\n\n## User\'s words\n> x' },
        { id: 'r-2', from: 'me', to: 'w1', text: 'second' },
        { id: 'r-3', from: 'me', to: 'w1', text: 'third' },
      ],
    })
    const statuses = new Map([['w1', { running: true }], ['w2', { pendingInteraction: true }]])
    const m = dockModel(r, statuses as never, undefined, 'me')
    expect(m.on).toBe(true)
    expect(m.workers).toEqual([
      { id: 'w1', name: 'hub', dot: 'running', request: 'Fix the crash', unread: 1, queued: 2, session: true },
      { id: 'w2', name: 'docs', dot: 'waiting', unread: 0, queued: 0, session: false },
      { id: 'w3', name: 'idle-one', dot: 'idle', unread: 0, queued: 0, session: true },
    ])
    expect(dockSummary(m)).toBe('3 个 worker · 1 个运行中 · 1 个等你 · 1 条未读')
  })

  it('a session another one created shows ← parent and its siblings, itself marked', () => {
    const mine = roster({ owner: { router: 'R', name: 'hub' } })
    const parent = roster({ members: [worker('me', 'hub'), worker('s2', 'docs'), worker('s3', 'old', { state: 'archived' })] })
    const m = dockModel(mine, undefined, parent, 'me')
    expect(m.parent?.id).toBe('R')
    expect(m.siblings).toEqual([{ id: 'me', name: 'hub', dot: 'idle', me: true }, { id: 's2', name: 'docs', dot: 'idle', me: false }])
    // The parent's roster not loaded yet: the parent link still shows, without siblings.
    expect(dockModel(mine, undefined, undefined, 'me')).toMatchObject({ parent: { id: 'R' }, siblings: [] })
  })

  it('the owner record folds into the roster view (the dock reads it from the projection)', () => {
    const owner = { seq: 1, type: 'plugin:dsh-agent-scheduler/owner', ignorable: true, time: 1, data: { version: 1, router: 'R', name: 'hub', role: 'r' } }
    const view = rosterView(applyRoster(EMPTY_ROSTER, owner as never))
    expect(view.owner).toEqual({ router: 'R', name: 'hub', role: 'r' })
  })

  it('opening a row with an unread reply marks it read; a worker with no workers of its own names its parent in the summary', () => {
    expect(rowOpenLine({ id: 'w1', unread: 1 })).toBe('/agents seen w1')
    expect(rowOpenLine({ id: 'w1', unread: 0 })).toBeUndefined()
    const m = dockModel(roster({ owner: { router: 'R', name: 'hub' } }), undefined, undefined, 'me')
    expect(dockSummary(m)).toBe('由上级会话创建')
  })

  it('the collapsed state is remembered across pages, and listeners hear the change', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
    const a = dockStore(storage)
    expect(a.collapsed()).toBe(false)
    const heard = vi.fn()
    a.subscribe(heard)
    a.set(true)
    expect(heard).toHaveBeenCalledOnce()
    expect(dockStore(storage).collapsed()).toBe(true)
    // No storage (private mode): kept for the page only.
    const b = dockStore()
    b.set(true)
    expect(b.collapsed()).toBe(true)
  })
})

describe('dock width', () => {
  it('lines up with the composer card when that is narrower than the seat, else fills the seat', () => {
    expect(composerBounds({ left: 280, width: 1920 }, { left: 900, width: 680 })).toEqual({ marginLeft: 620, width: 680 })
    expect(composerBounds({ left: 280, width: 587 }, { left: 280, width: 587 })).toBeUndefined()
    expect(composerBounds({ left: 280, width: 587 }, undefined)).toBeUndefined()
  })
})

describe('inbox card', () => {
  it('shows while replies wait or reports are unread, and hides once neither is left', () => {
    expect(inboxCardModel(roster())).toEqual({ waiting: [], unread: [] })
    const r = roster({
      members: [worker('w1', 'hub', { reportedAt: 9 }), worker('w2', 'docs')],
      inbox: [{ id: 'm-3', from: 'w2', kind: 'reply', request: 'r-4', text: '[reply to r-4 from docs]\nAll done here.', at: 1 }],
    })
    const card = inboxCardModel(r)
    expect(card.waiting).toEqual([{ id: 'm-3', worker: 'docs', request: 'r-4', preview: expect.stringContaining('All done here.') }])
    expect(card.unread).toEqual([{ id: 'w1', worker: 'hub' }])
    expect(inboxCardModel(roster({ members: [worker('w1', 'hub', { reportedAt: 9, seenAt: 10 })] }))).toEqual({ waiting: [], unread: [] })
  })

  it('its actions are /agents inbox and /agents seen', () => {
    expect(dockLine.deliverNow('m-3')).toBe(inboxLine('now', 'm-3'))
    expect(dockLine.seen('w1')).toBe('/agents seen w1')
  })
})

describe('everything moved off the Agents page stays reachable', () => {
  async function session() {
    const workspace = mkdtempSync(join(tmpdir(), 'dock-ws-'))
    const { ctx } = await setup(async () => textResponse('WORKER OK'))
    const lead = (await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('router'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'm' } } as never)).agent
    const controller = testController(ctx, { workspace })
    const queue = new MessageQueue(new MemoryQueueStore(), queueHost(ctx, controller.port, async id => stored(ctx, SessionId(id))))
    const scheduler = install(ctx, { defaultOn: false, sessionWorkers: controller.port, queue })
    const run = (line: string) => line.startsWith('/schedule')
      ? runScheduleCommand(scheduler, { agent: lead, rawInput: line.slice('/schedule'.length).trim() } as never)
      : runAgentsCommand(scheduler, { agent: lead, rawInput: line.slice('/agents'.length).trim() } as never)
    return { ctx, lead, scheduler, run }
  }

  it('the dock\'s lines all run: toggle, new worker, quick message, rename, seen all, archive', async () => {
    const { ctx, lead, scheduler, run } = await session()
    expect((await run(dockLine.toggle(true))).kind).toBe('success')
    expect(scheduler.isOn(lead)).toBe(true)
    expect((await run(dockLine.toggle(false))).kind).toBe('success')
    expect(scheduler.isOn(lead)).toBe(false)
    expect((await run(dockLine.create('hub', 'develops   the hub'))).kind).toBe('success')
    const hub = scheduler.ledgerOf(lead).find('hub')!
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(hub.id))?.status).toBe('idle') })
    const sent = await run(dockLine.send('hub', 'please   check the logs'))
    expect(sent).toMatchObject({ kind: 'success', text: expect.stringMatching(/r-\d+/u) })
    await until(lead, '[reply to r-1 from hub]')
    expect(body as unknown).toBeDefined()
    expect((await run(dockLine.rename('hub', 'hub-core'))).kind).toBe('success')
    expect(scheduler.ledgerOf(lead).find('hub-core')?.id).toBe(hub.id)
    // Fork from the dock: the same path as /agents fork, a session copy of hub.
    expect(dockLine.fork('hub-core', 'hub-two')).toBe('/agents fork hub-core hub-two')
    expect((await run(dockLine.fork('hub-core', 'hub-two'))).kind).toBe('success')
    expect(scheduler.ledgerOf(lead).find('hub-two')).toMatchObject({ session: true, from: hub.id })
    expect((await run(dockLine.seenAll())).kind).toBe('success')
    expect((await run(dockLine.archive('hub-core'))).kind).toBe('success')
    expect(scheduler.ledgerOf(lead).members.get(hub.id)?.state).toBe('archived')
  })

  it('/agents send refuses an empty message with its usage', async () => {
    const { run } = await session()
    expect(await run('/agents send hub')).toMatchObject({ kind: 'error' })
  })

  it('the default worker model stays on /worker model and the plugin config (the rule\'s worker setting)', () => {
    expect(ownFile('src/rule-plugin.ts')).toMatch(/worker: z\.string\(\)|worker:/u)
    expect(ownFile('src/rule-plugin.ts')).toContain("'worker'")
  })
})

describe('deck and Agents page removal', () => {
  it('no deck, no Agents page tab, no brand-row or left-sidebar slot', () => {
    const client = ownFile('src/client/index.tsx') + ownFile('src/client/dock.tsx') + ownFile('src/dsh/client/ui.ts')
    expect(client).not.toMatch(/sidebar\.panellist|'main'|brandName|sidebar\.brand|sidebar\.workspaces|registerDeck|createAgentsPage|sch-agents-btn/u)
    expect(client).not.toMatch(/className="[^"]*brand/u)
    for (const lang of ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) expect(ownFile(`src/i18n/${lang}.ts`)).not.toMatch(/'(cfg\.)?deck\./u)
  })

  it('an old config with deck.enabled still loads, and warns once', async () => {
    const mod = await import('../src/index.js')
    const parsed = mod.Config({ recovery: {}, deck: { enabled: false } } as never) as unknown as { deck?: unknown }
    expect(parsed.deck).toEqual({ enabled: false })
    const warnings: string[] = []
    const { setWarnSink } = await import('../src/dsh/host/index.js')
    setWarnSink(text => { warnings.push(text) })
    mod.warnDeckConfig({ enabled: false })
    mod.warnDeckConfig({ enabled: false })
    expect(warnings.filter(w => /"deck" setting/u.test(w))).toHaveLength(1)
  })
})
