/** The focus deck: card derivation from real records, pin persistence, and the panel gate. */
import { afterEach, describe, expect, it } from 'vitest'
import { cardOf, deckOf, readPins, togglePin, writePins, type DeckSession, type DeckStatus } from '../src/client/deck-model.js'
import { rowStateOf } from '../src/client/row-state.js'
import { applyRoster, EMPTY_ROSTER, rosterView, type RosterView } from '../src/projection.js'
import { AGENT_RECORD, MAIL_RECORD } from '../src/records.js'
import { createModeStore, matching, registerDeck, shortAgo } from '../src/client/deck.js'
import { providePrimitives } from '../src/dsh/client/index.js'
import { setLanguage } from '../src/i18n/index.js'
import { Config } from '../src/index.js'

afterEach(() => { setLanguage('zh') })

// ---------------------------------------------------------------- fixtures from real records

let seq = 0
const record = (type: string, data: object) => ({ type, ignorable: true, data: { version: 1, ...data }, seq: seq++, time: 1_000 + seq })
const workerRecord = (id: string, name = id) => record(AGENT_RECORD, { action: 'created', id, name, role: 'does things' })
const mailRecord = (id = 'm-1', from = 'w1') => record(MAIL_RECORD, { action: 'queued', id, from, kind: 'report', text: 'done', request: 'r-1' })
/** Fold real plugin records the way the host projection does; no hand-written roster state. */
const fold = (...events: readonly object[]): RosterView => rosterView((events as never[]).reduce(applyRoster, EMPTY_ROSTER))
const view = (...events: readonly object[]): RosterView => fold(...events)
const session = (id: string, roster: RosterView | undefined, over: Partial<DeckSession> = {}): DeckSession =>
  ({ id, displayTitle: id, updatedAt: 1_000, ...(roster === undefined ? {} : { projectionValues: { agentScheduler: roster } }), ...over })
const status = (running: boolean, pendingInteraction?: unknown): DeckStatus => ({ running, ...(pendingInteraction === undefined ? {} : { pendingInteraction }) })
const of = (...pairs: Array<[string, DeckStatus]>) => new Map<string, DeckStatus>(pairs)

describe('deck cards', () => {
  it('counts a worker as running only through the live status, using the Agents page rule', () => {
    const roster = view(workerRecord('w1'), workerRecord('w2', 'second'))
    // Recorded lifecycle alone is `started`, never `running`: the deck must read the status map.
    expect(cardOf(session('s-1', roster), undefined, false)).toMatchObject({ runningWorkers: 0, approvals: 0 })
    const running = cardOf(session('s-1', roster), of(['w1', status(true)], ['w2', status(false)]), false)
    expect(running).toMatchObject({ runningWorkers: 1, lead: 'idle' })
    expect(running.attention).toBe(true)
    // A worker waiting on approval/question: waiting, an approval, zero running.
    const waiting = cardOf(session('s-1', roster), of(['w1', status(true, { kind: 'approval' })]), false)
    expect(waiting).toMatchObject({ runningWorkers: 0, approvals: 1 })
    expect(waiting.attention).toBe(true)
    // Terminal workers are never counted, whatever the status says.
    const archived = view(workerRecord('w1'), record(AGENT_RECORD, { action: 'archived', id: 'w1', name: 'w1' }))
    expect(cardOf(session('s-2', archived), of(['w1', status(true)]), false)).toMatchObject({ runningWorkers: 0, approvals: 0 })
  })

  it('counts approvals on the lead and on live workers', () => {
    const roster = view(workerRecord('w1'), workerRecord('w2', 'second'))
    expect(cardOf(session('s-1', roster), of(['s-1', status(true, { kind: 'permission' })]), false).approvals).toBe(1)
    expect(cardOf(session('s-1', roster), of(['s-1', status(true, { kind: 'permission' })], ['w1', status(true, { kind: 'approval' })]), false).approvals).toBe(2)
    expect(cardOf(session('s-1', roster), of(['w1', status(true, { kind: 'approval' })], ['w2', status(true, { kind: 'question' })]), false)).toMatchObject({ approvals: 2, lead: 'idle' })
  })

  it('reports the same numbers the Agents page derives', () => {
    const roster = view(workerRecord('w1'), workerRecord('w2', 'second'), mailRecord())
    const statuses = of(['w1', status(true)], ['w2', status(true, { kind: 'approval' })])
    const card = cardOf(session('s-1', roster), statuses, false)
    // The Agents page's own derivation: rowStateOf per member, mail length, pending lead.
    const states = roster.members.map(m => rowStateOf(m, statuses))
    const pageRunning = roster.members.filter((m, i) => states[i] === 'running').length
    const pageWaiting = roster.members.filter((m, i) => states[i] === 'waiting').length
    expect(card.runningWorkers).toBe(pageRunning)
    expect(card.approvals).toBe(pageWaiting) // no lead prompt in this fixture
    expect(card.inbox).toBe(roster.inbox?.length)
    expect(card.lead).toBe('idle')
  })

  it('lists pinned Sessions in pin order, then unpinned ones that need attention', () => {
    const busy = view(workerRecord('w1'))
    const rows = [
      session('a', busy, { updatedAt: 5_000 }),
      session('b', view(workerRecord('w2'), mailRecord()), { updatedAt: 9_000 }),
      session('c', undefined, { updatedAt: 7_000 }),
      session('sub', busy, { parentId: 'a', updatedAt: 99_000 }),
    ]
    const statuses = of(['w1', status(true)], ['b', status(false, { kind: 'approval' })])
    const deck = deckOf(rows, statuses, ['b', 'c', 'missing'])
    expect(deck.pinned.map(c => c.id)).toEqual(['b', 'c'])
    // `a` has a live running worker (the regression: its roster state alone is `started`).
    expect(deck.attention.map(c => c.id)).toEqual(['a'])
    expect(deck.attention[0]).toMatchObject({ runningWorkers: 1 })
    // A pinned Session is not repeated; a subagent child is never a card; idle unpinned stays out.
    expect(deckOf([session('quiet', undefined)], new Map(), []).attention).toEqual([])
  })

  it('keeps pins in the browser profile and toggles them in order', () => {
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v) } }
    expect(readPins(storage)).toEqual([])
    const pinned = togglePin(togglePin([], 'a'), 'b')
    writePins(storage, pinned)
    expect(readPins(storage)).toEqual(['a', 'b'])
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b'])
    memory.set('dsh-agent-scheduler/deck/pinned', '{"not":"an array"}')
    expect(readPins(storage)).toEqual([])
  })
})

