/**
 * The roster: one pure fold over this plugin's records in the main Session log. The host's
 * ledger and the client's `agentScheduler` session projection are the same fold, so what the
 * sidebar draws and what the scheduler routes by cannot drift apart.
 * @module dsh-agent-scheduler/projection
 */
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ZodType } from 'zod'
import { inputOf, recordReaders as R, type ForkModelSelection } from './records.js'
import { memberModelRecordOf } from './member-model.js'
import { unread } from './review.js'

/** Projection key registered with the session-projection registry. */
export const SCHEDULER_PROJECTION = 'agentScheduler'

/** Lifecycle of a fork or worker as recorded; whether it is running comes from the runtime. */
export type MemberState = 'queued' | 'started' | 'done' | 'failed' | 'archived'

/** One fork or worker. */
export interface RosterMember {
  readonly id: string
  readonly name: string
  readonly kind: 'fork' | 'worker'
  readonly state: MemberState
  /** Fork: the user's words. Worker: its role. */
  readonly text: string
  readonly role?: string | undefined
  readonly cwd?: string | undefined
  readonly model?: string | undefined
  /** Worker whose conversation this one continues. */
  readonly from?: string | undefined
  readonly detail?: string | undefined
  /** Names a renamed worker had before; reserved, and still found by name. */
  readonly formerNames?: readonly string[] | undefined
  /** Repository or module this worker shares with the workers split from it; absent: none yet. */
  readonly area?: string | undefined
  /** Worker: Session id of the agent that created it. */
  readonly createdBy?: string | undefined
  /** Worker: the input (`fork-N`) or reply (`r-N`) it was created for. */
  readonly createdFor?: string | undefined
  /** Worker: ISO time it was created. */
  readonly createdAt?: string | undefined
  /** Model chosen for this member from its chat (`/agent-model`); absent uses its start model. */
  readonly pickedModel?: ForkModelSelection | undefined
  /** Seq of the last `turn/end` of this member's log already attributed. */
  readonly settledThrough?: number | undefined
  /** Time (ms) of this member's latest report: an answered or failed request, a fork's
   * conclusion, a failed start. The Agents page marks it for review until the user opens it. */
  readonly reportedAt?: number | undefined
  /** The latest report is a failure. */
  readonly reportFailed?: true | undefined
  /** Time (ms) the user opened this member since its latest report (see src/review.ts). */
  readonly seenAt?: number | undefined
}

/** One piece of delegated work with its latest state. */
export interface RosterRequest {
  readonly id: string
  /** Requesting Session id; the main Session's id when the lead asked. */
  readonly from: string
  readonly to: string
  readonly text: string
  readonly state: 'sent' | 'answered' | 'failed'
  /** Inbox id of the delivered message. */
  readonly messageId?: string | undefined
  readonly answer?: string | undefined
  readonly deliveredTo?: string | undefined
}

/** Whole fold state of one main Session; plain JSON. */
export interface Roster {
  /** Scheduling switch as last recorded; null before any `/schedule`. */
  readonly enabled: boolean | null
  readonly role: string | null
  /** Retired: forks always use the lead's model. Kept (always null) so saved states still parse. */
  readonly forkModel: ForkModelSelection | null
  /** `/worker model` default for later workers; absent in states saved before it existed. */
  readonly workerModel?: ForkModelSelection | null
  readonly members: readonly RosterMember[]
  readonly requests: readonly RosterRequest[]
}

/** What the client receives: members and the requests still open. */
export interface RosterView {
  /** Whether user messages go to forks now (see {@link schedulingOn}). */
  readonly enabled: boolean
  readonly role: string | null
  /** Retired, always null: forks use the lead's model. Kept for clients built against it. */
  readonly forkModel: ForkModelSelection | null
  /** `/worker model` default; null uses the plugin config, else the runtime default (the lead's). */
  readonly workerModel: ForkModelSelection | null
  readonly members: readonly Omit<RosterMember, 'settledThrough'>[]
  readonly openRequests: readonly Pick<RosterRequest, 'id' | 'from' | 'to' | 'text'>[]
}

export const EMPTY_ROSTER: Roster = { enabled: null, role: null, forkModel: null, members: [], requests: [] }

