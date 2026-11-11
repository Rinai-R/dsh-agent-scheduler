/**
 * Browser half: renders each handed-off user input where the lead's history no longer holds it,
 * the right-sidebar Agents page, and the scheduling switch in the composer's mode row. The roster reads the
 * host's `agentScheduler` session projection and the root `useSessionStatus` hook (the only
 * source of "waiting for you"); opening a fork or worker reuses the native subagent-chat
 * resource, so the embedded conversation, its composer and its stop action are the product's own.
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { registerRecoveryConfig } from './recovery-config.js'
import { catalogModel, MODEL_MENU_STYLE, ModelMenu, type CatalogGroup } from './model-menu.js'
import { catalogSource, isStale, type CatalogSource } from './catalog-source.js'
import { chatPlacementIn, visibleChildren } from './layout.js'
import { autoSeenTargets, browserSeen, type LocalSeen } from './active-seen.js'
import { reviewOf } from '../review.js'
import type { MailDelivery, MailItem } from '../projection.js'
import { createInboxCard, createSessionDock, DOCK_STYLE, dockModel } from './dock.js'
import { ACCESS_STYLE, AccessPicker } from './access-picker.js'
import type { RowState } from './row-state.js'
import type { TeamView } from '../projection.js'
import { t, tn, useLocale } from './i18n.js'
import {
  chatPlacement, clientHost, followDshLocale, HOST_CSS, injectStyle, keepChatTabsMounted, layoutOf, NO_FACE, registerChatEvent, registerSlot, SEL,
  steadyTabStrips, SUBAGENT_CHAT_KIND, type ClientHost, type Face, type SidebarFace, type Statuses, type UseSessionStatus,
} from '../dsh/client/index.js'

// Moved to the DSH adapter (src/dsh/client); re-exported for callers of this module.
export { chatPlacement, commandFailure, retainChatTabs, steadyTabStrips, subagentAddress, type Face, type SidebarFace, type TabTypesFace } from '../dsh/client/index.js'

const INPUT = 'plugin:dsh-agent-scheduler/input'
const FORK_STATE = 'plugin:dsh-agent-scheduler/fork-state'
const NODE_KIND = 'scheduler-input'
const REQUEST_KIND = 'scheduler-request'

/** Projection key registered by the host half. */
const ROSTER = 'agentScheduler'
/** Page kind, opened by name because the type has no resource patterns. */
const AGENTS_KIND = 'agent-scheduler-agents'
export const name = 'dsh-agent-scheduler'
export const inject = ['slots', 'uiConversation', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'remote', 'remote.commands', 'remote.session']

interface Event { type: string; seq: number; time: number; data: Record<string, unknown> }
type CardState = 'queued' | 'running' | 'done' | 'failed' | 'archived'
interface State { readonly seq: number; readonly time: number; readonly text: string; readonly forkId: string; readonly fork: CardState; readonly detail?: string; /** The chat already shows the user's own message (with its images); the card adds only the status. */ readonly logged?: true; /** `fork-N`; absent in the oldest records. */ readonly name?: string }

/** Fork-state record → what the card says. `started` follows a wait in the queue. */
const CARD_STATE: Record<string, CardState> = { queued: 'queued', started: 'running', done: 'done', failed: 'failed', archived: 'archived' }
interface Ctx { key: string; id: string; state?: State; start?: { location: unknown } }

/** One roster row as the host projection emits it. */
interface Member { readonly id: string; readonly name: string; readonly kind: 'fork' | 'worker'; readonly state: string; readonly text: string; readonly role?: string; readonly cwd?: string; readonly model?: string; readonly area?: string; readonly detail?: string; readonly pickedModel?: ForkModel; readonly reportedAt?: number; readonly reportFailed?: true; readonly seenAt?: number; readonly accessPreset?: string; readonly accessBy?: 'user' | 'lead' | 'inherited'; readonly session?: true }
/** Provider route and model, as `/fork model` records it. */
export interface ForkModel { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
interface Roster {
  readonly enabled?: boolean; readonly role: string | null; readonly workerModel?: ForkModel | null; readonly members: readonly Member[]; readonly openRequests: readonly { id: string; from: string; to: string; text: string }[]
  /** The lead's inbox in delivery order; absent from a host not restarted since it existed. */
  readonly inbox?: readonly MailItem[]
  readonly delivered?: MailDelivery
  /** Merges under way; absent from a host not restarted since merges existed. */
  readonly merging?: readonly { id: string; absorbed: string; survivor: string; state: string }[]
  readonly teams?: Readonly<Record<string, TeamView>>
  /** Access modes the host offers; absent when it has no permission presets. */
  readonly accessModes?: readonly { readonly name: string; readonly sandbox: string }[]
}
/** One Session's live status as the client root hook reports it. */

/** What the roster draws for one member: lifecycle record, refined by live status. */

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
    ...(match.event.data.logged === true ? { logged: true as const } : {}),
    ...(typeof match.event.data.name === 'string' ? { name: match.event.data.name } : {}),
  }),
  update: (context: Ctx & { state: State }, match: { event: Event }): State => {
    if (match.event.type !== FORK_STATE) return context.state
    const fork = CARD_STATE[String(match.event.data.state)]
    if (fork === undefined) return context.state
    // A fork archives itself after concluding; its card keeps saying it handed back.
    if (fork === 'archived' && context.state.fork === 'done') return context.state
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

/** What a request steered into a running member's round shows. */
interface RequestCard { readonly seq: number; readonly id: string; readonly from: string; readonly text: string; /** False when the runtime already shows it (it opened its own turn). */ readonly steered: boolean }
interface MessageEvent { type: string; seq: number; time: number; data: { id?: unknown; content?: unknown; source?: { kind?: unknown } } }
interface Located { location?: { kind?: string; step?: { step?: number } } }

/**
 * Parse a scheduler request relayed into a member: `[request r-N from name]` then the text.
 * @param event - a `user/message` event of the member's log.
 * @returns the request, or undefined for any other message.
 */
export function requestOf(event: MessageEvent): Omit<RequestCard, 'seq' | 'steered'> | undefined {
  if (event.type !== 'user/message' || event.data.source?.kind !== 'agent-message' || !Array.isArray(event.data.content)) return undefined
  for (const block of event.data.content as { type?: unknown; text?: unknown }[]) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const head = /^\[request (r-\d+) from ([^\]\n]+)\]\n?/u.exec(block.text)
    if (head !== null) return { id: head[1]!, from: head[2]!, text: block.text.slice(head[0].length) }
  }
  return undefined
}

