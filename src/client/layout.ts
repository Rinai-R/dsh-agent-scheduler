/**
 * Where the Agents page sits in the right column, computed over the sidebar's own saved layout
 * shape. The roster is a column of its own on the left of the right column, next to the main
 * conversation; agent chats share the other pane as tabs. The dock allows at most two horizontal
 * panes, so every step here is one of the gestures a user could make by hand: drop a tab on a
 * pane's left edge, move a tab into a pane, resize the divider.
 */

import type { DockLayout, DockNode } from '../dsh/client/sidebar.js'

export type { DockLayout, DockNode } from '../dsh/client/sidebar.js'

/** One gesture toward "roster alone in the left pane". */
export type RosterStep =
  | { readonly op: 'drop'; readonly tabId: string; readonly paneId: string; readonly zone: 'left' }
  | { readonly op: 'place'; readonly tabId: string; readonly paneId: string; readonly index?: number }

/** Share of the right column the roster pane takes when this module creates it. */
export const ROSTER_SHARE = 0.36

type Pane = Extract<DockNode, { kind: 'pane' }>

/**
 * The docked panes, left to right.
 * @param layout - sidebar layout.
 * @returns panes in the root, at most two.
 */
export function dockPanes(layout: DockLayout): Pane[] {
  const root = layout.nodes[layout.rootId]
  if (root === undefined) return []
  if (root.kind === 'pane') return root.host === 'dock' ? [root] : []
  return root.children.map(id => layout.nodes[id]).filter((n): n is Pane => n?.kind === 'pane' && n.host === 'dock')
}

/**
 * The Agents tab and the pane holding it.
 * @param layout - sidebar layout.
 * @param kind - the Agents page kind.
 * @returns the tab id and its pane, or undefined when it is not open.
 */
export function findRoster(layout: DockLayout, kind: string): { tabId: string; pane: Pane } | undefined {
  const tab = Object.values(layout.tabs).find(t => t.kind === kind)
  if (tab === undefined) return undefined
  for (const node of Object.values(layout.nodes)) {
    if (node.kind === 'pane' && node.tabs.includes(tab.id)) return { tabId: tab.id, pane: node }
  }
  return undefined
}

/**
 * The next gesture that brings the roster to a pane of its own on the left, or undefined when it
 * already is there (or floats, which is the user's choice).
 * @param layout - sidebar layout.
 * @param kind - the Agents page kind.
 * @returns one step; apply it, read the layout again, and repeat.
 */
export function nextRosterStep(layout: DockLayout, kind: string): RosterStep | undefined {
  const roster = findRoster(layout, kind)
  if (roster === undefined || roster.pane.host !== 'dock') return undefined
  const panes = dockPanes(layout)
  if (panes.length === 1) {
    const [only] = panes as [Pane]
    return only.tabs.length <= 1 ? undefined : { op: 'drop', tabId: roster.tabId, paneId: only.id, zone: 'left' }
  }
  if (panes.length !== 2) return undefined
  const [left, right] = panes as [Pane, Pane]
  if (roster.pane.id !== left.id) return { op: 'place', tabId: roster.tabId, paneId: left.id, index: 0 }
  const stray = left.tabs.find(id => id !== roster.tabId)
  return stray === undefined ? undefined : { op: 'place', tabId: stray, paneId: right.id }
}

/**
 * Where an agent chat opens: the docked pane that does not hold the roster; with the roster alone
 * in the column, a new pane to its right.
 * @param layout - sidebar layout.
 * @param kind - the Agents page kind.
 * @returns placement options for `openResource`.
 */
export function chatPlacementIn(layout: DockLayout, kind: string): { paneId: string } | { preferNewPane: true } {
  const roster = findRoster(layout, kind)
  const other = dockPanes(layout).find(p => p.id !== roster?.pane.id)
  return other === undefined ? { preferNewPane: true } : { paneId: other.id }
}

/**
 * The child Session an open tab shows, for the roster's selected row.
 * @param layout - sidebar layout.
 * @param kind - the Agents page kind.
 * @param ids - the roster's member Session ids.
 * @returns the member whose chat is the active tab of the chat pane.
 */
export function activeChild(layout: DockLayout, kind: string, ids: readonly string[]): string | undefined {
  const roster = findRoster(layout, kind)
  const pane = dockPanes(layout).find(p => p.id !== roster?.pane.id)
  const tab = pane?.activeTabId === undefined ? undefined : layout.tabs[pane.activeTabId]
  if (tab === undefined) return undefined
  return ids.find(id => tab.contentId.includes(`/session/${encodeURIComponent(id)}`) || tab.contentId.includes(`/session/${id}`))
}
