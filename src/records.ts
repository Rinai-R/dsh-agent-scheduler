/**
 * Plugin records in the main Session log. They are the only durable state: the ledger is a fold
 * over them, so a restarted host recovers forks, workers, requests and roles by reading the log.
 */
import { appendRecord as appendPluginRecord, recordOf as pluginRecordOf } from './dsh/host/session.js'
import type { Session, SessionEvent, SessionSeq } from './dsh/types.js'

export const INPUT_RECORD = 'plugin:dsh-agent-scheduler/input'
export const FORK_STATE_RECORD = 'plugin:dsh-agent-scheduler/fork-state'
export const FORK_MODEL_RECORD = 'plugin:dsh-agent-scheduler/fork-model'
export const WORKER_MODEL_RECORD = 'plugin:dsh-agent-scheduler/worker-model'
export const AGENT_RECORD = 'plugin:dsh-agent-scheduler/agent'
export const REQUEST_RECORD = 'plugin:dsh-agent-scheduler/request'
export const ROLE_RECORD = 'plugin:dsh-agent-scheduler/role'
export const SETTLED_RECORD = 'plugin:dsh-agent-scheduler/settled'
export const MODE_RECORD = 'plugin:dsh-agent-scheduler/mode'
export const SEEN_RECORD = 'plugin:dsh-agent-scheduler/seen'
export const MAIL_RECORD = 'plugin:dsh-agent-scheduler/mail'
export const TEAM_RECORD = 'plugin:dsh-agent-scheduler/team'

/**
 * The Agent Team one agent leads (the lead, or a worker), as last seen: what the Agents page
 * shows. The Team itself lives in that agent's own log (dsh-experimental-agent-team); this is a
 * copy in the main Session, written when it changes.
 */
export interface TeamRecord {
  readonly version: 1
  /** Session id of the Team Lead: the main Session or one of its workers. */
  readonly owner: string
  readonly members: readonly { readonly id: string; readonly name: string; readonly description: string; readonly status: string }[]
  readonly tasks: readonly { readonly id: string; readonly subject: string; readonly status: string; readonly owner?: string; readonly blockedBy: readonly string[] }[]
}

/** The user opened a member's chat: its latest report is read (`/agents seen`). */
export interface SeenRecord {
  readonly version: 1
  /** The member's Session id. */
  readonly agent: string
}

/** What a message for the lead is: a reply, a report, a fork's conclusion, or a failure. */
export type MailKind = 'reply' | 'report' | 'conclusion' | 'failure'

/**
 * The lead's inbox: messages for the lead wait here, not in the runtime's queue, until the lead
 * is idle (or the user hands them over now). The user orders, pins and holds them.
 * - `queued`: a new message (`id`, `from`, `kind`, `text`, and `request` when it answers one);
 * - `pinned` / `unpinned` / `held` / `released`: one message (`id`);
 * - `moved`: `id` now stands before `before` (`null`: last);
 * - `delivered`: `ids` were handed to the lead in one message (`via` followup or steer).
 */
export interface MailRecord {
  readonly version: 1
  readonly action: 'queued' | 'pinned' | 'unpinned' | 'held' | 'released' | 'moved' | 'delivered'
  readonly id?: string
  readonly ids?: readonly string[]
  /** `queued`: the member's Session id. */
  readonly from?: string
  readonly kind?: MailKind
  readonly request?: string
  readonly text?: string
  /** `moved`: the message it now stands before; null puts it last. */
  readonly before?: string | null
  readonly via?: 'followup' | 'steer'
}

/** Whether this Session hands each user message to a fork, switched by `/schedule on|off`. */
export interface ModeRecord {
  readonly version: 1
  readonly on: boolean
}

/** The user's words as handed to one fork. */
export interface InputRecord {
  readonly version: 1
  readonly messageId: string
  readonly forkId: string
  readonly text: string
  /** Display name, `fork-N`. */
  readonly name?: string
  /** The message is also logged as the user's own `user/message` (hidden from the lead), so
   * the chat already shows it; the card adds only the fork's state. Absent in older logs. */
  readonly logged?: true
}

/** A fork's lifecycle change as the main Session saw it. */
export interface ForkStateRecord {
  readonly version: 1
  readonly forkId: string
  readonly state: 'done' | 'failed' | 'queued' | 'started' | 'archived'
  readonly detail?: string
}

/**
 * How far a child's log has been attributed: every completed round up to and including the
 * `turn/end` at `through` has answered the requests it claimed. Rounds after it are still due.
 */
export interface SettledRecord {
  readonly version: 1
  readonly agent: string
  readonly through: number
}