/**
 * A request that reached a member while it was running. The runtime steers it into the round in
 * progress (step 2 or later), where the chat shows ordinary context as nothing at all; the round
 * then answers it with whatever it concludes. A request that wakes an idle member opens a turn
 * at step 1 and already has the runtime's own 「收到任务消息」 row, so it is left alone.
 */
export const requestDefinition = {
  kind: REQUEST_KIND,
  target: 'chat',
  match: (event: MessageEvent) => requestOf(event) === undefined ? null : { id: String(event.data.id), role: 'start' as const },
  // The engine requires a state from every start, so a request that needs no card is kept as
  // one that builds no node.
  start: (_context: unknown, match: { event: MessageEvent } & Located): RequestCard => {
    const step = match.location?.kind === 'step' ? match.location.step?.step : undefined
    const request = requestOf(match.event) ?? { id: '', from: '', text: '' }
    return { seq: match.event.seq, ...request, steered: step !== undefined && step >= 2 }
  },
  update: (context: { state?: RequestCard }) => context.state,
  buildViewNode: (context: { key: string; id: string; state?: RequestCard | undefined; start?: { location: unknown } }) => context.state?.steered !== true ? null : {
    key: context.key,
    kind: REQUEST_KIND,
    id: context.id,
    target: 'chat',
    anchorSeq: context.state.seq,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: context.state,
  },
}

/** The card for {@link requestDefinition}. */
export const RequestCardView = memo(function RequestCardView({ node }: { node: { data: RequestCard } }) {
  useLocale()
  const { id, from, text } = node.data
  return (
    <details className="sch-request" data-scheduler-request={id}>
      <summary><span className="sch-request-dot" />{t('request.summary', { id, from })}<span className="sch-request-hint">{t('request.hint')}</span></summary>
      <div className="sch-request-body">{text}</div>
    </details>
  )
})

