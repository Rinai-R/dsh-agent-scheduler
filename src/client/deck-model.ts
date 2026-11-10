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

/** One card of the deck. */
export interface DeckCard {
  readonly id: string
  readonly title: string
  readonly lead: LeadState
  /** Live workers on the roster. */
  readonly runningWorkers: number
  /** Messages waiting in the lead's inbox. */
  readonly inbox: number
  /** A pending approval or question on the lead. */
  readonly approvals: number
  /** Epoch ms of the Session's last durable activity, 0 when unknown. */
  readonly lastActivity: number
  /** Whether this card is pinned (a pinned card is never repeated in 「全部会话」). */
  readonly pinned: boolean
  /** Anything on this Session that waits for the user. */
  readonly attention: boolean
}

/** The slice of the roster view the deck reads from a Session summary. */
interface DeckRoster {
  readonly members?: readonly { readonly id: string; readonly kind: string; readonly state: string }[]
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
  return {
    id: session.id,
    title: session.displayTitle ?? session.title ?? session.id,
    lead,
    runningWorkers,
    inbox,
    // The user's approvals can wait on the lead and on any live worker.
    approvals: (waiting ? 1 : 0) + waitingWorkers,
    lastActivity: session.updatedAt ?? 0,
    pinned,
    attention: waiting || inbox > 0 || (roster?.openRequests?.length ?? 0) > 0 || waitingWorkers > 0 || runningWorkers > 0,
  }
}

/**
 * The deck's two lists.
 * @param sessions - every listed Session, in the shell's order.
 * @param statuses - live status by Session id.
 * @param pinned - the pinned Session ids, in the user's order.
 * @returns the pinned cards first (in pin order), then unpinned Sessions needing attention.
 */
export function deckOf(
  sessions: readonly DeckSession[],
  statuses: ReadonlyMap<string, DeckStatus> | undefined,
  pinned: readonly string[],
): { pinned: DeckCard[]; attention: DeckCard[] } {
  const byId = new Map(sessions.filter(s => s.parentId === undefined).map(s => [s.id, s]))
  const pinnedCards = pinned.flatMap(id => {
    const session = byId.get(id)
    return session === undefined ? [] : [cardOf(session, statuses, true)]
  })
  const shown = new Set(pinnedCards.map(card => card.id))
  const attention = sessions
    .filter(s => s.parentId === undefined && !shown.has(s.id))
    .map(s => cardOf(s, statuses, false))
    .filter(card => card.attention)
    .sort((a, b) => b.lastActivity - a.lastActivity)
  return { pinned: pinnedCards, attention }
}

// ------------------------------------------------------------------ pins

const KEY = 'dsh-agent-scheduler/deck/pinned'

/** Pins live in this browser profile: a view preference, not Session data (see the PR notes). */
export function readPins(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  if (storage === undefined) return []
  try {
    const raw = storage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * Persist one pin choice.
 * @param storage - where pins live.
 * @param pinned - the new list.
 */
export function writePins(storage: Pick<Storage, 'setItem'> | undefined, pinned: readonly string[]): void {
  try { storage?.setItem(KEY, JSON.stringify(pinned)) } catch { /* a full or private storage keeps the toggle for this page only */ }
}

/**
 * Toggle one id at the end (pin) or out (unpin).
 * @param pinned - current order.
 * @param id - the Session.
 * @returns the next order.
 */
export const togglePin = (pinned: readonly string[], id: string): string[] => pinned.includes(id) ? pinned.filter(x => x !== id) : [...pinned, id]