describe('sidebar mode registration and config', () => {
  /** A slot registry fake: occupants per slot, the official brand optionally present. */
  const fakeCtx = (state: { enabled: boolean; official: boolean }) => {
    const live = new Map<string, Array<{ component: unknown; spec: Record<string, unknown> }>>()
    const watchers = new Map<string, Set<() => void>>()
    const log: string[] = []
    let configListener: (() => void) | undefined
    const notify = (name: string) => { for (const fn of watchers.get(name) ?? []) fn() }
    const add = (name: string, entry: { component: unknown; spec: Record<string, unknown> }) => {
      live.set(name, [...(live.get(name) ?? []), entry]); log.push(`+${name}`); notify(name)
      return () => { live.set(name, (live.get(name) ?? []).filter(e => e !== entry)); log.push(`-${name}`); notify(name) }
    }
    if (state.official) add('sidebar.brand.name', { component: 'OfficialBrandName', spec: {} })
    log.length = 0
    const ctx = {
      get(name: string) {
        if (name !== 'configForms') return undefined
        return { get: () => ({ getSnapshot: () => ({ status: 'ready', value: { deck: { enabled: state.enabled } } }), subscribe: (fn: () => void) => { configListener = fn; return () => { configListener = undefined } } }) }
      },
      slots: {
        inject(name: string, cb: () => { component: unknown; spec: Record<string, unknown> }) { return add(name, cb()) },
        register(spec: Record<string, unknown>, component: unknown) { return { spec, component } },
        entries(name: string) { return live.get(name) ?? [] },
        subscribe(name: string, fn: () => void) { const set = watchers.get(name) ?? new Set(); set.add(fn); watchers.set(name, set); return () => { set.delete(fn) } },
      },
    }
    return { ctx, live, log, refresh: () => { configListener?.() } }
  }
  const memoryStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
  // The primitives module is loaded through the client loader's require; give the test one.
  const withPrimitives = (fn: () => void) => {
    providePrimitives({ BrandWordmark: () => null })
    try { fn() } finally { providePrimitives(undefined) }
  }

  it('starts in 工作区: the brand toggle sits beside the official wordmark and the tree stays stock', () => withPrimitives(() => {
    const { ctx, live, log } = fakeCtx({ enabled: true, official: true })
    const modes = createModeStore(memoryStorage())
    registerDeck(ctx, () => undefined, modes)
    expect(modes.get()).toBe('workspace')
    // The brand seat gets the deck's name entry (priority -1 shadows the official one, which stays).
    expect(log).toEqual(['+sidebar.brand.name'])
    expect(live.get('sidebar.brand.name')!.map(e => e.spec.priority)).toEqual([undefined, -1])
    expect(live.get('sidebar.workspaces') ?? []).toEqual([])
  }))

  it('toggling registers the body at priority -1 in deck mode and withdraws it in 工作区 mode', () => withPrimitives(() => {
    const { ctx, live, log } = fakeCtx({ enabled: true, official: true })
    const modes = createModeStore(memoryStorage())
    registerDeck(ctx, () => undefined, modes)
    modes.toggle()
    expect(modes.get()).toBe('deck')
    expect(live.get('sidebar.workspaces')!.map(e => e.spec.priority)).toEqual([-1])
    modes.toggle()
    expect(live.get('sidebar.workspaces')).toEqual([])
    expect(log).toEqual(['+sidebar.brand.name', '+sidebar.workspaces', '-sidebar.workspaces'])
  }))

  it('leaves the brand seat empty without an official occupant, so the local-build fallback stays', () => withPrimitives(() => {
    const { ctx, live } = fakeCtx({ enabled: true, official: false })
    registerDeck(ctx, () => undefined, createModeStore(memoryStorage()))
    expect(live.get('sidebar.brand.name') ?? []).toEqual([])
    // The body's own header toggle still switches modes there.
  }))

  it('config off: nothing is registered, not even the brand seat, and on restores both', () => withPrimitives(() => {
    const state = { enabled: true, official: true }
    const { ctx, live, refresh } = fakeCtx(state)
    const modes = createModeStore(memoryStorage())
    registerDeck(ctx, () => undefined, modes)
    modes.set('deck')
    state.enabled = false
    refresh()
    expect(live.get('sidebar.brand.name')!.map(e => e.component)).toEqual(['OfficialBrandName'])
    expect(live.get('sidebar.workspaces')).toEqual([])
    state.enabled = true
    refresh()
    expect(live.get('sidebar.brand.name')).toHaveLength(2)
    expect(live.get('sidebar.workspaces')).toHaveLength(1)
  }))

  it('the mode choice is remembered across reloads', () => {
    const storage = memoryStorage()
    const first = createModeStore(storage)
    expect(first.get()).toBe('workspace')
    first.toggle()
    expect(createModeStore(storage).get()).toBe('deck')
    first.toggle()
    expect(createModeStore(storage).get()).toBe('workspace')
  })

  it('the host config defaults deck.enabled to true and the form writes the same path', async () => {
    const parsed = (Config as unknown as (value: object) => { deck: { get: () => { enabled: boolean } } })({})
    expect(parsed.deck.get().enabled).toBe(true)
    const source = (await import('node:fs')).readFileSync(new URL('../src/client/recovery-config.tsx', import.meta.url), 'utf8')
    expect(source).toContain('data-scheduler-deck-config')
    expect(source).toContain("write('deck.enabled'")
  })
})

