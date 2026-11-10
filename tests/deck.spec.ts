/** The focus deck: card derivation, pin persistence, and the sidebar panel registration gate. */
import { afterEach, describe, expect, it } from 'vitest'
import { cardOf, deckOf, readPins, togglePin, writePins, type DeckSession } from '../src/client/deck-model.js'
import { DECK_PANEL_ID, registerDeck } from '../src/client/deck.js'
import { setLanguage } from '../src/i18n/index.js'
import { Config } from '../src/index.js'

afterEach(() => { setLanguage('zh') })

const session = (id: string, over: Partial<DeckSession> = {}): DeckSession => ({ id, displayTitle: id, updatedAt: 1_000, ...over })
const withRoster = (id: string, roster: unknown, over: Partial<DeckSession> = {}) => session(id, { projectionValues: { agentScheduler: roster }, ...over })

describe('deck cards', () => {
  it('summarizes the lead, its running workers, the inbox and approvals', () => {
    const roster = {
      members: [{ kind: 'worker', state: 'running' }, { kind: 'worker', state: 'running' }, { kind: 'worker', state: 'idle' }, { kind: 'fork', state: 'done' }],
      inbox: [{ id: 'm-1' }, { id: 'm-2' }],
      openRequests: [],
    }
    const card = cardOf(withRoster('s-1', roster), { running: true }, true)
    expect(card).toMatchObject({ id: 's-1', lead: 'running', runningWorkers: 2, inbox: 2, approvals: 0, pinned: true })
    // A pending interaction marks the lead waiting (and as an approval), even while it runs.
    const waiting = cardOf(withRoster('s-2', roster), { running: true, pendingInteraction: { kind: 'approval' } }, false)
    expect(waiting).toMatchObject({ lead: 'waiting', approvals: 1 })
    // Nothing on the roster, no status: idle.
    expect(cardOf(session('s-3'), undefined, false)).toMatchObject({ lead: 'idle', runningWorkers: 0, inbox: 0, approvals: 0, attention: false })
  })

  it('lists pinned Sessions in pin order, then unpinned ones that need attention', () => {
    const rows = [
      withRoster('a', { members: [{ kind: 'worker', state: 'running' }], inbox: [] }, { updatedAt: 5_000 }),
      withRoster('b', { members: [], inbox: [{ id: 'm' }] }, { updatedAt: 9_000 }),
      session('c', { updatedAt: 7_000 }),
      session('sub', { parentId: 'a', updatedAt: 99_000 }),
    ]
    const deck = deckOf(rows, new Map([['b', { pendingInteraction: { kind: 'approval' } }]]), ['b', 'c', 'missing'])
    expect(deck.pinned.map(c => c.id)).toEqual(['b', 'c'])
    // `a` runs a worker; `b`/`c` are pinned so not repeated; a subagent child is never a card.
    expect(deck.attention.map(c => c.id)).toEqual(['a'])
    // An unpinned idle Session is not in the attention list.
    expect(deckOf([session('quiet')], new Map(), []).attention).toEqual([])
  })

  it('keeps pins in the browser profile and toggles them in order', () => {
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v) } }
    expect(readPins(storage)).toEqual([])
    const pinned = togglePin(togglePin([], 'a'), 'b')
    writePins(storage, pinned)
    expect(readPins(storage)).toEqual(['a', 'b'])
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b'])
    // Corrupt storage is empty, never a crash.
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
    // The toggle withdraws both, and turning it back on registers them again.
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
})
