/** The persistent queue's state machine, ordering, dedupe, back-pressure and every crash window (design §3–§4). */
import { describe, expect, it } from 'vitest'
import { MemoryQueueStore, MessageQueue, QueueFull, queueIdOf, type QueueAgent, type QueueHost, type QueueMessage, type QueueReply, type QueueReport } from '../src/queue.js'
import type { Round } from '../src/rounds.js'

interface FakeTarget { running: boolean; inbox: Array<{ id: string; qid: string }>; log: Array<{ id: string; qid: string }>; rounds: Round[]; exists: boolean }

/** A host whose Sessions are plain arrays; `fail` injects the crash points. */
class FakeHost implements QueueHost {
  readonly targets = new Map<string, FakeTarget>()
  n = 0
  fail: { resolve?: boolean | undefined; send?: 'throw' | 'nack' | 'crash-after-send' | undefined } = {}
  woken: string[] = []
  sent: string[] = []
  t(id: string): FakeTarget {
    let t = this.targets.get(id)
    if (t === undefined) { t = { running: false, inbox: [], log: [], rounds: [], exists: true }; this.targets.set(id, t) }
    return t
  }
  async resolve(target: string): Promise<QueueAgent | undefined> {
    if (this.fail.resolve === true) throw new Error('cold resume failed')
    const t = this.t(target)
    return t.exists ? { id: target, running: t.running } : undefined
  }
  prepare(): string { this.n += 1; return `in-${this.n}` }
  async send(agent: QueueAgent, m: QueueMessage, id: string): Promise<boolean> {
    if (this.fail.send === 'throw') throw new Error('followup threw')
    this.t(agent.id).inbox.push({ id, qid: m.qid })
    this.sent.push(m.text)
    if (this.fail.send === 'crash-after-send') throw new Error('crashed before the flush returned')
    return this.fail.send !== 'nack'
  }
  find(agent: QueueAgent, qid: string, inboxMessageId: string | undefined): 'inbox' | 'log' | undefined {
    const t = this.t(agent.id)
    const hit = (e: { id: string; qid: string }) => e.qid === qid || e.id === inboxMessageId
    return t.inbox.some(hit) ? 'inbox' : t.log.some(hit) ? 'log' : undefined
  }
  wake(_agent: QueueAgent, id: string): void { this.woken.push(id) }
  async rounds(target: string, fromSeq: number): Promise<readonly Round[]> { return this.t(target).rounds.filter(r => r.endSeq >= fromSeq) }

  /** The target's next step takes its whole inbox (as next-step input) into `turn`. */
  claimAll(queue: MessageQueue, target: string, turn: number): string[] {
    const t = this.t(target)
    const ids = t.inbox.map(e => e.id)
    t.log.push(...t.inbox)
    t.inbox = []
    t.running = true
    queue.claimed(target, ids, turn)
    return ids
  }
  /** The turn ends. */
  end(target: string, ids: readonly string[], endSeq: number, round: Partial<Round> = {}): void {
    const t = this.t(target)
    t.running = false
    t.rounds.push({ endSeq, claimed: new Set(ids), answer: 'ANSWER', ...round })
  }
}

const settleTick = () => new Promise(resolve => setTimeout(resolve, 10))
const router = (id = 'R1') => ({ kind: 'router', id, session: id })

function setup(limits = { maxInFlight: 3, maxQueued: 20 }) {
  const store = new MemoryQueueStore()
  const host = new FakeHost()
  const queue = new MessageQueue(store, host, limits)
  const replies: QueueReply[] = []
  const reports: QueueReport[] = []
  queue.onReply('router', r => { replies.push(r) })
  queue.onReport(r => { reports.push(r) })
  return { store, host, queue, replies, reports }
}

