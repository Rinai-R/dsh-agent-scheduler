/**
 * Queries over one main Session's roster. The state is the same pure fold the client projection
 * uses ({@link applyRoster}); this class only caches lookups for the current state.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyRoster, EMPTY_ROSTER, type Roster, type RosterMember, type RosterRequest } from './projection.js'

export type { MemberState, RosterMember as Member, RosterRequest as Request } from './projection.js'

/** All records of one main Session, folded. */
export class Ledger {
  private current: Roster = EMPTY_ROSTER
  private memberIndex: ReadonlyMap<string, RosterMember> | undefined
  private requestIndex: ReadonlyMap<string, RosterRequest> | undefined

  /** @param mainId - the main Session's id. */
  constructor(readonly mainId: string) {}

  /**
   * Fold a whole log.
   * @param mainId - the main Session's id.
   * @param events - its events.
   * @returns the ledger.
   */
  static from(mainId: string, events: readonly SessionEvent[]): Ledger {
    const ledger = new Ledger(mainId)
    for (const event of events) ledger.apply(event)
    return ledger
  }

  /** @param event - one main-Session event; non-records leave the state as it is. */
  apply(event: SessionEvent): void {
    const next = applyRoster(this.current, event)
    if (next === this.current) return
    this.current = next
    this.memberIndex = undefined
    this.requestIndex = undefined
  }

  /** @returns the fold state. */
  get state(): Roster { return this.current }

  /** @returns the lead's role text. */
  get role(): string | undefined { return this.current.role ?? undefined }

  /** @returns forks and workers by Session id. */
  get members(): ReadonlyMap<string, RosterMember> {
    this.memberIndex ??= new Map(this.current.members.map(m => [m.id, m]))
    return this.memberIndex
  }

  /** @returns requests by id. */
  get requests(): ReadonlyMap<string, RosterRequest> {
    this.requestIndex ??= new Map(this.current.requests.map(r => [r.id, r]))
    return this.requestIndex
  }

  /** @returns the next fork display name. */
  nextForkName(): string { return `fork-${this.current.members.filter(m => m.kind === 'fork').length + 1}` }

  /** @returns the next request id; requests are never removed, so the count is the sequence. */
  nextRequestId(): string { return `r-${this.current.requests.length + 1}` }

  /**
   * Find a member by name or id.
   * @param key - `billing`, `fork-3`, or a Session id.
   * @returns the member.
   */
  find(key: string): RosterMember | undefined {
    return this.members.get(key) ?? this.current.members.find(m => m.name === key)
  }

  /** @returns the display name of a Session id; `lead` for the main Session. */
  nameOf(id: string): string {
    if (id === this.mainId) return 'lead'
    return this.members.get(id)?.name ?? id
  }

  /** @returns unanswered requests sent by `id`. */
  openFrom(id: string): RosterRequest[] {
    return this.current.requests.filter(r => r.from === id && r.state === 'sent')
  }

  /** @returns unanswered requests addressed to `id`. */
  openTo(id: string): RosterRequest[] {
    return this.current.requests.filter(r => r.to === id && r.state === 'sent')
  }
}