describe('deck rows', () => {
  it('filters by title and prints the stock compact time', () => {
    const roster = view(workerRecord('w1'))
    const cards = deckOf([session('修复关闭窗口时标签页', roster), session('调研 OMP 近期活跃会话', undefined)], undefined, ['修复关闭窗口时标签页', '调研 OMP 近期活跃会话'])
    expect(matching(cards.pinned, 'omp').map(c => c.id)).toEqual(['调研 OMP 近期活跃会话'])
    expect(matching(cards.pinned, '').length).toBe(2)
    const now = 10 * 86_400_000
    expect(shortAgo(now - 30_000, now)).toBe('刚刚')
    expect(shortAgo(now - 2 * 60_000, now)).toBe('2分钟')
    expect(shortAgo(now - 2 * 3_600_000, now)).toBe('2小时')
    expect(shortAgo(now - 86_400_000, now)).toBe('1天')
  })

  it('one dot per Session: waiting beats running beats idle; workers listed for the tree', () => {
    const roster = view(workerRecord('w1', 'scheduler-dots'), workerRecord('w2', 'scheduler-integrator'))
    const running = cardOf(session('a', roster), of(['w1', status(true)]), true)
    expect(running).toMatchObject({ state: 'running', runningWorkers: 1, approvals: 0 })
    expect(running.workers.map(w => [w.name, w.state])).toEqual([['scheduler-dots', 'running'], ['scheduler-integrator', 'idle']])
    expect(cardOf(session('a', roster), of(['w2', status(true, { kind: 'approval' })]), false)).toMatchObject({ state: 'waiting', approvals: 1 })
    expect(cardOf(session('b', undefined), undefined, true)).toMatchObject({ state: 'idle', workers: [] })
    // Archived workers are not part of the tree.
    const archived = view(workerRecord('w1'), record(AGENT_RECORD, { action: 'archived', id: 'w1', name: 'w1' }))
    expect(cardOf(session('c', archived), undefined, true).workers).toEqual([])
  })

  it('pinned Sessions come first by recency; 需要你 holds unpinned ones with workers, inbox or approvals only', () => {
    const rows = [
      session('old', undefined, { updatedAt: 1_000 }),
      session('new', undefined, { updatedAt: 9_000 }),
      session('approval', undefined, { updatedAt: 5_000 }),
      session('quiet', undefined, { updatedAt: 8_000 }),
      session('open-request-only', view(workerRecord('w9')), { updatedAt: 7_000 }),
    ]
    const deck = deckOf(rows, of(['approval', status(true, { kind: 'approval' })]), ['old', 'new'])
    expect(deck.pinned.map(c => c.id)).toEqual(['new', 'old'])
    expect(deck.attention.map(c => c.id)).toEqual(['approval'])
  })
})
