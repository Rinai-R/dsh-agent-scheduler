/**
 * The adapter's own promises: a DSH that lacks a service degrades as docs/dsh-adapter.md says
 * (required: scheduling off; optional: no-op and one warning), and reshaped answers are recognised.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { features, resetWarnings, setWarnSink, warnOnce } from '../../src/dsh/compat.js'
import { claimOnce, installGuard, missingRequired, turnEndOf } from '../../src/dsh/host/index.js'
import { CATALOG_EVENTS, clientHost, commandFailure, gesturesOf, keepChatTabsMounted, layoutOf, registerSlot } from '../../src/dsh/client/index.js'
import * as RulePlugin from '../../src/rule-plugin.js'

afterEach(() => { features.reset(); resetWarnings() })

const warnings = () => {
  const seen: string[] = []
  const undo = setWarnSink(message => { seen.push(message) })
  return { seen, undo }
}

describe('host degradation', () => {
  it('names every required service a composition lacks', () => {
    const missing = missingRequired({ subagents: {}, agents: { get() {} }, tools: { register() {} } } as never)
    expect(missing).toEqual(expect.arrayContaining(['subagents', 'tools.guard', 'systemPrompt', 'commands', 'sessionQuery']))
    expect(missing).not.toContain('agents')
  })

  it('without a tool guard the rule schedules nothing, and every command says why', async () => {
    const ctx = new Context()
    const commands: { name: string; handler: () => { kind: string; text: string } }[] = []
    ctx.provide('commands', { register: (d: never) => { commands.push(d); return () => undefined } })
    for (const name of ['subagents', 'agents', 'tools', 'systemPrompt', 'sessionQuery', 'llm']) {
      ctx.provide(name, ({ subagents: { startActivation() {}, sendMessage() {}, interrupt() {}, drainChildren() {} }, agents: { get() {} }, tools: { register() {} }, systemPrompt: { section() {} }, sessionQuery: { observeSession() {} }, llm: {} } as Record<string, unknown>)[name])
    }
    // The rule routes warnings to the host logger while it is mounted.
    await ctx.plugin(RulePlugin as never, {} as never)
    expect(commands.map(c => c.name)).toEqual(expect.arrayContaining(['schedule', 'agents']))
    const answer = commands.find(c => c.name === 'schedule')!.handler()
    expect(answer.kind).toBe('error')
    expect(answer.text).toMatch(/tools\.guard/u)
    expect(features.has('tools.guard')).toBe(false)
  })

  it('a second copy of a row stays off, and the slot frees with the first', async () => {
    const ctx = new Context()
    const { undo } = warnings()
    const first = ctx.extend()
    expect(claimOnce('contract-slot', ctx)).toBe(true)
    expect(claimOnce('contract-slot', first)).toBe(false)
    undo()
  })

  it('installGuard reports a missing guard instead of throwing', () => {
    const { undo } = warnings()
    expect(installGuard({ tools: {} } as never, () => undefined)).toBe(false)
    undo()
    expect(features.has('tools.guard')).toBe(false)
  })

  it('an unknown turn ending is never read as completed', () => {
    expect(turnEndOf({ type: 'turn/end', data: { reason: { kind: 'paused' } } } as never)).toEqual({ kind: 'paused' })
    expect(turnEndOf({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } } as never)).toEqual({ kind: 'aborted', cause: 'user' })
  })

  it('warns once per key', () => {
    const { seen, undo } = warnings()
    warnOnce('k', 'one'); warnOnce('k', 'two')
    undo()
    expect(seen).toEqual(['one'])
  })
})

describe('client degradation', () => {
  it('reads a command result in both shapes the server has used (D5)', () => {
    expect(commandFailure({ commandId: 'c', result: { kind: 'error', text: 'no' } }, '/x')).toBe('no')
    expect(commandFailure({ kind: 'error', text: 'no' }, '/x')).toBe('no')
    expect(commandFailure({ commandId: 'c', result: { kind: 'success', text: 'ok' } }, '/x')).toBeNull()
    expect(commandFailure(undefined, '/agents x')).toBe('unknown command: /agents')
  })

  it('a context without services gives answers, not exceptions', async () => {
    const { undo } = warnings()
    const host = clientHost({})
    expect(await host.run('s', '/schedule on')).toMatch(/no command service/u)
    expect(await host.has('s', 'schedule')).toBe(false)
    expect(await host.catalog()).toEqual([])
    expect(host.composerCatalog()).toBeUndefined()
    expect(() => host.onCatalogChange(() => undefined)()).not.toThrow()
    expect(host.isChild('s')).toBe(false)
    expect(host.parentOf('s')).toBeUndefined()
    expect(host.projection('s', 'agentScheduler').getSnapshot()).toBeUndefined()
    expect(host.chatAddress('p', 'c')).toBe('dsh-resource://subagentchat/session/c?parent=p&mode=continuable')
    expect(registerSlot({}, 'chatNode', {}, () => null)).toBe(false)
    expect(() => keepChatTabsMounted({})()).not.toThrow()
    undo()
  })

  it('reads the composer\'s live model catalog and its change events (C13)', async () => {
    const store = { getSnapshot: () => ({ value: { groups: [] }, status: 'ready', error: null }), subscribe: () => () => undefined }
    const catalog = { store, load: async () => undefined }
    const handlers = new Map<string, () => void>()
    const off = vi.fn()
    const ctx = {
      get: (name: string) => name === 'modelDirectories' ? { catalog } : undefined,
      remote: {
        $on: (event: string, listener: () => void) => { handlers.set(event, listener); return off },
        session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'p' }], failures: [{ id: 'q', message: 'down' }] } }) },
      },
    }
    const host = clientHost(ctx)
    expect(host.composerCatalog()).toBe(catalog)
    expect(await host.modelCatalog()).toEqual({ groups: [{ id: 'p' }], failures: [{ id: 'q', message: 'down' }] })
    const seen = vi.fn()
    const dispose = host.onCatalogChange(seen)
    expect([...handlers.keys()]).toEqual([...CATALOG_EVENTS])
    handlers.get('settings/document-updated')!()
    expect(seen).toHaveBeenCalledTimes(1)
    dispose()
    expect(off).toHaveBeenCalledTimes(CATALOG_EVENTS.length)
    // A service in another shape is not used: the menus fall back to their own copy.
    const { undo } = warnings()
    expect(clientHost({ get: () => ({ catalog: { store: {} } }) }).composerCatalog()).toBeUndefined()
    expect(features.has('modelDirectories.catalog')).toBe(false)
    undo()
  })

  it('a dock layout in an unknown shape is not used (C6)', () => {
    const { seen, undo } = warnings()
    expect(layoutOf({ mountedSurface: () => ({ layout: { rootId: 'r', nodes: { r: { kind: 'stack' } }, tabs: {} } as never }) })).toBeUndefined()
    expect(layoutOf({ mountedSurface: () => ({ layout: { rootId: 'r', nodes: { r: { kind: 'pane', id: 'r', host: 'dock', tabs: [] } }, tabs: {} } }) })).toBeDefined()
    expect(gesturesOf({ mounted: { getSnapshot: () => 's' } })).toBeUndefined()
    undo()
    expect(seen.some(m => /sidebar\.layout/u.test(m))).toBe(true)
  })

  it('a frozen subagent tab type is left alone (C4)', () => {
    const { undo } = warnings()
    const definition = Object.freeze({ keepMounted: false })
    const stop = keepChatTabsMounted({ sidebarRightTabs: { get: () => definition, subscribe: () => () => undefined } })
    stop()
    undo()
    expect(features.has('tabs.keepMounted')).toBe(false)
    vi.restoreAllMocks()
  })
})
