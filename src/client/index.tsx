/**
 * Browser half: renders each handed-off user input where the lead's history no longer holds it,
 * the right-sidebar Agents page, and the scheduling switch in the composer's mode row. The roster reads the
 * host's `agentScheduler` session projection and the root `useSessionStatus` hook (the only
 * source of "waiting for you"); opening a fork or worker reuses the native subagent-chat
 * resource, so the embedded conversation, its composer and its stop action are the product's own.
 */
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { registerRecoveryConfig } from './recovery-config.js'
import { catalogModel, effortLabel, MODEL_MENU_STYLE, ModelMenu, type CatalogGroup } from './model-menu.js'
import { catalogSource, isStale, type CatalogSource } from './catalog-source.js'
import { activeChild, chatPlacementIn, dockPanes, findRoster, nextRosterStep, ROSTER_SHARE, visibleChildren } from './layout.js'
import { autoSeenTargets, browserSeen, type LocalSeen } from './active-seen.js'
import { reviewOf } from '../review.js'
import type { MailDelivery, MailItem } from '../projection.js'
import { INBOX_STYLE, InboxSection } from './inbox.js'
import { defaultSurvivor } from '../merge-pick.js'
import type { TeamView } from '../projection.js'
import { TEAM_STYLE, TeamBlock, teamSummary } from './team.js'
import { list, t, tn, useLocale } from './i18n.js'
import {
  chatPlacement, clientHost, followDshLocale, gesturesOf, HOST_CSS, injectStyle, keepChatTabsMounted, layoutOf, NO_FACE, registerChatEvent, registerSlot, registerTabType, SEL,
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
/** Tab-system identity of the Agents page; also the keyed body's key. */
const AGENTS_ID = 'dsh-agent-scheduler/agents'
/** Page kind, opened by name because the type has no resource patterns. */
const AGENTS_KIND = 'agent-scheduler-agents'
/** Archived members listed before the roster folds the rest behind one button. */
const ARCHIVED_ROWS = 8

export const name = 'dsh-agent-scheduler'
export const inject = ['slots', 'uiConversation', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'remote', 'remote.commands', 'remote.session']

interface Event { type: string; seq: number; time: number; data: Record<string, unknown> }
type CardState = 'queued' | 'running' | 'done' | 'failed' | 'archived'
interface State { readonly seq: number; readonly time: number; readonly text: string; readonly forkId: string; readonly fork: CardState; readonly detail?: string; /** The chat already shows the user's own message (with its images); the card adds only the status. */ readonly logged?: true; /** `fork-N`; absent in the oldest records. */ readonly name?: string }

/** Fork-state record → what the card says. `started` follows a wait in the queue. */
const CARD_STATE: Record<string, CardState> = { queued: 'queued', started: 'running', done: 'done', failed: 'failed', archived: 'archived' }
interface Ctx { key: string; id: string; state?: State; start?: { location: unknown } }

/** One roster row as the host projection emits it. */
interface Member { readonly id: string; readonly name: string; readonly kind: 'fork' | 'worker'; readonly state: string; readonly text: string; readonly role?: string; readonly cwd?: string; readonly model?: string; readonly area?: string; readonly detail?: string; readonly pickedModel?: ForkModel; readonly reportedAt?: number; readonly reportFailed?: true; readonly seenAt?: number }
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
}
/** One Session's live status as the client root hook reports it. */

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
.sch-roster-reqs{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap}
.sch-roster-badge{flex:none;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 14%,transparent);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);font:var(--dsw-font-xxs-12);line-height:18px;white-space:nowrap}
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
.sch-review-n{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--sch-dot);color:#fff;font-size:11px;font-weight:600;line-height:16px}
.sch-roster-section-title{display:inline-flex;align-items:center;gap:6px}
@keyframes sch-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sch-dot) 55%,transparent)}100%{box-shadow:0 0 0 6px transparent}}