/**
 * Whether a Session schedules: its last switch, or, for a log from before the switch existed,
 * whether it ever handed a message to a fork (those Sessions were created in scheduling mode).
 * @param state - the fold.
 * @returns the effective switch.
 */
export const schedulingOn = (state: Roster): boolean => state.enabled ?? state.members.some(m => m.kind === 'fork')

/** @returns the state every empty or unrelated log starts from. */
export const initRoster = (_header: SessionHeader, _inherited: SessionLogOffset): Roster => EMPTY_ROSTER

const WORKER_STATE: Record<'created' | 'started' | 'queued' | 'archived' | 'failed', MemberState> = {
  created: 'started', started: 'started', queued: 'queued', archived: 'archived', failed: 'failed',
}

/** Drop absent optional fields, so state stays plain JSON with no `undefined` values. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** A member with a fresh report stamped on it: unread again until the user opens it. */
function reported(m: RosterMember, at: number, failed: boolean): RosterMember {
  const { reportFailed: _, seenAt: __, ...rest } = m
  return failed ? { ...rest, reportedAt: at, reportFailed: true } : { ...rest, reportedAt: at }
}

function upsert<T extends { readonly id: string }>(rows: readonly T[], id: string, next: (row: T | undefined) => T): readonly T[] {
  const index = rows.findIndex(row => row.id === id)
  if (index < 0) return [...rows, next(undefined)]
  const copy = rows.slice()
  copy[index] = next(rows[index])
  return copy
}

/**
 * Apply one event. Unrelated events return the same reference, as the projection registry
 * requires.
 * @param state - state covering all prior events.
 * @param event - the next committed main-Session event.
 * @returns the next state.
 */
