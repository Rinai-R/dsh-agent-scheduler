/**
 * The persistent message queue between producers (a router, later source plugins) and target
 * Sessions (workers). Many producers, one consumer per target, ordered per target, at-least-once
 * delivery with dedupe on the target, and recovery after a restart (docs: design §3–§4).
 *
 * Host-agnostic: storage is a {@link QueueStore} (the storage domain in production, memory in
 * tests) and Sessions are reached through a {@link QueueHost} (src/dsh/host/queue-host.ts).
 * @module dsh-agent-scheduler/queue
 */
import { createHash } from 'node:crypto'
import type { Round } from './rounds.js'

/** Where a message is in its life. */
export type QueueState = 'queued' | 'delivered' | 'claimed' | 'answered' | 'failed' | 'cancelled'
const TERMINAL: ReadonlySet<QueueState> = new Set(['answered', 'failed', 'cancelled'])
export const isTerminal = (state: QueueState): boolean => TERMINAL.has(state)

/** Who put a message in. `kind: 'router'` messages are a router's requests (`request` is its r-N). */
export interface QueueProducer {
  readonly kind: string
  readonly id: string
  /** The producing Session, when there is one (a router). */
  readonly session?: string | undefined
}

export interface QueueMessage {
  readonly qid: string
  readonly target: string
  readonly seq: number
  readonly producer: QueueProducer
  readonly dedupeKey: string
  readonly text: string
  /** `turn`: its own turn after the current one (followup); `step`: the next step of the current turn (steer). */
  readonly mode: 'turn' | 'step'
  readonly state: QueueState
  /** The id of the inbox message last created for it; a redelivery gets a new one. */
  readonly inboxMessageId?: string | undefined
  readonly claimedTurn?: number | undefined
  readonly attempts: number
  readonly createdAt: string
  readonly deliveredAt?: string | undefined
  readonly settledAt?: string | undefined
  /** The answer (closing text or report) of the turn that took it. */
  readonly answer?: string | undefined
  /** That turn also took a message the user typed there. */
  readonly mixed?: true | undefined
  readonly error?: string | undefined
  /** Its producer was told the outcome. */
  readonly replied?: true | undefined
  /** A router's request id (`r-N`), carried back with the reply. */
  readonly request?: string | undefined
}

export interface QueueTarget {
  readonly nextSeq: number
  /** Last seq of the target's log whose rounds were attributed. */
  readonly settledThrough?: number | undefined
}

/** Durable state; reads are synchronous, each write resolves once it is durable. */
export interface QueueStore {
  /** Resolves once the store can be read (a durable one opens after the plugin mounts). */
  readonly ready?: Promise<void> | undefined
  message(qid: string): QueueMessage | undefined
  messages(): readonly QueueMessage[]
  putMessage(message: QueueMessage): Promise<void>
  target(id: string): QueueTarget | undefined
  putTarget(id: string, target: QueueTarget): Promise<void>
}

/** A Session the queue delivers to, as the host resolved it. */
export interface QueueAgent {
  readonly id: string
  readonly running: boolean
}

/** How the queue reaches Sessions. */
export interface QueueHost {
  /** The live target (activating a cold one); undefined when there is no such Session. */
  resolve(target: string): Promise<QueueAgent | undefined>
  /** A new inbox message for `message` (not yet delivered); returns its id. */
  prepare(message: QueueMessage): string
  /** Put the prepared message in the target's inbox and flush it; resolves to whether persistence acknowledged it. */
  send(agent: QueueAgent, message: QueueMessage, inboxMessageId: string): Promise<boolean>
  /** Where a message for `qid` already is in the target: its inbox, its log, or nowhere. */
  find(agent: QueueAgent, qid: string, inboxMessageId: string | undefined): 'inbox' | 'log' | undefined
  /** Wake an idle target whose inbox still holds this message (after a restart). */
  wake(agent: QueueAgent, inboxMessageId: string): void
  /** Completed rounds of the target from `fromSeq` on. */
  rounds(target: string, fromSeq: number): Promise<readonly Round[]>
}

