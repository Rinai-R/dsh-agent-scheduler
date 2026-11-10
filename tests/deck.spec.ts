/** The focus deck: card derivation from real records, pin persistence, and the panel gate. */
import { afterEach, describe, expect, it } from 'vitest'
import { addMembers, cardOf, deckRows, importable, MEMBERS_KEY, readMembers, removeMember, writeMembers, type DeckSession, type DeckStatus } from '../src/client/deck-model.js'
import { rowStateOf } from '../src/client/row-state.js'
import { applyRoster, EMPTY_ROSTER, rosterView, type RosterView } from '../src/projection.js'
import { AGENT_RECORD, MAIL_RECORD } from '../src/records.js'
import { createMemberStore, createModeStore, createNewSessionWatcher, matching, registerDeck, shortAgo } from '../src/client/deck.js'
import { providePrimitives } from '../src/dsh/client/index.js'
import { setLanguage } from '../src/i18n/index.js'
import { Config } from '../src/index.js'
import { readFileSync } from 'node:fs'

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

  it('keeps the membership in the browser profile: add, remove, corrupt storage', () => {
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v) } }
    expect(readMembers(storage)).toEqual([])
    writeMembers(storage, addMembers(addMembers([], ['a', 'b']), ['b', 'c']))
    expect(readMembers(storage)).toEqual(['a', 'b', 'c'])
    expect(removeMember(['a', 'b'], 'a')).toEqual(['b'])
    memory.set(MEMBERS_KEY, '{"not":"an array"}')
    expect(readMembers(storage)).toEqual([])
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

  it('membership persists across a reload and removing never touches the Session itself', () => {
    const storage = memoryStorage()
    const first = createMemberStore(storage)
    first.add(['s-1', 's-2'])
    first.remove('s-1')
    expect(createMemberStore(storage).getSnapshot()).toEqual(['s-2'])
    // The deck's remove is membership only: no shell call exists in that path.
    const source = readFileSync(new URL('../src/client/deck.tsx', import.meta.url), 'utf8')
    const removePath = source.slice(source.indexOf('data-deck-remove'), source.indexOf('data-deck-remove') + 400)
    expect(removePath).toContain('members.remove(card.id)')
    expect(source).not.toMatch(/archiveSession|deleteSession|unpinSession/u)
  })

  it('a Session created from the deck through the shell joins the deck', () => withPrimitives(() => {
    const members = createMemberStore(memoryStorage())
    let snapshot = { byId: { old: { retainedBy: { mainView: 1 } } } as Record<string, { retainedBy: { mainView?: number } }> }
    const listeners = new Set<() => void>()
    const list = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
    let started = 0
    const ctx = {
      get(name: string) {
        if (name === 'sessions') return { list }
        if (name === 'uiWorkspace') return { startSession: () => { started += 1; snapshot = { byId: { old: { retainedBy: {} }, fresh: { retainedBy: { mainView: 1 } } } }; for (const fn of listeners) fn() } }
        return undefined
      },
      slots: { inject: () => () => undefined, register: () => ({}), entries: () => [], subscribe: () => () => undefined },
    }
    const deck = registerDeck(ctx, () => undefined, createModeStore(memoryStorage()), members)
    deck.newSession()
    expect(started).toBe(1)
    expect(members.getSnapshot()).toEqual(['fresh'])
    // A later, unrelated switch of the open Session does not add anything.
    snapshot = { byId: { other: { retainedBy: { mainView: 1 } } } }
    for (const fn of listeners) fn()
    expect(members.getSnapshot()).toEqual(['fresh'])
  }))

  it('the auto-add window closes: a Session opened long after 新会话 is not imported', () => {
    const members = createMemberStore(memoryStorage())
    let snapshot = { byId: { a: { retainedBy: { mainView: 1 } } } as Record<string, { retainedBy: { mainView?: number } }> }
    let clock = 0
    const watcher = createNewSessionWatcher({ getSnapshot: () => snapshot, subscribe: () => () => undefined }, members, () => clock)
    watcher.expect()
    clock = 60_000
    snapshot = { byId: { b: { retainedBy: { mainView: 1 } } } }
    watcher.check()
    expect(members.getSnapshot()).toEqual([])
  })

  it('「加入指挥台」 in the stock session menu adds and then offers removal', () => withPrimitives(() => {
    const members = createMemberStore(memoryStorage())
    let provider: { id: string; order: number; resolve: (target: { sessionId: string }) => Array<{ id: string; label: string; run: () => void }> } | undefined
    const ctx = {
      get(name: string) {
        if (name === 'contextMenus') return { register: (p: typeof provider) => { provider = p; return () => { provider = undefined } } }
        return undefined
      },
      slots: { inject: () => () => undefined, register: () => ({}), entries: () => [], subscribe: () => () => undefined },
    }
    registerDeck(ctx, () => undefined, createModeStore(memoryStorage()), members)
    expect(provider).toMatchObject({ id: 'agent-scheduler.deck', order: 150 })
    const [add] = provider!.resolve({ sessionId: 's-9' })
    expect(add).toMatchObject({ id: 'deck-add', label: '加入指挥台' })
    add!.run()
    expect(members.getSnapshot()).toEqual(['s-9'])
    expect(provider!.resolve({ sessionId: 's-9' })[0]).toMatchObject({ id: 'deck-remove', label: '从指挥台移除' })
  }))

  it('the deck body has one switch only (beside the brand), the stock-position search, import and 新会话, and an empty state with both actions', () => {
    const source = readFileSync(new URL('../src/client/deck.tsx', import.meta.url), 'utf8')
    expect(source.match(/data-deck-toggle=/gu)).toHaveLength(1)
    expect(source).toContain('data-deck-toggle="brand"')
    for (const marker of ['data-deck-search=', 'data-deck-import=', 'data-deck-new=', 'data-deck-empty-import=', 'data-deck-empty-new=']) expect(source, marker).toContain(marker)
    // 新会话 is the shell's own action, with the stock wording.
    expect(source).toContain('startStockSession(ctx)')
    expect(source).toContain("stockText(ctx, 'actions.newSession'")
    // The two switch glyphs differ and come from the primitives.
    expect(source).toContain("'IconAppsAddOutlineRegular'")
    expect(source).toContain("'IconWorkspaceTreeOutlineRegular'")
    // The open Session gets the stock selected treatment (and theme rules keyed on it).
    expect(source).toContain("'sch-deck_sessionRow sch-deck_selected'")
    // No class name carries "brand" (themes paint `[class*='brand'] svg rect`).
    expect(source.match(/className="[^"]*brand[^"]*"/gu)).toBeNull()
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
    const cards = deckRows([session('修复关闭窗口时标签页', roster), session('调研 OMP 近期活跃会话', undefined)], undefined, ['修复关闭窗口时标签页', '调研 OMP 近期活跃会话'])
    expect(matching(cards, 'omp').map(c => c.id)).toEqual(['调研 OMP 近期活跃会话'])
    expect(matching(cards, '').length).toBe(2)
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

  it('rows are the imported Sessions, most recent first; pins draw the glyph but never decide membership', () => {
    const rows = [
      session('old', undefined, { updatedAt: 1_000 }),
      session('new', undefined, { updatedAt: 9_000 }),
      session('approval', undefined, { updatedAt: 5_000 }),
      session('pinned-not-imported', undefined, { updatedAt: 8_000 }),
      session('archived', undefined, { updatedAt: 9_500 }),
      session('worker-child', undefined, { parentId: 'new', updatedAt: 9_900 }),
    ]
    const cards = deckRows(rows, of(['approval', status(true, { kind: 'approval' })]), ['old', 'new', 'approval', 'archived', 'worker-child'], { pinned: ['old', 'pinned-not-imported'], archived: ['archived'] })
    expect(cards.map(c => c.id)).toEqual(['new', 'approval', 'old'])
    expect(cards.map(c => c.pinned)).toEqual([false, false, true])
    // Attention lives on the row itself: one waiting row with its approval tag.
    expect(cards.find(c => c.id === 'approval')).toMatchObject({ state: 'waiting', approvals: 1 })
    // A fresh draft (a new session created from the deck) sits on top until it has activity.
    const withDraft = deckRows([...rows, session('draft', undefined, { blank: true, updatedAt: 0 })], undefined, ['old', 'new', 'draft'])
    expect(withDraft.map(c => c.id)).toEqual(['draft', 'new', 'old'])
    expect(withDraft[0]).toMatchObject({ blank: true })
  })

  it('the import picker offers listable main Sessions not yet imported, never archived, children or drafts', () => {
    const rows = [
      session('a', undefined, { updatedAt: 3_000 }),
      session('b', undefined, { updatedAt: 9_000 }),
      session('in-deck', undefined, { updatedAt: 8_000 }),
      session('archived', undefined, { updatedAt: 7_000 }),
      session('fork', undefined, { parentId: 'a', updatedAt: 9_500 }),
      session('draft', undefined, { blank: true, updatedAt: 9_900 }),
    ]
    expect(importable(rows, ['in-deck'], { archived: ['archived'] }).map(s => s.id)).toEqual(['b', 'a'])
  })
})