export function applyRoster(state: Roster, event: SessionEvent): Roster {
  const input = inputOf(event)
  if (input !== undefined) {
    const forks = state.members.filter(m => m.kind === 'fork').length
    return {
      ...state,
      members: upsert(state.members, input.forkId, () => ({
        id: input.forkId, name: input.name ?? `fork-${forks + 1}`, kind: 'fork', state: 'started', text: input.text,
      })),
    }
  }
  const fork = R.forkState(event)
  if (fork !== undefined) {
    if (!state.members.some(m => m.id === fork.forkId)) return state
    const concluded = fork.state === 'done' || fork.state === 'failed'
    return { ...state, members: upsert(state.members, fork.forkId, m => {
      const next = compact({ ...m!, state: fork.state, detail: fork.detail })
      return concluded ? reported(next, event.time, fork.state === 'failed') : next
    }) }
  }
  const agent = R.agent(event)
  if (agent !== undefined) {
    // A worker created under the name of one that failed to start replaces it: that one never
    // ran, and its requests already failed.
    const members = agent.action === 'created'
      ? state.members.filter(m => !(m.kind === 'worker' && m.state === 'failed' && m.name === agent.name && m.id !== agent.id))
      : state.members
    if (agent.action === 'renamed') {
      const known = state.members.find(m => m.id === agent.id && m.kind === 'worker')
      if (known === undefined || (known.name === agent.name && agent.role === undefined && agent.area === undefined)) return state
      const former = known.name === agent.name ? known.formerNames ?? [] : [...(known.formerNames ?? []), ...(agent.previousName === undefined ? [known.name] : [agent.previousName])]
      // A split (agent_split) also narrows the role and sets the area; a plain rename keeps both.
      return { ...state, members: upsert(state.members, agent.id, m => compact({
        ...m!, name: agent.name,
        formerNames: former.length === 0 ? undefined : [...new Set(former)].filter(n => n !== agent.name),
        role: agent.role ?? m!.role, text: agent.role ?? m!.text, area: agent.area ?? m!.area,
      })) }
    }
    return {
      ...state,
      members: upsert(members, agent.id, existing => compact({
        id: agent.id,
        // A record written under a name it has since been renamed from does not undo the rename.
        name: existing?.formerNames?.includes(agent.name) === true ? existing.name : agent.name,
        kind: 'worker' as const,
        state: WORKER_STATE[agent.action as Exclude<typeof agent.action, 'renamed'>],
        text: agent.role ?? existing?.text ?? '',
        role: agent.role ?? existing?.role,
        cwd: agent.cwd ?? existing?.cwd,
        model: agent.model ?? existing?.model,
        from: agent.from ?? existing?.from,
        detail: agent.detail,
        formerNames: existing?.formerNames,
        area: agent.area ?? existing?.area,
        createdBy: agent.action === 'created' ? agent.by : existing?.createdBy,
        createdFor: agent.action === 'created' ? agent.for : existing?.createdFor,
        createdAt: agent.action === 'created' ? agent.at : existing?.createdAt,
        settledThrough: existing?.settledThrough,
        ...(agent.action === 'failed'
          ? { reportedAt: event.time, reportFailed: true as const }
          : { reportedAt: existing?.reportedAt, reportFailed: existing?.reportFailed, seenAt: existing?.seenAt }),
      })),
    }
  }
  const request = R.request(event)
  if (request !== undefined) {
    const known = state.requests.find(r => r.id === request.id)
    if (known === undefined && request.action !== 'sent') return state
    // An answer or a failure is something the user should look at, on the member that owes it.
    // Archiving fails what the member still owed; the user did that themselves, nothing to review.
    const owner = request.action === 'sent' ? undefined : (request.to ?? known?.to)
    const archived = request.action === 'failed' && state.members.some(m => m.id === owner && m.state === 'archived')
    const members = owner !== undefined && !archived && state.members.some(m => m.id === owner)
      ? upsert(state.members, owner, m => reported(m!, event.time, request.action === 'failed'))
      : state.members
    return {
      ...state,
      members,
      requests: upsert(state.requests, request.id, r => compact({
        id: request.id,
        from: request.from ?? r?.from ?? '',
        to: request.to ?? r?.to ?? '',
        text: request.text ?? r?.text ?? '',
        // A second `sent` for a known request only adds the delivered message id.
        state: request.action === 'sent' ? (r?.state ?? 'sent') : request.action,
        messageId: request.messageId ?? r?.messageId,
        answer: request.answer ?? request.detail ?? r?.answer,
        deliveredTo: request.deliveredTo ?? r?.deliveredTo,
      })),
    }
  }
  const role = R.role(event)
  if (role !== undefined) {
    if (role.agent === undefined) return { ...state, role: role.text }
    if (!state.members.some(m => m.id === role.agent)) return state
    return { ...state, members: upsert(state.members, role.agent, m => ({ ...m!, role: role.text, text: role.text })) }
  }
  const mode = R.mode(event)
  if (mode !== undefined) return mode.on === state.enabled ? state : { ...state, enabled: mode.on }
  // `/fork model` records from before forks lost their own model are history only: not folded.
  const workerModel = R.workerModel(event)
  if (workerModel !== undefined) {
    const next = workerModel.selection === null ? null : compact({ ...workerModel.selection })
    return JSON.stringify(next) === JSON.stringify(state.workerModel ?? null) ? state : { ...state, workerModel: next }
  }
  const picked = memberModelRecordOf(event)
  if (picked !== undefined) {
    // Only a worker has a model of its own; an older pick for a fork is history only.
    if (!state.members.some(m => m.id === picked.agent && m.kind === 'worker')) return state
    return { ...state, members: upsert(state.members, picked.agent, m => { const { pickedModel: _, ...rest } = m!; return picked.selection === null ? rest : { ...rest, pickedModel: compact({ ...picked.selection }) } }) }
  }
  const seen = R.seen(event)
  if (seen !== undefined) {
    // Only an unread report is marked: opening a member with nothing new changes nothing.
    const member = state.members.find(m => m.id === seen.agent)
    if (member === undefined || !unread(member)) return state
    return { ...state, members: upsert(state.members, seen.agent, m => ({ ...m!, seenAt: event.time })) }
  }
  const settled = R.settled(event)
  if (settled !== undefined) {
    if (!state.members.some(m => m.id === settled.agent)) return state
    return { ...state, members: upsert(state.members, settled.agent, m => ({ ...m!, settledThrough: settled.through })) }
  }
  return state
}

const views = new WeakMap<Roster, RosterView>()

