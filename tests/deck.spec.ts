/** The focus deck: card derivation from real records, pin persistence, and the panel gate. */
import { afterEach, describe, expect, it } from 'vitest'
import { cardOf, deckOf, readPins, togglePin, writePins, type DeckSession, type DeckStatus } from '../src/client/deck-model.js'
import { rowStateOf } from '../src/client/row-state.js'
import { applyRoster, EMPTY_ROSTER, rosterView, type RosterView } from '../src/projection.js'
import { AGENT_RECORD, MAIL_RECORD } from '../src/records.js'
import { DECK_PANEL_ID, registerDeck } from '../src/client/deck.js'
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

describe('registration and config', () => {
  const fakeCtx = (deckEnabled: () => boolean, registrations: Array<{ name: string; spec: Record<string, unknown> }>, disposed: string[]) => {
    let listener: (() => void) | undefined
    return {
      get(name: string) {
        if (name === 'configForms') {
          return { get: () => ({ getSnapshot: () => ({ status: 'ready', value: { deck: { enabled: deckEnabled() } } }), subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined } } }) }
        }
        return undefined
      },
      slots: {
        inject(name: string, cb: () => unknown) {
          const spec = cb() as { name: string }
          registrations.push({ name, spec: spec as unknown as Record<string, unknown> })
          return () => { disposed.push(name) }
        },
        register(spec: Record<string, unknown>) { return spec },
      },
      refresh() { listener?.() },
    }
  }

  it('registers the sidebar entry and the keyed main panel while enabled', () => {
    let enabled = true
    const registered: Array<{ name: string; spec: Record<string, unknown> }> = []
    const disposed: string[] = []
    const ctx = fakeCtx(() => enabled, registered, disposed)
    registerDeck(ctx, () => undefined)
    expect(registered.map(r => r.name)).toEqual(['sidebar.panellist', 'main'])
    expect(registered[0]!.spec).toMatchObject({ id: DECK_PANEL_ID, order: 5 })
    expect(typeof (registered[0]!.spec as { label: () => string }).label()).toBe('string')
    expect(registered[1]!.spec).toMatchObject({ key: DECK_PANEL_ID })
    enabled = false
    ctx.refresh()
    expect(disposed).toEqual(['sidebar.panellist', 'main'])
    enabled = true
    ctx.refresh()
    expect(registered).toHaveLength(4)
  })

  it('registers when the settings service is absent (deck is on by default)', () => {
    const registered: Array<{ name: string; spec: Record<string, unknown> }> = []
    const ctx = { get: () => undefined, slots: { inject(name: string, cb: () => unknown) { registered.push({ name, spec: cb() as Record<string, unknown> }); return () => undefined }, register(spec: Record<string, unknown>) { return spec } } }
    registerDeck(ctx, () => undefined)
    expect(registered.map(r => r.name)).toEqual(['sidebar.panellist', 'main'])
  })

  it('the host config defaults deck.enabled to true and the form writes the same path', async () => {
    const parsed = (Config as unknown as (value: object) => { deck: { get: () => { enabled: boolean } } })({})
    expect(parsed.deck.get().enabled).toBe(true)
    const source = (await import('node:fs')).readFileSync(new URL('../src/client/recovery-config.tsx', import.meta.url), 'utf8')
    expect(source).toContain('data-scheduler-deck-config')
    expect(source).toContain("write('deck.enabled'")
  })

  it('without a config forms service the deck stays on and says so once', async () => {
    const { configSource } = await import('../src/dsh/client/ui.js')
    const { resetWarnings, setWarnSink } = await import('../src/dsh/compat.js')
    resetWarnings()
    const warned: string[] = []
    const restore = setWarnSink(m => { warned.push(m) })
    try {
      expect(configSource({ get: () => undefined }, 'dsh-agent-scheduler')).toBeUndefined()
      expect(configSource({ get: () => undefined }, 'dsh-agent-scheduler')).toBeUndefined()
      expect(warned.filter(m => /config forms/u.test(m))).toHaveLength(1)
    } finally { restore() }
  })
})
