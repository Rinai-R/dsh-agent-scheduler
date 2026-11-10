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
  IconAppsAddOutlineRegular?: (props: { size?: number }) => unknown
  IconNewChatOutlineRegular?: (props: { size?: number }) => unknown
  IconPlusOutlineRegular?: (props: { size?: number }) => unknown
  IconCloseFillRegular?: (props: { size?: number }) => unknown
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

/**
 * The stock workspace browser's own wording, so the deck's controls read exactly like it
 * (`workspace` locale namespace of dsh-client-ui-workspace).
 * @param ctx - the browser plugin context.
 * @param key - a key of that namespace, e.g. `actions.newSession`.
 * @param fallback - our own string when the namespace is unavailable.
 * @returns the stock text.
 */
export function stockText(ctx: any, key: 'actions.newSession' | 'search.placeholder' | 'session.new' | 'session.untitled' | 'search', fallback: string): string {
  try {
    const t = ctx?.locale?.bind?.('workspace') as ((key: string) => string) | undefined
    const text = t?.(key)
    return typeof text === 'string' && text !== '' && text !== key ? text : fallback
  } catch {
    return fallback
  }
}

/**
 * Start a new Session exactly like the stock 新会话 button: the shell resolves the workspace
 * (the current Session's, else the most recent) and opens it in the centre.
 * @param ctx - the browser plugin context.
 * @returns whether the shell accepted the request.
 */
export function startStockSession(ctx: any): boolean {
  const ui = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  if (!features.record('workspace.startSession', typeof ui?.startSession === 'function', 'uiWorkspace.startSession')) return false
  ui.startSession()
  return true
}

/**
 * The Session open in the centre, as the stock tree computes it: the list row the main view
 * retains.
 * @param snapshot - the session list snapshot.
 * @returns its id, if any.
 */
export function mainViewSessionId(snapshot: { byId?: Record<string, { retainedBy?: Record<string, number | undefined> } | undefined> } | null | undefined): string | undefined {
  for (const [id, row] of Object.entries(snapshot?.byId ?? {})) if ((row?.retainedBy?.mainView ?? 0) > 0) return id
  return undefined
}

/** A context-menu item on the stock session row menu. */
export interface SessionMenuItem { readonly id: string; readonly label: string; readonly run: () => void }

/**
 * Add an item to the stock session row menu (the ⋯ menu of 工作区 rows).
 * @param ctx - the browser plugin context.
 * @param id - the item id (unique among session menu providers).
 * @param order - its position (the stock pin item is 100, rename 200, fork 300).
 * @param observe - stores whose changes re-resolve the item.
 * @param resolve - the items for one Session.
 * @returns a disposer.
 */
export function registerSessionMenu(ctx: any, id: string, order: number, observe: readonly { subscribe(listener: () => void): () => void; getSnapshot(): unknown }[], resolve: (sessionId: string) => SessionMenuItem[]): () => void {
  const menus = (() => { try { return ctx.get?.('contextMenus') } catch { return undefined } })()
  if (!features.record('contextMenus', typeof menus?.register === 'function', 'contextMenus.register')) return () => undefined
  try {
    const off = menus.register({ id, target: 'session', order, observe: () => [...observe], resolve: (target: { sessionId: string }) => resolve(target.sessionId) })
    return typeof off === 'function' ? off as () => void : () => undefined
  } catch {
    return () => undefined
  }
}
