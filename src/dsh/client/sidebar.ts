/**
 * The right sidebar as the plugin drives it (dsh-client-ui-sidebar-right): its tab types, its
 * live dock layout, and the gestures that rearrange it. The layout shape and the gestures are not
 * documented API; {@link layoutOf} checks the shape before anyone reads it, and every gesture is
 * optional.
 * @module dsh-agent-scheduler/dsh/client/sidebar
 */
import { features } from '../compat.js'

/** The sidebar tab type of a native subagent chat (dsh-client-ui-subagent). */
export const SUBAGENT_CHAT_KIND = 'subagentchat'

/** The parts of the sidebar's saved layout the plugin reads. */
export interface DockLayout {
  readonly rootId: string
  readonly nodes: Readonly<Record<string, DockNode>>
  readonly tabs: Readonly<Record<string, { readonly id: string; readonly kind: string; readonly contentId: string }>>
  readonly expanded?: boolean
}
export type DockNode =
  | { readonly kind: 'pane'; readonly id: string; readonly host: 'dock' | 'float'; readonly tabs: readonly string[]; readonly activeTabId?: string }
  | { readonly kind: 'split'; readonly id: string; readonly axis: 'row' | 'column'; readonly children: readonly string[]; readonly sizes: readonly number[] }

/** The parts of `ctx.sidebarRight` this plugin uses; every member is optional at this boundary. */
export interface SidebarFace {
  mounted?: { getSnapshot: () => string | undefined }
  mountedSurface?: () => { layout: DockLayout } | undefined
  actionsFor?: (sessionId: string) => DockActions | undefined
  openTab?: (kind: string, options?: Record<string, unknown>) => void
  openResource?: (address: string, options?: Record<string, unknown>) => void
  focus?: (tabId: string) => void
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}
/** The sidebar store's own gestures: dropping a tab on a pane edge, moving it, resizing the divider. */
export interface DockActions {
  dropTab?: (sessionId: string, tabId: string, paneId: string, zone: 'left') => void
  placeTab?: (sessionId: string, tabId: string, paneId: string, index?: number) => void
  resizeSplit?: (sessionId: string, splitId: string, sizes: number[]) => void
}


const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isNode = (n: unknown): boolean => isObject(n) && typeof n.id === 'string' && (
  (n.kind === 'pane' && (n.host === 'dock' || n.host === 'float') && Array.isArray(n.tabs))
  || (n.kind === 'split' && Array.isArray(n.children) && Array.isArray(n.sizes)))

/**
 * The live layout, when the sidebar exposes one in the shape this plugin knows.
 * @param sidebar - `ctx.sidebarRight`.
 * @returns the layout, or undefined (and one warning) when it is missing or reshaped.
 */
export function layoutOf(sidebar: SidebarFace | undefined): DockLayout | undefined {
  if (sidebar?.mountedSurface === undefined) return undefined
  const layout = sidebar.mountedSurface()?.layout as unknown
  if (layout === undefined) return undefined
  const ok = isObject(layout) && typeof layout.rootId === 'string' && isObject(layout.nodes) && isObject(layout.tabs)
    && Object.values(layout.nodes).every(isNode)
  if (!ok) {
    features.record('sidebar.layout', false, 'the dock layout has a shape this plugin does not know')
    return undefined
  }
  return layout as unknown as DockLayout
}

/**
 * The sidebar's own gestures for the mounted Session.
 * @param sidebar - `ctx.sidebarRight`.
 * @returns the mounted Session and its gestures, or undefined when the sidebar has none.
 */
export function gesturesOf(sidebar: SidebarFace | undefined): { sessionId: string; actions: DockActions } | undefined {
  const sessionId = sidebar?.mounted?.getSnapshot()
  if (sessionId === undefined) return undefined
  const actions = sidebar?.actionsFor?.(sessionId)
  if (actions === undefined) {
    if (sidebar?.actionsFor === undefined) features.record('sidebar.gestures', false, 'sidebarRight.actionsFor')
    return undefined
  }
  return { sessionId, actions }
}

/** The parts of `ctx.sidebarRightTabs` used to keep agent chats mounted. */
export interface TabTypesFace {
  get?: (kind: string) => { keepMounted?: boolean } | undefined
  subscribe?: (listener: () => void) => () => void
}

/**
 * Keep the native subagent chat tabs mounted while another tab of their pane is in front.
 * The dock renders only each pane's active tab unless its type says `keepMounted`, so closing one
 * chat (or switching tabs) brought the neighbour back as a fresh mount: its conversation reloaded
 * from the top. The type is the product's own (`subagentchat`, builtin band); taking it over with
 * an extension would mean re-implementing its body, so the flag is set on the registered
 * definition, again whenever the registry changes, and put back on dispose.
 * @param tabs - `ctx.sidebarRightTabs`.
 * @returns undo.
 */
export function retainChatTabs(tabs: TabTypesFace | undefined): () => void {
  if (tabs?.get === undefined) return () => undefined
  const touched = new Map<object, boolean | undefined>()
  const apply = () => {
    const definition = tabs.get?.(SUBAGENT_CHAT_KIND)
    if (definition === undefined || definition.keepMounted === true || touched.has(definition)) return
    touched.set(definition, definition.keepMounted)
    try {
      definition.keepMounted = true
      if (definition.keepMounted !== true) throw new Error('not writable')
    } catch {
      touched.delete(definition)
      features.record('tabs.keepMounted', false, 'the subagent chat tab type cannot be changed')
    }
  }
  apply()
  const unsubscribe = tabs.subscribe?.(apply)
  return () => {
    unsubscribe?.()
    for (const [definition, before] of touched) {
      try {
        if (before === undefined) delete (definition as { keepMounted?: boolean }).keepMounted
        else (definition as { keepMounted?: boolean }).keepMounted = before
      } catch { /* frozen after the fact: leave it */ }
    }
  }
}


/**
 * {@link retainChatTabs} on the plugin context's tab registry.
 * @param ctx - the browser plugin context.
 * @returns undo.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export const keepChatTabsMounted = (ctx: any): (() => void) => retainChatTabs(ctx.sidebarRightTabs as TabTypesFace | undefined)