const STYLE = `
.sch-request{margin:4px 0;border:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-interactive-bg-hover));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-markdown-code-block,transparent);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.sch-request summary{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;list-style:none}
.sch-request summary::-webkit-details-marker{display:none}
.sch-request-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,currentColor)}
.sch-request-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.sch-request-body{padding:0 14px 10px 29px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;color:var(--dsw-alias-label-primary)}
.sch-input{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.sch-input-bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:min(calc(var(--dsh-chat-content-width,748px)*.702),82%);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}
.sch-input-fork{display:inline-flex;align-items:center;gap:6px;max-width:82%;border:.5px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-layer-1,transparent);padding:4px 6px 4px 10px;border-radius:999px;color:var(--sch-tone,var(--dsw-alias-label-secondary));font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap}
.sch-input-fork:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-input-fork:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.sch-input-what{overflow:hidden;text-overflow:ellipsis}
.sch-input-name{font-weight:600}
.sch-input-open{display:inline-flex;align-items:center;gap:1px;padding-left:6px;border-left:.5px solid var(--dsw-alias-border-l1,currentColor);color:var(--dsw-alias-label-tertiary)}
.sch-input-fork:hover .sch-input-open{color:var(--dsw-alias-label-primary)}
.sch-input-fork[data-state=running] .sch-input-dot,.sch-input-fork[data-state=queued] .sch-input-dot{animation:sch-pulse 1.4s ease-out infinite}
.sch-input-fork[data-state=queued]{--sch-dot:var(--dsw-alias-state-warn-primary);--sch-tone:var(--dsw-alias-state-warn-primary)}
.sch-input-fork[data-state=archived]{--sch-dot:var(--dsw-alias-label-caption)}
.sch-input-fork[data-state=running] .sch-input-what::after{content:"";display:inline-block;width:1.2em;text-align:left;animation:sch-ellipsis 1.2s steps(4,end) infinite}
@keyframes sch-ellipsis{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
@media (prefers-reduced-motion:reduce){.sch-input-fork .sch-input-dot,.sch-input-fork .sch-input-what::after{animation:none}}
.sch-input-dot,.sch-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--sch-dot,var(--dsw-alias-label-caption))}
:is(.sch-input,.sch-roster,.sch-mode-group) [data-state=running],:is(.sch-input,.sch-roster,.sch-mode-group) [data-row=running]{--sch-dot:var(--dsw-alias-brand-primary-new-colorprimary-new-color);--sch-tone:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
:is(.sch-input,.sch-roster,.sch-mode-group) [data-state=done],:is(.sch-input,.sch-roster,.sch-mode-group) [data-row=done]{--sch-dot:var(--dsw-alias-state-success-primary)}
:is(.sch-input,.sch-roster,.sch-mode-group) [data-state=failed],:is(.sch-input,.sch-roster,.sch-mode-group) [data-row=failed]{--sch-dot:var(--dsw-alias-state-error-primary);--sch-tone:var(--dsw-alias-state-error-primary)}
:is(.sch-input,.sch-roster,.sch-mode-group) [data-row=waiting]{--sch-dot:var(--dsw-alias-state-warn-primary);--sch-tone:var(--dsw-alias-state-warn-primary)}
.sch-dot[data-row=running]{box-shadow:0 0 0 0 var(--sch-dot);animation:sch-pulse 1.8s ease-out infinite}
/* Review marks: a report the user has not opened yet (green, red), or a prompt waiting for them
   (yellow). Solid, larger, with a halo; opening the chat returns the dot to its state colour. */
.sch-dot[data-review]{justify-self:center;width:9px;height:9px;animation:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--sch-dot) 24%,transparent)}
.sch-dot[data-review=reported],.sch-review-n[data-review=reported]{--sch-dot:var(--dsw-alias-state-success-primary)}
.sch-dot[data-review=failed],.sch-review-n[data-review=failed]{--sch-dot:var(--dsw-alias-state-error-primary)}
.sch-dot[data-review=approval],.sch-review-n[data-review=approval]{--sch-dot:var(--dsw-alias-state-warn-primary)}
.sch-review-n{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--sch-dot);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:11px;font-weight:600;line-height:16px}
@keyframes sch-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sch-dot) 55%,transparent)}100%{box-shadow:0 0 0 6px transparent}}

/* Scheduling switch in the composer's mode row, beside access mode and Plan, in their metrics. */
.sch-mode-group{display:inline-flex;align-items:center;gap:4px}
.sch-mode{display:inline-flex;align-items:center;height:28px;border-radius:var(--dsw-radius-sm);font-size:13px;font-weight:500;line-height:20px}
.sch-mode button{display:inline-flex;align-items:center;gap:4px;height:28px;border:0;background:none;margin:0;padding:0 8px;color:inherit;font:inherit;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.sch-mode button:disabled{opacity:.6;cursor:default}
.sch-mode button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.sch-mode svg{flex:none}
.sch-mode[data-on=no]{color:var(--dsw-alias-label-secondary)}
.sch-mode[data-on=no] button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-mode[data-on=yes]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.sch-mode[data-on=yes]:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-tertiary),var(--dsw-alias-state-business-primary) 6%)}
.sch-mode-glyph,.sch-mode-x{width:14px;height:14px;line-height:0}
.sch-mode-glyph{display:block}
.sch-mode-exit .sch-mode-x,.sch-mode-exit:hover:not(:disabled) .sch-mode-glyph,.sch-mode-exit:focus-visible .sch-mode-glyph{display:none}
.sch-mode-exit:hover:not(:disabled) .sch-mode-x,.sch-mode-exit:focus-visible .sch-mode-x{display:block}
.sch-mode-group[data-unsupported] button{opacity:.45}
.sch-mode-error{margin-left:6px;color:var(--dsw-alias-state-error-primary);font-size:12px}

/* Agents page: its own narrow column at the left of the right sidebar, a list of agents. */
/* The card is the highlight box: one box per row, so a selected row's background covers the
   row, its meta line and anything folded open under it, with the same inset on every side. */
/* One quiet meta line under the row: team count and a non-default access mode only. */
@keyframes sch-flash{0%,35%{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}100%{background:transparent}}
.sch-forkmodel{display:flex;flex-direction:column;gap:2px;padding:0 12px 4px 18px}
.sch-forkmodel-row{display:flex;align-items:center;gap:4px;min-width:0;margin-left:-6px}
.sch-forkmodel-label{flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-forkmodel-row>.sch-mt{flex:none;max-width:60%}
.sch-forkmodel-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}
.sch-mm-composer{display:inline-flex;align-items:center;min-width:0}
`

const inputLabel = (state: CardState): string => t(`input.label.${state}`)

/**
 * What the status line under a handed-off message says: who has it and where it is, so a send
 * that the lead did not answer still visibly went somewhere.
 * @param state - the card state.
 * @returns the line's parts; `name` is bold, `open` is the call to action.
 */
export function statusLine(state: Pick<State, 'fork' | 'name' | 'detail'>): { lead: string; name: string; tail: string; open: string } {
  const name = state.name ?? t('status.fork')
  // A fork archives itself once it has handed back; to the user it is still "handed back".
  const key = state.fork === 'queued' ? 'status.queued' : state.fork === 'running' ? 'status.running' : state.fork === 'failed' ? (state.detail === undefined ? 'status.failed' : 'status.failedDetail') : 'status.done'
  // The name is bold, so the sentence is split around it; each language puts it where it belongs.
  const [lead = '', tail = ''] = t(key, state.detail === undefined ? undefined : { detail: state.detail }).split('{name}')
  return { lead, name, tail, open: t('status.open') }
}

// One rule for the Agents page and the focus deck (src/client/row-state.ts).
export { rowStateOf, type RowState } from './row-state.js'

/**
 * The command line that marks a member's latest report read.
 * @param member - the member's Session id.
 * @returns e.g. `/agents seen <id>`.
 */
export const seenLine = (member: string): string => `/agents seen ${member}`

/** A member's review mark (see src/review.ts). */
export type ReviewMark = 'approval' | 'failed' | 'reported'
const REVIEW_RANK: Record<ReviewMark, number> = { approval: 3, failed: 2, reported: 1 }
/**
 * One member's review mark: yellow while a prompt waits for the user, else red or green for a
 * report the user has not opened yet.
 * @param member - a roster row.
 * @param statuses - the root Session-status map.
 * @returns the mark, or undefined when there is nothing to look at.
 */
