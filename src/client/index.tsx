/**
 * Browser half: renders each handed-off user input where the lead's history no longer holds it,
 * the right-sidebar Agents page, and the Agents chip above the composer. The roster reads the
 * host's `agentScheduler` session projection and the root `useSessionStatus` hook (the only
 * source of "waiting for you"); opening a fork or worker reuses the native subagent-chat
 * resource, so the embedded conversation, its composer and its stop action are the product's own.
 */
import { memo, useState } from 'react'
import { activeChild, chatPlacementIn, dockPanes, findRoster, nextRosterStep, ROSTER_SHARE, type DockLayout } from './layout.js'

const INPUT = 'plugin:dsh-agent-scheduler/input'
const FORK_STATE = 'plugin:dsh-agent-scheduler/fork-state'
const NODE_KIND = 'scheduler-input'

/** Projection key registered by the host half. */
const ROSTER = 'agentScheduler'
/** Tab-system identity of the Agents page; also the keyed body's key. */
const AGENTS_ID = 'dsh-agent-scheduler/agents'
/** Page kind, opened by name because the type has no resource patterns. */
const AGENTS_KIND = 'agent-scheduler-agents'

export const name = 'dsh-agent-scheduler'
export const inject = ['slots', 'uiConversation', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace']

interface Event { type: string; seq: number; time: number; data: Record<string, unknown> }
type CardState = 'queued' | 'running' | 'done' | 'failed' | 'archived'
interface State { readonly seq: number; readonly time: number; readonly text: string; readonly forkId: string; readonly fork: CardState; readonly detail?: string }

/** Fork-state record → what the card says. `started` follows a wait in the queue. */
const CARD_STATE: Record<string, CardState> = { queued: 'queued', started: 'running', done: 'done', failed: 'failed', archived: 'archived' }
interface Ctx { key: string; id: string; state?: State; start?: { location: unknown } }

/** One roster row as the host projection emits it. */
interface Member { readonly id: string; readonly name: string; readonly kind: 'fork' | 'worker'; readonly state: string; readonly text: string; readonly role?: string; readonly cwd?: string; readonly model?: string; readonly detail?: string }
interface Roster { readonly role: string | null; readonly members: readonly Member[]; readonly openRequests: readonly { id: string; from: string; to: string; text: string }[] }
/** One Session's live status as the client root hook reports it. */
interface StatusRow { running?: boolean; pendingInteraction?: unknown; completionUnread?: boolean }
type Statuses = Map<string, StatusRow>
type UseSessionStatus = (selector: (value: Statuses) => Statuses) => Statuses

/** What the roster draws for one member: lifecycle record, refined by live status. */
type RowState = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'queued' | 'archived'

/** Input card state machine: starts at the input record, updated by the fork's state records. */
export const inputDefinition = {
  kind: 'scheduler-input',
  target: 'chat',
  match: (event: Event) => {
    if (event.type === INPUT) return { id: String(event.data.forkId), role: 'start' as const }
    if (event.type === FORK_STATE) return { id: String(event.data.forkId), role: 'update' as const }
    return null
  },
  start: (_context: Ctx, match: { event: Event }): State => ({
    seq: match.event.seq,
    time: match.event.time,
    text: String(match.event.data.text ?? ''),
    forkId: String(match.event.data.forkId),
    fork: 'running',
  }),
  update: (context: Ctx & { state: State }, match: { event: Event }): State => {
    if (match.event.type !== FORK_STATE) return context.state
    const fork = CARD_STATE[String(match.event.data.state)]
    if (fork === undefined) return context.state
    const { detail: _, ...rest } = context.state
    const detail = match.event.data.detail
    return { ...rest, fork, ...(typeof detail === 'string' && fork === 'failed' ? { detail } : {}) }
  },
  buildViewNode: (context: Ctx) => context.state === undefined ? null : {
    key: context.key,
    kind: NODE_KIND,
    id: context.id,
    target: 'chat',
    anchorSeq: context.state.seq,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: context.state,
  },
}

const STYLE = `
.sch-input{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.sch-input-bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:min(calc(var(--dsh-chat-content-width,748px)*.702),82%);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}
.sch-input-fork{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:2px 6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-input-fork:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sch-input-dot,.sch-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--sch-dot,var(--dsw-alias-label-caption))}
:is(.sch-input,.sch-roster,.sch-dock) [data-state=running],:is(.sch-input,.sch-roster,.sch-dock) [data-row=running]{--sch-dot:var(--dsw-alias-brand-primary-new-colorprimary-new-color);--sch-tone:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
:is(.sch-input,.sch-roster,.sch-dock) [data-state=done],:is(.sch-input,.sch-roster,.sch-dock) [data-row=done]{--sch-dot:var(--dsw-alias-state-success-primary)}
:is(.sch-input,.sch-roster,.sch-dock) [data-state=failed],:is(.sch-input,.sch-roster,.sch-dock) [data-row=failed]{--sch-dot:var(--dsw-alias-state-error-primary);--sch-tone:var(--dsw-alias-state-error-primary)}
:is(.sch-input,.sch-roster,.sch-dock) [data-row=waiting]{--sch-dot:var(--dsw-alias-state-warn-primary);--sch-tone:var(--dsw-alias-state-warn-primary)}
.sch-dot[data-row=running]{box-shadow:0 0 0 0 var(--sch-dot);animation:sch-pulse 1.8s ease-out infinite}
@keyframes sch-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sch-dot) 55%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
/* A wake whose only message was handed off leaves a turn with no content: process row, then tail. */
[data-chat-flow-kind="turn-process"]:has(+ [data-chat-flow-kind="turn-tail"]),
[data-chat-flow-kind="turn-process"] + [data-chat-flow-kind="turn-tail"]{display:none}

/* Agents chip above the composer: a quiet pill; it only takes colour when someone needs you. */
.sch-dock{display:flex;align-items:center;justify-content:flex-end;padding:0 6px 6px}
.sch-dock-chip{display:inline-flex;align-items:center;gap:7px;height:26px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);padding:0 11px;border-radius:999px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background .15s,color .15s}
.sch-dock-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-dock-chip[data-needs=yes]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.sch-dock-sep{color:var(--dsw-alias-label-caption)}

/* Agents page: its own narrow column at the left of the right sidebar, a list of agents. */
.sch-roster{display:flex;flex-direction:column;height:100%;overflow:auto;padding:0 0 12px;font-size:13px}
.sch-roster-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:14px 12px 6px 18px}
.sch-roster-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.sch-roster-summary{margin-top:2px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-collapse{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;background:none;padding:0;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-roster-section{display:flex;justify-content:space-between;gap:8px;padding:14px 18px 6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-row{position:relative;display:grid;grid-template-columns:7px minmax(0,1fr) auto;align-items:center;column-gap:10px;margin:1px 8px;border:0;background:none;padding:8px 10px;border-radius:10px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);transition:background .12s}
.sch-roster-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-row[data-selected=yes]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.sch-roster-row[data-row=archived] .sch-roster-name{color:var(--dsw-alias-label-tertiary)}
.sch-roster-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.sch-roster-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:18px}
.sch-roster-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-end{display:flex;align-items:center;gap:2px}
.sch-roster-state{color:var(--sch-tone,var(--dsw-alias-label-tertiary));font:var(--dsw-font-xxs-12);white-space:nowrap}
.sch-roster-chev{color:var(--dsw-alias-label-caption);opacity:0;transition:opacity .12s}
.sch-roster-row:hover .sch-roster-chev,.sch-roster-row[data-selected=yes] .sch-roster-chev{opacity:1}
.sch-roster-fold{display:flex;align-items:center;gap:4px;margin:6px 8px 0;border:0;background:none;padding:6px 10px;border-radius:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer;text-align:left}
.sch-roster-fold:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sch-roster-fold svg{transition:transform .15s}
.sch-roster-fold[aria-expanded=true] svg{transform:rotate(90deg)}
.sch-roster-empty{margin:auto;padding:24px;max-width:220px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
`

const INPUT_LABEL: Record<CardState, string> = { queued: '分身排队中', running: '分身处理中', done: '分身已交回', failed: '分身启动失败', archived: '分身已归档' }

const STATE_LABEL: Record<RowState, string> = {
  running: '在跑',
  waiting: '在等你',
  idle: '空闲',
  done: '已交回',
  failed: '失败',
  queued: '排队中',
  archived: '已归档',
}

/**
 * Refine one member's lifecycle record with the live status the client hook reports.
 * @param member - a roster row.
 * @param statuses - the root Session-status map.
 * @returns what to draw.
 */
export function rowStateOf(member: Member, statuses: Statuses | undefined): RowState {
  if (member.state === 'archived' || member.state === 'failed' || member.state === 'queued' || member.state === 'done') {
    return member.state as RowState
  }
  const status = statuses?.get(member.id)
  if (status?.pendingInteraction !== undefined) return 'waiting'
  return status?.running === true ? 'running' : 'idle'
}

/**
 * Address of one child's native sidebar chat, preferring the controller's known mode.
 * @param ctx - client plugin context.
 * @param parent - main Session id, the fallback parent when the controller has no address.
 * @param child - fork or worker Session id.
 * @returns the resource address.
 */
export function subagentAddress(
  ctx: { sessions?: { subagentAddress?: (id: string) => { parentSessionId?: string; mode?: string } | undefined } },
  parent: string,
  child: string,
): string {
  const known = ctx.sessions?.subagentAddress?.(child)
  const query = new URLSearchParams({ parent: known?.parentSessionId ?? parent, mode: known?.mode ?? 'continuable' })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(child)}?${query}`
}

/**
 * Where an agent's chat goes in the right column: a docked pane other than the one showing the
 * Agents page, so opening a second agent never covers the roster. The column allows two panes;
 * once both exist, `preferNewPane` no longer splits and would drop the chat into the active pane,
 * which is the roster's pane right after a row click.
 * @param doc - the document.
 * @param rosterPane - the Agents page's own pane id, when known.
 * @returns placement options for `openResource`.
 */
export function chatPlacement(doc: Pick<Document, 'querySelectorAll'>, rosterPane?: string): { paneId: string } | { preferNewPane: true } {
  const panes = [...doc.querySelectorAll<HTMLElement>('[data-sidebar-right-session]:not([hidden]) [data-dockkit-pane]')]
  const holding = rosterPane ?? panes.find(p => p.querySelector('[data-scheduler-roster]') !== null)?.dataset.dockkitPane
  const other = panes.map(p => p.dataset.dockkitPane).find(id => id !== undefined && id !== '' && id !== holding)
  return other === undefined ? { preferNewPane: true } : { paneId: other }
}

/**
 * Read the roster projection, tolerating a missing hook.
 * @param props - framework standard props of the seat.
 * @returns the roster, or undefined before it exists.
 */
function rosterOf(props: { useProjection?: (key: string) => unknown }): Roster | undefined {
  if (props.useProjection === undefined) return undefined
  return props.useProjection(ROSTER) as Roster | undefined
}

/**
 * Count what the dock chip reports.
 * @param members - roster rows.
 * @param statuses - the root Session-status map.
 * @returns the four counts.
 */
function countsOf(members: readonly Member[], statuses: Statuses | undefined) {
  let running = 0
  let waiting = 0
  let queued = 0
  let failed = 0
  for (const member of members) {
    const state = rowStateOf(member, statuses)
    if (state === 'running') running += 1
    else if (state === 'waiting') waiting += 1
    else if (state === 'queued') queued += 1
    else if (state === 'failed') failed += 1
  }
  return { running, waiting, queued, failed }
}

/**
 * Create the input card bound to its sidebar opener.
 * @param open - opens a fork beside the main session.
 * @returns the slot component.
 */
export function createInputCard(open: (parent: string, child: string) => void) {
  return memo(function InputCard({ node, sessionId }: { node: { data: State }; sessionId: string }) {
    const { text, fork, forkId, detail } = node.data
    return (
      <div className="sch-input" data-scheduler-input="" data-fork-state={fork}>
        <div className="sch-input-bubble">{text}</div>
        <button type="button" className="sch-input-fork" title={detail ?? forkId} onClick={() => { open(sessionId, forkId) }}>
          <span className="sch-input-dot" data-state={fork} />
          {INPUT_LABEL[fork]}{detail === undefined ? '' : `：${detail}`}
        </button>
      </div>
    )
  })
}

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
interface DockActions {
  dropTab?: (sessionId: string, tabId: string, paneId: string, zone: 'left') => void
  placeTab?: (sessionId: string, tabId: string, paneId: string, index?: number) => void
  resizeSplit?: (sessionId: string, splitId: string, sizes: number[]) => void
}

/**
 * Give the Agents page a column of its own at the left of the right sidebar, moving any other
 * tab out of that column, and size it narrow when this call made the split. Each step is a
 * gesture the user could make by hand, so undo and saved layouts treat it the same way.
 * @param sidebar - `ctx.sidebarRight`.
 */
export function arrangeRoster(sidebar: SidebarFace | undefined): void {
  const sessionId = sidebar?.mounted?.getSnapshot()
  const actions = sessionId === undefined ? undefined : sidebar?.actionsFor?.(sessionId)
  if (sidebar === undefined || sessionId === undefined || actions === undefined) return
  let split = false
  for (let i = 0; i < 12; i += 1) {
    const layout = sidebar.mountedSurface?.()?.layout
    const step = layout === undefined ? undefined : nextRosterStep(layout, AGENTS_KIND)
    if (step === undefined) break
    if (step.op === 'drop') {
      if (actions.dropTab === undefined) break
      actions.dropTab(sessionId, step.tabId, step.paneId, step.zone)
      split = true
    } else {
      if (actions.placeTab === undefined) break
      actions.placeTab(sessionId, step.tabId, step.paneId, step.index)
    }
  }
  const layout = sidebar.mountedSurface?.()?.layout
  const root = layout?.nodes[layout.rootId]
  if (split && root?.kind === 'split' && actions.resizeSplit !== undefined) {
    actions.resizeSplit(sessionId, root.id, [ROSTER_SHARE, 1 - ROSTER_SHARE])
  }
  const roster = layout === undefined ? undefined : findRoster(layout, AGENTS_KIND)
  if (roster !== undefined) sidebar.focus?.(roster.tabId)
}

/**
 * Open the Agents page, or bring back the one already open wherever it sits, then give it its
 * own left column. Pages deduplicate only within one pane, so an open roster is focused rather
 * than opened again into whichever pane is active.
 * @param sidebar - `ctx.sidebarRight`.
 */
export function openAgentsPage(sidebar: SidebarFace | undefined): void {
  if (sidebar?.openTab === undefined || sidebar.mounted?.getSnapshot() === undefined) return
  try {
    const layout = sidebar.mountedSurface?.()?.layout
    const roster = layout === undefined ? undefined : findRoster(layout, AGENTS_KIND)
    if (roster !== undefined && roster.pane.host === 'dock') {
      if (sidebar.isExpanded?.() === false) sidebar.toggleExpanded?.()
      sidebar.focus?.(roster.tabId)
    } else if (roster === undefined) {
      const left = layout === undefined || layout.expanded === false ? undefined : dockPanes(layout)[0]
      sidebar.openTab(AGENTS_KIND, { revealIfOpened: true, ...(left === undefined ? {} : { paneId: left.id }) })
    } else {
      sidebar.focus?.(roster.tabId)
      return
    }
    arrangeRoster(sidebar)
  } catch {
    sidebar.openTab(AGENTS_KIND, { revealIfOpened: true })
  }
}

/**
 * Where an agent chat opens, from the live layout when the sidebar exposes it.
 * @param sidebar - `ctx.sidebarRight`.
 * @param rosterPane - the Agents page's own pane id, when known.
 * @returns placement options for `openResource`.
 */
function placeChat(sidebar: SidebarFace | undefined, rosterPane?: string) {
  const layout = sidebar?.mountedSurface?.()?.layout
  return layout === undefined ? chatPlacement(document, rosterPane) : chatPlacementIn(layout, AGENTS_KIND)
}

const ICON = {
  collapse: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11M5.5 6.5 7.5 8l-2 1.5" />
    </svg>
  ),
  chevron: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
  ),
}

/**
 * The one-line totals shared by the chip and the page header.
 * @param counts - live counts.
 * @param total - members that are not archived.
 * @returns the parts, in order of urgency.
 */
function summaryParts(counts: ReturnType<typeof countsOf>, total: number): string[] {
  const parts = [
    counts.waiting === 0 ? undefined : `${counts.waiting} 等你`,
    counts.running === 0 ? undefined : `${counts.running} 在跑`,
    counts.queued === 0 ? undefined : `${counts.queued} 排队`,
    counts.failed === 0 ? undefined : `${counts.failed} 失败`,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 || total === 0 ? parts : ['都已停下']
}

/**
 * Narrow a roster pane that a chat just split off: `preferNewPane` splits evenly, and the list
 * needs far less room than a conversation. Only called right after that split, so a divider the
 * user dragged stays where they left it.
 * @param sidebar - `ctx.sidebarRight`.
 */
export function narrowRoster(sidebar: SidebarFace | undefined): void {
  const sessionId = sidebar?.mounted?.getSnapshot()
  const layout = sidebar?.mountedSurface?.()?.layout
  const root = layout?.nodes[layout.rootId]
  if (sessionId === undefined || layout === undefined || root?.kind !== 'split') return
  const roster = findRoster(layout, AGENTS_KIND)
  const [left] = dockPanes(layout)
  if (roster === undefined || left === undefined || roster.pane.id !== left.id || left.tabs.length !== 1) return
  sidebar?.actionsFor?.(sessionId)?.resizeSplit?.(sessionId, root.id, [ROSTER_SHARE, 1 - ROSTER_SHARE])
}

/**
 * Create the dock chip that shows the roster's totals and opens the Agents page.
 * @param openAgents - opens (or focuses) the Agents tab.
 * @returns the slot component.
 */
export function createAgentsDock(openAgents: () => void) {
  return memo(function AgentsDock(props: { useProjection?: (key: string) => unknown; useSessionStatus?: UseSessionStatus }) {
    const roster = rosterOf(props)
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    if (roster === undefined || roster.members.length === 0) return null
    const counts = countsOf(roster.members, statuses)
    const live = counts.running + counts.waiting + counts.queued + counts.failed
    const parts = live === 0 ? [] : summaryParts(counts, live)
    return (
      <div className="sch-dock">
        <button type="button" className="sch-dock-chip" data-needs={counts.waiting > 0 ? 'yes' : 'no'} onClick={openAgents} title="打开 Agents">
          {live === 0 ? null : <span className="sch-dot" data-row={counts.waiting > 0 ? 'waiting' : counts.failed > 0 && counts.running === 0 ? 'failed' : counts.running > 0 ? 'running' : 'queued'} />}
          <span>Agents</span>
          {parts.map(part => <span key={part}><span className="sch-dock-sep">· </span>{part}</span>)}
        </button>
      </div>
    )
  })
}

/**
 * The second line of a row: what a fork was asked, or a worker's directory and duty.
 * @param member - a roster row.
 * @returns the line.
 */
export function subline(member: Member): string {
  const failure = member.state === 'failed' ? member.detail : undefined
  if (member.kind === 'fork') return failure ?? member.text
  const dir = member.cwd === undefined ? undefined : member.cwd.replace(/\/+$/u, '').split('/').pop()
  const duty = failure ?? member.role ?? member.text
  return [dir, duty].filter(part => part !== undefined && part !== '').join(' · ')
}

/**
 * Create the Agents page body for the right sidebar.
 * @param ctx - client plugin context, for the controller's known child addresses.
 * @returns the slot component.
 */
export function createAgentsPage(ctx: {
  sessions?: { subagentAddress?: (id: string) => { parentSessionId?: string; mode?: string } | undefined }
  sidebarRight?: SidebarFace
}) {
  return memo(function AgentsPage(props: {
    sessionId?: string
    useProjection?: (key: string) => unknown
    useSessionStatus?: UseSessionStatus
    useTabInfo?: () => { panel?: { id?: string }; tab: { actions: { openResource: (address: string, options?: Record<string, unknown>) => void; close: () => void } } }
  }) {
    const roster = rosterOf(props)
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    const tab = props.useTabInfo?.()
    const rows = roster?.members ?? []
    const [picked, setPicked] = useState<string | undefined>(undefined)
    const [showArchived, setShowArchived] = useState(false)
    const layout = ctx.sidebarRight?.mountedSurface?.()?.layout
    const selected = (layout === undefined ? undefined : activeChild(layout, AGENTS_KIND, rows.map(m => m.id))) ?? picked
    const open = (member: Member) => {
      if (props.sessionId === undefined || tab === undefined) return
      setPicked(member.id)
      const placement = placeChat(ctx.sidebarRight, tab.panel?.id)
      tab.tab.actions.openResource(subagentAddress(ctx, props.sessionId, member.id), placement)
      if ('preferNewPane' in placement) narrowRoster(ctx.sidebarRight)
    }
    // Fold the whole column, keeping its tabs: closing only this tab would leave open agent chats
    // holding the column's width. The runtime's header button and the chip expand it again.
    const collapse = () => {
      const sidebar = ctx.sidebarRight
      if (sidebar?.toggleExpanded !== undefined && sidebar.isExpanded?.() !== false) sidebar.toggleExpanded()
      else tab?.tab.actions.close()
    }
    const live = rows.filter(m => m.state !== 'archived')
    const forks = live.filter(m => m.kind === 'fork')
    const workers = live.filter(m => m.kind === 'worker')
    const archived = rows.filter(m => m.state === 'archived')
    const counts = countsOf(rows, statuses)
    const row = (member: Member) => {
      const state = rowStateOf(member, statuses)
      return (
        <button type="button" key={member.id} className="sch-roster-row" data-row={state} data-selected={member.id === selected ? 'yes' : 'no'} onClick={() => { open(member) }} title={member.id}>
          <span className="sch-dot" data-row={state} />
          <span className="sch-roster-main">
            <span className="sch-roster-name">{member.name}</span>
            <span className="sch-roster-sub">{subline(member)}</span>
          </span>
          <span className="sch-roster-end">
            <span className="sch-roster-state" data-row={state}>{STATE_LABEL[state]}</span>
            <span className="sch-roster-chev">{ICON.chevron}</span>
          </span>
        </button>
      )
    }
    const section = (title: string, members: readonly Member[]) => {
      if (members.length === 0) return null
      const busy = members.filter(m => { const s = rowStateOf(m, statuses); return s === 'running' || s === 'waiting' }).length
      return (
        <>
          <div className="sch-roster-section"><span>{title}</span><span>{busy === 0 ? members.length : `${busy} / ${members.length} 在忙`}</span></div>
          {members.map(member => row(member))}
        </>
      )
    }
    return (
      <div className="sch-roster" data-scheduler-roster="">
        <div className="sch-roster-head">
          <div>
            <div className="sch-roster-title">Agents</div>
            <div className="sch-roster-summary">{live.length === 0 ? '还没有 agent' : [`${live.length} 个`, ...summaryParts(counts, live.length)].join(' · ')}</div>
          </div>
          <button type="button" className="sch-roster-collapse" aria-label="收起右栏" title="收起右栏（Agents 和已打开的对话都保留）" onClick={collapse}>{ICON.collapse}</button>
        </div>
        {rows.length === 0
          ? <div className="sch-roster-empty">还没有分身或 worker。<br />在主会话里说一件事，lead 会交给一个分身去做。</div>
          : (
            <>
              {section('分身', forks)}
              {section('Worker', workers)}
              {archived.length === 0 ? null : (
                <>
                  <button type="button" className="sch-roster-fold" aria-expanded={showArchived} onClick={() => { setShowArchived(v => !v) }}>
                    {ICON.chevron}已归档 {archived.length}
                  </button>
                  {showArchived ? archived.map(member => row(member)) : null}
                </>
              )}
            </>
          )}
      </div>
    )
  })
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function apply(ctx: any): void {
  ctx.uiConversation.events.register(inputDefinition)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-agent-scheduler'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'agent-scheduler: styles')
  const sidebar = () => ctx.sidebarRight as SidebarFace | undefined
  const open = (parent: string, child: string) => {
    const address = { parentSessionId: parent, childSessionId: child, mode: 'continuable' }
    const face = sidebar()
    if (face?.openResource === undefined) { ctx.uiWorkspace?.openSession(address); return }
    const placement = placeChat(face)
    face.openResource(subagentAddress(ctx, parent, child), { kind: 'subagentchat', ...placement })
    if ('preferNewPane' in placement) narrowRoster(face)
  }
  const openAgents = () => { openAgentsPage(sidebar()) }
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, createInputCard(open)))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: AGENTS_ID,
    kind: AGENTS_KIND,
    priority: 'extension',
    title: () => 'Agents',
    keepMounted: true,
  }), 'agent-scheduler: agents tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: AGENTS_ID }, createAgentsPage(ctx)))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'agent-scheduler', order: 10 }, createAgentsDock(openAgents)))
}