/** The outcome a producer is told. */
export interface QueueReply {
  readonly qid: string
  readonly target: string
  readonly producer: QueueProducer
  readonly state: 'answered' | 'failed' | 'cancelled'
  readonly text?: string | undefined
  readonly error?: string | undefined
  readonly mixed?: true | undefined
  readonly request?: string | undefined
}

/** A round of a target that took no queued message but called `report`. */
export interface QueueReport { readonly target: string; readonly text: string; readonly endSeq: number }

export interface QueueLimits {
  /** Delivered but not yet taken, per target. */
  readonly maxInFlight: number
  /** Queued per producer per target. */
  readonly maxQueued: number
}
export const DEFAULT_LIMITS: QueueLimits = { maxInFlight: 3, maxQueued: 20 }

/**
 * How long one step may take before it counts as failed. Nothing in the queue waits without a
 * bound: a store that never opens, an activation or flush that never returns, a log read that
 * hangs. A step that times out is retried up to `maxAttempts`, then the message fails with the
 * reason and its producer is told.
 */
export interface QueueTimeouts {
  /** Waiting for the durable store to open (enqueue, cancel, settle). */
  readonly storeMs: number
  /** Resolving (activating) the target Session. */
  readonly activateMs: number
  /** Handing the message to the target and flushing it to its log. */
  readonly sendMs: number
  /** Reading the target's completed rounds. */
  readonly roundsMs: number
  /** Delivery attempts before the message fails. */
  readonly maxAttempts: number
  /** Wait before retrying a failed delivery. */
  readonly retryMs: number
}
export const DEFAULT_TIMEOUTS: QueueTimeouts = { storeMs: 10_000, activateMs: 30_000, sendMs: 15_000, roundsMs: 30_000, maxAttempts: 3, retryMs: 5_000 }

/** A step that did not finish in time. */
export class QueueTimeout extends Error {
  override readonly name = 'QueueTimeout'
  readonly code = 'queue/timeout'
}

/** @returns `work`, or a rejection with `what` once `ms` pass first. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new QueueTimeout(`${what} did not finish within ${Math.round(ms / 1000)}s`)) }, ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([work, late]).finally(() => { clearTimeout(timer) })
}

/** A producer is over its quota on a target; back off and retry. */
export class QueueFull extends Error {
  override readonly name = 'QueueFull'
  readonly code = 'queue/full'
}

export interface Enqueue {
  readonly target: string
  readonly producer: QueueProducer
  readonly dedupeKey: string
  readonly text: string
  readonly mode?: 'turn' | 'step' | undefined
  readonly request?: string | undefined
}

/** @returns the stable id of a producer's message. */
export function queueIdOf(producer: QueueProducer, dedupeKey: string): string {
  return `q-${createHash('sha256').update(JSON.stringify([producer.kind, producer.id, dedupeKey])).digest('hex').slice(0, 20)}`
}

type Listener<T> = (value: T) => void | Promise<void>

/** The queue. One instance per host process (see design §3.6). */
export class MessageQueue {
  private readonly chains = new Map<string, Promise<void>>()
  /** Targets being delivered to now, and those kicked meanwhile (delivered to again when it ends). */
  private readonly delivering = new Set<string>()
  private readonly kickedAgain = new Set<string>()
  private readonly timeouts: QueueTimeouts
  private readonly replyListeners = new Map<string, Set<Listener<QueueReply>>>()
  private readonly reportListeners = new Set<Listener<QueueReport>>()
  private readonly now: () => Date

