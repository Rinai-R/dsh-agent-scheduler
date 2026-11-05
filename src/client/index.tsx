/**
 * Browser half: renders each handed-off user input where the lead's history no longer holds it,
 * the right-sidebar Agents page, and the scheduling switch in the composer's mode row. The roster reads the
 * host's `agentScheduler` session projection and the root `useSessionStatus` hook (the only
 * source of "waiting for you"); opening a fork or worker reuses the native subagent-chat
 * resource, so the embedded conversation, its composer and its stop action are the product's own.
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { registerRecoveryConfig } from './recovery-config.js'
import { catalogModel, effortLabel, MODEL_MENU_STYLE, ModelMenu, type CatalogGroup } from './model-menu.js'
import { activeChild, chatPlacementIn, dockPanes, findRoster, nextRosterStep, ROSTER_SHARE, type DockLayout } from './layout.js'

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
interface Member { readonly id: string; readonly name: string; readonly kind: 'fork' | 'worker'; readonly state: string; readonly text: string; readonly role?: string; readonly cwd?: string; readonly model?: string; readonly detail?: string; readonly pickedModel?: ForkModel }
/** Provider route and model, as `/fork model` records it. */
export interface ForkModel { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
interface Roster { readonly enabled?: boolean; readonly role: string | null; readonly workerModel?: ForkModel | null; readonly members: readonly Member[]; readonly openRequests: readonly { id: string; from: string; to: string; text: string }[] }
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
  const { id, from, text } = node.data
  return (
    <details className="sch-request" data-scheduler-request={id}>
      <summary><span className="sch-request-dot" />收到请求 {id}（来自 {from}）<span className="sch-request-hint">在这轮进行中送达，这轮结束时一并回答，回答交给 lead</span></summary>
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
.sch-roster-reqs{margin-right:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap}
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
@keyframes sch-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sch-dot) 55%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
/* A wake whose only message was handed off leaves a turn with no content: process row, then tail. */
[data-chat-flow-kind="turn-process"]:has(+ [data-chat-flow-kind="turn-tail"]),
[data-chat-flow-kind="turn-process"] + [data-chat-flow-kind="turn-tail"]{display:none}

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
.sch-roster{display:flex;flex-direction:column;height:100%;overflow:auto;padding:0 0 12px;font-size:13px}
.sch-roster-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px 12px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,transparent)}
.sch-roster-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.sch-roster-summary{margin-top:2px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-roster-collapse{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;background:none;padding:0;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-roster-section{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:12px 18px 4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);letter-spacing:.02em}
.sch-roster-row{position:relative;display:grid;grid-template-columns:7px minmax(0,1fr) auto;align-items:center;column-gap:10px;margin:1px 8px;border:0;background:none;padding:8px 10px;border-radius:10px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);transition:background .12s}
.sch-roster-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-row[data-selected=yes]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.sch-roster-row[data-row=archived] .sch-roster-name{color:var(--dsw-alias-label-tertiary)}
.sch-roster-row[data-compact=yes]{padding:3px 10px}
.sch-roster-row[data-compact=yes] .sch-roster-name{font-weight:400}
.sch-roster-row[data-compact=yes] .sch-roster-main{flex-direction:row;align-items:center}
.sch-roster-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.sch-roster-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:18px}
.sch-roster-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:16px}
.sch-roster-end{display:flex;align-items:center;gap:6px}
.sch-roster-state{min-width:3.2em;text-align:right;color:var(--sch-tone,var(--dsw-alias-label-tertiary));font:var(--dsw-font-xxs-12);white-space:nowrap}
.sch-roster-chev{color:var(--dsw-alias-label-caption);opacity:0;transition:opacity .12s}
.sch-roster-row:hover .sch-roster-chev,.sch-roster-row[data-selected=yes] .sch-roster-chev{opacity:1}
.sch-roster-item{position:relative}
.sch-roster-item[data-pending=yes]{opacity:.5}
.sch-roster-item .sch-roster-row{width:calc(100% - 16px)}
.sch-roster-archive{position:absolute;right:16px;top:50%;transform:translateY(-50%);display:none;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-item:hover .sch-roster-archive,.sch-roster-archive:focus-visible{display:inline-flex}
.sch-roster-item:has(.sch-roster-archive):hover .sch-roster-end{visibility:hidden}
.sch-roster-archive:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
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
.sch-forkmodel-label{flex:none;padding-left:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-forkmodel-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}
.sch-mm-composer{display:inline-flex;align-items:center;min-width:0}
.sch-roster-empty{margin:auto;padding:24px;max-width:220px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
`

const INPUT_LABEL: Record<CardState, string> = { queued: '分身排队中', running: '分身处理中', done: '分身已交回', failed: '分身启动失败', archived: '分身已归档' }

/**
 * What the status line under a handed-off message says: who has it and where it is, so a send
 * that the lead did not answer still visibly went somewhere.
 * @param state - the card state.
 * @returns the line's parts; `name` is bold, `open` is the call to action.
 */
export function statusLine(state: Pick<State, 'fork' | 'name' | 'detail'>): { lead: string; name: string; tail: string; open: string } {
  const name = state.name ?? '分身'
  switch (state.fork) {
    case 'queued': return { lead: '已交给 ', name, tail: ' · 排队等空位', open: '查看' }
    case 'running': return { lead: '已交给 ', name, tail: ' · 处理中', open: '查看' }
    case 'done': return { lead: '', name, tail: ' 已交回', open: '查看' }
    // A fork archives itself once it has handed back; to the user it is still "handed back".
    case 'archived': return { lead: '', name, tail: ' 已交回', open: '查看' }
    case 'failed': return { lead: '', name, tail: ` 启动失败${state.detail === undefined ? '' : `：${state.detail}`}`, open: '查看' }
  }
}

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
    const definition = tabs.get?.('subagentchat')
    if (definition === undefined || definition.keepMounted === true || touched.has(definition)) return
    touched.set(definition, definition.keepMounted)
    try { definition.keepMounted = true } catch { touched.delete(definition) }
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
    const { text, fork, forkId, detail, logged } = node.data
    const line = statusLine(node.data)
    return (
      <div className="sch-input" data-scheduler-input="" data-fork-state={fork} data-logged={logged === true ? 'yes' : 'no'}>
        {logged === true ? null : <div className="sch-input-bubble">{text}</div>}
        <button type="button" className="sch-input-fork" data-state={fork} title={`${INPUT_LABEL[fork]}${detail === undefined ? '' : `：${detail}`}。点击在右侧打开这个分身的对话`} aria-label={`${line.lead}${line.name}${line.tail}，${line.open}`} onClick={() => { open(sessionId, forkId) }}>
          <span className="sch-input-dot" data-state={fork} />
          <span className="sch-input-what">{line.lead}<span className="sch-input-name">{line.name}</span>{line.tail}</span>
          <span className="sch-input-open">{line.open}{ICON.chevron}</span>
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

/** What the Agents button says: the most urgent count, or how many are still around. */
function agentsLabel(members: readonly Member[], statuses: Statuses | undefined): { tone: RowState | 'idle'; text: string } {
  const counts = countsOf(members, statuses)
  if (counts.waiting > 0) return { tone: 'waiting', text: `${counts.waiting} 等你` }
  if (counts.running > 0) return { tone: 'running', text: `${counts.running} 在跑` }
  if (counts.queued > 0) return { tone: 'queued', text: `${counts.queued} 排队` }
  if (counts.failed > 0) return { tone: 'failed', text: `${counts.failed} 失败` }
  return { tone: 'idle', text: '' }
}

/**
 * Create the scheduling switch for the composer's mode row: one chip that turns scheduling on or
 * off, like Plan beside it, and next to it an Agents button whenever this session has forks or
 * workers. Turning scheduling off keeps them; the Agents page archives them.
 * @param deps - the command runner and the Agents page opener.
 * @returns the slot component.
 */
export function createScheduleSwitch(deps: { setMode: (sessionId: string, on: boolean) => Promise<string | null>; openAgents: () => void; isChild: (sessionId: string) => boolean; supports: (sessionId: string) => Promise<boolean> }) {
  return memo(function ScheduleSwitch(props: { sessionId?: string; locked?: boolean; useProjection?: (key: string) => unknown; useSessionStatus?: UseSessionStatus }) {
    const roster = rosterOf(props)
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
    if (sessionId === undefined || deps.isChild(sessionId)) return null
    if (supported === false) {
      return (
        <span className="sch-mode-group" data-scheduler-switch="" data-on="no" data-unsupported="">
          <span className="sch-mode" data-on="no">
            <button type="button" disabled aria-label="调度不可用" title="这个会话在装调度插件之前就已经在运行，不支持开关。新建一个会话，或重启 DeepSeek Harness 后再打开这个会话。">
              {ICON.fork}调度
            </button>
          </span>
        </span>
      )
    }
    const on = roster?.enabled === true
    const members = (roster?.members ?? []).filter(m => m.state !== 'archived')
    const label = agentsLabel(members, statuses)
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
              <button type="button" className="sch-mode-exit" disabled={disabled} aria-label="关闭调度" title="调度已开启：每条消息交给一个分身。点击关闭（/schedule off）；已有的分身和 worker 保留" onClick={() => { switchTo(false) }}>
                <span className="sch-mode-glyph">{ICON.fork}</span><span className="sch-mode-x">{ICON.close}</span>调度
              </button>
            )
            : (
              <button type="button" disabled={disabled} aria-label="开启调度" title="开启调度（/schedule）：之后的每条消息交给一个分身处理，lead 不被占住" onClick={() => { switchTo(true) }}>
                {ICON.fork}调度
              </button>
            )}
        </span>
        {members.length === 0 && !on ? null : (
          <button type="button" className="sch-agents-btn" aria-label="打开 Agents" title="打开 Agents：查看、打开或归档分身和 worker，设置分身模型" onClick={deps.openAgents}>
            {label.tone === 'idle' ? null : <span className="sch-dot" data-row={label.tone} />}
            Agents
            {label.text === '' ? (members.length === 0 ? null : <span className="sch-agents-n">{members.length}</span>) : <span className="sch-agents-n" data-row={label.tone}>{label.text}</span>}
          </button>
        )}
        {error === null ? null : <span className="sch-mode-error" role="status" title={error}>切换失败</span>}
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
  return state === 'running' ? `${n} 个请求处理中` : `${n} 个请求待回答`
}

/** One line of readable text: runs of whitespace become one space, ends trimmed. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * The second line of a row: why it failed, what it is working on right now, or what it was asked.
 *
 * A running agent's own requests say more than the message that created it, so the oldest still
 * unanswered one leads; a fork with nothing open shows the ask, a worker its directory and duty.
 * @param member - a roster row.
 * @param pending - the member's unanswered requests, oldest first.
 * @returns the line, or '' when there is nothing worth saying.
 */
export function subline(member: Member, pending: readonly { readonly id: string; readonly text: string }[] = []): string {
  const failure = member.state === 'failed' ? member.detail : undefined
  if (failure !== undefined) return flat(failure)
  const oldest = pending[0]
  if (member.kind === 'fork') return oldest === undefined ? flat(member.text) : `${oldest.id}：${flat(oldest.text)}`
  const dir = member.cwd === undefined ? undefined : member.cwd.replace(/\/+$/u, '').split('/').pop()
  const duty = oldest === undefined ? member.role ?? member.text : `${oldest.id}：${flat(oldest.text)}`
  return [dir, duty === undefined ? undefined : flat(duty)].filter(part => part !== undefined && part !== '').join(' · ')
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
  if (selection === null || selection === undefined) return '默认模型'
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
export interface Face { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }
const NO_FACE: Face = { getSnapshot: () => undefined, subscribe: () => () => undefined }

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
  catalog: () => Promise<readonly CatalogGroup[]>
}) {
  return memo(function MemberModelPicker(props: { sessionId?: string }) {
    const sessionId = props.sessionId
    const parentId = sessionId === undefined ? undefined : deps.parentOf(sessionId)
    const face = parentId === undefined ? NO_FACE : deps.rosterFace(parentId)
    const roster = useSyncExternalStore(face.subscribe, face.getSnapshot) as Roster | undefined
    const row = sessionId === undefined ? undefined : memberOf(roster, sessionId)
    const member = parentId === undefined || row === undefined ? undefined : { parent: parentId, name: row.name }
    const own = row?.pickedModel ?? null
    const [groups, setGroups] = useState<readonly CatalogGroup[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [supported, setSupported] = useState(false)
    const parent = member?.parent
    useEffect(() => {
      if (parent === undefined) return undefined
      let alive = true
      deps.has(parent, 'agent-model').then(ok => { if (alive) setSupported(ok) }, () => undefined)
      deps.catalog().then(g => { if (alive) setGroups(g) }, () => undefined)
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
          label={own === null ? '默认模型' : own.model}
          defaultLabel="默认模型（创建时的模型）"
          defaultValue="默认模型"
          avoid="[data-composer-card]"
          busy={busy}
          ariaLabel={`${member.name} 的模型：${label}`}
          title={`${member.name} 自己用的模型，下一次模型调用生效（/agent-model）。`}
          onPick={choose}
        />
        {error === null ? null : <span className="sch-mode-error" role="status" title={error}>切换失败</span>}
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
 * The menu's groups: the catalog, plus the current default when the catalog lacks it
 * (signed out, provider removed), so the control never silently shows another value.
 * @param groups - catalog groups, in catalog order.
 * @param current - the current default.
 * @returns groups to render.
 */
export function workerModelGroups(groups: readonly CatalogGroup[], current: ForkModel | null | undefined): readonly CatalogGroup[] {
  if (current === null || current === undefined) return groups
  if (groups.some(g => g.id === current.provider && g.models.some(m => m.id === current.model))) return groups
  return [...groups, { id: current.provider, name: `${current.provider}（不在当前模型列表）`, models: [{ id: current.model, name: current.model }]}]
}

/**
 * What the 「Worker 默认模型」 trigger says for its model part.
 * @param groups - catalog groups (with any missing current default added).
 * @param current - the default, or null.
 * @returns 「默认」 or the model's name.
 */
export function workerModelLabel(groups: readonly CatalogGroup[], current: ForkModel | null | undefined): string {
  if (current === null || current === undefined) return '默认'
  return catalogModel(groups, current)?.name ?? current.model
}

/**
 * The 「Worker 默认模型」 control of the Agents page: shows the Session's `/worker model` default and
 * changes it by running that command, so the log records it like a typed command.
 * @param deps - session, current value, command runner, and catalog loader.
 * @returns the control.
 */
function WorkerModelPicker(deps: { sessionId: string; current: ForkModel | null; run: (sessionId: string, line: string) => Promise<string | null>; catalog: () => Promise<readonly CatalogGroup[]> }) {
  const { sessionId, current, run, catalog } = deps
  const [groups, setGroups] = useState<readonly CatalogGroup[] | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    catalog().then(g => { if (alive) setGroups(g) }, (reason: unknown) => { if (alive) setLoadError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { alive = false }
  }, [sessionId])
  const change = (next: ForkModel | null) => {
    setBusy(true)
    setError(null)
    run(sessionId, workerModelCommand(next)).then(failure => { setBusy(false); setError(failure) }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
  }
  const shown = workerModelGroups(groups ?? [], current)
  const label = workerModelLabel(shown, current)
  const level = effortLabel(shown, current)
  const value = workerModelValue(current)
  return (
    <div className="sch-forkmodel" data-scheduler-worker-model={value === '' ? 'default' : value}>
      <div className="sch-forkmodel-row">
        <span className="sch-forkmodel-label">Worker 默认模型</span>
        <ModelMenu
          groups={groups === undefined ? undefined : shown}
          current={current}
          label={label}
          defaultLabel="默认（运行时默认模型）"
          defaultValue="默认"
          busy={busy}
          size="compact"
          ariaLabel={`Worker 默认模型：${label}${level === undefined ? '' : ` · ${level}`}`}
          title="之后新建的 worker 用哪个模型和推理等级（/worker model）。lead 创建 worker 时指定了模型就以它为准；都没指定时用运行时默认模型。已有的 worker 不受影响，可以在它自己的对话底栏单独换。分身不能单独换模型，始终和 lead 相同。"
          onPick={change}
          failure={loadError === null ? undefined : <div className="sch-mm-empty" role="status" title={loadError}>模型列表加载失败</div>}
        />
      </div>
      {error === null ? null : <div className="sch-forkmodel-error" role="status" title={error}>切换失败：{error}</div>}
    </div>
  )
}

/**
 * Create the Agents page body for the right sidebar.
 * @param ctx - client plugin context, for the controller's known child addresses.
 * @returns the slot component.
 */
export function createAgentsPage(ctx: {
  sessions?: { subagentAddress?: (id: string) => { parentSessionId?: string; mode?: string } | undefined }
  sidebarRight?: SidebarFace
}, run: (sessionId: string, line: string) => Promise<string | null> = async () => 'unavailable', has: (sessionId: string, name: string) => Promise<boolean> = async () => true, catalog?: () => Promise<readonly CatalogGroup[]>) {
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
    // A fork that handed back its conclusion and is not working again is finished work: folded
    // away under 「已交回」, where one click archives it or all of them.
    const finished = (m: Member) => m.kind === 'fork' && m.state === 'done' && statuses?.get(m.id)?.running !== true && statuses?.get(m.id)?.pendingInteraction === undefined
    const done = live.filter(finished)
    const forks = live.filter(m => m.kind === 'fork' && !finished(m))
    const workers = live.filter(m => m.kind === 'worker')
    const archived = rows.filter(m => m.state === 'archived')
    const counts = countsOf(rows, statuses)
    // The open chat's row is always visible: opening an archived or handed-back fork (say from
    // its message's 「查看」) unfolds its group once, so the selection is not hidden in a fold.
    const selectedIn = selected === undefined ? undefined : archived.some(m => m.id === selected) ? 'archived' : done.some(m => m.id === selected) ? 'done' : undefined
    useEffect(() => {
      if (selectedIn === 'archived') setShowArchived(true)
      else if (selectedIn === 'done') setShowDone(true)
    }, [selected, selectedIn])
    const openTo = (id: string) => (roster?.openRequests ?? []).filter(r => r.to === id)
    const row = (member: Member) => {
      const state = rowStateOf(member, statuses)
      const pendingRequests = openTo(member.id)
      const canArchive = canArchiveHere && member.state !== 'archived' && state !== 'running' && state !== 'waiting'
      // An archived member is history: one line, no subtitle. A dozen of them must not push the
      // live work off the page.
      const compact = member.state === 'archived'
      const second = compact ? '' : subline(member, pendingRequests)
      return (
        <div key={member.id} className="sch-roster-item" data-pending={pending.has(member.name) ? 'yes' : 'no'}>
        <button type="button" className="sch-roster-row" data-row={state} data-compact={compact ? 'yes' : 'no'} data-selected={member.id === selected ? 'yes' : 'no'} onClick={() => { open(member) }} title={member.id}>
          <span className="sch-dot" data-row={state} />
          <span className="sch-roster-main">
            <span className="sch-roster-name">{member.name}</span>
            {second === '' ? null : <span className="sch-roster-sub">{second}</span>}
          </span>
          <span className="sch-roster-end">
            {pendingRequests.length === 0 ? null : <span className="sch-roster-reqs" data-scheduler-open={pendingRequests.length} title={pendingRequests.map(r => `${r.id}：${r.text.replace(/\s+/gu, ' ').slice(0, 80)}`).join('\n')}>{openLabel(pendingRequests.length, state)}</span>}
            <span className="sch-roster-state" data-row={state}>{STATE_LABEL[state]}</span>
            <span className="sch-roster-chev">{ICON.chevron}</span>
          </span>
        </button>
        {canArchive ? <button type="button" className="sch-roster-archive" aria-label={`归档 ${member.name}`} title="归档：从名单移到「已归档」，对话保留，名字不再复用" disabled={pending.has(member.name)} onClick={() => { archive(member.name) }}>{ICON.archive}</button> : null}
        </div>
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
        {failure === null ? null : <div className="sch-roster-failure" role="status">{failure}</div>}
        {canArchiveHere ? null : <div className="sch-roster-notice" role="status" data-scheduler-restart="">插件已更新，但 DeepSeek Harness 还在用旧版本运行，暂时不能归档。按 ⌘Q 完全退出再打开即可。</div>}
        <div className="sch-roster-head">
          <div>
            <div className="sch-roster-title">Agents</div>
            <div className="sch-roster-summary">{live.length === 0 ? '还没有 agent' : [`${live.length} 个`, ...summaryParts(counts, live.length)].join(' · ')}</div>
          </div>
          <button type="button" className="sch-roster-collapse" aria-label="收起右栏" title="收起右栏（Agents 和已打开的对话都保留）" onClick={collapse}>{ICON.collapse}</button>
        </div>
        {sessionId === undefined || catalog === undefined || !canPickWorkerModel ? null : <WorkerModelPicker sessionId={sessionId} current={roster?.workerModel ?? null} run={run} catalog={catalog} />}
        {rows.length === 0
          ? <div className="sch-roster-empty">还没有分身或 worker。<br />{roster?.enabled === true ? '在主会话里说一件事，lead 会交给一个分身去做。' : '在输入框底栏打开「调度」后，每条消息会交给一个分身。'}</div>
          : (
            <>
              {section('分身', forks)}
              {section('Worker', workers)}
              {done.length === 0 ? null : (
                <>
                  <div className="sch-roster-foldrow">
                    <button type="button" className="sch-roster-fold" aria-expanded={showDone} onClick={() => { setShowDone(v => !v) }}>
                      {ICON.chevron}已交回 {done.length}
                    </button>
                    {canArchiveHere
                      ? <button type="button" className="sch-roster-clear" disabled={pending.has('done')} title="归档所有已交回、没有待回答请求的分身（/agents archive done）" onClick={() => { archive('done') }}>全部归档</button>
                      : null}
                  </div>
                  {showDone ? done.map(member => row(member)) : null}
                </>
              )}
              {archived.length === 0 ? null : (
                <>
                  <button type="button" className="sch-roster-fold" aria-expanded={showArchived} onClick={() => { setShowArchived(v => !v) }}>
                    {ICON.chevron}已归档 {archived.length}
                  </button>
                  {showArchived ? (showAllArchived ? archived : archived.slice(0, ARCHIVED_ROWS)).map(member => row(member)) : null}
                  {showArchived && archived.length > ARCHIVED_ROWS ? (
                    <button type="button" className="sch-roster-more" aria-expanded={showAllArchived} onClick={() => { setShowAllArchived(v => !v) }}>
                      {showAllArchived ? '收起' : `再显示 ${archived.length - ARCHIVED_ROWS} 个`}
                    </button>
                  ) : null}
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
  ctx.uiConversation.events.register(requestDefinition)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-agent-scheduler'
    style.textContent = STYLE + MODEL_MENU_STYLE
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
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: REQUEST_KIND }, RequestCardView))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: AGENTS_ID,
    kind: AGENTS_KIND,
    priority: 'extension',
    title: () => 'Agents',
    keepMounted: true,
  }), 'agent-scheduler: agents tab type')
  ctx.effect(() => retainChatTabs(ctx.sidebarRightTabs), 'agent-scheduler: keep agent chats mounted')
  /** Run one command line; returns null on success, otherwise what went wrong. */
  const run = async (sessionId: string, line: string): Promise<string | null> => {
    const result = await ctx.remote.commands.execute(sessionId, line, [])
    if (!result.ok) return `${result.error.message} (${result.error.code})`
    const value = result.value as { kind?: string; text?: string } | undefined
    if (value === undefined) return `unknown command: ${line.split(' ')[0]}`
    return value.kind === 'error' ? (value.text ?? 'failed') : null
  }
  /** Whether the Session's host half knows a command: it lags the browser half until a restart. */
  const has = async (sessionId: string, name: string): Promise<boolean> => {
    const result = await ctx.remote.commands.list(sessionId)
    if (!result.ok) throw new Error(result.error.message)
    return (result.value as readonly { name?: string }[]).some(command => command.name === name)
  }
  /** The Host's provider-grouped model catalog, the one the composer's model menu lists. */
  const catalog = async (): Promise<readonly CatalogGroup[]> => {
    const result = await ctx.remote.session.modelCatalog()
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return (result.value as { groups: readonly CatalogGroup[] }).groups
  }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: AGENTS_ID }, createAgentsPage(ctx, run, has, catalog)))
  const setMode = (sessionId: string, on: boolean) => run(sessionId, on ? '/schedule on' : '/schedule off')
  const isChild = (sessionId: string) => ctx.sessions?.subagentAddress?.(sessionId) !== undefined
  const supports = (sessionId: string) => has(sessionId, 'schedule')
  /** Parent of an addressed fork or worker chat. */
  const parentOf = (sessionId: string): string | undefined => (ctx.sessions?.subagentAddress?.(sessionId) as { parentSessionId?: string } | undefined)?.parentSessionId
  /** The parent's roster projection; the parent is the open main Session, so its binding is retained. */
  const rosterFace = (parent: string): Face => ctx.sessions?.binding?.(parent)?.session?.projections?.faceOf?.(ROSTER) ?? NO_FACE
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'agent-scheduler-model', order: 100, inject: (sessionId: string) => ({ sessionId }) }, createMemberModelPicker({ parentOf, rosterFace, run, has, catalog })))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'agent-scheduler', order: 10, inject: (sessionId: string) => ({ sessionId }) }, createScheduleSwitch({ setMode, openAgents, isChild, supports })))
  registerRecoveryConfig(ctx)
}
