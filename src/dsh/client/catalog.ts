/**
 * The composer's model catalog (dsh-client-ui-model-selection), as the plugin's model menus read it.
 *
 * That package mounts the `modelDirectories` service (`ModelDirectoryResolver`). It owns one
 * Host-generation catalog, `modelDirectories.catalog` (`ModelCatalogDirectory`): a snapshot store
 * `{ value, status, error }` filled from `remote.session.modelCatalog()`, reloaded on the Host's
 * {@link CATALOG_EVENTS} and reset on `connection/reset`. The composer's model seat and `/model`
 * both render that store. Reading the same store keeps the plugin's menus in step with them.
 * Contract C13 in docs/dsh-adapter.md (tests/contract/client-probe.spec.ts).
 * @module dsh-agent-scheduler/dsh/client/catalog
 */
import { features, hasFunction } from '../compat.js'

/** Host events after which the composer reloads its catalog (ModelDirectoryResolver). */
export const CATALOG_EVENTS = ['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const

/** One catalog read: provider groups, and providers whose catalog could not be read. */
export interface CatalogValue<G = unknown> {
  readonly groups: readonly G[]
  readonly failures?: readonly { readonly id: string; readonly name?: string; readonly message?: string }[]
}

/** `modelDirectories.catalog.store`'s snapshot. While a refresh loads, `value` keeps the last one. */
export interface ComposerCatalogState<G = unknown> { readonly value: CatalogValue<G> | null; readonly status: string; readonly error: string | null }

/** The part of `modelDirectories.catalog` the plugin reads. */
export interface ComposerCatalog<G = unknown> {
  readonly store: { getSnapshot: () => ComposerCatalogState<G>; subscribe: (listener: () => void) => () => void }
  /** Load when due (a no-op when the current generation is loaded); rejects on failure. */
  load: () => Promise<unknown>
}

/**
 * The composer's catalog, when this DSH mounted it.
 * @param ctx - the browser plugin context.
 * @returns the catalog, or undefined (an older or stripped DSH; the caller falls back).
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function composerCatalog<G>(ctx: any): ComposerCatalog<G> | undefined {
  let service: unknown
  try { service = ctx?.get?.('modelDirectories') ?? ctx?.modelDirectories } catch { service = undefined }
  const catalog = (service as { catalog?: unknown } | undefined)?.catalog
  const ok = hasFunction(catalog, 'store.getSnapshot') && hasFunction(catalog, 'store.subscribe') && hasFunction(catalog, 'load')
  features.record('modelDirectories.catalog', ok, 'modelDirectories.catalog')
  return ok ? catalog as ComposerCatalog<G> : undefined
}

/**
 * Call `listener` after every Host event on which the composer reloads its catalog.
 * @param ctx - the browser plugin context.
 * @param listener - what to run.
 * @returns a disposer.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function onCatalogChange(ctx: any, listener: () => void): () => void {
  if (!hasFunction(ctx, 'remote.$on')) return () => undefined
  const disposers = CATALOG_EVENTS.map(event => ctx.remote.$on(event, listener) as unknown).filter((d): d is () => void => typeof d === 'function')
  return () => { for (const d of disposers) d() }
}