/** Model override for this Session's later forks; `null` clears it. */
export interface ForkModelRecord {
  readonly version: 1
  readonly selection: ForkModelSelection | null
}

/** Provider route and model. */
export interface ForkModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** A worker's creation, start, archival, or new name. Names are never reused, archived, renamed away, or not. */
export interface AgentRecord {
  readonly version: 1
  readonly action: 'created' | 'started' | 'queued' | 'archived' | 'failed' | 'renamed'
  readonly id: string
  /** The worker's name from this record on; for `renamed`, its new name. */
  readonly name: string
  /** `renamed` only: the name it had before. That name stays reserved. */
  readonly previousName?: string
  /** On `renamed` too: a split narrows the role along with the name. */
  readonly role?: string
  /** The area (repository or module) the worker shares with the workers split from it (`agent_split`). */
  readonly area?: string
  readonly cwd?: string
  readonly model?: string
  /** Worker whose conversation this one was forked from. */
  readonly from?: string
  readonly detail?: string
  /** On `created`: Session id of the agent that created it (the main Session's for the lead). */
  readonly by?: string
  /** On `created`: what it was created for, `fork-N` (that fork's input) or `r-N` (a reply); one creation each. */
  readonly for?: string
  /** On `created`: ISO time of the creation. */
  readonly at?: string
}

/** One piece of delegated work, or what became of it. */
export interface RequestRecord {
  readonly version: 1
  readonly action: 'sent' | 'answered' | 'failed'
  readonly id: string
  /** Session that asked; the main Session's id when the lead asked. */
  readonly from?: string
  /** Session that answers. */
  readonly to?: string
  /** Inbox id of the delivered message: how a round is matched to the requests it answers. */
  readonly messageId?: string
  readonly text?: string
  readonly answer?: string
  /** Where the answer went: always the lead. */
  readonly deliveredTo?: string
  readonly detail?: string
  /** On `sent`: its worker ended a round while its teammates still worked; a later round of that worker answers it. */
  readonly deferred?: true
}

/** The role text of the lead (no `agent`) or of one worker. */
export interface RoleRecord {
  readonly version: 1
  readonly agent?: string
  readonly text: string
}

// Their entries in DSH's PluginRecordMap are declared in src/dsh/host/augment.ts.

type Fields<T> = Omit<T, 'version'>

export const appendInput = (session: Session, record: Fields<InputRecord>): SessionSeq =>
  appendPluginRecord(session, INPUT_RECORD, { version: 1, ...record })
export const appendForkState = (session: Session, record: Fields<ForkStateRecord>): SessionSeq =>
  appendPluginRecord(session, FORK_STATE_RECORD, { version: 1, ...record })
export const appendForkModel = (session: Session, selection: ForkModelSelection | null): SessionSeq =>
  appendPluginRecord(session, FORK_MODEL_RECORD, { version: 1, selection })
/** `/worker model`: the model later workers start with when the lead names none; `null` clears it. */
export const appendWorkerModel = (session: Session, selection: ForkModelSelection | null): SessionSeq =>
  appendPluginRecord(session, WORKER_MODEL_RECORD, { version: 1, selection })
export const appendAgent = (session: Session, record: Fields<AgentRecord>): SessionSeq =>
  appendPluginRecord(session, AGENT_RECORD, { version: 1, ...record })
export const appendRequest = (session: Session, record: Fields<RequestRecord>): SessionSeq =>
  appendPluginRecord(session, REQUEST_RECORD, { version: 1, ...record })
export const appendRole = (session: Session, record: Fields<RoleRecord>): SessionSeq =>
  appendPluginRecord(session, ROLE_RECORD, { version: 1, ...record })
export const appendMode = (session: Session, on: boolean): SessionSeq =>
  appendPluginRecord(session, MODE_RECORD, { version: 1, on })
export const appendSeen = (session: Session, record: Fields<SeenRecord>): SessionSeq =>
  appendPluginRecord(session, SEEN_RECORD, { version: 1, ...record })
export const appendMail = (session: Session, record: Fields<MailRecord>): SessionSeq =>
  appendPluginRecord(session, MAIL_RECORD, { version: 1, ...record })
export const appendTeam = (session: Session, record: Fields<TeamRecord>): SessionSeq =>
  appendPluginRecord(session, TEAM_RECORD, { version: 1, ...record })
export const appendSettled = (session: Session, record: Fields<SettledRecord>): SessionSeq =>
  appendPluginRecord(session, SETTLED_RECORD, { version: 1, ...record })

