/**
 * Browser half: renders each handed-off user input where the lead's history no longer holds it,
 * the right-sidebar Agents page, and the Agents chip above the composer. The roster reads the
 * host's `agentScheduler` session projection and the root `useSessionStatus` hook (the only
 * source of "waiting for you"); opening a fork or worker reuses the native subagent-chat
 * resource, so the embedded conversation, its composer and its stop action are the product's own.
 */
import { memo } from 'react'

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
interface State { readonly seq: number; readonly time: number; readonly text: string; readonly forkId: string; readonly fork: 'running' | 'done' | 'failed'; readonly detail?: string }
interface Ctx { key: string; id: string; state?: State; start?: { location: unknown } }

/** One roster row as the host projection emits it. */
interface Member { readonly id: string; readonly name: string; readonly kind: 'fork' | 'worker'; readonly state: string; readonly text: string; readonly role?: string; readonly cwd?: string; readonly model?: string; readonly detail?: string }
interface Roster { readonly role: string | null; readonly members: readonly Member[]; readonly requests: readonly unknown[] }
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
    const detail = match.event.data.detail
    return { ...context.state, fork: match.event.data.state === 'failed' ? 'failed' : 'done', ...(typeof detail === 'string' ? { detail } : {}) }
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
.sch-input-dot{width:6px;height:6px;border-radius:50%;background:var(--sch-dot)}
.sch-input-dot[data-state=running]{--sch-dot:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.sch-input-dot[data-state=done]{--sch-dot:var(--dsw-alias-state-success-primary)}
.sch-input-dot[data-state=failed]{--sch-dot:var(--dsw-alias-state-error-primary)}
/* A wake whose only message was handed off leaves a turn with no content: process row, then tail. */
[data-chat-flow-kind="turn-process"]:has(+ [data-chat-flow-kind="turn-tail"]),
[data-chat-flow-kind="turn-process"] + [data-chat-flow-kind="turn-tail"]{display:none}

/* Agents chip above the composer: the one place that says whether anyone needs you. */
.sch-dock{display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:2px 4px 4px}
.sch-dock-chip{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:3px 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-dock-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-dock-chip[data-needs=yes]{color:var(--dsw-alias-state-warning-primary)}

/* Agents page in the right sidebar. One column of rows, no cards: the list is the content. */
.sch-roster{display:flex;flex-direction:column;height:100%;overflow:auto;padding:6px 0}
.sch-roster-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 12px 6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-collapse{display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:2px 6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-roster-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sch-roster-section{padding:8px 12px 4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;border:0;background:none;padding:6px 12px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,13px)}
.sch-roster-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-row[data-row=archived]{opacity:.55}
.sch-roster-dot{width:6px;height:6px;border-radius:50%;background:var(--sch-dot,var(--dsw-alias-label-quaternary))}
.sch-roster-dot[data-row=running]{--sch-dot:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.sch-roster-dot[data-row=waiting]{--sch-dot:var(--dsw-alias-state-warning-primary)}
.sch-roster-dot[data-row=done]{--sch-dot:var(--dsw-alias-state-success-primary)}
.sch-roster-dot[data-row=failed]{--sch-dot:var(--dsw-alias-state-error-primary)}
.sch-roster-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.sch-roster-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-roster-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-state{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap}
.sch-roster-state[data-row=running]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.sch-roster-state[data-row=waiting]{color:var(--dsw-alias-state-warning-primary)}
.sch-roster-state[data-row=failed]{color:var(--dsw-alias-state-error-primary)}
.sch-roster-empty{padding:12px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
`

const INPUT_LABEL = { running: '分身处理中', done: '分身已交回', failed: '分身启动失败' } as const

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
    const parts = [
      counts.running === 0 ? undefined : `${counts.running} 在跑`,
      counts.waiting === 0 ? undefined : `${counts.waiting} 等你`,
      counts.queued === 0 ? undefined : `${counts.queued} 排队`,
      counts.failed === 0 ? undefined : `${counts.failed} 失败`,
    ].filter((part): part is string => part !== undefined)
    return (
      <div className="sch-dock">
        <button type="button" className="sch-dock-chip" data-needs={counts.waiting > 0 ? 'yes' : 'no'} onClick={openAgents} title="打开 Agents">
          <span className="sch-roster-dot" data-row={counts.waiting > 0 ? 'waiting' : counts.running > 0 ? 'running' : 'queued'} />
          Agents{parts.length === 0 ? '' : ` · ${parts.join(' · ')}`}
        </button>
      </div>
    )
  })
}

/**
 * Create the Agents page body for the right sidebar.
 * @param ctx - client plugin context, for the controller's known child addresses.
 * @returns the slot component.
 */
export function createAgentsPage(ctx: { sessions?: { subagentAddress?: (id: string) => { parentSessionId?: string; mode?: string } | undefined } }) {
  return memo(function AgentsPage(props: {
    sessionId?: string
    useProjection?: (key: string) => unknown
    useSessionStatus?: UseSessionStatus
    useTabInfo?: () => { tab: { actions: { openResource: (address: string, options?: Record<string, unknown>) => void; close: () => void } } }
  }) {
    const roster = rosterOf(props)
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    const tab = props.useTabInfo?.()
    const open = (member: Member) => {
      if (props.sessionId === undefined || tab === undefined) return
      tab.tab.actions.openResource(subagentAddress(ctx, props.sessionId, member.id), { preferNewPane: true })
    }
    const rows = roster?.members ?? []
    const forks = rows.filter(m => m.kind === 'fork' && m.state !== 'archived')
    const workers = rows.filter(m => m.kind === 'worker' && m.state !== 'archived')
    const archived = rows.filter(m => m.state === 'archived')
    const row = (member: Member) => {
      const state = rowStateOf(member, statuses)
      return (
        <button type="button" key={member.id} className="sch-roster-row" data-row={state} onClick={() => { open(member) }} title={member.id}>
          <span className="sch-roster-dot" data-row={state} />
          <span className="sch-roster-main">
            <span className="sch-roster-name">{member.name}</span>
            <span className="sch-roster-sub">{member.kind === 'fork' ? member.text : (member.role ?? member.text)}</span>
          </span>
          <span className="sch-roster-state" data-row={state}>{STATE_LABEL[state]}</span>
        </button>
      )
    }
    const section = (title: string, members: readonly Member[]) => members.length === 0 ? null : (
      <>
        <div className="sch-roster-section">{title}</div>
        {members.map(member => row(member))}
      </>
    )
    return (
      <div className="sch-roster" data-scheduler-roster="">
        <div className="sch-roster-head">
          <span>{rows.length === 0 ? '' : `${rows.filter(m => m.state !== 'archived').length} 个 agent`}</span>
          <button type="button" className="sch-roster-collapse" title="收起这一栏；点输入框上方的 Agents chip 可以再打开" onClick={() => { tab?.tab.actions.close() }}>收起 ⇥</button>
        </div>
        {rows.length === 0
          ? <div className="sch-roster-empty">还没有分身或 worker。发一条消息给 lead。</div>
          : (
            <>
              {section('分身', forks)}
              {section('Worker', workers)}
              {section('已归档', archived)}
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
  const open = (parent: string, child: string) => {
    const address = { parentSessionId: parent, childSessionId: child, mode: 'continuable' }
    const sidebar = ctx.sidebarRight as { openResource?: (address: string, options?: Record<string, unknown>) => void } | undefined
    if (sidebar?.openResource === undefined) { ctx.uiWorkspace?.openSession(address); return }
    sidebar.openResource(subagentAddress(ctx, parent, child), { kind: 'subagentchat', preferNewPane: true })
  }
  const openAgents = () => {
    const sidebar = ctx.sidebarRight as { mounted?: { getSnapshot: () => unknown }; openTab?: (kind: string, options?: Record<string, unknown>) => void } | undefined
    if (sidebar?.openTab === undefined || sidebar.mounted?.getSnapshot() === undefined) return
    sidebar.openTab(AGENTS_KIND, { revealIfOpened: true })
  }
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
