/**
 * The model catalog every model menu of this plugin lists, read from the same place the Host
 * composer's model menu reads it.
 *
 * The composer's selector (`@deepseek-ai/dsh-client-ui-model-selection`, `lib/client.js`) mounts
 * the `modelDirectories` service (`ModelDirectoryResolver`). It owns one Host-generation catalog,
 * `modelDirectories.catalog` (`ModelCatalogDirectory`): a snapshot store `{ value, status, error }`
 * filled from `remote.session.modelCatalog()`, invalidated and reloaded on the Host's
 * `llm/adapters-updated`, `settings/document-updated`, `credentials/record-updated` and
 * `credentials/reference-updated` events, and reset on `connection/reset`. Both entries of the
 * composer (the model seat and `/model`) render that store, so they follow a model-list change.
 *
 * {@link hostCatalogSource} subscribes to that very store when the service is mounted, so this
 * plugin's menus and the composer change together. Without the service (an older or stripped Host
 * bundle) it falls back to its own copy: loaded through the same RPC and reloaded on the same four
 * events and on every menu opening — same data and the same triggers, but not the same object.
 * @module dsh-agent-scheduler/client/catalog-source
 */
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

/** The Host composer's catalog value (`remote.session.modelCatalog` response value). */
interface HostCatalogValue { readonly groups: readonly CatalogGroup[]; readonly failures?: readonly CatalogFailure[] }
interface HostCatalogState { readonly value: HostCatalogValue | null; readonly status: string; readonly error: string | null }
/** The part of `modelDirectories.catalog` this plugin reads. */
export interface HostCatalog {
  readonly store: { getSnapshot: () => HostCatalogState; subscribe: (listener: () => void) => () => void }
  load: () => Promise<unknown>
}

/** Host events after which the composer reloads its catalog (ModelDirectoryResolver). */
export const CATALOG_EVENTS = ['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const

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
 * @param catalog - `modelDirectories.catalog`.
 * @returns the source.
 */
export function fromHostCatalog(catalog: HostCatalog): CatalogSource {
  let seen: HostCatalogState | undefined
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

/** What the fallback needs from the client context. */
export interface CatalogRemote {
  modelCatalog: () => Promise<{ ok: true; value: HostCatalogValue } | { ok: false; error: { code: string; message: string } }>
  /** `ctx.remote.$on`: subscribe to a Host event; returns a disposer when the runtime gives one. */
  on?: (event: string, listener: () => void) => (() => void) | void
}

/**
 * Own copy of the catalog, for a Host without the `modelDirectories` service: same RPC as the
 * composer, reloaded on the same Host events and whenever a menu opens.
 * @param remote - the RPC and the event hook.
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
    remote.modelCatalog().then(result => {
      if (mine !== generation) return
      if (result.ok) publish({ groups: orderProviders(result.value.groups), failures: result.value.failures ?? [], error: null })
      else publish({ ...snapshot, error: `${result.error.code}: ${result.error.message}` })
    }, (reason: unknown) => {
      if (mine === generation) publish({ ...snapshot, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { if (mine === generation) inflight = false })
  }
  const refresh = () => { inflight = false; load() }
  const disposers = CATALOG_EVENTS.map(event => remote.on?.(event, refresh)).filter((d): d is () => void => typeof d === 'function')
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    dispose: () => { for (const d of disposers) d() },
  }
}

/**
 * The plugin's catalog: the composer's own store when the Host mounted it, else the fallback.
 * Resolved on first use, after every client plugin applied.
 * @param ctx - client context: `get('modelDirectories')`, `remote.session`, `remote.$on`.
 * @returns the source.
 */
export function hostCatalogSource(ctx: {
  get?: (name: string) => unknown
  modelDirectories?: unknown
  remote?: { session?: { modelCatalog?: CatalogRemote['modelCatalog'] }; $on?: CatalogRemote['on'] }
}): CatalogSource & { dispose: () => void } {
  let resolved: (CatalogSource & { dispose?: () => void }) | undefined
  const resolve = (): CatalogSource & { dispose?: () => void } => {
    if (resolved !== undefined) return resolved
    const service = (ctx.get?.('modelDirectories') ?? ctx.modelDirectories) as { catalog?: Partial<HostCatalog> } | undefined
    const catalog = service?.catalog
    if (catalog?.store !== undefined && typeof catalog.store.getSnapshot === 'function' && typeof catalog.store.subscribe === 'function' && typeof catalog.load === 'function') {
      resolved = fromHostCatalog(catalog as HostCatalog)
    } else {
      const modelCatalog = ctx.remote?.session?.modelCatalog
      const on = ctx.remote?.$on
      resolved = fallbackCatalog({
        modelCatalog: modelCatalog === undefined ? async () => ({ ok: false, error: { code: 'unavailable', message: 'no model catalog' } }) : (...args) => modelCatalog.apply(ctx.remote!.session, args as []),
        ...(on === undefined ? {} : { on: (event, listener) => on.call(ctx.remote, event, listener) }),
      })
    }
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