  constructor(
    private readonly store: QueueStore,
    private readonly host: QueueHost,
    private readonly limits: QueueLimits = DEFAULT_LIMITS,
    opts: { now?: () => Date; log?: (message: string, error?: unknown) => void; timeouts?: Partial<QueueTimeouts> } = {},
  ) {
    this.now = opts.now ?? (() => new Date())
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts }
    this.log = opts.log ?? (() => undefined)
  }

  private readonly log: (message: string, error?: unknown) => void

  /** Messages of one target, oldest first. */
  messagesTo(target: string): QueueMessage[] {
    return this.store.messages().filter(m => m.target === target).sort((a, b) => a.seq - b.seq)
  }

  status(qid: string): QueueState | undefined { return this.store.message(qid)?.state }

  /**
   * Put a message in. A repeated (producer, dedupeKey) returns the first one and writes nothing.
   * @throws {QueueFull} when the producer has too many queued messages for this target.
   */
  async enqueue(e: Enqueue): Promise<{ qid: string; state: QueueState; duplicate: boolean }> {
    const qid = queueIdOf(e.producer, e.dedupeKey)
    let result!: { qid: string; state: QueueState; duplicate: boolean }
    // Under the target's chain: the seq it takes and the quota it checks are not raced.
    await this.serial(e.target, async () => {
      const existing = this.store.message(qid)
      if (existing !== undefined) { result = { qid, state: existing.state, duplicate: true }; return }
      const mine = this.messagesTo(e.target).filter(m => m.state === 'queued' && m.producer.kind === e.producer.kind && m.producer.id === e.producer.id).length
      if (mine >= this.limits.maxQueued) throw new QueueFull(`${e.producer.kind}:${e.producer.id} already has ${mine} messages queued for ${e.target}; wait for some to be taken`)
      const t = this.store.target(e.target) ?? { nextSeq: 1 }
      await this.store.putTarget(e.target, { ...t, nextSeq: t.nextSeq + 1 })
      await this.store.putMessage({
        qid, target: e.target, seq: t.nextSeq, producer: e.producer, dedupeKey: e.dedupeKey, text: e.text,
        mode: e.mode ?? 'turn', state: 'queued', attempts: 0, createdAt: this.now().toISOString(),
        ...(e.request === undefined ? {} : { request: e.request }),
      })
      result = { qid, state: 'queued', duplicate: false }
    })
    this.kick(e.target)
    return result
  }

  /** Cancel a message that has not been taken yet. A delivered one is cancelled only by the caller removing it from the inbox. */
  async cancel(qid: string): Promise<boolean> {
    const m = this.store.message(qid)
    if (m === undefined || m.state !== 'queued') return false
    let done = false
    await this.serial(m.target, async () => {
      const now = this.store.message(qid)
      if (now?.state !== 'queued') return
      await this.update(now, { state: 'cancelled', settledAt: this.now().toISOString() })
      done = true
    })
    if (done) await this.replyAll(m.target)
    return done
  }

  /** @param kind - a producer kind. Its replies, from now on and for pending ones on {@link recover}. */
  onReply(kind: string, listener: Listener<QueueReply>): () => void {
    let set = this.replyListeners.get(kind)
    if (set === undefined) { set = new Set(); this.replyListeners.set(kind, set) }
    set.add(listener)
    return () => { set.delete(listener) }
  }

  /** Rounds that took no queued message but called `report`. */
  onReport(listener: Listener<QueueReport>): () => void {
    this.reportListeners.add(listener)
    return () => { this.reportListeners.delete(listener) }
  }

  /** Deliver what can go to a target now. */
  kick(target: string): void {
    // Delivery runs outside the target's write chain: enqueue never waits behind an activation or
    // a flush. One delivery loop per target keeps the order; a kick meanwhile runs it once more.
    if (this.delivering.has(target)) { this.kickedAgain.add(target); return }
    this.delivering.add(target)
    void (async () => {
      try {
        await this.waitReady()
        await this.drain(target)
      } catch (error) {
        this.log(`delivering to ${target} failed`, error)
      } finally {
        this.delivering.delete(target)
        if (this.kickedAgain.delete(target)) this.kick(target)
      }
    })()
  }

  /**
   * The target's step took these inbox messages (agent/pre-step): they are claimed by `turn`.
   * Frees in-flight room, so more may be delivered.
   */
  claimed(target: string, inboxMessageIds: readonly string[], turn: number): void {
    const ids = new Set(inboxMessageIds)
    const mine = this.messagesTo(target).filter(m => m.inboxMessageId !== undefined && ids.has(m.inboxMessageId) && (m.state === 'delivered' || m.state === 'queued'))
    if (mine.length === 0) return
    void this.serial(target, async () => {
      for (const m of mine) {
        const now = this.store.message(m.qid)
        if (now === undefined || isTerminal(now.state) || now.state === 'claimed') continue
        await this.update(now, { state: 'claimed', claimedTurn: turn })
      }
    }).then(() => { this.kick(target) }, error => { this.log(`marking claims of ${target} failed`, error) })
  }

  /**
   * Attribute the target's completed rounds: each queued message a round took is answered with
   * that round's answer (or failed when it stopped), and a round that took none but called
   * `report` is reported. Then tell producers.
   */
  async settle(target: string): Promise<void> {
    await this.serial(target, () => this.settleLocked(target, false))
    await this.replyAll(target)
    this.kick(target)
  }

  /**
   * After a restart: attribute rounds, fail claims whose turn never ended, put back deliveries the
   * target lost, wake targets whose inbox still holds a delivery, retry replies, then deliver.
   */
  async recover(): Promise<void> {
    const targets = [...new Set(this.store.messages().filter(m => !isTerminal(m.state) || m.replied !== true).map(m => m.target))]
    for (const target of targets) {
      try {
        await this.serial(target, () => this.settleLocked(target, true))
        await this.replyAll(target)
      } catch (error) {
        this.log(`recovering the queue of ${target} failed`, error)
      }
      this.kick(target)
    }
  }

  // ---------------------------------------------------------------- internals

  /** The store is open, or a bounded wait says why not (never forever). */
  private async waitReady(): Promise<void> {
    if (this.store.ready === undefined) return
    await withTimeout(this.store.ready, this.timeouts.storeMs, 'opening the queue store')
  }

  /** The target's write chain: short state changes only, never host I/O that can hang. */
  private serial(target: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(target) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => { await this.waitReady(); await work() })
    this.chains.set(target, next)
    // A failure is the caller's to handle (enqueue rethrows it); the chain itself must not leave it unhandled.
    next.catch(() => undefined)
    void next.finally(() => { if (this.chains.get(target) === next) this.chains.delete(target) }).catch(() => undefined)
    return next
  }

  private async update(m: QueueMessage, patch: Partial<QueueMessage>): Promise<QueueMessage> {
    const next = { ...m, ...patch } as QueueMessage
    await this.store.putMessage(next)
    return next
  }

  /**
   * Change a message from the delivery loop, on the target's write chain and against its current
   * state (a claim or settle may have moved it meanwhile).
   * @returns the message after the change, or undefined when `when` refused it.
   */
  private async patch(m: QueueMessage, change: Partial<QueueMessage>, when: (now: QueueMessage) => boolean = now => now.state === m.state): Promise<QueueMessage | undefined> {
    let out: QueueMessage | undefined
    await this.serial(m.target, async () => {
      const now = this.store.message(m.qid)
      if (now === undefined || !when(now)) return
      out = await this.update(now, change)
    })
    return out
  }

  /** A delivery step failed: retry later, or fail the message with the reason once out of attempts. */
  private async deliveryFailed(m: QueueMessage, error: unknown): Promise<false> {
    const attempts = m.attempts + 1
    const reason = messageOf(error)
    if (attempts >= this.timeouts.maxAttempts) {
      await this.patch(m, { attempts, state: 'failed', error: `not delivered after ${attempts} attempts: ${reason}`, settledAt: this.now().toISOString() }, now => now.state === 'queued')
      await this.replyAll(m.target)
      // The next message may go: a failed one does not hold the target.
      setTimeout(() => { this.kick(m.target) }, 0)
    } else {
      await this.patch(m, { attempts, error: reason }, now => now.state === 'queued')
      const retry = setTimeout(() => { this.kick(m.target) }, this.timeouts.retryMs)
      ;(retry as { unref?: () => void }).unref?.()
    }
    return false
  }

  private async drain(target: string): Promise<void> {
    for (;;) {
      const all = this.messagesTo(target)
      const inFlight = all.filter(m => m.state === 'delivered').length
      if (inFlight >= this.limits.maxInFlight) return
      const next = all.find(m => m.state === 'queued')
      if (next === undefined) return
      // Strict order per target: a message is not passed over; one that cannot go now stops the drain.
      if (!await this.deliverOne(next)) return
    }
  }

  /** @returns whether the drain may go on. */
  private async deliverOne(m: QueueMessage): Promise<boolean> {
    let agent: QueueAgent | undefined
    try {
      agent = await withTimeout(this.host.resolve(m.target), this.timeouts.activateMs, `activating session ${m.target}`)
    } catch (error) {
      return this.deliveryFailed(m, error)
    }
    if (agent === undefined) {
      await this.patch(m, { state: 'failed', error: `no session ${m.target}`, settledAt: this.now().toISOString() })
      void this.replyAll(m.target)
      return true
    }
    // At least once: a delivery that landed before a crash (or before a timed-out flush) is found, not repeated.
    const where = this.host.find(agent, m.qid, m.inboxMessageId)
    if (where !== undefined) {
      await this.patch(m, { state: 'delivered', deliveredAt: m.deliveredAt ?? this.now().toISOString(), error: undefined })
      return true
    }
    const inboxMessageId = this.host.prepare(m)
    // Recorded before it is sent: a crash after sending finds it by this id (or by its qid).
    const prepared = await this.patch(m, { inboxMessageId })
    if (prepared === undefined) return true
    let ok = false
    try {
      ok = await withTimeout(this.host.send(agent, prepared, inboxMessageId), this.timeouts.sendMs, `delivering to session ${m.target}`)
    } catch (error) {
      return this.deliveryFailed(prepared, error)
    }
    if (!ok) return this.deliveryFailed(prepared, new Error('the target did not acknowledge the delivery'))
    // A claim may already have moved it on (the target took it at once): keep that.
    await this.patch(prepared, { state: 'delivered', deliveredAt: this.now().toISOString(), error: undefined }, now => now.state === 'queued')
    return true
  }

  private async settleLocked(target: string, restarting: boolean): Promise<void> {
    const t = this.store.target(target) ?? { nextSeq: 1 }
    const from = (t.settledThrough ?? -1) + 1
    const rounds = await withTimeout(this.host.rounds(target, from), this.timeouts.roundsMs, `reading the rounds of session ${target}`)
    const byInbox = new Map(this.messagesTo(target).filter(m => m.inboxMessageId !== undefined).map(m => [m.inboxMessageId!, m]))
    for (const round of rounds) {
      const taken = [...round.claimed].flatMap(id => { const m = byInbox.get(id); return m === undefined ? [] : [m] })
      const at = this.now().toISOString()
      for (const m of taken) {
        const now = this.store.message(m.qid)!
        if (isTerminal(now.state)) continue
        if (round.stopped !== undefined) {
          await this.update(now, { state: 'failed', error: `the turn that took it ended (${round.stopped}${round.cause === undefined ? '' : `: ${round.cause}`})`, settledAt: at })
        } else {
          await this.update(now, { state: 'answered', answer: round.answer, settledAt: at, ...(round.userInput === true ? { mixed: true as const } : {}) })
        }
      }
      if (taken.length === 0 && round.stopped === undefined && round.report !== undefined) {
        let told = true
        for (const listener of this.reportListeners) {
          try { await listener({ target, text: round.report, endSeq: round.endSeq }) } catch (error) { told = false; this.log(`a report of ${target} was not delivered`, error) }
        }
        // Not told (its router is not running): this round is settled again later, report included.
        if (!told) return
      }
      await this.store.putTarget(target, { ...(this.store.target(target) ?? t), settledThrough: round.endSeq })
    }
    if (!restarting) return
    // After a restart: what no completed round took.
    const agent = await withTimeout(this.host.resolve(target), this.timeouts.activateMs, `activating session ${target}`).catch(() => undefined)
    if (agent === undefined) return
    for (const m of this.messagesTo(target)) {
      if (m.state === 'claimed' && !agent.running) {
        // Its turn never ended (DSH went away mid-turn): told, not re-run (design §10 #4).
        await this.update(m, { state: 'failed', error: 'interrupted by a DSH restart', settledAt: this.now().toISOString() })
        continue
      }
      if (m.state !== 'delivered' && !(m.state === 'queued' && m.inboxMessageId !== undefined)) continue
      const where = this.host.find(agent, m.qid, m.inboxMessageId)
      if (where === 'log' && !agent.running) {
        // A turn took it (it is in the log), no completed round settled it above, and nothing runs
        // now: that turn never ended, and the process died before its claim was written. Same as a
        // claimed message whose turn never ended: told, not re-run, and it frees its in-flight slot.
        await this.update(m, { state: 'failed', error: 'interrupted by a DSH restart', settledAt: this.now().toISOString() })
        continue
      }
      if (where === undefined) {
        // Lost with the inbox (graceful disposal discards queued input): deliver it again.
        if (m.state === 'delivered') await this.update(m, { state: 'queued', error: 'redelivered after a restart' })
        continue
      }
      if (m.state === 'queued') await this.update(m, { state: 'delivered', deliveredAt: this.now().toISOString() })
      if (where === 'inbox' && !agent.running && m.inboxMessageId !== undefined) this.host.wake(agent, m.inboxMessageId)
    }
  }

  private async replyAll(target: string): Promise<void> {
    for (const m of this.messagesTo(target)) {
      if (!isTerminal(m.state) || m.replied === true) continue
      const listeners = this.replyListeners.get(m.producer.kind)
      if (listeners === undefined || listeners.size === 0) continue
      const reply: QueueReply = {
        qid: m.qid, target, producer: m.producer, state: m.state as QueueReply['state'],
        ...(m.answer === undefined ? {} : { text: m.answer }), ...(m.error === undefined ? {} : { error: m.error }),
        ...(m.mixed === true ? { mixed: true as const } : {}), ...(m.request === undefined ? {} : { request: m.request }),
      }
      let ok = true
      for (const listener of listeners) {
        try { await listener(reply) } catch (error) { ok = false; this.log(`the reply to ${m.qid} was not delivered`, error) }
      }
      if (ok) await this.update(this.store.message(m.qid)!, { replied: true })
    }
  }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * A store that waits for the durable one: every queue operation waits on `ready` (see
 * {@link MessageQueue}), so nothing is read or written before the storage domain is open.
 */
