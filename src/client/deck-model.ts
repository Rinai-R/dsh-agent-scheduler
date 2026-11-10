/**
 * The focus deck's derivation: which Sessions are cards, what each card says, and which unpinned
 * Sessions need attention. Pure, so the panel's rules are testable without a browser.
 * @module dsh-agent-scheduler/client/deck-model
 */
import { rowStateOf } from './row-state.js'

/** One Session as the shell's session list carries it (`ctx.sessions.list`). */
export interface DeckSession {
  readonly id: string
  readonly displayTitle?: string | undefined
  readonly title?: string | undefined
  readonly running?: boolean | undefined
  readonly blank?: boolean | undefined
  readonly updatedAt?: number | undefined
  readonly parentId?: string | undefined
  readonly origin?: string | undefined
  /** Who holds the row: the stock tree's open Session is the one with `mainView > 0`. */
  readonly retainedBy?: Readonly<Record<string, number | undefined>> | undefined
  /** Every client-visible projection, at the summary level: our roster is `agentScheduler`. */
  readonly projectionValues?: Readonly<Record<string, unknown>> | undefined
}

/** What the shell's `uiSession.sessionStatus` says about one Session. */
export interface DeckStatus {
  readonly running?: boolean | undefined
  readonly pendingInteraction?: unknown
  readonly completionUnread?: boolean | undefined
}

/** How a lead looks right now. */
export type LeadState = 'running' | 'waiting' | 'idle'

/** One worker line under an expanded deck row. */
export interface DeckWorker {
  readonly id: string
  readonly name: string
  /** {@link rowStateOf}: running / waiting / idle while live; terminal states as recorded. */
  readonly state: ReturnType<typeof rowStateOf>
  readonly text: string
}

/** One card of the deck. */
export interface DeckCard {
  readonly id: string
  readonly title: string
  readonly lead: LeadState
  /**
   * The row's one state dot: waiting when the lead or any live worker waits for the user, else
   * running when the lead or any worker runs, else idle.
   */
  readonly state: LeadState
  /** The Session's workers that are not archived, for the expanded tree. */
  readonly workers: readonly DeckWorker[]
  /** Live workers on the roster. */
  readonly runningWorkers: number
  /** Messages waiting in the lead's inbox. */
  readonly inbox: number
  /** A pending approval or question on the lead. */
  readonly approvals: number
  /** Epoch ms of the Session's last durable activity, 0 when unknown. */
  readonly lastActivity: number
  /** A draft the user has not sent anything to yet (the stock tree labels it 「新会话」). */
  readonly blank: boolean
  /** Whether the shell pins this Session (the pin glyph only). */
  readonly pinned: boolean
  /** Anything on this Session that waits for the user. */
  readonly attention: boolean
}

/** The slice of the roster view the deck reads from a Session summary. */
interface DeckRoster {
  readonly members?: readonly { readonly id: string; readonly kind: string; readonly state: string; readonly name?: string; readonly text?: string }[]
  readonly inbox?: readonly unknown[]
  readonly openRequests?: readonly unknown[]
}

/** The roster view as the deck reads it from a Session summary. */
const rosterOf = (session: DeckSession): DeckRoster | undefined => {
  const value = session.projectionValues?.agentScheduler
  return value === null || typeof value !== 'object' ? undefined : value as DeckRoster
}

/**
 * A Session's card. Main Sessions only: a subagent child is a worker row on its lead's card.
 * @param session - one listed Session.
 * @param status - its live status, when the shell tracks one.
 * @param pinned - whether the user pinned it.
 * @returns the card.
 */
