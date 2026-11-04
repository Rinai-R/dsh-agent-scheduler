/**
 * Roster placement in the right column. A small model of the dock (at most two docked panes, an
 * emptied pane merges away, pages deduplicate only within a pane) stands in for the sidebar, so
 * the chip's whole open path runs against the gestures the real store exposes.
 */
import { describe, expect, it } from 'vitest'
import { openAgentsPage, type SidebarFace } from '../src/client/index.js'
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

describe('Agents page placement', () => {
  it('reopened after closing, while chats fill the column: gets its own left column, not a tab beside them', () => {
    // The reported case: the roster was closed, its pane merged away, two chats remain in one pane.
    const d = dock([{ id: 'pane1', tabs: ['fork-5', 'fork-4'] }])
    openAgentsPage(d.face)
    expect(panesOf(d.layout())).toEqual([['agents'], ['fork-5', 'fork-4']])
    expect((d.layout().nodes.split1 as unknown as { sizes: number[] }).sizes).toEqual([ROSTER_SHARE, 1 - ROSTER_SHARE])
  })
  it('reopened with chats in two panes: takes the left one and moves its chats right', () => {
    const d = dock([{ id: 'pane1', tabs: ['fork-1'] }, { id: 'pane2', tabs: ['fork-2', 'fork-3'] }])
    openAgentsPage(d.face)
    expect(panesOf(d.layout())).toEqual([['agents'], ['fork-2', 'fork-3', 'fork-1']])
  })
  it('already open in the right pane (moved there by hand earlier): moves left, chats stay together', () => {
    const d = dock([{ id: 'pane1', tabs: ['fork-1'] }, { id: 'pane2', tabs: ['agents'] }])
    openAgentsPage(d.face)
    expect(panesOf(d.layout())).toEqual([['agents'], ['fork-1']])
  })
  it('already in place: focuses it and never opens a second Agents page', () => {
    const d = dock([{ id: 'pane1', tabs: ['agents'] }, { id: 'pane2', tabs: ['fork-1'], active: 'fork-1' }])
    openAgentsPage(d.face)
    expect(panesOf(d.layout())).toEqual([['agents'], ['fork-1']])
    expect(d.log).toEqual(['focus:agents', 'focus:agents'])
  })
  it('collapsed with the roster still open: expands the column instead of opening another', () => {
    const d = dock([{ id: 'pane1', tabs: ['agents'] }, { id: 'pane2', tabs: ['fork-1'] }], false)
    openAgentsPage(d.face)
    expect(d.log[0]).toBe('expand:true')
    expect(panesOf(d.layout())).toEqual([['agents'], ['fork-1']])
  })
  it('an empty column: one pane holding only the roster', () => {
    const d = dock([], false)
    openAgentsPage(d.face)
    expect(panesOf(d.layout())).toEqual([['agents']])
  })
})

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

describe('first agent opened from the roster', () => {
  it('narrows the even split preferNewPane made, and leaves a dragged divider alone', async () => {
    const { narrowRoster } = await import('../src/client/index.js')
    const sizes: number[][] = []
    const face = (s: number[]): SidebarFace => ({
      mounted: { getSnapshot: () => 'main' },
      mountedSurface: () => ({ layout: layoutOf([{ id: 'a', tabs: ['agents'] }, { id: 'b', tabs: ['x'] }], true, s) }),
      actionsFor: () => ({ resizeSplit: (_s, _id, next) => { sizes.push(next) } }),
    })
    narrowRoster(face([0.5, 0.5]))
    expect(sizes).toEqual([[ROSTER_SHARE, 1 - ROSTER_SHARE]])
    // A roster that shares its pane is not the roster column; nothing to narrow.
    narrowRoster({ ...face([0.5, 0.5]), mountedSurface: () => ({ layout: layoutOf([{ id: 'a', tabs: ['agents', 'y'] }, { id: 'b', tabs: ['x'] }]) }) })
    expect(sizes).toHaveLength(1)
  })
})