export class PendingQueueStore implements QueueStore {
  private current: QueueStore | undefined
  private open!: () => void
  private refuse: ((error: Error) => void) | undefined
  ready: Promise<void> = new Promise((resolve, reject) => { this.open = resolve; this.refuse = reject })
  /** Why the durable store will not open (this DSH has no storage domain); operations then fail at once. */
  private unavailable: string | undefined
  /**
   * The durable store cannot open on this host: fail waiting and later operations with the reason,
   * instead of letting a send wait forever.
   */
  fail(reason: string): void {
    this.unavailable = reason
    const refuse = this.refuse
    const failed = Promise.reject(new Error(reason))
    failed.catch(() => undefined)
    // The promise callers already wait on is rejected too; nobody may be waiting, so mark it handled.
    this.ready.catch(() => undefined)
    this.ready = failed
    refuse?.(new Error(reason))
  }
  /** The reason the store will not open, when it will not. */
  get unavailableReason(): string | undefined { return this.unavailable }
  /** @param store - the durable store, now open; undefined when it went away (later operations wait again). */
  set(store: QueueStore | undefined): void {
    this.current = store
    if (store !== undefined) {
      this.unavailable = undefined
      this.open()
      // After a failure (fail() replaced `ready` with a rejection) the store came back: ready again.
      this.ready = Promise.resolve()
    }
    else this.ready = new Promise((resolve, reject) => { this.open = resolve; this.refuse = reject })
  }
  get isOpen(): boolean { return this.current !== undefined }
  private get s(): QueueStore { if (this.current === undefined) throw new Error('the queue store is not open'); return this.current }
  message(qid: string) { return this.current?.message(qid) }
  messages() { return this.current?.messages() ?? [] }
  putMessage(m: QueueMessage) { return this.s.putMessage(m) }
  target(id: string) { return this.current?.target(id) }
  putTarget(id: string, t: QueueTarget) { return this.s.putTarget(id, t) }
}

/** A store in memory, for tests and for a DSH without the storage domain (nothing survives a restart). */
export class MemoryQueueStore implements QueueStore {
  readonly msgs = new Map<string, QueueMessage>()
  readonly targets = new Map<string, QueueTarget>()
  writes = 0
  message(qid: string) { return this.msgs.get(qid) }
  messages() { return [...this.msgs.values()] }
  async putMessage(m: QueueMessage) { this.writes += 1; this.msgs.set(m.qid, m) }
  target(id: string) { return this.targets.get(id) }
  async putTarget(id: string, t: QueueTarget) { this.writes += 1; this.targets.set(id, t) }
}