function dataOf<T>(event: SessionEvent, type: string): T | undefined {
  const record = pluginRecordOf(event)
  if (record?.type !== type) return undefined
  const data = record.data as { version?: unknown } | null
  return data?.version === 1 ? data as T : undefined
}

/**
 * Read one input record from any event.
 * @param event - a Session event.
 * @returns the validated record, or undefined.
 */
export function inputOf(event: SessionEvent): InputRecord | undefined {
  const data = dataOf<Partial<InputRecord>>(event, INPUT_RECORD)
  if (typeof data?.forkId !== 'string' || typeof data.text !== 'string' || typeof data.messageId !== 'string') return undefined
  return data as InputRecord
}

/**
 * Fold this Session's current fork model override.
 * @param events - the Session's log.
 * @returns the latest selection, or null when none applies.
 */
export function forkModelOf(events: readonly SessionEvent[]): ForkModelSelection | null {
  // Retired: read only by tests that check old records are ignored. Nothing routes by it.
  return modelRecordOf(events, FORK_MODEL_RECORD)
}

/**
 * Fold this Session's current worker default model.
 * @param events - the Session's log.
 * @returns the latest selection, or null when none applies.
 */
export function workerModelOf(events: readonly SessionEvent[]): ForkModelSelection | null {
  return modelRecordOf(events, WORKER_MODEL_RECORD)
}

function modelRecordOf(events: readonly SessionEvent[], type: string): ForkModelSelection | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = dataOf<ForkModelRecord>(events[i]!, type)
    if (data !== undefined) return data.selection ?? null
  }
  return null
}

/** A well-formed model record of `type`, or undefined. */
function modelRecord(e: SessionEvent, type: string): ForkModelRecord | undefined {
  const d = dataOf<ForkModelRecord>(e, type)
  if (d === undefined) return undefined
  const sel = d.selection as Partial<ForkModelSelection> | null
  if (sel === null) return d
  if (typeof sel?.provider !== 'string' || typeof sel.model !== 'string' || (sel.reasoningEffort !== undefined && typeof sel.reasoningEffort !== 'string')) return undefined
  return d
}

/** Typed readers used by the roster fold. */
export const recordReaders = {
  forkState: (e: SessionEvent) => dataOf<ForkStateRecord>(e, FORK_STATE_RECORD),
  agent: (e: SessionEvent) => dataOf<AgentRecord>(e, AGENT_RECORD),
  request: (e: SessionEvent) => dataOf<RequestRecord>(e, REQUEST_RECORD),
  role: (e: SessionEvent) => dataOf<RoleRecord>(e, ROLE_RECORD),
  settled: (e: SessionEvent) => dataOf<SettledRecord>(e, SETTLED_RECORD),
  seen: (e: SessionEvent) => { const d = dataOf<SeenRecord>(e, SEEN_RECORD); return typeof d?.agent === 'string' ? d : undefined },
  forkModel: (e: SessionEvent) => modelRecord(e, FORK_MODEL_RECORD),
  workerModel: (e: SessionEvent) => modelRecord(e, WORKER_MODEL_RECORD),
  mode: (e: SessionEvent) => { const d = dataOf<ModeRecord>(e, MODE_RECORD); return typeof d?.on === 'boolean' ? d : undefined },
  team: (e: SessionEvent) => { const d = dataOf<TeamRecord>(e, TEAM_RECORD); return typeof d?.owner === 'string' && Array.isArray(d.members) && Array.isArray(d.tasks) ? d : undefined },
  mail: (e: SessionEvent) => mailOf(e),
}

const MAIL_ACTIONS = new Set(['queued', 'pinned', 'unpinned', 'held', 'released', 'moved', 'delivered'])
const MAIL_KINDS = new Set(['reply', 'report', 'conclusion', 'failure'])

/** A well-formed mail record, or undefined. */
function mailOf(e: SessionEvent): MailRecord | undefined {
  const d = dataOf<Partial<MailRecord>>(e, MAIL_RECORD)
  if (d === undefined || !MAIL_ACTIONS.has(d.action as string)) return undefined
  if (d.action === 'delivered') return Array.isArray(d.ids) && d.ids.every(i => typeof i === 'string') ? d as MailRecord : undefined
  if (typeof d.id !== 'string') return undefined
  if (d.action === 'queued' && (typeof d.from !== 'string' || typeof d.text !== 'string' || !MAIL_KINDS.has(d.kind as string))) return undefined
  if (d.action === 'moved' && d.before !== null && typeof d.before !== 'string') return undefined
  return d as MailRecord
}