/* Scheduling switch in the composer's mode row, beside access mode and Plan, in their metrics. */
.sch-mode-group{display:inline-flex;align-items:center;gap:4px}
.sch-mode{display:inline-flex;align-items:center;height:28px;border-radius:var(--dsw-radius-sm);font-size:13px;font-weight:500;line-height:20px}
.sch-mode button,.sch-agents-btn{display:inline-flex;align-items:center;gap:4px;height:28px;border:0;background:none;margin:0;padding:0 8px;color:inherit;font:inherit;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.sch-mode button:disabled{opacity:.6;cursor:default}
.sch-mode button:focus-visible,.sch-agents-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
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
.sch-agents-btn{gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.sch-agents-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-agents-btn .sch-dot{width:6px;height:6px}
.sch-agents-n{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sch-agents-n[data-row=waiting]{color:var(--dsw-alias-state-warn-primary)}
.sch-agents-n[data-row=running]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.sch-agents-n[data-row=failed]{color:var(--dsw-alias-state-error-primary)}
.sch-mode-error{margin-left:6px;color:var(--dsw-alias-state-error-primary);font-size:12px}

/* Agents page: its own narrow column at the left of the right sidebar, a list of agents. */
.sch-roster{display:flex;flex-direction:column;height:100%;overflow:auto;padding:0;font-size:13px}
.sch-roster::after{content:'';flex:none;height:12px}
.sch-roster:has(> .sch-roster-below)::after{order:-1;display:none}
.sch-roster-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 12px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,transparent)}
.sch-roster-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.sch-roster-summary{margin-top:2px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-collapse{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;background:none;padding:0;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-roster-section{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:12px 18px 4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);letter-spacing:.02em}
.sch-roster-row{position:relative;display:grid;grid-template-columns:7px minmax(min(8em,100%),1fr) minmax(0,max-content);align-items:center;column-gap:10px;margin:1px 8px;border:0;background:none;padding:8px 10px;border-radius:10px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);transition:background .12s}
.sch-roster-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-row[data-selected=yes]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.sch-roster-row[data-row=archived] .sch-roster-name{color:var(--dsw-alias-label-tertiary)}
.sch-roster-row[data-compact=yes]{padding:3px 10px}
.sch-roster-row[data-compact=yes] .sch-roster-name{font-weight:400}
.sch-roster-row[data-compact=yes] .sch-roster-main{flex-direction:row;align-items:center}
.sch-roster-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.sch-roster-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:18px}
.sch-roster-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:16px}
.sch-roster-end{min-width:0;max-width:100%;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;column-gap:6px;row-gap:2px}
.sch-roster-state{min-width:3.2em;text-align:right;color:var(--sch-tone,var(--dsw-alias-label-tertiary));font:var(--dsw-font-xxs-12);white-space:nowrap}
.sch-roster-tail{flex:none;display:inline-flex;align-items:center;gap:6px}
.sch-roster-chev{color:var(--dsw-alias-label-caption);opacity:0;transition:opacity .12s}
.sch-roster-row:hover .sch-roster-chev,.sch-roster-row[data-selected=yes] .sch-roster-chev{opacity:1}
.sch-roster-item{position:relative}
.sch-roster-item[data-pending=yes]{opacity:.5}
.sch-roster-item .sch-roster-row{box-sizing:border-box;width:calc(100% - 16px);max-width:calc(100% - 16px)}
.sch-roster-archive,.sch-roster-rename{position:absolute;right:16px;top:50%;transform:translateY(-50%);display:none;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-item:hover :is(.sch-roster-archive,.sch-roster-rename),:is(.sch-roster-archive,.sch-roster-rename):focus-visible{display:inline-flex}
.sch-roster-item:has(.sch-roster-archive,.sch-roster-rename):hover .sch-roster-end{visibility:hidden}
:is(.sch-roster-archive,.sch-roster-rename):hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-head-actions{flex:none;display:flex;align-items:center;gap:2px}
.sch-roster-rename{right:46px}
.sch-roster-merge{position:absolute;right:76px;top:50%;transform:translateY(-50%);display:none;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-merge[data-slot="1"]{right:46px}
.sch-roster-merge[data-slot="0"]{right:16px}
.sch-roster-item:hover .sch-roster-merge,.sch-roster-merge:focus-visible{display:inline-flex}
.sch-roster-merge:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-item:has(.sch-roster-merge):hover .sch-roster-end{visibility:hidden}
.sch-roster-item > .sch-roster-form{margin:2px 12px 8px}
.sch-merge-keep{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-merge-keep label{display:inline-flex;flex-direction:row;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary)}
select.sch-roster-input{padding:0 4px}
.sch-roster-item:has(> .sch-roster-form) :is(.sch-roster-archive,.sch-roster-rename,.sch-roster-merge){display:none}
.sch-roster-rename[data-alone]{right:16px}
.sch-roster-edit{display:grid;grid-template-columns:7px minmax(0,1fr);align-items:center;column-gap:10px;margin:1px 8px;padding:6px 10px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-input{box-sizing:border-box;width:100%;min-width:0;height:26px;border:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-interactive-bg-hover));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);padding:0 8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.sch-roster-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.sch-roster-input::placeholder{color:var(--dsw-alias-label-caption)}
textarea.sch-roster-input{height:auto;min-height:52px;padding:5px 8px;resize:vertical;line-height:18px}
.sch-roster-form{display:flex;flex-direction:column;gap:6px;margin:4px 12px 6px;padding:10px;border:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-interactive-bg-hover));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
.sch-roster-form label{display:flex;flex-direction:column;gap:3px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-form-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:2px}
.sch-roster-primary{border:0;padding:4px 10px;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-roster-primary:disabled{opacity:.5;cursor:default}
.sch-roster-form-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere}
.sch-roster-below{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;justify-content:center;gap:4px;flex:none;margin:auto 0 0;border:0;border-top:1px solid var(--dsw-alias-border-l1,transparent);padding:7px 12px 8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;box-shadow:0 -8px 12px -6px color-mix(in srgb,var(--dsw-alias-bg-layer-1) 90%,transparent)}
.sch-roster-below:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 60%,var(--dsw-alias-bg-layer-1))}
.sch-roster-below svg{transform:rotate(90deg)}
.sch-roster-below[data-review=approval]{color:var(--dsw-alias-state-warn-primary)}
.sch-roster-below[data-review=reported]{color:var(--dsw-alias-label-primary)}
.sch-roster-below[data-review]::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.sch-roster-below[data-review=approval]::before{background:var(--dsw-alias-state-warn-primary)}
.sch-roster-item[data-flash] .sch-roster-row{animation:sch-flash 1.4s ease-out}
@keyframes sch-flash{0%,35%{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}100%{background:transparent}}
.sch-roster-more{display:block;margin:2px 8px 4px;border:0;background:none;padding:6px 10px 6px 28px;border-radius:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer;text-align:left}
.sch-roster-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sch-roster-foldrow{display:flex;align-items:center;justify-content:space-between;margin:6px 8px 0}
.sch-roster-foldrow .sch-roster-fold{margin:0}
.sch-roster-clear{border:0;background:none;padding:4px 8px;border-radius:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-roster-clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-roster-notice{margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));font:var(--dsw-font-xxs-12);line-height:18px}
.sch-roster-failure{margin:8px 12px 0;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}
.sch-roster-fold{display:flex;align-items:center;gap:4px;margin:6px 8px 0;border:0;background:none;padding:6px 10px;border-radius:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer;text-align:left}
.sch-roster-fold:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sch-roster-fold svg{transition:transform .15s}
.sch-roster-fold[aria-expanded=true] svg{transform:rotate(90deg)}
.sch-forkmodel{display:flex;flex-direction:column;gap:2px;padding:0 12px 4px 18px}
.sch-forkmodel-row{display:flex;align-items:center;gap:4px;min-width:0;margin-left:-6px}
.sch-forkmodel-label{flex:0 1 auto;min-width:3em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-forkmodel-row>.sch-mt{flex:none;max-width:60%}
.sch-forkmodel-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}
.sch-mm-composer{display:inline-flex;align-items:center;min-width:0}
.sch-roster-empty{margin:auto;padding:24px;max-width:220px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
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

const stateLabel = (state: RowState): string => t(`state.${state}`)

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
 * The command line that marks a member's latest report read.
 * @param member - the member's Session id.
 * @returns e.g. `/agents seen <id>`.
 */
export const seenLine = (member: string): string => `/agents seen ${member}`

/** A member's review mark (see src/review.ts). */
export type ReviewMark = 'approval' | 'failed' | 'reported'
const REVIEW_RANK: Record<ReviewMark, number> = { approval: 3, failed: 2, reported: 1 }
const reviewTitle = (mark: ReviewMark): string => t(`review.${mark}`)

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

function ReviewBadge({ summary }: { summary: { n: number; tone: ReviewMark | undefined } }) {
  if (summary.n === 0 || summary.tone === undefined) return null
  return <span className="sch-review-n" data-review={summary.tone} title={tn('review.count', summary.n)}>{summary.n}</span>
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
 * Give the Agents page a column of its own at the left of the right sidebar, moving any other
 * tab out of that column, and size it narrow when this call made the split. Each step is a
 * gesture the user could make by hand, so undo and saved layouts treat it the same way.
 * @param sidebar - `ctx.sidebarRight`.
 */
export function arrangeRoster(sidebar: SidebarFace | undefined): void {
  const gestures = gesturesOf(sidebar)
  if (sidebar === undefined || gestures === undefined) return
  const { sessionId, actions } = gestures
  let split = false
  for (let i = 0; i < 12; i += 1) {
    const layout = layoutOf(sidebar)
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
  const layout = layoutOf(sidebar)
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
    const layout = layoutOf(sidebar)
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
 * The one-line totals shared by the chip and the page header.
 * @param counts - live counts.
 * @param total - members that are not archived.
 * @returns the parts, in order of urgency.
 */
function summaryParts(counts: ReturnType<typeof countsOf>, total: number): string[] {
  const parts = [
    counts.waiting === 0 ? undefined : tn('count.waiting', counts.waiting),
    counts.running === 0 ? undefined : tn('count.running', counts.running),
    counts.queued === 0 ? undefined : tn('count.queued', counts.queued),
    counts.failed === 0 ? undefined : tn('count.failed', counts.failed),
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 || total === 0 ? parts : [t('count.allStopped')]
}

/**
 * Narrow a roster pane that a chat just split off: `preferNewPane` splits evenly, and the list
 * needs far less room than a conversation. Only called right after that split, so a divider the
 * user dragged stays where they left it.
 * @param sidebar - `ctx.sidebarRight`.
 */
export function narrowRoster(sidebar: SidebarFace | undefined): void {
  const gestures = gesturesOf(sidebar)
  const layout = layoutOf(sidebar)
  const root = layout?.nodes[layout.rootId]
  if (gestures === undefined || layout === undefined || root?.kind !== 'split') return
  const roster = findRoster(layout, AGENTS_KIND)
  const [left] = dockPanes(layout)
  if (roster === undefined || left === undefined || roster.pane.id !== left.id || left.tabs.length !== 1) return
  gestures.actions.resizeSplit?.(gestures.sessionId, root.id, [ROSTER_SHARE, 1 - ROSTER_SHARE])
}

/** What the Agents button says: the most urgent count, or how many are still around. */
function agentsLabel(members: readonly Member[], statuses: Statuses | undefined): { tone: RowState | 'idle'; text: string } {
  const counts = countsOf(members, statuses)
  if (counts.waiting > 0) return { tone: 'waiting', text: tn('count.waiting', counts.waiting) }
  if (counts.running > 0) return { tone: 'running', text: tn('count.running', counts.running) }
  if (counts.queued > 0) return { tone: 'queued', text: tn('count.queued', counts.queued) }
  if (counts.failed > 0) return { tone: 'failed', text: tn('count.failed', counts.failed) }
  return { tone: 'idle', text: '' }
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
  openAgents: () => void
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
    const members = (roster?.members ?? []).filter(m => m.state !== 'archived')
    const label = agentsLabel(members, statuses)
    // A fork archives itself right after handing back, so unread reports count over every member.
    const unreadReports = reviewSummary(roster?.members ?? [], statuses, true, visible)
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
        {members.length === 0 && !on && unreadReports.n === 0 ? null : (
          <button type="button" className="sch-agents-btn" aria-label={t('agents.open.aria')} title={t('agents.open.title')} onClick={deps.openAgents}>
            {label.tone === 'idle' ? null : <span className="sch-dot" data-row={label.tone} />}
            {t('agents.title')}
            {label.text === '' ? (members.length === 0 ? null : <span className="sch-agents-n">{members.length}</span>) : <span className="sch-agents-n" data-row={label.tone}>{label.text}</span>}
            <ReviewBadge summary={unreadReports} />
            {(roster?.inbox?.length ?? 0) === 0 ? null : <span className="sch-agents-mail" data-scheduler-mail={roster!.inbox!.length} title={tn('inbox.member', roster!.inbox!.length)}>✉{roster!.inbox!.length}</span>}
          </button>
        )}
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

/** What the roster has below its visible part: rows, and how many of them carry a mark. */
export interface HiddenBelow {
  /** Rows not wholly visible under the viewport's bottom edge. */
  readonly n: number
  /** Of those, rows with an unread report (green or red dot). */
  readonly unread: number
  /** Of those, rows waiting on the user (yellow dot). */
  readonly waiting: number
  /** Index of the first such row, or -1. */
  readonly first: number
}

/**
 * Count the rows below the visible part of a scrolled list.
 * @param rows - each row's bottom edge in content coordinates, with its review mark, top to bottom.
 * @param viewBottom - the content coordinate of the viewport's bottom edge (scrollTop + height).
 * @returns the hidden rows and their marks.
 */
export function hiddenBelow(rows: readonly { readonly bottom: number; readonly review?: ReviewMark | undefined }[], viewBottom: number): HiddenBelow {
  let n = 0
  let unread = 0
  let waiting = 0
  let first = -1
  // A pixel of slack: sub-pixel layouts leave the last row a fraction past a list scrolled to its end.
  rows.forEach((row, index) => {
    if (row.bottom <= viewBottom + 1) return
    if (first < 0) first = index
    n += 1
    if (row.review === 'approval') waiting += 1
    else if (row.review !== undefined) unread += 1
  })
  return { n, unread, waiting, first }
}

/**
 * The bottom hint's words.
 * @param below - what is hidden.
 * @returns e.g. 「下面还有 3 个 · 1 个未读」, or '' when nothing is.
 */
export function hiddenLabel(below: HiddenBelow): string {
  if (below.n === 0) return ''
  return [tn('below.rows', below.n), below.waiting === 0 ? undefined : tn('below.waiting', below.waiting), below.unread === 0 ? undefined : tn('below.unread', below.unread)]
    .filter(part => part !== undefined).join(' · ')
}

const NOTHING_BELOW: HiddenBelow = { n: 0, unread: 0, waiting: 0, first: -1 }
const sameBelow = (a: HiddenBelow, b: HiddenBelow) => a.n === b.n && a.unread === b.unread && a.waiting === b.waiting && a.first === b.first

/** The roster's member rows in DOM order. */
const rosterItems = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > .sch-roster-item')]

/**
 * Measure what a scrolled roster hides under its bottom edge.
 * @param list - the `.sch-roster` scroll container.
 * @returns the hidden rows; nothing while the page is not laid out (a hidden kept-mounted tab).
 */
function measureBelow(list: HTMLElement): HiddenBelow {
  if (list.clientHeight === 0) return NOTHING_BELOW
  const top = list.getBoundingClientRect().top - list.scrollTop
  const rows = rosterItems(list).map(item => ({ bottom: item.getBoundingClientRect().bottom - top, review: (item.dataset.review || undefined) as ReviewMark | undefined }))
  // The hint itself, pinned to the bottom, covers what is under it.
  const hint = list.querySelector<HTMLElement>(':scope > .sch-roster-below')?.offsetHeight ?? 0
  return hiddenBelow(rows, list.scrollTop + list.clientHeight - hint)
}

/**
 * Bring the first row below the fold into view, smoothly, and flash it so the eye lands on it.
 * It goes near the top, so the click shows a whole new screen of rows.
 * @param list - the `.sch-roster` scroll container.
 * @param index - the row's index among the member rows.
 */
function revealRow(list: HTMLElement, index: number): void {
  const item = rosterItems(list)[index]
  if (item === undefined) return
  const offset = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
  // Leave the row above it in sight, for context.
  list.scrollTo({ top: Math.max(0, offset - 56), behavior: 'smooth' })
  item.dataset.flash = ''
  window.setTimeout(() => { delete item.dataset.flash }, 1400)
}

/**
 * Track the rows a roster hides below its bottom edge. Recomputed on scroll (one read per frame),
 * on resize, and after every render (rows added, folds opened); never polled.
 * @returns a ref callback for the scroll container, the list element, and what it hides.
 */
function useHiddenBelow(): [(node: HTMLDivElement | null) => void, HTMLDivElement | null, HiddenBelow] {
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const [below, setBelow] = useState<HiddenBelow>(NOTHING_BELOW)
  const update = useCallback(() => {
    if (list === null) return
    const next = measureBelow(list)
    setBelow(prev => (sameBelow(prev, next) ? prev : next))
  }, [list])
  // After every render: cheap (one rect per row), and the only signal for rows that came or went.
  useEffect(update)
  useEffect(() => {
    if (list === null) return undefined
    let frame = 0
    const onScroll = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => { frame = 0; update() })
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onScroll)
    resize?.observe(list)
    return () => {
      list.removeEventListener('scroll', onScroll)
      resize?.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [list, update])
  return [setList, list, below]
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
    const label = memberModelLabel(groups, own)
    return (
      <span className="sch-mm-composer" data-scheduler-member-model={own === null ? 'default' : `${own.provider}/${own.model}${own.reasoningEffort === undefined ? '' : ` ${own.reasoningEffort}`}`}>
        <ModelMenu
          groups={groups}
          current={own}
          label={own === null ? t('model.default') : own.model}
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
 * The 「Worker 默认模型」 control of the Agents page: shows the Session's `/worker model` default and
 * changes it by running that command, so the log records it like a typed command.
 * @param deps - session, current value, command runner, and catalog loader.
 * @returns the control.
 */
function WorkerModelPicker(deps: { sessionId: string; current: ForkModel | null; run: (sessionId: string, line: string) => Promise<string | null>; catalog: CatalogSource }) {
  const { sessionId, current, run, catalog } = deps
  // Live: follows every change the Host makes to the model list, like the composer's menu.
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const groups = snapshot.groups
  const loadError = groups === undefined ? snapshot.error : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { catalog.load() }, [catalog])
  const change = (next: ForkModel | null) => {
    setBusy(true)
    setError(null)
    run(sessionId, workerModelCommand(next)).then(failure => { setBusy(false); setError(failure) }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
  }
  const shown = groups ?? []
  const stale = isStale(snapshot, current)
  const label = workerModelLabel(shown, current)
  const level = stale ? undefined : effortLabel(shown, current)
  const value = workerModelValue(current)
  return (
    <div className="sch-forkmodel" data-scheduler-worker-model={value === '' ? 'default' : value}>
      <div className="sch-forkmodel-row">
        <span className="sch-forkmodel-label" title={t('worker.model.label')}>{t('worker.model.label')}</span>
        <ModelMenu
          groups={groups}
          current={current}
          label={label}
          stale={stale}
          onOpen={catalog.load}
          defaultLabel={t('worker.model.defaultRow')}
          defaultValue={t('worker.model.default')}
          busy={busy}
          size="compact"
          ariaLabel={stale ? t('worker.model.ariaStale', { label }) : t('worker.model.aria', { label: level === undefined ? label : `${label} · ${level}` })}
          title={t('worker.model.title')}
          onPick={change}
          failure={loadError === null ? undefined : <div className="sch-mm-empty" role="status" title={loadError}>{t('model.loadFailed')}</div>}
        />
      </div>
      {error === null ? null : <div className="sch-forkmodel-error" role="status" title={error}>{t('error.switchDetail', { error })}</div>}
    </div>
  )
}

/**
 * Create the Agents page body for the right sidebar.
 * @param ctx - client plugin context, for the controller's known child addresses.
 * @returns the slot component.
 */
export function createAgentsPage(ctx: {
  sidebarRight?: SidebarFace | undefined
  /** The sidebar resource address of a member's native chat. */
  chatAddress: (parent: string, child: string) => string
}, run: (sessionId: string, line: string) => Promise<string | null> = async () => 'unavailable', has: (sessionId: string, name: string) => Promise<boolean> = async () => true, catalog?: CatalogSource) {
  return memo(function AgentsPage(props: {
    sessionId?: string
    useProjection?: (key: string) => unknown
    useSessionStatus?: UseSessionStatus
    useTabInfo?: () => { panel?: { id?: string }; tab: { actions: { openResource: (address: string, options?: Record<string, unknown>) => void; close: () => void } } }
  }) {
    useLocale()
    const roster = rosterOf(props)
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    const tab = props.useTabInfo?.()
    // What this browser read on screen (see active-seen.ts) counts here too.
    useSyncExternalStore(browserSeen.subscribe, browserSeen.revision, browserSeen.revision)
    const rows = props.sessionId === undefined ? roster?.members ?? [] : browserSeen.apply(props.sessionId, roster?.members ?? [])
    const [picked, setPicked] = useState<string | undefined>(undefined)
    const [showArchived, setShowArchived] = useState(false)
    const [showAllArchived, setShowAllArchived] = useState(false)
    const [showDone, setShowDone] = useState(false)
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
    const [failure, setFailure] = useState<string | null>(null)
    // The browser half updates as soon as the plugin is installed; the host half (and with it
    // /agents) only after DeepSeek Harness restarts. Ask the Session instead of failing on click.
    const [canArchiveHere, setCanArchiveHere] = useState(true)
    // Hosts without /worker (not restarted since the update) hide the picker.
    const [canPickWorkerModel, setCanPickWorkerModel] = useState(false)
    const sessionId = props.sessionId
    useEffect(() => {
      if (sessionId === undefined) return undefined
      let alive = true
      has(sessionId, 'agents').then(ok => { if (alive) setCanArchiveHere(ok) }, () => undefined)
      has(sessionId, 'worker').then(ok => { if (alive) setCanPickWorkerModel(ok) }, () => undefined)
      return () => { alive = false }
    }, [sessionId])
    // A host not restarted since the update refuses `seen`; the mark then stays until it is.
    const markSeen = (session: string, member: string) => { run(session, seenLine(member)).catch(() => undefined) }
    const archive = (target: string) => {
      if (props.sessionId === undefined) return
      setPending(p => new Set([...p, target]))
      setFailure(null)
      const settle = (error: string | null) => {
        setPending(p => { const next = new Set(p); next.delete(target); return next })
        if (error !== null && /unknown command/u.test(error)) { setCanArchiveHere(false); setFailure(null); return }
        setFailure(error)
      }
      run(props.sessionId, `/agents archive ${target}`).then(settle, (reason: unknown) => { settle(reason instanceof Error ? reason.message : String(reason)) })
    }
    // 「新建 worker」 form and the row being renamed; both run /agents, which the host checks again.
    const [creating, setCreating] = useState(false)
    const [draft, setDraft] = useState({ name: '', role: '', cwd: '' })
    const [formError, setFormError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    // 「合并到…」 on a worker row: the other worker, which side stays, the survivor's new name.
    const [merging, setMerging] = useState<{ id: string; from: string; other: string; keep: 'other' | 'this'; name: string; error: string | null; busy: boolean } | undefined>(undefined)
    const [renaming, setRenaming] = useState<{ id: string; from: string; value: string; error: string | null; busy: boolean } | undefined>(undefined)
    const restartNote = (error: string) => needsRestartFor(error) || /unknown command/u.test(error) ? t('restart.note') : error
    const create = () => {
      if (sessionId === undefined || submitting) return
      const built = newWorkerCommand(draft)
      if ('error' in built) { setFormError(built.error); return }
      setSubmitting(true)
      setFormError(null)
      const settle = (error: string | null) => {
        setSubmitting(false)
        if (error !== null) { setFormError(restartNote(error)); return }
        setCreating(false)
        setDraft({ name: '', role: '', cwd: '' })
      }
      run(sessionId, built.line).then(settle, (reason: unknown) => { settle(reason instanceof Error ? reason.message : String(reason)) })
    }
    const commitRename = () => {
      if (sessionId === undefined || renaming === undefined || renaming.busy) return
      if (renaming.value.trim() === renaming.from) { setRenaming(undefined); return }
      const built = renameCommand(renaming.from, renaming.value)
      if ('error' in built) { setRenaming({ ...renaming, error: built.error }); return }
      setRenaming({ ...renaming, busy: true, error: null })
      const settle = (error: string | null) => {
        setRenaming(r => r === undefined || r.id !== renaming.id ? r : error === null ? undefined : { ...r, busy: false, error: restartNote(error) })
      }
      run(sessionId, built.line).then(settle, (reason: unknown) => { settle(reason instanceof Error ? reason.message : String(reason)) })
    }
    const layout = layoutOf(ctx.sidebarRight)
    // A member whose chat the user is looking at carries no dot: what arrived is already visible.
    const visible = layout === undefined ? new Set<string>() : visibleChildren(layout, rows.map(m => m.id))
    const selected = (layout === undefined ? undefined : activeChild(layout, AGENTS_KIND, rows.map(m => m.id))) ?? picked
    const open = (member: Member) => {
      if (props.sessionId === undefined || tab === undefined) return
      setPicked(member.id)
      // Opening the chat reads its latest report; a prompt waiting stays marked until answered.
      if (reviewOf(member) !== undefined) markSeen(props.sessionId, member.id)
      const placement = placeChat(ctx.sidebarRight, tab.panel?.id)
      tab.tab.actions.openResource(ctx.chatAddress(props.sessionId, member.id), placement)
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
    // A member with something to look at stays in its section until the user opens it, even a
    // fork that archived itself right after handing back: the folds hide only what was read.
    const marked = (m: Member) => reviewMarkOf(m, statuses, visible) !== undefined
    // A fork that handed back its conclusion and is not working again is finished work: folded
    // away under 「已交回」, where one click archives it or all of them.
    const finished = (m: Member) => m.kind === 'fork' && m.state === 'done' && statuses?.get(m.id)?.running !== true && statuses?.get(m.id)?.pendingInteraction === undefined
    const done = live.filter(m => finished(m) && !marked(m))
    const forks = rows.filter(m => m.kind === 'fork' && (m.state === 'archived' || finished(m) ? marked(m) : true))
    const workers = byArea(rows.filter(m => m.kind === 'worker' && (m.state !== 'archived' || marked(m))))
    const archived = rows.filter(m => m.state === 'archived' && !marked(m))
    const counts = countsOf(rows, statuses)
    // The open chat's row is always visible: opening an archived or handed-back fork (say from
    // its message's 「查看」) unfolds its group once, so the selection is not hidden in a fold.
    const selectedIn = selected === undefined ? undefined : archived.some(m => m.id === selected) ? 'archived' : done.some(m => m.id === selected) ? 'done' : undefined
    useEffect(() => {
      if (selectedIn === 'archived') setShowArchived(true)
      else if (selectedIn === 'done') setShowDone(true)
    }, [selected, selectedIn])
    const openTo = (id: string) => (roster?.openRequests ?? []).filter(r => r.to === id)
    const [listRef, list, below] = useHiddenBelow()
    // Workers whose team is folded open under their row.
    const [teamsOpen, setTeamsOpen] = useState<ReadonlySet<string>>(new Set())
    const openMember = (parent: string, child: string) => {
      if (tab === undefined) return
      const placement = placeChat(ctx.sidebarRight, tab.panel?.id)
      tab.tab.actions.openResource(ctx.chatAddress(parent, child), placement)
      if ('preferNewPane' in placement) narrowRoster(ctx.sidebarRight)
    }
    const row = (member: Member) => {
      const state = rowStateOf(member, statuses)
      const pendingRequests = openTo(member.id)
      const waiting = (roster?.inbox ?? []).filter(m => m.from === member.id).length
      const canArchive = canArchiveHere && member.state !== 'archived' && state !== 'running' && state !== 'waiting'
      const review = reviewMarkOf(member, statuses, visible)
      // An archived member is history: one line, no subtitle. A dozen of them must not push the
      // live work off the page. One still unread keeps its full row until it is opened.
      const compact = member.state === 'archived' && review === undefined
      const team = member.kind === 'worker' ? roster?.teams?.[member.id] : undefined
      const hasTeam = team !== undefined && (team.members.length > 0 || team.tasks.length > 0)
      const merge = (roster?.merging ?? []).find(m => m.absorbed === member.id || m.survivor === member.id)
      const nameOf = (id: string) => rows.find(m => m.id === id)?.name ?? id
      const usual = hasTeam ? `${subline(member, pendingRequests)}${subline(member, pendingRequests) === '' ? '' : ' · '}${teamSummary(team)}` : subline(member, pendingRequests)
      const second = compact ? '' : merge !== undefined ? mergeLine(member, merge, nameOf) : usual
      // The subtitle is cut to one line: its tooltip has it whole, and during a merge also what it replaced
      // (the absorbed side's handoff request, or the survivor's own work).
      const secondTitle = merge !== undefined && usual !== '' ? `${second}\n${usual}` : second
      // Only a worker has a name of its own to change; a fork is fork-N. An archived one keeps its name.
      const canRename = canArchiveHere && member.kind === 'worker' && member.state !== 'archived' && merge === undefined
      // Merge into another live worker: there must be one, and neither may be mid-merge.
      const partners = mergePartners(rows, member, roster?.merging ?? [])
      const canMerge = canRename && partners.length > 0
      if (renaming?.id === member.id) {
        return (
          <div key={member.id} className="sch-roster-item">
            <form className="sch-roster-edit" onSubmit={e => { e.preventDefault(); commitRename() }}>
              <span className="sch-dot" data-row={state} />
              <span className="sch-roster-main">
                <input
                  className="sch-roster-input"
                  aria-label={t('rename.input', { name: member.name })}
                  value={renaming.value}
                  disabled={renaming.busy}
                  autoFocus
                  spellCheck={false}
                  onChange={e => { const value = e.currentTarget.value; setRenaming(r => r === undefined ? r : { ...r, value, error: null }) }}
                  onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(undefined) } }}
                />
                {renaming.error === null ? <span className="sch-roster-sub">{t('rename.hint')}</span> : <span className="sch-roster-form-error" role="status">{renaming.error}</span>}
              </span>
            </form>
          </div>
        )
      }
      return (
        <div key={member.id} className="sch-roster-item" {...(hasTeam ? { 'data-team': '' } : {})} data-pending={pending.has(member.name) ? 'yes' : 'no'} {...(review === undefined ? {} : { 'data-review': review })}>
        <button type="button" className="sch-roster-row" data-row={state} data-compact={compact ? 'yes' : 'no'} data-selected={member.id === selected ? 'yes' : 'no'} onClick={() => { open(member) }} title={rowTitle(member)}>
          <span className="sch-dot" data-row={state} {...(review === undefined ? {} : { 'data-review': review, title: reviewTitle(review) })} />
          <span className="sch-roster-main">
            <span className="sch-roster-name">{member.name}</span>
            {second === '' ? null : <span className="sch-roster-sub" title={secondTitle}>{second}</span>}
          </span>
          <span className="sch-roster-end">
            {waiting === 0 ? null : <span className="sch-roster-mail" data-scheduler-mail={waiting} title={tn('inbox.member', waiting)}>✉</span>}
            {merge === undefined ? null : <span className="sch-roster-badge" data-scheduler-merging={merge.id} title={t('merge.pending', { id: merge.id })}>{merge.id}</span>}
            {pendingRequests.length === 0 ? null : <span className="sch-roster-reqs" data-scheduler-open={pendingRequests.length} title={pendingRequests.map(r => t('row.request', { id: r.id, text: r.text.replace(/\s+/gu, ' ').slice(0, 80) })).join('\n')}>{openLabel(pendingRequests.length, state)}</span>}
            <span className="sch-roster-tail"><span className="sch-roster-state" data-row={state}>{stateLabel(state)}</span><span className="sch-roster-chev">{ICON.chevron}</span></span>
          </span>
        </button>
        {canMerge ? <button type="button" className="sch-roster-merge" data-slot={(canRename ? 1 : 0) + (canArchive ? 1 : 0)} aria-label={t('merge.aria', { name: member.name })} title={t('merge.action')} disabled={pending.has(member.name)} onClick={() => { setMerging(startMerge(member, partners, statuses, openTo)) }}>{ICON.merge}</button> : null}
        {merging?.id === member.id ? mergeForm(member, partners) : null}
        {canRename ? <button type="button" className="sch-roster-rename" data-alone={canArchive ? undefined : ''} aria-label={t('rename.aria', { name: member.name })} title={t('rename.title')} disabled={pending.has(member.name)} onClick={() => { setRenaming({ id: member.id, from: member.name, value: member.name, error: null, busy: false }) }}>{ICON.rename}</button> : null}
        {canArchive ? <button type="button" className="sch-roster-archive" aria-label={t('archive.aria', { name: member.name })} title={t('archive.title')} disabled={pending.has(member.name)} onClick={() => { archive(member.name) }}>{ICON.archive}</button> : null}
        {!hasTeam ? null : (
          <button type="button" className="sch-roster-team-toggle" data-scheduler-team-toggle={member.name} aria-expanded={teamsOpen.has(member.id)} aria-label={t(teamsOpen.has(member.id) ? 'team.collapse' : 'team.expand', { name: member.name })} onClick={() => { setTeamsOpen(s => { const n = new Set(s); if (n.has(member.id)) n.delete(member.id); else n.add(member.id); return n }) }}>
            {teamsOpen.has(member.id) ? '▾' : '▸'} {t('team.toggle')}
          </button>
        )}
        {hasTeam && teamsOpen.has(member.id) ? <TeamBlock team={team} owner={member.id} open={openMember} /> : null}
        </div>
      )
    }
    const commitMerge = (member: Member) => {
      if (sessionId === undefined || merging === undefined || merging.busy) return
      const other = rows.find(m => m.name === merging.other)
      if (other === undefined) return
      const [absorbed, survivor] = merging.keep === 'other' ? [member.name, other.name] : [other.name, member.name]
      const built = mergeCommand(absorbed, survivor, merging.name)
      if ('error' in built) { setMerging({ ...merging, error: built.error }); return }
      setMerging({ ...merging, busy: true, error: null })
      const settle = (error: string | null) => { setMerging(m => m === undefined || m.id !== member.id ? m : error === null ? undefined : { ...m, busy: false, error: restartNote(error) }) }
      run(sessionId, built.line).then(settle, (reason: unknown) => { settle(reason instanceof Error ? reason.message : String(reason)) })
    }
    const mergeForm = (member: Member, partners: readonly Member[]) => {
      if (merging === undefined) return null
      const other = merging.other
      const keep = (which: 'other' | 'this') => { setMerging(m => m === undefined ? m : { ...m, keep: which, error: null }) }
      return (
        <form className="sch-roster-form" data-scheduler-merge={member.name} onSubmit={e => { e.preventDefault(); commitMerge(member) }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setMerging(undefined) } }}>
          <label>{t('merge.with')}
            <select className="sch-roster-input" value={other} disabled={merging.busy} onChange={e => { const value = e.currentTarget.value; setMerging(m => m === undefined ? m : { ...startMerge(member, partners.filter(p => p.name === value), statuses, openTo), name: m.name }) }}>
              {partners.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <div className="sch-merge-keep" role="radiogroup" aria-label={t('merge.keep')}>
            <span>{t('merge.keep')}</span>
            <label><input type="radio" name={`keep-${member.id}`} checked={merging.keep === 'other'} disabled={merging.busy} onChange={() => { keep('other') }} />{other}</label>
            <label><input type="radio" name={`keep-${member.id}`} checked={merging.keep === 'this'} disabled={merging.busy} onChange={() => { keep('this') }} />{member.name}</label>
          </div>
          <label>{t('merge.name')}
            <input className="sch-roster-input" value={merging.name} placeholder={t('merge.namePlaceholder')} spellCheck={false} disabled={merging.busy} onChange={e => { const name = e.currentTarget.value; setMerging(m => m === undefined ? m : { ...m, name, error: null }) }} />
          </label>
          <div className="sch-roster-sub">{t('merge.hint')}</div>
          {merging.error === null ? null : <div className="sch-roster-form-error" role="status">{merging.error}</div>}
          <div className="sch-roster-form-actions">
            <button type="button" className="sch-roster-clear" disabled={merging.busy} onClick={() => { setMerging(undefined) }}>{t('merge.cancel')}</button>
            <button type="submit" className="sch-roster-primary" disabled={merging.busy}>{merging.busy ? t('merge.submitting') : t('merge.submit')}</button>
          </div>
        </form>
      )
    }
    const section = (title: string, members: readonly Member[]) => {
      if (members.length === 0) return null
      const busy = members.filter(m => { const s = rowStateOf(m, statuses); return s === 'running' || s === 'waiting' }).length
      return (
        <>
          <div className="sch-roster-section"><span className="sch-roster-section-title">{title}<ReviewBadge summary={reviewSummary(members, statuses, false, visible)} /></span><span>{busy === 0 ? members.length : t('section.busy', { busy, total: members.length })}</span></div>
          {members.map(member => row(member))}
        </>
      )
    }
    return (
      <div className="sch-roster" data-scheduler-roster="" ref={listRef}>
        {failure === null ? null : <div className="sch-roster-failure" role="status">{failure}</div>}
        {canArchiveHere ? null : <div className="sch-roster-notice" role="status" data-scheduler-restart="">{t('restart.archive')}</div>}
        <div className="sch-roster-head">
          <div>
            <div className="sch-roster-title">{t('agents.title')}</div>
            <div className="sch-roster-summary">{live.length === 0 ? t('roster.none') : [tn('roster.total', live.length), ...summaryParts(counts, live.length)].join(' · ')}</div>
          </div>
          <div className="sch-roster-head-actions">
            {props.sessionId === undefined || reviewSummary(rows, statuses, true, visible).n === 0 ? null : <button type="button" className="sch-roster-clear" data-scheduler-seen-all="" title={t('seenAll.title')} onClick={() => { markSeen(props.sessionId!, 'all') }}>{t('seenAll.label')}</button>}
            {sessionId === undefined || !canArchiveHere ? null : <button type="button" className="sch-roster-collapse" aria-label={t('new.aria')} aria-expanded={creating} title={t('new.title')} onClick={() => { setCreating(v => !v); setFormError(null) }}>{ICON.plus}</button>}
            <button type="button" className="sch-roster-collapse" aria-label={t('collapse.aria')} title={t('collapse.title')} onClick={collapse}>{ICON.collapse}</button>
          </div>
        </div>
        {!creating ? null : (
          <form className="sch-roster-form" data-scheduler-new-worker="" onSubmit={e => { e.preventDefault(); create() }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setCreating(false) } }}>
            <label>{t('form.name')}
              <input className="sch-roster-input" value={draft.name} placeholder={t('form.namePlaceholder')} autoFocus spellCheck={false} disabled={submitting} onChange={e => { const name = e.currentTarget.value; setDraft(d => ({ ...d, name })); setFormError(null) }} />
            </label>
            <label>{t('form.role')}
              <textarea className="sch-roster-input" value={draft.role} placeholder={t('form.rolePlaceholder')} disabled={submitting} onChange={e => { const role = e.currentTarget.value; setDraft(d => ({ ...d, role })); setFormError(null) }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create() } }} />
            </label>
            <label>{t('form.cwd')}
              <input className="sch-roster-input" value={draft.cwd} placeholder={t('form.cwdPlaceholder')} spellCheck={false} disabled={submitting} onChange={e => { const cwd = e.currentTarget.value; setDraft(d => ({ ...d, cwd })); setFormError(null) }} />
            </label>
            {formError === null ? null : <div className="sch-roster-form-error" role="status">{formError}</div>}
            <div className="sch-roster-form-actions">
              <button type="button" className="sch-roster-clear" disabled={submitting} onClick={() => { setCreating(false); setFormError(null) }}>{t('form.cancel')}</button>
              <button type="submit" className="sch-roster-primary" disabled={submitting || draft.name.trim() === '' || draft.role.trim() === ''}>{submitting ? t('form.creating') : t('form.create')}</button>
            </div>
          </form>
        )}
        {sessionId === undefined || catalog === undefined || !canPickWorkerModel ? null : <WorkerModelPicker sessionId={sessionId} current={roster?.workerModel ?? null} run={run} catalog={catalog} />}
        {sessionId === undefined || rows.length === 0 || roster?.inbox === undefined ? null : (
          <InboxSection
            items={roster.inbox}
            delivered={roster.delivered}
            leadRunning={statuses?.get(sessionId)?.running === true}
            owed={(roster.openRequests ?? []).map(r => `${r.id} ${rows.find(m => m.id === r.to)?.name ?? r.to}`)}
            nameOf={id => rows.find(m => m.id === id)?.name ?? id}
            run={line => run(sessionId, line)}
            open={id => { const member = rows.find(m => m.id === id); if (member !== undefined) open(member) }}
          />
        )}
        {sessionId === undefined || (roster?.teams?.[sessionId]?.members.length ?? 0) === 0 ? null : (
          <>
            <div className="sch-roster-section" data-scheduler-lead-team=""><span className="sch-roster-section-title">{t('team.lead')}</span><span>{roster?.enabled === true ? t('team.leadOn') : teamSummary(roster!.teams![sessionId]!)}</span></div>
            <TeamBlock team={roster!.teams![sessionId]!} owner={sessionId} open={openMember} />
          </>
        )}
        {rows.length === 0
          ? <div className="sch-roster-empty">{t('empty.none')}<br />{t(roster?.enabled === true ? 'empty.on' : 'empty.off')}</div>
          : (
            <>
              {section(t('section.forks'), forks)}
              {section(t('section.workers'), workers)}
              {done.length === 0 ? null : (
                <>
                  <div className="sch-roster-foldrow">
                    <button type="button" className="sch-roster-fold" aria-expanded={showDone} onClick={() => { setShowDone(v => !v) }}>
                      {ICON.chevron}{t('fold.done', { count: done.length })}
                    </button>
                    {canArchiveHere
                      ? <button type="button" className="sch-roster-clear" disabled={pending.has('done')} title={t('archiveDone.title')} onClick={() => { archive('done') }}>{t('archiveDone.label')}</button>
                      : null}
                  </div>
                  {showDone ? done.map(member => row(member)) : null}
                </>
              )}
              {archived.length === 0 ? null : (
                <>
                  <button type="button" className="sch-roster-fold" aria-expanded={showArchived} onClick={() => { setShowArchived(v => !v) }}>
                    {ICON.chevron}{t('fold.archived', { count: archived.length })}
                  </button>
                  {showArchived ? (showAllArchived ? archived : archived.slice(0, ARCHIVED_ROWS)).map(member => row(member)) : null}
                  {showArchived && archived.length > ARCHIVED_ROWS ? (
                    <button type="button" className="sch-roster-more" aria-expanded={showAllArchived} onClick={() => { setShowAllArchived(v => !v) }}>
                      {showAllArchived ? t('more.collapse') : t('more.show', { count: archived.length - ARCHIVED_ROWS })}
                    </button>
                  ) : null}
                </>
              )}
            </>
          )}
        {below.n === 0 ? null : (
          <button
            type="button"
            className="sch-roster-below"
            data-scheduler-below={below.n}
            {...(below.waiting > 0 ? { 'data-review': 'approval' } : below.unread > 0 ? { 'data-review': 'reported' } : {})}
            title={t('below.title')}
            onClick={() => { if (list !== null) revealRow(list, below.first) }}
          >
            {ICON.chevron}{hiddenLabel(below)}
          </button>
        )}
      </div>
    )
  })
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

/** The form's first state: the first partner, and which side stays by the scheduler's rule. */
function startMerge(member: Member, partners: readonly Member[], statuses: Statuses | undefined, openTo: (id: string) => readonly unknown[]) {
  const other = partners[0]!
  const busy = (m: Member) => { const s = rowStateOf(m, statuses); return s === 'running' || s === 'waiting' || openTo(m.id).length > 0 }
  const [, survivor] = defaultSurvivor(member, other, busy)
  return { id: member.id, from: member.name, other: other.name, keep: survivor.id === other.id ? 'other' as const : 'this' as const, name: '', error: null, busy: false }
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
  ctx.effect(() => injectStyle(doc, 'dsh-agent-scheduler', STYLE + HOST_CSS + MODEL_MENU_STYLE + INBOX_STYLE + TEAM_STYLE), 'agent-scheduler: styles')
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
    if ('preferNewPane' in placement) narrowRoster(face)
  }
  const openAgents = () => { openAgentsPage(sidebar()) }
  registerSlot(ctx, 'chatNode', { key: NODE_KIND }, createInputCard(open))
  registerSlot(ctx, 'chatNode', { key: REQUEST_KIND }, RequestCardView)
  registerTabType(ctx, { id: AGENTS_ID, kind: AGENTS_KIND, title: () => t('agents.title'), keepMounted: true })
  ctx.effect(() => keepChatTabsMounted(ctx), 'agent-scheduler: keep agent chats mounted')
  ctx.effect(() => steadyTabStrips(doc), 'agent-scheduler: keep the sidebar tab strip still')
  registerSlot(ctx, 'paneTab', { key: AGENTS_ID }, createAgentsPage({ get sidebarRight() { return sidebar() }, chatAddress: host.chatAddress }, run, has, catalog))
  const setMode = (sessionId: string, on: boolean) => run(sessionId, on ? '/schedule on' : '/schedule off')
  const supports = (sessionId: string) => has(sessionId, 'schedule')
  registerSlot(ctx, 'inputRight', { id: 'agent-scheduler-model', order: 100, inject: (sessionId: string) => ({ sessionId }) }, createMemberModelPicker({ parentOf: host.parentOf, rosterFace, run, has, catalog }))
  registerSlot(ctx, 'inputLeft', { id: 'agent-scheduler', order: 10, inject: (sessionId: string) => ({ sessionId }) }, createScheduleSwitch({ setMode, openAgents, isChild: host.isChild, supports, sidebar }))
  registerRecoveryConfig(ctx)
}
