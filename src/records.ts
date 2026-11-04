/**
 * Plugin records in the main Session log. They are the only durable state: the ledger is a fold
 * over them, so a restarted host recovers forks, workers, requests and roles by reading the log.
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

export const INPUT_RECORD = 'plugin:dsh-agent-scheduler/input'
export const FORK_STATE_RECORD = 'plugin:dsh-agent-scheduler/fork-state'
export const FORK_MODEL_RECORD = 'plugin:dsh-agent-scheduler/fork-model'
export const AGENT_RECORD = 'plugin:dsh-agent-scheduler/agent'
export const REQUEST_RECORD = 'plugin:dsh-agent-scheduler/request'
export const ROLE_RECORD = 'plugin:dsh-agent-scheduler/role'
export const SETTLED_RECORD = 'plugin:dsh-agent-scheduler/settled'

/** The user's words as handed to one fork. */
export interface InputRecord {
  readonly version: 1
  readonly messageId: string
  readonly forkId: string
  readonly text: string
  /** Display name, `fork-N`. */
  readonly name?: string
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

/** A worker's creation, start, or archival. Names are never reused, archived or not. */
export interface AgentRecord {
  readonly version: 1
  readonly action: 'created' | 'started' | 'queued' | 'archived' | 'failed'
  readonly id: string
  readonly name: string
  readonly role?: string
  readonly cwd?: string
  readonly model?: string
  /** Worker whose conversation this one was forked from. */
  readonly from?: string
  readonly detail?: string
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
}

/** The role text of the lead (no `agent`) or of one worker. */
export interface RoleRecord {
  readonly version: 1
  readonly agent?: string
  readonly text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-agent-scheduler/input': InputRecord
    'plugin:dsh-agent-scheduler/fork-state': ForkStateRecord
    'plugin:dsh-agent-scheduler/fork-model': ForkModelRecord
    'plugin:dsh-agent-scheduler/agent': AgentRecord
    'plugin:dsh-agent-scheduler/request': RequestRecord
    'plugin:dsh-agent-scheduler/role': RoleRecord
    'plugin:dsh-agent-scheduler/settled': SettledRecord
  }
}

type Fields<T> = Omit<T, 'version'>

export const appendInput = (session: Session, record: Fields<InputRecord>): SessionSeq =>
  appendPluginRecord(session, INPUT_RECORD, { version: 1, ...record })
export const appendForkState = (session: Session, record: Fields<ForkStateRecord>): SessionSeq =>
  appendPluginRecord(session, FORK_STATE_RECORD, { version: 1, ...record })
export const appendForkModel = (session: Session, selection: ForkModelSelection | null): SessionSeq =>
  appendPluginRecord(session, FORK_MODEL_RECORD, { version: 1, selection })
export const appendAgent = (session: Session, record: Fields<AgentRecord>): SessionSeq =>
  appendPluginRecord(session, AGENT_RECORD, { version: 1, ...record })
export const appendRequest = (session: Session, record: Fields<RequestRecord>): SessionSeq =>
  appendPluginRecord(session, REQUEST_RECORD, { version: 1, ...record })
export const appendRole = (session: Session, record: Fields<RoleRecord>): SessionSeq =>
  appendPluginRecord(session, ROLE_RECORD, { version: 1, ...record })
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
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = dataOf<ForkModelRecord>(events[i]!, FORK_MODEL_RECORD)
    if (data !== undefined) return data.selection ?? null
  }
  return null
}

/** Typed readers used by the roster fold. */
export const recordReaders = {
  forkState: (e: SessionEvent) => dataOf<ForkStateRecord>(e, FORK_STATE_RECORD),
  agent: (e: SessionEvent) => dataOf<AgentRecord>(e, AGENT_RECORD),
  request: (e: SessionEvent) => dataOf<RequestRecord>(e, REQUEST_RECORD),
  role: (e: SessionEvent) => dataOf<RoleRecord>(e, ROLE_RECORD),
  settled: (e: SessionEvent) => dataOf<SettledRecord>(e, SETTLED_RECORD),
}