export function reviewMarkOf(member: Member, statuses: Statuses | undefined, visible?: ReadonlySet<string>): ReviewMark | undefined {
  return reviewOf(member, statuses?.get(member.id)?.pendingInteraction !== undefined, visible?.has(member.id) === true)
}

/**
 * How many members carry a mark, and the most urgent one.
 * @param members - roster rows.
 * @param statuses - the root Session-status map.
 * @param reportsOnly - count only unread reports (the composer already says 「N 等你」).
 * @returns the count and the tone of the badge.
 */
export function reviewSummary(members: readonly Member[], statuses: Statuses | undefined, reportsOnly = false, visible?: ReadonlySet<string>): { n: number; tone: ReviewMark | undefined } {
  let n = 0
  let tone: ReviewMark | undefined
  for (const member of members) {
    const active = visible?.has(member.id) === true
    const mark = reportsOnly ? reviewOf(member, false, active) : reviewMarkOf(member, statuses, visible)
    if (mark === undefined) continue
    n += 1
    if (tone === undefined || REVIEW_RANK[mark] > REVIEW_RANK[tone]) tone = mark
  }
  return { n, tone }
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
 * Create the input card bound to its sidebar opener.
 * @param open - opens a fork beside the main session.
 * @returns the slot component.
 */
export function createInputCard(open: (parent: string, child: string) => void) {
  return memo(function InputCard({ node, sessionId }: { node: { data: State }; sessionId: string }) {
    useLocale()
    const { text, fork, forkId, detail, logged } = node.data
    const line = statusLine(node.data)
    return (
      <div className="sch-input" data-scheduler-input="" data-fork-state={fork} data-logged={logged === true ? 'yes' : 'no'}>
        {logged === true ? null : <div className="sch-input-bubble">{text}</div>}
        <button type="button" className="sch-input-fork" data-state={fork} title={detail === undefined ? t('input.title', { label: inputLabel(fork) }) : t('input.titleDetail', { label: inputLabel(fork), detail })} aria-label={t('input.aria', { line: `${line.lead}${line.name}${line.tail}`, open: line.open })} onClick={() => { open(sessionId, forkId) }}>
          <span className="sch-input-dot" data-state={fork} />
          <span className="sch-input-what">{line.lead}<span className="sch-input-name">{line.name}</span>{line.tail}</span>
          <span className="sch-input-open">{line.open}{ICON.chevron}</span>
        </button>
      </div>
    )
  })
}

/**
 * Where an agent chat opens, from the live layout when the sidebar exposes it.
 * @param sidebar - `ctx.sidebarRight`.
 * @param rosterPane - the Agents page's own pane id, when known.
 * @returns placement options for `openResource`.
 */
function placeChat(sidebar: SidebarFace | undefined, rosterPane?: string) {
  const layout = layoutOf(sidebar)
  return layout === undefined ? chatPlacement(document, rosterPane) : chatPlacementIn(layout, AGENTS_KIND)
}

const ICON = {
  collapse: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11M5.5 6.5 7.5 8l-2 1.5" />
    </svg>
  ),
  fork: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="8" r="1.6" /><path d="M4 5.1v5.8M4 8h3.2c1.6 0 2.4-.9 3.2-.9" />
    </svg>
  ),
  close: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm-2.1 3.7a.6.6 0 0 0-.85.85L7.15 8l-2.1 2.1a.6.6 0 1 0 .85.85L8 8.85l2.1 2.1a.6.6 0 0 0 .85-.85L8.85 8l2.1-2.1a.6.6 0 0 0-.85-.85L8 7.15Z" /></svg>
  ),
  archive: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 9h3" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
  ),
  forkWorker: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13.5V9M8 9 4 5M8 9l4-4M4 5V2.5M12 5V2.5M2.5 4 4 2.5 5.5 4M10.5 4 12 2.5 13.5 4" /></svg>
  ),
  merge: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5v3.2c0 1.6 1.2 2.6 2.6 3.2L8 9.5M12 2.5v3.2c0 1.6-1.2 2.6-2.6 3.2L8 9.5V13.5M6 11.6l2 2 2-2" /></svg>
  ),
  rename: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2 7.2-7.2Z" /></svg>
  ),
  chevron: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
  ),
}

/**
 * Create the scheduling switch for the composer's mode row: one chip that turns scheduling on or
 * off, like Plan beside it, and next to it an Agents button whenever this session has forks or
 * workers. Turning scheduling off keeps them; the Agents page archives them.
 * @param deps - the command runner and the Agents page opener.
 * @returns the slot component.
 */
