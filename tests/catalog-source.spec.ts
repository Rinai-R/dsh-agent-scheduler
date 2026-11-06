/** The plugin's model catalog: the composer's own store, live; a fallback copy on the same triggers. */
import { describe, expect, it, vi } from 'vitest'
import { catalogSource, fallbackCatalog, fromHostCatalog, isStale, orderProviders } from '../src/client/catalog-source.js'
import type { CatalogGroup } from '../src/client/model-menu.js'

const magpie: CatalogGroup = { id: 'magpie', name: 'Magpie', models: [{ id: 'claude-opus', name: 'Claude Opus' }, { id: 'gpt', name: 'GPT' }] }
const moved: CatalogGroup[] = [{ id: 'magpie', name: 'Magpie', models: [{ id: 'gpt', name: 'GPT' }] }, { id: 'magpie-anthropic', name: 'Magpie (Anthropic)', models: [{ id: 'claude-opus', name: 'Claude Opus' }] }]

/** A stand-in for `modelDirectories.catalog`: a snapshot store the Host replaces on a model-list change. */
function hostCatalog(groups: unknown) {
  let state = { value: { groups, failures: [] }, status: 'ready', error: null as string | null } as { value: { groups: unknown; failures: unknown[] } | null; status: string; error: string | null }
  const listeners = new Set<() => void>()
  return {
    store: { getSnapshot: () => state, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } } },
    load: vi.fn(async () => state.value),
    /** What the Host does on `settings/document-updated` and friends: publish a new catalog. */
    publish(next: typeof state) { state = next; for (const l of [...listeners]) l() },
    listeners,
  }
}

describe('model catalog source', () => {
  it('follows the composer\'s catalog: a model-list change reaches the menu without reloading it', () => {
    const host = hostCatalog([magpie])
    const source = fromHostCatalog(host as never)
    const seen: unknown[] = []
    const off = source.subscribe(() => { seen.push(source.getSnapshot().groups) })
    const first = source.getSnapshot()
    expect(first.groups!.map(g => g.id)).toEqual(['magpie'])
    // Same Host snapshot, same object: React's useSyncExternalStore does not loop.
    expect(source.getSnapshot()).toBe(first)
    // The user moves Claude to another provider; the Host reloads and publishes.
    host.publish({ value: { groups: moved, failures: [] }, status: 'ready', error: null })
    expect(seen).toHaveLength(1)
    expect(source.getSnapshot().groups!.map(g => g.id)).toEqual(['magpie', 'magpie-anthropic'])
    // A recorded magpie/claude-opus is now stale; the new route is not.
    expect(isStale(source.getSnapshot(), { provider: 'magpie', model: 'claude-opus' })).toBe(true)
    expect(isStale(source.getSnapshot(), { provider: 'magpie-anthropic', model: 'claude-opus' })).toBe(false)
    // While a refresh loads the Host keeps the old value; so does the menu (no blank flash).
    const during = source.getSnapshot().groups
    host.publish({ value: { groups: moved, failures: [] }, status: 'loading', error: null })
    expect(source.getSnapshot().groups).toEqual(during)
    off()
    expect(host.listeners.size).toBe(0)
    source.load()
    expect(host.load).toHaveBeenCalledTimes(1)
  })

  it('prefers the composer\'s store over its own copy', () => {
    const host = hostCatalog([magpie])
    const modelCatalog = vi.fn()
    const source = catalogSource({ composerCatalog: () => host as never, modelCatalog, onCatalogChange: () => () => undefined })
    expect(source.getSnapshot().groups!.map(g => g.id)).toEqual(['magpie'])
    host.publish({ value: { groups: moved, failures: [] }, status: 'ready', error: null })
    expect(source.getSnapshot().groups!.map(g => g.id)).toEqual(['magpie', 'magpie-anthropic'])
    expect(modelCatalog).not.toHaveBeenCalled()
  })

  it('without the composer\'s store: loads the same read and reloads on the Host\'s catalog events', async () => {
    let groups = [magpie]
    const modelCatalog = vi.fn(async () => ({ groups }))
    let changed: (() => void) | undefined
    const off = vi.fn()
    const source = catalogSource({ composerCatalog: () => undefined, modelCatalog: modelCatalog as never, onCatalogChange: (listener) => { changed = listener; return off } })
    expect(source.getSnapshot().groups).toBeUndefined()
    const notified = vi.fn()
    source.subscribe(notified)
    source.load()
    await vi.waitFor(() => { expect(source.getSnapshot().groups?.map(g => g.id)).toEqual(['magpie']) })
    groups = moved
    changed!()
    await vi.waitFor(() => { expect(source.getSnapshot().groups?.map(g => g.id)).toEqual(['magpie', 'magpie-anthropic']) })
    expect(notified).toHaveBeenCalledTimes(2)
    source.dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('a failed reload keeps the last list and reports the error', async () => {
    let fail = false
    const source = fallbackCatalog({ modelCatalog: async () => { if (fail) throw new Error('x: down'); return { groups: [magpie] } } })
    source.load()
    await vi.waitFor(() => { expect(source.getSnapshot().groups).toHaveLength(1) })
    fail = true
    source.load()
    await vi.waitFor(() => { expect(source.getSnapshot().error).toBe('x: down') })
    expect(source.getSnapshot().groups).toHaveLength(1)
  })

  it('orders and names providers as the composer does', () => {
    const ordered = orderProviders([magpie, { id: 'deepseek-official', name: 'DeepSeek', models: [] }, { id: 'deepseek-account', name: 'deepseek-account', models: [] }])
    expect(ordered.map(g => [g.id, g.name])).toEqual([['deepseek-account', 'DeepSeek 账号'], ['deepseek-official', 'DeepSeek'], ['magpie', 'Magpie']])
  })

  it('stale only when the catalog is known and the provider loaded', () => {
    const choice = { provider: 'magpie', model: 'claude-opus' }
    expect(isStale({ groups: undefined, failures: [] }, choice)).toBe(false)
    expect(isStale({ groups: moved, failures: [] }, null)).toBe(false)
    expect(isStale({ groups: moved, failures: [] }, choice)).toBe(true)
    // A provider whose catalog failed to load: its models are unknown, not gone.
    expect(isStale({ groups: [], failures: [{ id: 'magpie' }] }, choice)).toBe(false)
    expect(isStale({ groups: [], failures: [] }, { provider: 'magpie-anthropic', model: 'claude-opus' })).toBe(true)
  })
})