export function cardOf(session: DeckSession, statuses: ReadonlyMap<string, DeckStatus> | undefined, pinned: boolean): DeckCard {
  const status = statuses?.get(session.id)
  const roster = rosterOf(session)
  const members = roster?.members ?? []
  // The Agents page's own rule (src/client/row-state.ts), so the two can never disagree: a roster
  // row is only `started` while it lives, and running/waiting comes from the live Session status.
  const states = members.map(member => rowStateOf(member, statuses))
  const runningWorkers = members.filter((m, i) => m.kind === 'worker' && states[i] === 'running').length
  const waitingWorkers = members.filter((m, i) => m.kind === 'worker' && states[i] === 'waiting').length
  const waiting = status?.pendingInteraction !== undefined
  const lead: LeadState = waiting ? 'waiting' : status?.running === true || session.running === true ? 'running' : 'idle'
  const inbox = roster?.inbox?.length ?? 0
  const approvals = (waiting ? 1 : 0) + waitingWorkers
  const workers = members.flatMap((m, i): DeckWorker[] => m.kind !== 'worker' || m.state === 'archived' ? [] : [{ id: m.id, name: m.name ?? m.id, state: states[i]!, text: m.text ?? '' }])
  return {
    id: session.id,
    title: session.displayTitle ?? session.title ?? session.id,
    blank: session.blank === true,
    lead,
    state: approvals > 0 ? 'waiting' : lead === 'running' || runningWorkers > 0 ? 'running' : 'idle',
    workers,
    runningWorkers,
    inbox,
    // The user's approvals can wait on the lead and on any live worker.
    approvals,
    lastActivity: session.updatedAt ?? 0,
    pinned,
    // 「需要你」: running workers, inbox mail, or an approval/question waiting for the user.
    attention: runningWorkers > 0 || inbox > 0 || approvals > 0,
  }
}

/** What the deck needs from the shell's workspace store. */
export interface DeckShell {
  /** Shell pins: only decide the pin glyph, never membership. */
  readonly pinned?: readonly string[] | undefined
  /** Archived Sessions, hidden like the stock tree hides them. */
  readonly archived?: readonly string[] | undefined
}

/** A main Session the stock tree would show: top-level and not archived. */
const listable = (session: DeckSession, archived: ReadonlySet<string>): boolean => session.parentId === undefined && !archived.has(session.id)

/**
 * The deck's rows: the Sessions the user imported, most recently updated first.
 * @param sessions - every listed Session.
 * @param statuses - live status by Session id.
 * @param members - the deck's membership (imported ids).
 * @param shell - shell pins (glyph only) and the archived set.
 * @returns one card per imported, listable Session.
 */
export function deckRows(
  sessions: readonly DeckSession[],
  statuses: ReadonlyMap<string, DeckStatus> | undefined,
  members: readonly string[],
  shell: DeckShell = {},
): DeckCard[] {
  const archived = new Set(shell.archived ?? [])
  const pinned = new Set(shell.pinned ?? [])
  const wanted = new Set(members)
  return sessions
    .filter(s => wanted.has(s.id) && listable(s, archived))
    .map(s => cardOf(s, statuses, pinned.has(s.id)))
    // A fresh draft (just created from the deck) first, then by most recent activity.
    .sort((a, b) => Number(b.blank) - Number(a.blank) || b.lastActivity - a.lastActivity)
}

/**
 * What the import picker offers: listable main Sessions not yet in the deck, never a draft,
 * most recently updated first.
 * @param sessions - every listed Session.
 * @param members - the deck's membership.
 * @param shell - the archived set.
 * @returns the candidates.
 */
export function importable(sessions: readonly DeckSession[], members: readonly string[], shell: DeckShell = {}): DeckSession[] {
  const archived = new Set(shell.archived ?? [])
  const taken = new Set(members)
  return sessions
    .filter(s => !taken.has(s.id) && s.blank !== true && listable(s, archived))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

// ------------------------------------------------------------------ membership

/** The deck's membership (imported Session ids), in this browser profile. */
export const MEMBERS_KEY = 'dsh-agent-scheduler/deck/members'
const KEY = MEMBERS_KEY

/**
 * Read the membership; a missing or corrupt value is an empty deck, never a crash.
 * @param storage - this browser profile's storage.
 * @returns imported Session ids, in import order.
 */
export function readMembers(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  if (storage === undefined) return []
  try {
    const raw = storage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : []
  } catch {
    return []
  }
}

/**
 * Persist the membership.
 * @param storage - this browser profile's storage.
 * @param members - the new list.
 */
export function writeMembers(storage: Pick<Storage, 'setItem'> | undefined, members: readonly string[]): void {
  try { storage?.setItem(KEY, JSON.stringify(members)) } catch { /* a full or private storage keeps the change for this page only */ }
}

/** Add ids at the end, keeping order and dropping duplicates. */
export const addMembers = (members: readonly string[], ids: readonly string[]): string[] => [...new Set([...members, ...ids])]
/** Remove one id from the deck (never archives or deletes the Session). */
export const removeMember = (members: readonly string[], id: string): string[] => members.filter(x => x !== id)