export function createScheduleSwitch(deps: {
  setMode: (sessionId: string, on: boolean) => Promise<string | null>
  isChild: (sessionId: string) => boolean
  supports: (sessionId: string) => Promise<boolean>
  /** The right sidebar, for the Sessions its panes show; absent: no dot is suppressed. */
  sidebar?: (() => SidebarFace | undefined) | undefined
  /** Where reads of on-screen reports are kept (tests pass their own). */
  seen?: LocalSeen | undefined
}) {
  const store = deps.seen ?? browserSeen
  return memo(function ScheduleSwitch(props: { sessionId?: string; locked?: boolean; useProjection?: (key: string) => unknown; useSessionStatus?: UseSessionStatus }) {
    useLocale()
    const raw = rosterOf(props)
    useSyncExternalStore(store.subscribe, store.revision, store.revision)
    const roster = raw === undefined || props.sessionId === undefined ? raw : { ...raw, members: store.apply(props.sessionId, raw.members) }
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // A Session keeps the preset revision it started with: one that was running before this
    // plugin was installed has no /schedule until it is reopened after a restart.
    const [supported, setSupported] = useState<boolean | undefined>(undefined)
    const sessionId = props.sessionId
    useEffect(() => {
      if (sessionId === undefined) return undefined
      let alive = true
      setSupported(undefined)
      deps.supports(sessionId).then(ok => { if (alive) setSupported(ok) }, () => { if (alive) setSupported(undefined) })
      return () => { alive = false }
    }, [sessionId])
    // The member chats on screen carry no dot, and a report arriving in one counts as read: kept
    // in the browser, since a command per arrival would leave a row in the lead's chat each time.
    const layout = deps.sidebar?.() === undefined ? undefined : layoutOf(deps.sidebar?.())
    const onScreen = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const visible = layout === undefined || !onScreen ? undefined : visibleChildren(layout, (roster?.members ?? []).map(m => m.id))
    const due = sessionId === undefined || deps.isChild(sessionId) ? [] : autoSeenTargets(roster?.members ?? [], visible ?? new Set())
    const dueKey = due.join(',')
    useEffect(() => {
      if (sessionId === undefined || dueKey === '') return
      const ids = new Set(dueKey.split(','))
      store.mark(sessionId, (roster?.members ?? []).filter(m => ids.has(m.id)))
    }, [dueKey, sessionId])
    if (sessionId === undefined || deps.isChild(sessionId)) return null
    // One switch at a time: while the session dock shows, its summary line carries 调度.
    if (dockModel(roster as never, statuses, undefined, sessionId).visible) return null
    if (supported === false) {
      return (
        <span className="sch-mode-group" data-scheduler-switch="" data-on="no" data-unsupported="">
          <span className="sch-mode" data-on="no">
            <button type="button" disabled aria-label={t('switch.unsupported.aria')} title={t('switch.unsupported.title')}>
              {ICON.fork}{t('switch.label')}
            </button>
          </span>
        </span>
      )
    }
    const on = roster?.enabled === true
    const switchTo = (next: boolean) => {
      setBusy(true)
      setError(null)
      deps.setMode(sessionId, next).then(failure => {
        setBusy(false)
        setError(failure)
        if (failure !== null) deps.supports(sessionId).then(ok => { setSupported(ok) }, () => undefined)
      }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    const disabled = busy || props.locked === true
    return (
      <span className="sch-mode-group" data-scheduler-switch="" data-on={on ? 'yes' : 'no'}>
        <span className="sch-mode" data-on={on ? 'yes' : 'no'}>
          {on
            ? (
              <button type="button" className="sch-mode-exit" disabled={disabled} aria-label={t('switch.off.aria')} title={t('switch.off.title')} onClick={() => { switchTo(false) }}>
                <span className="sch-mode-glyph">{ICON.fork}</span><span className="sch-mode-x">{ICON.close}</span>{t('switch.label')}
              </button>
            )
            : (
              <button type="button" disabled={disabled} aria-label={t('switch.on.aria')} title={t('switch.on.title')} onClick={() => { switchTo(true) }}>
                {ICON.fork}{t('switch.label')}
              </button>
            )}
        </span>
        {error === null ? null : <span className="sch-mode-error" role="status" title={error}>{t('error.switch')}</span>}
      </span>
    )
  })
}

/**
 * What a row says about requests sent to it and not yet answered.
 * @param n - open requests to this member.
 * @param state - the row's live state.
 * @returns e.g. 「2 个请求待回答」.
 */
export function openLabel(n: number, state: RowState): string {
  return tn(state === 'running' ? 'requests.running' : 'requests.open', n)
}

/** One line of readable text: runs of whitespace become one space, ends trimmed. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * The second line of a row: why it failed, what it is working on right now, or what it was asked.
 *
 * A running agent's own requests say more than the message that created it, so the oldest still
 * unanswered one leads; a fork with nothing open shows the ask, a worker its duty. A worker's
 * directory is left to the row's tooltip ({@link rowTitle}): worktree names are long and pushed
 * the duty out of the narrow column.
 * @param member - a roster row.
 * @param pending - the member's unanswered requests, oldest first.
 * @returns the line, or '' when there is nothing worth saying.
 */
export function subline(member: Member, pending: readonly { readonly id: string; readonly text: string }[] = []): string {
  const failure = member.state === 'failed' ? member.detail : undefined
  if (failure !== undefined) return flat(failure)
  const oldest = pending[0]
  // A worker split from an area is prefixed with the area (a short repository or module name),
  // so the halves read as one area; the directory stays in the tooltip ({@link rowTitle}).
  const area = member.kind === 'worker' && member.area !== undefined ? `${member.area.slice(0, 16)} · ` : ''
  if (oldest !== undefined) return area + t('row.request', { id: oldest.id, text: flat(oldest.text) })
  return area + flat(member.kind === 'fork' ? member.text : member.role ?? member.text)
}

/**
 * What a row says while its worker takes part in a merge: it replaces the subtitle, so the name
 * keeps its column and the right-hand side carries only a short badge.
 * @param member - the row.
 * @param merge - the merge in progress it takes part in.
 * @param nameOf - display name of a Session id.
 * @returns e.g. 「合并到 scheduler-worker-merge · mg-1」 for the absorbed side.
 */
export function mergeLine(member: Pick<Member, 'id'>, merge: { readonly id: string; readonly absorbed: string; readonly survivor: string }, nameOf: (id: string) => string): string {
  return member.id === merge.absorbed
    ? t('merge.into', { name: nameOf(merge.survivor), id: merge.id })
    : t('merge.from', { name: nameOf(merge.absorbed), id: merge.id })
}

/**
 * A row's tooltip: its Session id, and the worker's directory, which the subline leaves out.
 * @param member - a roster row.
 * @returns the title text.
 */
export function rowTitle(member: Member): string {
  // The name is cut with an ellipsis in a narrow column: the tooltip leads with it whole.
  const head = member.name === undefined || member.name === member.id ? member.id : `${member.name}\n${member.id}`
  return member.cwd === undefined ? head : t('row.titleCwd', { id: head, cwd: member.cwd })
}

/**
 * Workers in roster order, except that workers split from one area sit together, where the
 * first of them appears.
 * @param workers - worker rows in roster order.
 * @returns the same rows, grouped by area.
 */
export function byArea<T extends { readonly id: string; readonly area?: string | undefined }>(workers: readonly T[]): T[] {
  const out: T[] = []
  for (const worker of workers) {
    if (out.includes(worker)) continue
    out.push(worker)
    if (worker.area !== undefined) out.push(...workers.filter(w => w !== worker && w.area === worker.area))
  }
  return out
}

/** The rule a worker name must follow; the host checks it again (and that it is free). */
export const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/u

/** A word for an `/agents` command line: quoted when it holds spaces. */
function word(value: string): string { return /\s/u.test(value) ? `"${value}"` : value }

/**
 * The `/agents new` line for the Agents page's form.
 * @param input - name, role, and an optional directory.
 * @returns the command line, or what is wrong with the input.
 */
export function newWorkerCommand(input: { name: string; role: string; cwd?: string }): { line: string } | { error: string } {
  const name = input.name.trim()
  const role = input.role.replace(/\s+/gu, ' ').trim()
  const cwd = input.cwd?.trim() ?? ''
  if (!WORKER_NAME.test(name)) return { error: t('form.nameRule') }
  if (role === '') return { error: t('form.roleMissing') }
  if (cwd.includes('"')) return { error: t('form.cwdQuote') }
  // A role that starts like an option would be read as one.
  const safeRole = role.startsWith('--') ? `- ${role}` : role
  return { line: `/agents new ${name}${cwd === '' ? '' : ` --cwd ${word(cwd)}`} ${safeRole}` }
}

/**
 * The `/agents rename` line for a worker row.
 * @returns the command line, or what is wrong with the new name.
 */
export function renameCommand(from: string, to: string): { line: string } | { error: string } {
  const next = to.trim()
  if (!WORKER_NAME.test(next)) return { error: t('form.nameRule') }
  return { line: `/agents rename ${from} ${next}` }
}

/** A host that predates `/agents new` and `/agents rename` answers with its old usage line. */
export function needsRestartFor(error: string): boolean {
  return /^Usage: \/agents archive/u.test(error)
}

export type { CatalogGroup, CatalogReasoning } from './model-menu.js'

/**
 * The command that sets one member's model, run in the main Session.
 * @param member - member name.
 * @param selection - the choice, or null for the model it started with.
 * @returns the command line.
 */
export function memberModelCommand(member: string, selection: ForkModel | null): string {
  if (selection === null) return `/agent-model ${member} default`
  return `/agent-model ${member} ${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` ${selection.reasoningEffort}`}`
}

/**
 * The model a member started with, as the roster records it (`provider/model` or
 * `provider/model:effort`).
 * @param model - the roster's `model` field.
 * @returns the selection, or undefined when absent or unreadable.
 */
export function startedModel(model: string | undefined): ForkModel | undefined {
  const m = model === undefined ? null : /^([^/\s]+)\/([^:\s]+)(?::(\S+))?$/u.exec(model)
  if (m === null) return undefined
  return { provider: m[1]!, model: m[2]!, ...(m[3] === undefined ? {} : { reasoningEffort: m[3] }) }
}

/**
 * What the member composer's trigger says.
 * @param groups - the catalog.
 * @param selection - the member's own choice.
 * @returns the label: model name and effort, or 「默认模型」.
 */
export function memberModelLabel(groups: readonly CatalogGroup[], selection: ForkModel | null | undefined): string {
  if (selection === null || selection === undefined) return t('model.default')
  const model = groups.find(g => g.id === selection.provider)?.models.find(m => m.id === selection.model)
  const name = model?.name ?? selection.model
  const effort = selection.reasoningEffort === undefined ? undefined : model?.reasoning?.efforts.find(e => e.id === selection.reasoningEffort)?.name ?? selection.reasoningEffort
  return effort === undefined ? name : `${name} · ${effort}`
}

/**
 * Model picker in a fork's or worker's own chat composer: the runtime's selector hides itself for
 * subagent Sessions, so this one sets the member's model through the main Session.
 * @param deps - who the member is, the command runner and the catalog.
 * @returns the slot component.
 */
/** A subscribable read of one projection key, as the client session binding exposes it. */

/**
 * The worker a Session is, from its parent's roster: only a worker has a model of its own (a fork
 * always runs on the lead's). An archived worker still talks in its chat (speaking to it wakes
 * it), so it keeps the picker; one that failed to start has nothing to switch.
 * @param roster - the parent's roster view.
 * @param sessionId - the child Session.
 * @returns the worker, or undefined for a fork, a non-member, or one that never started.
 */
export function memberOf(roster: Roster | undefined, sessionId: string): Member | undefined {
  return roster?.members.find(m => m.id === sessionId && m.kind === 'worker' && m.state !== 'failed')
}

export function createMemberModelPicker(deps: {
  parentOf: (sessionId: string) => string | undefined
  rosterFace: (parent: string) => Face
  run: (sessionId: string, line: string) => Promise<string | null>
  has: (sessionId: string, name: string) => Promise<boolean>
  /** The composer's model catalog (see catalog-source.ts), shared by every menu of this plugin. */
  catalog: CatalogSource
}) {
  return memo(function MemberModelPicker(props: { sessionId?: string }) {
    useLocale()
    const sessionId = props.sessionId
    const parentId = sessionId === undefined ? undefined : deps.parentOf(sessionId)
    const face = parentId === undefined ? NO_FACE : deps.rosterFace(parentId)
    const roster = useSyncExternalStore(face.subscribe, face.getSnapshot) as Roster | undefined
    const row = sessionId === undefined ? undefined : memberOf(roster, sessionId)
    const member = parentId === undefined || row === undefined ? undefined : { parent: parentId, name: row.name }
    const own = row?.pickedModel ?? null
    // Live: follows every change the Host makes to the model list, like the composer's menu.
    const catalog = useSyncExternalStore(deps.catalog.subscribe, deps.catalog.getSnapshot)
    const groups = catalog.groups ?? []
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [supported, setSupported] = useState(false)
    const parent = member?.parent
    useEffect(() => {
      if (parent === undefined) return undefined
      let alive = true
      deps.has(parent, 'agent-model').then(ok => { if (alive) setSupported(ok) }, () => undefined)
      deps.catalog.load()
      return () => { alive = false }
    }, [parent])
    if (member === undefined || !supported) return null
    const choose = (selection: ForkModel | null) => {
      setBusy(true)
      setError(null)
      deps.run(member.parent, memberModelCommand(member.name, selection)).then(failure => { setBusy(false); setError(failure) }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    // With no model of its own the worker still runs on a definite one (the one it started with):
    // show that instead of a bare 「默认模型」.
    const started = own === null ? startedModel(row?.model) : undefined
    const label = memberModelLabel(groups, own ?? started)
    return (
      <span className="sch-mm-composer" data-scheduler-member-model={own === null ? 'default' : `${own.provider}/${own.model}${own.reasoningEffort === undefined ? '' : ` ${own.reasoningEffort}`}`}>
        <ModelMenu
          groups={groups}
          current={own}
          label={own !== null ? own.model : started !== undefined ? label : t('model.default')}
          defaultLabel={t('model.memberDefaultRow')}
          defaultValue={t('model.default')}
          avoid={SEL.composerCard}
          busy={busy}
          ariaLabel={t(isStale(catalog, own) ? 'model.memberAriaStale' : 'model.memberAria', { name: member.name, label })}
          title={t('model.memberTitle', { name: member.name })}
          stale={isStale(catalog, own)}
          onOpen={deps.catalog.load}
          onPick={choose}
        />
        {error === null ? null : <span className="sch-mode-error" role="status" title={error}>{t('error.switch')}</span>}
      </span>
    )
  })
}

/**
 * Encode a default model as a stable value; JSON keeps provider ids with slashes intact.
 * @param model - the selection, or null for the default.
 * @returns the value, '' for the default.
 */
export const workerModelValue = (model: ForkModel | null | undefined): string =>
  model === null || model === undefined ? '' : JSON.stringify([model.provider, model.model, ...(model.reasoningEffort === undefined ? [] : [model.reasoningEffort])])

/**
 * The `/worker` command line for a choice from the menu.
 * @param selection - the choice, with its reasoning level, or null for the default.
 * @returns the command line.
 */
export function workerModelCommand(selection: ForkModel | null): string {
  if (selection === null) return '/worker model default'
  return `/worker model ${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` ${selection.reasoningEffort}`}`
}

/**
 * What the 「Worker 默认模型」 trigger says for its model part.
 * @param groups - catalog groups.
 * @param current - the default, or null.
 * @returns 「默认」, the model's name, or its id when the catalog no longer lists it.
 */
export function workerModelLabel(groups: readonly CatalogGroup[], current: ForkModel | null | undefined): string {
  if (current === null || current === undefined) return t('worker.model.default')
  return catalogModel(groups, current)?.name ?? current.model
}

/**
 * Workers a worker can be merged with: live, started, not itself, not mid-merge; same area first.
 * @returns the candidates.
 */
export function mergePartners<M extends Pick<Member, 'id' | 'kind' | 'state' | 'area'>>(rows: readonly M[], member: M, merging: readonly { absorbed: string; survivor: string }[]): M[] {
  const busy = new Set(merging.flatMap(m => [m.absorbed, m.survivor]))
  const ok = rows.filter(m => m.kind === 'worker' && m.state === 'started' && m.id !== member.id && !busy.has(m.id))
  return [...ok.filter(m => m.area !== undefined && m.area === member.area), ...ok.filter(m => m.area === undefined || m.area !== member.area)]
}

/**
 * The command the merge form runs.
 * @param absorbed - the worker merged away.
 * @param survivor - the worker that stays.
 * @param name - the survivor's new name, or '' to keep its own.
 * @returns the line, or why it cannot run.
 */
export function mergeCommand(absorbed: string, survivor: string, name: string): { line: string } | { error: string } {
  const next = name.trim()
  if (next !== '' && !/^[a-z][a-z0-9-]{0,39}$/u.test(next)) return { error: t('form.nameRule') }
  return { line: `/agents merge ${absorbed} into ${survivor}${next === '' ? '' : ` --name ${next}`}` }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function apply(ctx: any): void {
  const host: ClientHost = clientHost(ctx)
  // Every word below follows DSH's language, switching live (src/dsh/client/locale.ts).
  followDshLocale(ctx)
  registerChatEvent(ctx, inputDefinition)
  registerChatEvent(ctx, requestDefinition)
  const doc = typeof document === 'undefined' ? undefined : document
  ctx.effect(() => injectStyle(doc, 'dsh-agent-scheduler', STYLE + HOST_CSS + MODEL_MENU_STYLE + ACCESS_STYLE + DOCK_STYLE), 'agent-scheduler: styles')
  const sidebar = () => ctx.sidebarRight as SidebarFace | undefined
  const run = (sessionId: string, line: string) => host.run(sessionId, line)
  const has = (sessionId: string, name: string) => host.has(sessionId, name)
  /**
   * The composer's own model catalog (its live store, via the adapter), so these menus change
   * with the composer's when the model list changes; see catalog-source.ts.
   */
  const catalog = catalogSource(host)
  ctx.effect(() => () => { catalog.dispose() }, 'agent-scheduler: model catalog')
  /** The parent's roster projection; the parent is the open main Session, so its binding is retained. */
  const rosterFace = (parent: string): Face => host.projection(parent, ROSTER)
  const open = (parent: string, child: string) => {
    // Opening a member from its status pill in the main chat reads its latest report too.
    const member = (rosterFace(parent).getSnapshot() as Roster | undefined)?.members.find(m => m.id === child)
    if (member !== undefined && reviewOf(member) !== undefined) run(parent, seenLine(child)).catch(() => undefined)
    const face = sidebar()
    if (face?.openResource === undefined) { host.openSession(parent, child); return }
    const placement = placeChat(face)
    face.openResource(host.chatAddress(parent, child), { kind: SUBAGENT_CHAT_KIND, ...placement })
  }
  registerSlot(ctx, 'chatNode', { key: NODE_KIND }, createInputCard(open))
  registerSlot(ctx, 'chatNode', { key: REQUEST_KIND }, RequestCardView)
  ctx.effect(() => keepChatTabsMounted(ctx), 'agent-scheduler: keep agent chats mounted')
  ctx.effect(() => steadyTabStrips(doc), 'agent-scheduler: keep the sidebar tab strip still')
  const setMode = (sessionId: string, on: boolean) => run(sessionId, on ? '/schedule on' : '/schedule off')
  const supports = (sessionId: string) => has(sessionId, 'schedule')
  registerSlot(ctx, 'inputRight', { id: 'agent-scheduler-model', order: 100, inject: (sessionId: string) => ({ sessionId }) }, createMemberModelPicker({ parentOf: host.parentOf, rosterFace, run, has, catalog }))
  registerSlot(ctx, 'inputLeft', { id: 'agent-scheduler', order: 10, inject: (sessionId: string) => ({ sessionId }) }, createScheduleSwitch({ setMode, isChild: host.isChild, supports, sidebar }))
  // The session dock and the inbox card, where DSH's Todo dock sits (conversation.input.dock).
  const dockDeps = { run, projection: rosterFace, openSession: (id: string) => { host.openTopLevel(id) }, openChild: open, isChild: host.isChild }
  registerSlot(ctx, 'inputDock', { id: 'agent-scheduler-inbox', order: 40, inject: (sessionId: string) => ({ sessionId }) }, createInboxCard(dockDeps))
  registerSlot(ctx, 'inputDock', { id: 'agent-scheduler-dock', order: 50, inject: (sessionId: string) => ({ sessionId }) }, createSessionDock(dockDeps))
  // A worker's own chat: the working access control (DSH's own picker cannot write an addressed child).
  registerSlot(ctx, 'inputLeft', { id: 'agent-scheduler-access', order: 20, inject: (sessionId: string) => ({ sessionId }) }, createMemberAccessPicker({ parentOf: host.parentOf, rosterFace, run }))
  registerRecoveryConfig(ctx)
}

/**
 * A worker's access mode in its own chat footer: the chip writes through the main Session's
 * `/agent-access`, which the host's own permission picker cannot do for an addressed child.
 * @param deps - how to find the member's parent and roster, and run a command there.
 * @returns the slot component.
 */
export function createMemberAccessPicker(deps: {
  parentOf: (sessionId: string) => string | undefined
  rosterFace: (parent: string) => Face
  run: (sessionId: string, line: string) => Promise<string | null>
}) {
  return memo(function MemberAccessPicker(props: { sessionId?: string }) {
    useLocale()
    const sessionId = props.sessionId
    const parentId = sessionId === undefined ? undefined : deps.parentOf(sessionId)
    const face = parentId === undefined ? NO_FACE : deps.rosterFace(parentId)
    const roster = useSyncExternalStore(face.subscribe, face.getSnapshot) as Roster | undefined
    const row = sessionId === undefined ? undefined : (roster?.members ?? []).find(m => m.id === sessionId)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const modes = roster?.accessModes ?? []
    if (parentId === undefined || sessionId === undefined || row === undefined || row.kind !== 'worker' || row.state === 'archived' || modes.length === 0) return null
    const choose = (preset: string) => {
      setBusy(true)
      setError(null)
      deps.run(parentId, `/agent-access ${row.name} ${preset}`).then(failure => {
        setBusy(false)
        setError(failure)
      }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    return <AccessPicker name={row.name} preset={row.accessPreset} modes={modes} busy={busy} error={error} choose={choose} />
  })
}
