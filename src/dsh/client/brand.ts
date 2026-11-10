/**
 * The sidebar brand row and the shell's UI primitives, as the focus deck uses them.
 *
 * Contract (pinned and next, see tests/contract/client-probe.spec.ts C15):
 * - `sidebar.brand.name` is a root `single` slot; the shell renders its fallback (「本地构建」 + a
 *   copy-on-click version badge) only while the slot has no entry. An occupant replaces the
 *   fallback outright, so the deck occupies the slot only while another (official) occupant is
 *   registered there, and then renders that occupant's own artwork: `BrandWordmark` with
 *   `includeMark: false`, exactly what `dsh-client-ui-brand-official` registers.
 * - The UI primitives are a module the client loader shares with every plugin
 *   (`@deepseek-ai/dsh-client-ui-primitives`, same instance the shell and the official brand use).
 * @module dsh-agent-scheduler/dsh/client/brand
 */
import { features } from '../compat.js'

declare const require: ((id: string) => unknown) | undefined

/** The primitives the deck draws with; all optional, a missing one degrades to plain markup. */
export interface Primitives {
  BrandWordmark?: (props: { includeMark?: boolean }) => unknown
  Tooltip?: (props: Record<string, unknown>) => unknown
  IconSearchOutlineRegular?: (props: { size?: number }) => unknown
  IconUsersOutlineRegular?: (props: { size?: number }) => unknown
  IconWorkspaceTreeOutlineRegular?: (props: { size?: number }) => unknown
  IconChevronRightOutlineRegular?: (props: { size?: number }) => unknown
  IconPinFillRegular?: (props: { size?: number }) => unknown
  IconCloseOutlineRegular?: (props: { size?: number }) => unknown
}

/** Shared module id of the shell's UI primitives in the client module loader. */
export const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives'
/** The brand name seat in the sidebar header. */
export const BRAND_NAME_SLOT = 'sidebar.brand.name'

let cached: Primitives | undefined
/**
 * Provide the primitives module directly (tests; a host that hands it over another way).
 * @param module - the module, or undefined to forget it and load through `require` again.
 */
export function providePrimitives(module: Primitives | undefined): void { cached = module }
/**
 * The shell's primitives module, loaded through the client module loader's `require` (cached once
 * found; a miss is retried, since the loader may not have it yet on the first render).
 * @returns the module, or undefined when this build cannot reach it.
 */
export function primitives(): Primitives | undefined {
  if (cached !== undefined) return cached
  let found: Primitives | undefined
  try {
    found = typeof require === 'function' ? (require(PRIMITIVES_MODULE) as Primitives | undefined) : undefined
  } catch {
    found = undefined
  }
  if (found !== undefined && found !== null && typeof found.BrandWordmark === 'function') {
    cached = found
    features.record('primitives', true, PRIMITIVES_MODULE)
  }
  return found ?? undefined
}

/**
 * Whether someone other than the deck occupies the brand name seat (the official brand plugin).
 * @param ctx - the browser plugin context.
 * @param ours - the deck's own component, excluded from the count.
 * @returns true when another live entry is registered there.
 */
export function brandOccupied(ctx: any, ours: unknown): boolean {
  try {
    const entries = typeof ctx?.slots?.entries === 'function' ? (ctx.slots.entries(BRAND_NAME_SLOT) as readonly { component?: unknown }[]) : []
    return entries.some(entry => entry.component !== ours)
  } catch {
    return false
  }
}

/**
 * Follow registration changes of one slot (microtask-batched by the registry).
 * @param ctx - the browser plugin context.
 * @param key - the slot.
 * @param listener - called after a change.
 * @returns unsubscribe.
 */
export function watchSlot(ctx: any, key: string, listener: () => void): () => void {
  try {
    const off = typeof ctx?.slots?.subscribe === 'function' ? ctx.slots.subscribe(key, listener) : undefined
    return typeof off === 'function' ? off as () => void : () => undefined
  } catch {
    return () => undefined
  }
}
