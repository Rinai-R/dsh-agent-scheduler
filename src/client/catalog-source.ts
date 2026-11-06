/**
 * The model catalog every model menu of this plugin lists: the composer's own catalog store when
 * the DSH adapter finds it (src/dsh/client/catalog.ts, contract C13), so these menus and the
 * composer's change together; otherwise an own copy loaded through the same RPC and reloaded on
 * the same Host events and on every menu opening — same data and triggers, not the same object.
 * Everything here is pure: the host is reached only through the adapter's `ClientHost`.
 * @module dsh-agent-scheduler/client/catalog-source
 */
import type { CatalogValue, ClientHost, ComposerCatalog } from '../dsh/client/index.js'
import type { CatalogGroup } from './model-menu.js'

/** A provider whose catalog could not be read; its models are unknown, not removed. */
export interface CatalogFailure { readonly id: string; readonly name?: string; readonly message?: string }

/** What a menu renders. `groups` is undefined until the first load settles. */
export interface CatalogSnapshot {
  readonly groups: readonly CatalogGroup[] | undefined
  readonly failures: readonly CatalogFailure[]
  readonly error: string | null
}

/** A subscribable catalog. `load` asks for a fresh copy when one is due (cheap when it is not). */
export interface CatalogSource {
  getSnapshot: () => CatalogSnapshot
  subscribe: (listener: () => void) => () => void
  load: () => void
}

const EMPTY: CatalogSnapshot = { groups: undefined, failures: [], error: null }

/** The account provider's display name in the composer (its locale `provider.account`). */
const ACCOUNT_NAME = 'DeepSeek 账号'

/**
 * Order and name provider groups the way the composer does (`orderModelProviders`): the DeepSeek
 * account first, the official DeepSeek route second, the rest in catalog order.
 * @param groups - catalog groups in catalog order.
 * @returns a sorted copy; models keep their order.
 */
export function orderProviders(groups: readonly CatalogGroup[]): CatalogGroup[] {
  const rank = (id: string) => id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2
  return [...groups]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group.id) - rank(b.group.id) || a.index - b.index)
    .map(({ group }) => group.id === 'deepseek-account' ? { ...group, name: ACCOUNT_NAME } : group)
}

/**
 * Adapt the composer's catalog store. Snapshots are memoized per Host snapshot, so React's
 * `useSyncExternalStore` sees a stable value until the Host publishes a new one.
 * @param catalog - the composer's catalog store (adapter `composerCatalog`).
 * @returns the source.
 */
export function fromHostCatalog(catalog: ComposerCatalog<CatalogGroup>): CatalogSource {
  let seen: ReturnType<ComposerCatalog<CatalogGroup>['store']['getSnapshot']> | undefined
  let mapped: CatalogSnapshot = EMPTY
  const getSnapshot = (): CatalogSnapshot => {
    const state = catalog.store.getSnapshot()
    if (state === seen) return mapped
    seen = state
    // While a refresh loads, the Host keeps the previous value; show it rather than blank out.
    mapped = state.value === null
      ? { groups: undefined, failures: [], error: state.status === 'error' ? state.error : null }
      : { groups: orderProviders(state.value.groups), failures: state.value.failures ?? [], error: state.status === 'error' ? state.error : null }
    return mapped
  }
  return {
    getSnapshot,
    subscribe: (listener) => catalog.store.subscribe(listener),
    load: () => { catalog.load().catch(() => undefined) },
  }
}

/** What the fallback needs: one catalog read, and the Host's catalog-change events. */
export interface CatalogRemote {
  modelCatalog: () => Promise<CatalogValue<CatalogGroup>>
  onChange?: (listener: () => void) => () => void
}

/**
 * Own copy of the catalog, for a DSH without the composer's store: same RPC as the composer,
 * reloaded on the same Host events and whenever a menu opens.
 * @param remote - the read and the change events.
 * @returns the source and a disposer for its event hooks.
 */
export function fallbackCatalog(remote: CatalogRemote): CatalogSource & { dispose: () => void } {
  let snapshot: CatalogSnapshot = EMPTY
  let generation = 0
  let inflight = false
  const listeners = new Set<() => void>()
  const publish = (next: CatalogSnapshot) => { snapshot = next; for (const listener of [...listeners]) listener() }
  const load = () => {
    if (inflight) return
    inflight = true
    const mine = ++generation
    remote.modelCatalog().then(value => {
      if (mine === generation) publish({ groups: orderProviders(value.groups), failures: value.failures ?? [], error: null })
    }, (reason: unknown) => {
      if (mine === generation) publish({ ...snapshot, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { if (mine === generation) inflight = false })
  }
  const refresh = () => { inflight = false; load() }
  const off = remote.onChange?.(refresh)
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    dispose: () => { off?.() },
  }
}

/**
 * The plugin's catalog: the composer's own store when the adapter finds it, else the fallback.
 * Resolved on first use (a menu mounting), after every client plugin applied.
 * @param host - the DSH adapter's client services.
 * @returns the source.
 */
export function catalogSource(host: Pick<ClientHost, 'composerCatalog' | 'modelCatalog' | 'onCatalogChange'>): CatalogSource & { dispose: () => void } {
  let resolved: (CatalogSource & { dispose?: () => void }) | undefined
  const resolve = (): CatalogSource & { dispose?: () => void } => {
    if (resolved !== undefined) return resolved
    const composer = host.composerCatalog<CatalogGroup>()
    resolved = composer !== undefined
      ? fromHostCatalog(composer)
      : fallbackCatalog({ modelCatalog: () => host.modelCatalog<CatalogGroup>(), onChange: (listener) => host.onCatalogChange(listener) })
    return resolved
  }
  return {
    getSnapshot: () => resolve().getSnapshot(),
    subscribe: (listener) => resolve().subscribe(listener),
    load: () => { resolve().load() },
    dispose: () => { resolved?.dispose?.() },
  }
}

/**
 * Whether a recorded choice is no longer in the catalog. Unknown until the catalog loaded, and
 * never for a provider whose catalog failed to load (its models are unknown, not gone).
 * @param snapshot - the catalog.
 * @param choice - the recorded provider and model.
 * @returns true when the choice should be shown as stale.
 */
export function isStale(snapshot: Pick<CatalogSnapshot, 'groups' | 'failures'>, choice: { provider: string; model: string } | null | undefined): boolean {
  if (choice === null || choice === undefined || snapshot.groups === undefined) return false
  if (snapshot.failures.some(f => f.id === choice.provider)) return false
  return !snapshot.groups.some(g => g.id === choice.provider && g.models.some(m => m.id === choice.model))
}