describe('enqueue and delivery', () => {
  it('delivers in order per target and dedupes a repeated (producer, key) without writing', async () => {
    const { store, host, queue } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'r-1', text: 'one', request: 'r-1' })
    const b = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'r-2', text: 'two' })
    await settleTick()
    const writes = store.writes
    const again = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'r-1', text: 'one (retry)' })
    expect(again).toEqual({ qid: a.qid, state: expect.any(String), duplicate: true })
    expect(store.writes).toBe(writes)
    await settleTick()
    expect(host.sent).toEqual(['one', 'two'])
    expect(store.message(a.qid)?.seq).toBeLessThan(store.message(b.qid)!.seq)
    expect(queue.status(a.qid)).toBe('delivered')
    expect(a.qid).toBe(queueIdOf(router(), 'r-1'))
  })

  it('two producers on one target are ordered by arrival, each target has its own order', async () => {
    const { host, queue } = setup()
    await Promise.all([
      queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'a', text: 'router 1' }),
      queue.enqueue({ target: 'W', producer: { kind: 'feishu', id: 'chat:1' }, dedupeKey: 'm1', text: 'feishu 1' }),
      queue.enqueue({ target: 'V', producer: router(), dedupeKey: 'b', text: 'other target' }),
      queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'c', text: 'router 2' }),
    ])
    await settleTick()
    expect(host.t('W').inbox.length).toBe(3)
    expect(queue.messagesTo('W').map(m => m.text)).toEqual(['router 1', 'feishu 1', 'router 2'])
    expect(host.sent.filter(t => t !== 'other target')).toEqual(['router 1', 'feishu 1', 'router 2'])
  })

  it('back-pressure: at most maxInFlight undelivered-but-untaken per target, and a quota per producer', async () => {
    const { host, queue } = setup({ maxInFlight: 2, maxQueued: 3 })
    for (const k of ['1', '2', '3', '4', '5']) await queue.enqueue({ target: 'W', producer: router(), dedupeKey: k, text: k })
    await settleTick()
    expect(host.sent).toEqual(['1', '2'])
    expect(queue.messagesTo('W').filter(m => m.state === 'queued')).toHaveLength(3)
    await expect(queue.enqueue({ target: 'W', producer: router(), dedupeKey: '6', text: '6' })).rejects.toBeInstanceOf(QueueFull)
    // Another producer has its own quota.
    await queue.enqueue({ target: 'W', producer: { kind: 'github', id: 'repo' }, dedupeKey: 'x', text: 'gh' })
    // Taking frees room: the next ones go, still in order.
    host.claimAll(queue, 'W', 1)
    await settleTick()
    expect(host.sent).toEqual(['1', '2', '3', '4'])
  })

  it('a target that cannot be reached keeps its messages queued and retries; a missing session fails them', async () => {
    const { host, queue, replies } = setup()
    host.fail.resolve = true
    const m = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'k', text: 'x' })
    await settleTick()
    expect(queue.status(m.qid)).toBe('queued')
    host.fail.resolve = false
    queue.kick('W')
    await settleTick()
    expect(queue.status(m.qid)).toBe('delivered')
    host.t('gone').exists = false
    const lost = await queue.enqueue({ target: 'gone', producer: router(), dedupeKey: 'k2', text: 'x' })
    await settleTick()
    expect(queue.status(lost.qid)).toBe('failed')
    expect(replies.find(r => r.qid === lost.qid)).toMatchObject({ state: 'failed', error: expect.stringMatching(/no session/u) })
  })

  it('a queued message can be cancelled; a delivered one cannot', async () => {
    const { host, queue, replies } = setup({ maxInFlight: 1, maxQueued: 20 })
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'a', text: 'a' })
    const b = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'b', text: 'b' })
    await settleTick()
    expect(await queue.cancel(a.qid)).toBe(false)
    expect(await queue.cancel(b.qid)).toBe(true)
    expect(replies.find(r => r.qid === b.qid)?.state).toBe('cancelled')
    host.claimAll(queue, 'W', 1)
    await settleTick()
    expect(host.sent).toEqual(['a'])
  })
})

describe('reply correlation (claim → turn → answer)', () => {
  it('the turn that took a message answers it; its producer is told once', async () => {
    const { host, queue, replies } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: 'r-1', text: 'task', request: 'r-1' })
    await settleTick()
    const ids = host.claimAll(queue, 'W', 4)
    await settleTick()
    expect(queue.status(a.qid)).toBe('claimed')
    host.end('W', ids, 30, { answer: 'DONE' })
    await queue.settle('W')
    await queue.settle('W')
    expect(replies).toEqual([expect.objectContaining({ qid: a.qid, state: 'answered', text: 'DONE', request: 'r-1' })])
  })

  it('several messages taken in one turn share its answer; a turn that also took the user\'s words is mixed', async () => {
    const { host, queue, replies } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: '1' })
    const b = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '2', text: '2' })
    await settleTick()
    const ids = host.claimAll(queue, 'W', 2)
    host.end('W', ids, 10, { answer: 'BOTH', userInput: true })
    await queue.settle('W')
    expect(replies.map(r => [r.qid, r.text, r.mixed])).toEqual([[a.qid, 'BOTH', true], [b.qid, 'BOTH', true]])
  })

  it('an aborted or failed turn fails what it took, without a rerun', async () => {
    const { host, queue, replies } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: '1' })
    await settleTick()
    const ids = host.claimAll(queue, 'W', 1)
    host.end('W', ids, 9, { stopped: 'aborted', cause: 'user' })
    await queue.settle('W')
    expect(replies[0]).toMatchObject({ qid: a.qid, state: 'failed', error: expect.stringMatching(/aborted: user/u) })
    expect(host.sent).toEqual(['1'])
  })

  it('the user chatting directly pushes nothing; a report there goes to the report listener', async () => {
    const { host, queue, replies, reports } = setup()
    host.end('W', ['typed-by-user'], 5, { answer: 'chat', userInput: true })
    host.end('W', ['typed-again'], 8, { answer: 'shared', report: 'summary + pointer seq 0-8', userInput: true })
    await queue.settle('W')
    expect(replies).toEqual([])
    expect(reports).toEqual([{ target: 'W', text: 'summary + pointer seq 0-8', endSeq: 8 }])
    // Settled through seq 8: a second settle reports nothing again.
    await queue.settle('W')
    expect(reports).toHaveLength(1)
  })
})

