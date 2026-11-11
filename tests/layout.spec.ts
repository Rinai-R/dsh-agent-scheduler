/**
 * Roster placement in the right column. A small model of the dock (at most two docked panes, an
 * emptied pane merges away, pages deduplicate only within a pane) stands in for the sidebar, so
 * the chip's whole open path runs against the gestures the real store exposes.
 */
import { describe, expect, it } from 'vitest'
import type { SidebarFace } from '../src/client/index.js'
import { chatPlacementIn, nextRosterStep, ROSTER_SHARE, type DockLayout, type DockNode } from '../src/client/layout.js'

const AGENTS = 'agent-scheduler-agents'
type Pane = { id: string; tabs: string[]; active?: string }

/** Build a layout from panes listed left to right; tab ids name their kind (`agents` or a chat). */
function layoutOf(panes: Pane[], expanded = true, sizes?: number[]): DockLayout {
  const nodes: Record<string, DockNode> = {}
  for (const p of panes) nodes[p.id] = { kind: 'pane', id: p.id, host: 'dock', tabs: p.tabs, ...(p.active === undefined ? {} : { activeTabId: p.active }) }
  let rootId = panes[0]?.id ?? 'pane1'
  if (panes.length === 2) { rootId = 'split1'; nodes.split1 = { kind: 'split', id: 'split1', axis: 'row', children: panes.map(p => p.id), sizes: sizes ?? [0.5, 0.5] } }
  const tabs: DockLayout['tabs'] = Object.fromEntries(panes.flatMap(p => p.tabs).map(id => [id, { id, kind: id === 'agents' ? AGENTS : 'subagentchat', contentId: id === 'agents' ? 'page' : `dsh-resource://subagentchat/session/${id}?parent=main` }]))
  return { rootId, nodes, tabs, expanded }
}
const panesOf = (layout: DockLayout): string[][] => {
  const root = layout.nodes[layout.rootId]!
  const ids = root.kind === 'split' ? root.children : [root.id]
  return ids.map(id => [...(layout.nodes[id] as unknown as { tabs: string[] }).tabs])
}

/** The dock model: the same gestures `ctx.sidebarRight` and its store expose. */
function dock(initial: Pane[], expanded = true) {
  let panes = initial.map(p => ({ ...p, tabs: [...p.tabs] }))
  let open = expanded
  let sizes: number[] | undefined
  let minted = 10
  const log: string[] = []
  const settle = () => { panes = panes.filter(p => p.tabs.length > 0); if (panes.length < 2) sizes = undefined }
  const face: SidebarFace = {
    mounted: { getSnapshot: () => 'main' },
    mountedSurface: () => ({ layout: layoutOf(panes, open, sizes) }),
    isExpanded: () => open,
    toggleExpanded: () => { open = !open; log.push(`expand:${open}`) },
    focus: id => { log.push(`focus:${id}`) },
    openTab: (_kind, options) => {
      const target = panes.find(p => p.id === options?.paneId) ?? panes[0]
      if (target === undefined) panes = [{ id: `pane${minted++}`, tabs: ['agents'] }]
      else target.tabs.push('agents')
      open = true
      log.push(`openTab:${String(options?.paneId)}`)
    },
    actionsFor: () => ({
      dropTab: (_s, tab, paneId, zone) => {
        const from = panes.find(p => p.tabs.includes(tab))!
        from.tabs = from.tabs.filter(t => t !== tab)
        panes.splice(panes.findIndex(p => p.id === paneId), 0, { id: `pane${minted++}`, tabs: [tab] })
        log.push(`drop:${tab}:${zone}`)
        settle()
      },
      placeTab: (_s, tab, paneId, index) => {
        const from = panes.find(p => p.tabs.includes(tab))!
        from.tabs = from.tabs.filter(t => t !== tab)
        const to = panes.find(p => p.id === paneId)!
        to.tabs.splice(index ?? to.tabs.length, 0, tab)
        log.push(`place:${tab}`)
        settle()
      },
      resizeSplit: (_s, _id, next) => { sizes = next; log.push(`resize:${next.join(',')}`) },
    }),
  }
  return { face, layout: () => layoutOf(panes, open, sizes), log }
}

describe('agent chat placement over the layout', () => {
  it('opens beside the roster, never in its pane', () => {
    expect(chatPlacementIn(layoutOf([{ id: 'a', tabs: ['agents'] }]), AGENTS)).toEqual({ preferNewPane: true })
    expect(chatPlacementIn(layoutOf([{ id: 'a', tabs: ['agents'] }, { id: 'b', tabs: ['x'] }]), AGENTS)).toEqual({ paneId: 'b' })
    expect(chatPlacementIn(layoutOf([{ id: 'a', tabs: ['x'] }]), AGENTS)).toEqual({ paneId: 'a' })
  })
  it('leaves a roster that is already alone on the left', () => {
    expect(nextRosterStep(layoutOf([{ id: 'a', tabs: ['agents'] }, { id: 'b', tabs: ['x', 'y'] }]), AGENTS)).toBeUndefined()
  })
})