/**
 * The client view, memoized per state so an unchanged state publishes nothing.
 * @param state - the fold state.
 * @returns members without host bookkeeping, and the open requests without answers.
 */
export function rosterView(state: Roster): RosterView {
  let view = views.get(state)
  if (view === undefined) {
    view = {
      enabled: schedulingOn(state),
      role: state.role,
      forkModel: null,
      workerModel: state.workerModel ?? null,
      members: state.members.map(({ settledThrough: _, ...member }) => member),
      openRequests: state.requests.filter(r => r.state === 'sent').map(({ id, from, to, text }) => ({ id, from, to, text })),
    }
    views.set(state, view)
  }
  return view
}

// ------------------------------------------------------------------ validation

const isString = (v: unknown): v is string => typeof v === 'string'
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function fail(what: string): never { throw new TypeError(`agentScheduler projection: invalid ${what}`) }

function checkForkModel(v: unknown): void {
  if (v === null) return
  if (!isRecord(v) || !isString(v.provider) || !isString(v.model) || !optionalString(v.reasoningEffort)) fail('forkModel')
}

function checkMember(m: unknown, view: boolean): void {
  if (!isRecord(m) || !isString(m.id) || !isString(m.name) || !isString(m.text)) fail('member')
  if (m.kind !== 'fork' && m.kind !== 'worker') fail('member kind')
  if (!['queued', 'started', 'done', 'failed', 'archived'].includes(m.state as string)) fail('member state')
  for (const key of ['role', 'cwd', 'model', 'from', 'area', 'detail', 'createdBy', 'createdFor', 'createdAt']) if (!optionalString(m[key])) fail(`member ${key}`)
  if (m.pickedModel !== undefined) checkForkModel(m.pickedModel)
  if (m.formerNames !== undefined && !(Array.isArray(m.formerNames) && m.formerNames.every(isString))) fail('member formerNames')
  if (!view && m.settledThrough !== undefined && typeof m.settledThrough !== 'number') fail('member settledThrough')
  if (m.reportedAt !== undefined && typeof m.reportedAt !== 'number') fail('member reportedAt')
  if (m.reportFailed !== undefined && m.reportFailed !== true) fail('member reportFailed')
  if (m.seenAt !== undefined && typeof m.seenAt !== 'number') fail('member seenAt')
}

/**
 * The registry calls only `parse` on persisted state and on the wire copy. These shims check the
 * shape for real without adding zod to the published dependencies; the cast is the only bridge.
 */
export const rosterSchema = {
  parse(value: unknown): Roster {
    if (!isRecord(value) || !(value.role === null || isString(value.role)) || !Array.isArray(value.members) || !Array.isArray(value.requests)) fail('state')
    if (value.enabled !== null && typeof value.enabled !== 'boolean') fail('state enabled')
    checkForkModel(value.forkModel)
    if (value.workerModel !== undefined) checkForkModel(value.workerModel)
    for (const m of value.members) checkMember(m, false)
    for (const r of value.requests) {
      if (!isRecord(r) || !isString(r.id) || !isString(r.from) || !isString(r.to) || !isString(r.text)) fail('request')
      if (r.state !== 'sent' && r.state !== 'answered' && r.state !== 'failed') fail('request state')
      for (const key of ['messageId', 'answer', 'deliveredTo']) if (!optionalString(r[key])) fail(`request ${key}`)
    }
    return value as unknown as Roster
  },
} as unknown as ZodType<Roster>

export const rosterViewSchema = {
  parse(value: unknown): RosterView {
    if (!isRecord(value) || !(value.role === null || isString(value.role)) || !Array.isArray(value.members) || !Array.isArray(value.openRequests)) fail('view')
    if (typeof value.enabled !== 'boolean') fail('view enabled')
    checkForkModel(value.forkModel)
    if (value.workerModel !== undefined) checkForkModel(value.workerModel)
    for (const m of value.members) checkMember(m, true)
    return value as unknown as RosterView
  },
} as unknown as ZodType<RosterView>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    agentScheduler: RosterView
  }
  interface SessionProjectionStateMap {
    agentScheduler: Roster
  }
}
