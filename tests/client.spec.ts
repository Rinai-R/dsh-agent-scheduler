/** Input card state machine. The rendered card is covered by the GUI run in docs/p1-report.md. */
import { describe, expect, it, vi } from 'vitest'
import { chatPlacement, createInputCard, openLabel, statusLine, requestDefinition, requestOf, workerModelCommand, workerModelLabel, workerModelValue, inputDefinition as def, retainChatTabs, rowStateOf, steadyTabStrips, subline, rowTitle, hiddenBelow, hiddenLabel } from '../src/client/index.js'
import { isStale } from '../src/client/catalog-source.js'
import { parseForkCommand } from '../src/rule-plugin.js'

// Components are called as plain functions here, outside a React render.
vi.mock('../src/client/i18n.js', async (original) => ({ ...await original<typeof import('../src/client/i18n.js')>(), useLocale: () => undefined }))

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

describe('worker default model picker', () => {
  const groups = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }] }, { id: 'glm-gateway', name: 'GLM', models: [{ id: 'claude/opus', name: 'Opus' }] }]
  it('maps menu choices to /worker commands the host parses back to the same selection', () => {
    expect(workerModelValue(null)).toBe('')
    expect(workerModelCommand(null)).toBe('/worker model default')
    expect(parseForkCommand(workerModelCommand(null).slice('/worker '.length))).toBeNull()
    const opus = { provider: 'glm-gateway', model: 'claude/opus' }
    expect(workerModelCommand(opus)).toBe('/worker model glm-gateway/claude/opus')
    expect(parseForkCommand(workerModelCommand(opus).slice('/worker '.length))).toEqual(opus)
    // The reasoning level picked in the menu goes into the command.
    const high = { ...opus, reasoningEffort: 'high' }
    expect(workerModelCommand(high)).toBe('/worker model glm-gateway/claude/opus high')
    expect(parseForkCommand(workerModelCommand(high).slice('/worker '.length))).toEqual(high)
    // Values differ by level, so the attribute the GUI test reads shows it.
    expect(workerModelValue(high)).not.toBe(workerModelValue(opus))
  })
  it('a default the catalog no longer lists is not dressed up as an entry: it is named by its id and flagged stale', () => {
    expect(workerModelLabel(groups, null)).toBe('默认')
    expect(workerModelLabel(groups, { provider: 'glm-gateway', model: 'claude/opus', reasoningEffort: 'high' })).toBe('Opus')
    expect(workerModelLabel(groups, { provider: 'gone', model: 'm' })).toBe('m')
    expect(isStale({ groups, failures: [] }, { provider: 'gone', model: 'm' })).toBe(true)
    expect(isStale({ groups, failures: [] }, { provider: 'glm-gateway', model: 'claude/opus' })).toBe(false)
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

describe('hand-off status line', () => {
  it('names the fork and where the message is, in every state', () => {
    const say = (fork: Parameters<typeof statusLine>[0]['fork'], extra: { detail?: string } = {}) => {
      const l = statusLine({ fork, name: 'fork-7', ...extra })
      return `${l.lead}${l.name}${l.tail} · ${l.open}`
    }
    expect(say('running')).toBe('已交给 fork-7 · 处理中 · 查看')
    expect(say('queued')).toBe('已交给 fork-7 · 排队等空位 · 查看')
    expect(say('done')).toBe('fork-7 已交回 · 查看')
    // Forks archive themselves right after handing back; the line keeps saying so.
    expect(say('archived')).toBe('fork-7 已交回 · 查看')
    expect(say('failed', { detail: 'at capacity' })).toBe('fork-7 启动失败：at capacity · 查看')
    // The oldest records carry no name.
    expect(statusLine({ fork: 'running' }).name).toBe('分身')
  })
  it('carries the fork name from the input record into the card state', () => {
    const logged = { type: 'plugin:dsh-agent-scheduler/input', seq: 7, time: 9, data: { forkId: 'f2', text: 't', name: 'fork-7', logged: true } }
    expect(def.start({ key: 'k', id: 'f2' }, { event: logged })).toMatchObject({ name: 'fork-7', fork: 'running', logged: true })
  })
  it('renders one clickable line that opens the fork, under the native bubble when the message is logged', () => {
    const opened: string[][] = []
    const Card = createInputCard((parent, child) => { opened.push([parent, child]) }) as unknown as { type: (props: unknown) => { props: { children: unknown[] } } }
    const tree = Card.type({ node: { data: { seq: 1, time: 1, text: 'hi', forkId: 'f2', fork: 'running', logged: true, name: 'fork-7' } }, sessionId: 'main' })
    const [bubble, button] = tree.props.children as [unknown, { props: { onClick: () => void; 'aria-label': string; 'data-state': string } }]
    expect(bubble).toBeNull()
    expect(button.props['aria-label']).toBe('已交给 fork-7 · 处理中，查看')
    expect(button.props['data-state']).toBe('running')
    button.props.onClick()
    expect(opened).toEqual([['main', 'f2']])
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

describe('sidebar tab strip', () => {
  it('is a no-op without a document', () => {
    expect(() => { steadyTabStrips(undefined)() }).not.toThrow()
  })
})

describe('roster subline', () => {
  const fork = { id: 'f', name: 'fork-1', kind: 'fork', state: 'running', text: '  补充\n架构  说明 ' } as never
  it('flattens the ask, and leads with the oldest open request', () => {
    expect(subline(fork)).toBe('补充 架构 说明')
    expect(subline(fork, [{ id: 'r-3', text: '改\n方向' }, { id: 'r-4', text: 'x' }])).toBe('r-3：改 方向')
  })
  it('a worker shows only its oldest open request or else its duty; the directory goes to the tooltip', () => {
    const worker = { id: 'w', name: 'w', kind: 'worker', state: 'running', text: 'first task', role: 'docs\nowner', cwd: '/x/dsh-agent-scheduler__roster-lead-workers/' } as never
    expect(subline(worker)).toBe('docs owner')
    expect(subline(worker, [{ id: 'r-2', text: 'fix\nit' }])).toBe('r-2：fix it')
    expect(subline(worker)).not.toContain('roster-lead-workers')
    expect(subline({ ...(worker as object), cwd: undefined, role: undefined } as never)).toBe('first task')
    expect(rowTitle(worker)).toBe('w\n目录：/x/dsh-agent-scheduler__roster-lead-workers/')
    expect(rowTitle({ ...(worker as object), cwd: undefined } as never)).toBe('w')
  })
  it('says why a member failed before anything else', () => {
    expect(subline({ ...(fork as object), state: 'failed', detail: 'quota\nexhausted' } as never, [{ id: 'r-1', text: 'x' }])).toBe('quota exhausted')
  })
})

describe('roster rows below the fold', () => {
  const rows = [
    { bottom: 50 }, { bottom: 100, review: 'reported' as const }, { bottom: 150 },
    { bottom: 200, review: 'failed' as const }, { bottom: 250, review: 'approval' as const }, { bottom: 300 },
  ]
  it('counts the rows not wholly visible, and their marks', () => {
    expect(hiddenBelow(rows, 120)).toEqual({ n: 4, unread: 1, waiting: 1, first: 2 })
    expect(hiddenLabel(hiddenBelow(rows, 120))).toBe('下面还有 4 个 · 1 个等你 · 1 个未读')
  })
  it('a row cut in half is still below; a sub-pixel overhang is not', () => {
    expect(hiddenBelow(rows, 140).first).toBe(2)
    expect(hiddenBelow(rows, 299.5).n).toBe(0)
  })
  it('says nothing once the end is in sight', () => {
    expect(hiddenBelow(rows, 300)).toEqual({ n: 0, unread: 0, waiting: 0, first: -1 })
    expect(hiddenLabel(hiddenBelow(rows, 300))).toBe('')
    expect(hiddenLabel(hiddenBelow(rows.slice(0, 3), 60))).toBe('下面还有 2 个 · 1 个未读')
    expect(hiddenLabel(hiddenBelow([{ bottom: 10 }, { bottom: 20 }], 5))).toBe('下面还有 2 个')
  })
})
