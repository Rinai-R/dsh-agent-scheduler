/** Input card state machine. The rendered card is covered by the GUI run in docs/p1-report.md. */
import { describe, expect, it } from 'vitest'
import { chatPlacement, inputDefinition as def, rowStateOf } from '../src/client/index.js'

/** A stand-in for the right column's DOM: visible docked panes, one maybe holding the roster. */
const column = (panes: Array<{ id: string; roster?: boolean }>) => ({
  querySelectorAll: () => panes.map(p => ({ dataset: { dockkitPane: p.id }, querySelector: () => (p.roster === true ? {} : null) })),
}) as never

describe('agent chat placement', () => {
  it('splits while the roster has the column to itself', () => {
    expect(chatPlacement(column([{ id: 'a', roster: true }]))).toEqual({ preferNewPane: true })
    expect(chatPlacement(column([{ id: 'a' }]), 'a')).toEqual({ preferNewPane: true })
  })
  it('once two panes exist, opens in the one that is not the roster\'s, never over the roster', () => {
    expect(chatPlacement(column([{ id: 'a', roster: true }, { id: 'b' }]))).toEqual({ paneId: 'b' })
    expect(chatPlacement(column([{ id: 'b' }, { id: 'a', roster: true }]))).toEqual({ paneId: 'b' })
    // The page's own pane id wins over the DOM guess.
    expect(chatPlacement(column([{ id: 'a' }, { id: 'b' }]), 'b')).toEqual({ paneId: 'a' })
  })
})

const input = { type: 'plugin:dsh-agent-scheduler/input', seq: 5, time: 9, data: { forkId: 'f1', text: 'hello' } }
const state = (s: string, detail?: string) => ({ type: 'plugin:dsh-agent-scheduler/fork-state', seq: 8, time: 10, data: { forkId: 'f1', state: s, ...(detail ? { detail } : {}) } })

const member = (state: string) => ({ id: 'x', name: 'x', kind: 'fork' as const, state, text: '' })
const status = (row: { running?: boolean; pendingInteraction?: unknown }) => new Map([['x', row]])

describe('roster rows', () => {
  it('refines a started member with live status and passes lifecycle states through', () => {
    expect(rowStateOf(member('started'), status({ running: true }))).toBe('running')
    expect(rowStateOf(member('started'), status({}))).toBe('idle')
    // A pending question is the only "waiting for you" signal the client has.
    expect(rowStateOf(member('started'), status({ pendingInteraction: { kind: 'question' } }))).toBe('waiting')
    expect(rowStateOf(member('started'), undefined)).toBe('idle')
    for (const state of ['done', 'failed', 'queued', 'archived']) expect(rowStateOf(member(state), status({ running: true }))).toBe(state)
  })
})

describe('input definition', () => {
  it('correlates input and fork-state by fork id and ignores other events', () => {
    expect(def.match(input)).toEqual({ id: 'f1', role: 'start' })
    expect(def.match(state('done'))).toEqual({ id: 'f1', role: 'update' })
    expect(def.match({ type: 'turn/start', seq: 1, time: 1, data: {} })).toBeNull()
  })
  it('moves from running to done or failed, anchored at the input', () => {
    const s = def.start({ key: 'k', id: 'f1' }, { event: input })
    expect(s).toMatchObject({ fork: 'running', text: 'hello', forkId: 'f1' })
    expect(def.update({ key: 'k', id: 'f1', state: s }, { event: state('done') }).fork).toBe('done')
    // A fork waiting for a slot is not "handed back"; it runs once it starts.
    const waiting = def.update({ key: 'k', id: 'f1', state: s }, { event: state('queued') })
    expect(waiting.fork).toBe('queued')
    expect(def.update({ key: 'k', id: 'f1', state: waiting }, { event: state('started') }).fork).toBe('running')
    expect(def.update({ key: 'k', id: 'f1', state: s }, { event: state('archived') }).fork).toBe('archived')
    expect(def.update({ key: 'k', id: 'f1', state: s }, { event: state('failed', 'at capacity') })).toMatchObject({ fork: 'failed', detail: 'at capacity' })
    const node = def.buildViewNode({ key: 'k', id: 'f1', state: s })
    expect(node).toMatchObject({ kind: 'scheduler-input', target: 'chat', anchorSeq: 5, visibility: 'visible' })
    expect(def.buildViewNode({ key: 'k', id: 'f1' })).toBeNull()
  })
})
