/** Input card state machine. The rendered card is covered by the GUI run in docs/p1-report.md. */
import { describe, expect, it } from 'vitest'
import { chatPlacement, openLabel, requestDefinition, requestOf, forkModelCommand, forkModelGroups, forkModelValue, inputDefinition as def, retainChatTabs, rowStateOf, SAME_AS_LEAD } from '../src/client/index.js'
import { parseForkCommand } from '../src/rule-plugin.js'

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

describe('client activation', () => {
  it('apply runs to the end with seats that build their bodies immediately', async () => {
    const { apply } = await import('../src/client/index.js')
    const registered: string[] = []
    ;(globalThis as { document?: unknown }).document ??= { createElement: () => ({ dataset: {} }), head: { appendChild: () => undefined } }
    const ctx = {
      effect: (f: () => unknown) => { f() },
      uiConversation: { events: { register: () => () => undefined } },
      sidebarRightTabs: { register: () => () => undefined },
      // The real slot runtime may call the factory at once; anything it closes over must exist.
      slots: { inject: (_name: string, f: () => unknown) => { f() }, register: (seat: { name: string }) => { registered.push(seat.name); return () => undefined } },
      remote: { commands: { execute: async () => ({ ok: true, value: { kind: 'success' } }), list: async () => ({ ok: true, value: [] }) }, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
      sessions: {}, sidebarRight: {}, uiWorkspace: {},
    }
    expect(() => { apply(ctx) }).not.toThrow()
    expect(registered).toEqual(expect.arrayContaining(['conversation.chat.node', 'sidebar.right.pane.tab', 'conversation.input.left']))
  })
})

describe('fork model picker', () => {
  const groups = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }] }, { id: 'glm-gateway', name: 'GLM', models: [{ id: 'claude/opus', name: 'Opus' }] }]
  it('maps options to /fork commands the host parses back to the same selection', () => {
    expect(forkModelValue(null)).toBe(SAME_AS_LEAD)
    expect(forkModelCommand(SAME_AS_LEAD)).toBe('/fork model default')
    expect(parseForkCommand(forkModelCommand(SAME_AS_LEAD).slice('/fork '.length))).toBeNull()
    const value = forkModelValue({ provider: 'glm-gateway', model: 'claude/opus' })
    expect(forkModelCommand(value)).toBe('/fork model glm-gateway/claude/opus')
    expect(parseForkCommand(forkModelCommand(value).slice('/fork '.length))).toEqual({ provider: 'glm-gateway', model: 'claude/opus' })
    // Re-picking the current model keeps the effort set by command; another model drops it.
    const current = { provider: 'glm-gateway', model: 'claude/opus', reasoningEffort: 'high' }
    expect(forkModelCommand(value, current)).toBe('/fork model glm-gateway/claude/opus high')
    expect(forkModelCommand(forkModelValue({ provider: 'deepseek', model: 'v4' }), current)).toBe('/fork model deepseek/v4')
  })
  it('keeps an override the catalog no longer lists visible instead of showing another value', () => {
    expect(forkModelGroups(groups, null)).toBe(groups)
    expect(forkModelGroups(groups, { provider: 'deepseek', model: 'v4' })).toBe(groups)
    const shown = forkModelGroups(groups, { provider: 'gone', model: 'm' })
    expect(shown).toHaveLength(3)
    expect(shown[2]).toMatchObject({ id: 'gone', models: [{ id: 'm' }] })
  })
})

describe('request card', () => {
  const relay = (text: string, kind = 'agent-message') => ({ type: 'user/message', seq: 201, time: 1, data: { id: 'm1', content: [{ type: 'text', text: 'Agent s sent a message: ' }, { type: 'text', text }], source: { kind } } })
  const at = (step: number) => ({ kind: 'step', step: { step } })
  it('reads a relayed request and nothing else', () => {
    expect(requestOf(relay('[request r-2 from fork-2]\nlook at gpt_image'))).toEqual({ id: 'r-2', from: 'fork-2', text: 'look at gpt_image' })
    expect(requestOf(relay('[reply to r-2 from hub]\nx'))).toBeUndefined()
    expect(requestOf(relay('[request r-2 from fork-2]\nx', 'user'))).toBeUndefined()
    expect(requestDefinition.match({ type: 'turn/start', seq: 1, time: 1, data: {} })).toBeNull()
  })
  it('shows a request steered into a running round, not one that opened its own turn', () => {
    const event = relay('[request r-2 from fork-2]\nlook at gpt_image')
    expect(requestDefinition.match(event)).toEqual({ id: 'm1', role: 'start' })
    const steered = requestDefinition.start(undefined, { event, location: at(27) })
    expect(steered).toEqual({ seq: 201, id: 'r-2', from: 'fork-2', text: 'look at gpt_image', steered: true })
    expect(requestDefinition.buildViewNode({ key: 'k', id: 'm1', state: steered })).toMatchObject({ kind: 'scheduler-request', anchorSeq: 201, visibility: 'visible' })
    // The engine rejects an undefined state; one that opened its own turn builds no node instead.
    const waking = requestDefinition.start(undefined, { event, location: at(1) })
    expect(waking).toMatchObject({ steered: false })
    expect(requestDefinition.buildViewNode({ key: 'k', id: 'm1', state: waking })).toBeNull()
    expect(requestDefinition.buildViewNode({ key: 'k', id: 'm1' })).toBeNull()
  })
  it('labels open requests on a roster row', () => {
    expect(openLabel(1, 'running')).toBe('1 个请求处理中')
    expect(openLabel(2, 'idle')).toBe('2 个请求待回答')
  })
})

describe('input card when the message is logged', () => {
  it('keeps the logged flag so the card draws only the fork status under the native bubble', () => {
    const logged = { type: 'plugin:dsh-agent-scheduler/input', seq: 7, time: 9, data: { forkId: 'f2', text: 'with image', logged: true } }
    expect(def.start({ key: 'k', id: 'f2' }, { event: logged })).toMatchObject({ logged: true, text: 'with image' })
    // Older records have no flag: the card still draws the user's words itself.
    expect(def.start({ key: 'k', id: 'f1' }, { event: input })).not.toHaveProperty('logged')
  })
})

describe('agent chat tabs', () => {
  it('keeps the native chat type mounted, follows re-registration, and undoes on dispose', () => {
    const listeners = new Set<() => void>()
    let definition: { kind: string; keepMounted?: boolean } = { kind: 'subagentchat' }
    const tabs = { get: (kind: string) => (kind === 'subagentchat' ? definition : undefined), subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } } }
    const undo = retainChatTabs(tabs)
    expect(definition.keepMounted).toBe(true)
    const first = definition
    definition = { kind: 'subagentchat' }
    for (const l of listeners) l()
    expect(definition.keepMounted).toBe(true)
    undo()
    expect(listeners.size).toBe(0)
    expect('keepMounted' in first).toBe(false)
    expect('keepMounted' in definition).toBe(false)
  })
  it('does nothing without a registry', () => {
    expect(() => { retainChatTabs(undefined)() }).not.toThrow()
  })
})
