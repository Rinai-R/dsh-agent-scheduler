/** In-memory fold of one main Session's records: forks, workers, requests, roles. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { inputOf, recordReaders as R } from './records.js'

/** Lifecycle of a fork or worker as recorded; liveness comes from the runtime. */
export type MemberState = 'queued' | 'started' | 'done' | 'failed' | 'archived'

/** One fork or worker. */
export interface Member {
  readonly id: string
  readonly name: string
  readonly kind: 'fork' | 'worker'
  state: MemberState
  /** Fork: the user's input. Worker: its role. */
  text: string
  role?: string | undefined
  cwd?: string | undefined
  model?: string | undefined
  from?: string | undefined
  detail?: string | undefined
}

/** One request with its latest state. */
export interface Request {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  messageId?: string | undefined
  state: 'sent' | 'answered' | 'failed'
  answer?: string | undefined
  deliveredTo?: string | undefined
}

/** All records of one main Session. */
export class Ledger {
  readonly members = new Map<string, Member>()
  readonly requests = new Map<string, Request>()
  role: string | undefined
  private forkCount = 0
  private requestCount = 0

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

  /**
   * Apply one event; non-records are ignored. Called for every appended record, so the fold and
   * the log never disagree.
   * @param event - a main Session event.
   */
  apply(event: SessionEvent): void {
    const input = inputOf(event)
    if (input !== undefined) {
      this.forkCount += 1
      this.members.set(input.forkId, { id: input.forkId, name: input.name ?? `fork-${this.forkCount}`, kind: 'fork', state: 'started', text: input.text })
      return
    }
    const fork = R.forkState(event)
    if (fork !== undefined) {
      const member = this.members.get(fork.forkId)
      if (member !== undefined) { member.state = fork.state; member.detail = fork.detail }
      return
    }
    const agent = R.agent(event)
    if (agent !== undefined) {
      const existing = this.members.get(agent.id)
      if (agent.action === 'created' || existing === undefined) {
        this.members.set(agent.id, {
          id: agent.id, name: agent.name, kind: 'worker', state: agent.action === 'created' ? 'started' : stateOf(agent.action),
          text: agent.role ?? '', role: agent.role, cwd: agent.cwd, model: agent.model, from: agent.from, detail: agent.detail,
        })
      } else {
        existing.state = stateOf(agent.action)
        existing.detail = agent.detail
      }
      return
    }
    const request = R.request(event)
    if (request !== undefined) {
      const known = this.requests.get(request.id)
      if (request.action === 'sent' && known !== undefined) {
        // The same request again, now with the id of the delivered message.
        if (request.messageId !== undefined) known.messageId = request.messageId
        return
      }
      if (request.action === 'sent') {
        this.requestCount += 1
        this.requests.set(request.id, { id: request.id, from: request.from ?? this.mainId, to: request.to ?? '', text: request.text ?? '', messageId: request.messageId, state: 'sent' })
        return
      }
      if (known === undefined) return
      known.state = request.action
      known.answer = request.answer ?? request.detail
      known.deliveredTo = request.deliveredTo
      if (request.messageId !== undefined) known.messageId = request.messageId
      return
    }
    const role = R.role(event)
    if (role !== undefined) {
      if (role.agent === undefined) this.role = role.text
      else { const member = this.members.get(role.agent); if (member !== undefined) member.role = role.text }
    }
  }

  /** @returns the next fork display name. */
  nextForkName(): string { return `fork-${this.forkCount + 1}` }

  /** @returns the next request id. */
  nextRequestId(): string { return `r-${this.requestCount + 1}` }

  /**
   * Find a member by name or id.
   * @param key - `billing`, `fork-3`, or a Session id.
   * @returns the member.
   */
  find(key: string): Member | undefined {
    const byId = this.members.get(key)
    if (byId !== undefined) return byId
    for (const member of this.members.values()) if (member.name === key) return member
    return undefined
  }

  /** @returns the display name of a Session id; `lead` for the main Session. */
  nameOf(id: string): string {
    if (id === this.mainId) return 'lead'
    return this.members.get(id)?.name ?? id
  }

  /** @returns unanswered requests sent by `id`. */
  openFrom(id: string): Request[] {
    return [...this.requests.values()].filter(r => r.from === id && r.state === 'sent')
  }

  /** @returns unanswered requests addressed to `id`. */
  openTo(id: string): Request[] {
    return [...this.requests.values()].filter(r => r.to === id && r.state === 'sent')
  }
}

function stateOf(action: 'created' | 'started' | 'queued' | 'archived' | 'failed'): MemberState {
  return action === 'created' ? 'started' : action
}