describe('crash windows and restart recovery (§3.5)', () => {
  /** A new queue over the same store and Sessions: what a restart rebuilds. */
  const restart = (store: MemoryQueueStore, host: FakeHost) => {
    const queue = new MessageQueue(store, host)
    const replies: QueueReply[] = []
    queue.onReply('router', r => { replies.push(r) })
    return { queue, replies }
  }

  it('written but never sent: delivered once after the restart', async () => {
    const { store, host, queue } = setup()
    host.fail.send = 'throw'
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })
    await settleTick()
    expect(store.message(a.qid)).toMatchObject({ state: 'queued', inboxMessageId: 'in-1' })
    host.fail.send = undefined
    const after = restart(store, host)
    await after.queue.recover()
    await settleTick()
    expect(host.t('W').inbox).toHaveLength(1)
    expect(after.queue.status(a.qid)).toBe('delivered')
  })

  it('sent but the process died before it was marked: found in the inbox, not sent twice; an idle target is woken', async () => {
    const { store, host, queue } = setup()
    host.fail.send = 'crash-after-send'
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })
    await settleTick()
    expect(store.message(a.qid)?.state).toBe('queued')
    host.fail.send = undefined
    const after = restart(store, host)
    await after.queue.recover()
    await settleTick()
    expect(host.t('W').inbox).toHaveLength(1)
    expect(after.queue.status(a.qid)).toBe('delivered')
    expect(host.woken).toEqual(['in-1'])
  })

  it('persistence did not acknowledge: retried, deduped by its qid on the target', async () => {
    const { host, queue } = setup()
    host.fail.send = 'nack'
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })
    await settleTick()
    host.fail.send = undefined
    queue.kick('W')
    await settleTick()
    expect(host.t('W').inbox).toHaveLength(1)
    expect(queue.status(a.qid)).toBe('delivered')
  })

  it('delivered, then the inbox was lost with the process: delivered again', async () => {
    const { store, host, queue } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })
    await settleTick()
    host.t('W').inbox = []
    const after = restart(store, host)
    await after.queue.recover()
    await settleTick()
    expect(host.sent).toEqual(['x', 'x'])
    expect(after.queue.status(a.qid)).toBe('delivered')
  })

  it('claimed, and the turn never ended: failed as interrupted by the restart, and told', async () => {
    const { store, host, queue } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x', request: 'r-9' })
    await settleTick()
    host.claimAll(queue, 'W', 3)
    await settleTick()
    host.t('W').running = false
    const after = restart(store, host)
    await after.queue.recover()
    expect(after.replies).toEqual([expect.objectContaining({ qid: a.qid, state: 'failed', error: 'interrupted by a DSH restart', request: 'r-9' })])
  })

  it('answered but the producer was not told (its listener threw): told on the next settle or restart', async () => {
    const { store, host, queue } = setup()
    let fail = true
    queue.onReply('router', () => { if (fail) throw new Error('router not resident') })
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })
    await settleTick()
    host.end('W', host.claimAll(queue, 'W', 1), 5)
    await queue.settle('W')
    expect(store.message(a.qid)).toMatchObject({ state: 'answered' })
    expect(store.message(a.qid)?.replied).toBeUndefined()
    fail = false
    const after = restart(store, host)
    await after.queue.recover()
    expect(after.replies.map(r => r.qid)).toEqual([a.qid])
    expect(store.message(a.qid)?.replied).toBe(true)
  })

  it('taken into a turn but the claim was not written before the crash, and the turn never ended: failed, not left delivered', async () => {
    const { store, host, queue } = setup()
    const a = await queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x', request: 'r-1' })
    await settleTick()
    expect(store.message(a.qid)?.state).toBe('delivered')
    // The target's step took it (it is in the log), and the process died before claimed() was written.
    const t = host.t('W')
    t.log.push(...t.inbox)
    t.inbox = []
    t.running = false
    const after = restart(store, host)
    await after.queue.recover()
    await settleTick()
    expect(store.message(a.qid)?.state).toBe('failed')
    expect(after.replies).toEqual([expect.objectContaining({ qid: a.qid, state: 'failed', request: 'r-1' })])
    // It does not hold an in-flight slot: three more are delivered.
    for (const k of ['2', '3', '4']) await after.queue.enqueue({ target: 'W', producer: router(), dedupeKey: k, text: k })
    await settleTick()
    expect(after.queue.messagesTo('W').filter(m => m.state === 'delivered')).toHaveLength(3)
  })

  it('a store that can never open fails a send at once with the reason, instead of waiting forever', async () => {
    const { PendingQueueStore } = await import('../src/queue.js')
    const pending = new PendingQueueStore()
    const queue = new MessageQueue(pending, new FakeHost())
    pending.fail('this DSH has no storage domain')
    await expect(queue.enqueue({ target: 'W', producer: router(), dedupeKey: '1', text: 'x' })).rejects.toThrow(/no storage domain/u)
    expect(pending.unavailableReason).toMatch(/no storage domain/u)
  })
})
