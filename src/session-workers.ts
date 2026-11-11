/**
 * Scheduler v2: workers are top-level Sessions in the router's workspace, reached through the
 * persistent queue (src/queue.ts). The router (the main Session, "lead") keeps its roster, request
 * ids, inbox and tools; this module is the part of the scheduler that differs for session workers:
 * creating one, sending it a request, settling its answers and reports, and converting a v1
 * (subagent) worker. Design: ~/project/research/scheduler-router-v2/design.md (§2 option B, §3–§5, §7).
 * @module dsh-agent-scheduler/session-workers
 */
import { isAbsolute, relative, resolve } from 'node:path'
import type { Agent } from './dsh/types.js'
import type { SessionWorkerPort } from './dsh/host/index.js'
import { MessageQueue, QueueFull, type QueueReply, type QueueReport } from './queue.js'
import type { Ledger } from './ledger.js'

/** The producer kind of a router's requests. */
export const ROUTER_PRODUCER = 'router'

/**
 * Whether `path` is inside `root` (or is it): a session worker can write only under its header cwd,
 * the router's workspace (`asar:dsh-sandbox-policy/README.md:75`).
 */
export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** What the scheduler lends this module. */
export interface SessionWorkerHooks {
  /** A reply for the router's inbox: what the router reads, from which member. */
  toLead(router: Agent, text: string, sender: string): void
  /** Record a request answered or failed in the router's log. */
  settleRequest(router: Agent, request: string, outcome: { answer: string } | { failed: string }): void
  /** The ledger of a router. */
  ledgerOf(router: Agent): Ledger
  /** A resident router by id. */
  live(id: string): Agent | undefined
  /** The router a worker Session belongs to, when known. */
  routerOfWorker(worker: string): string | undefined
  log(message: string, error?: unknown): void
}

/**
 * Wire the queue's replies and reports to routers. Replies of a router's requests come back as
 * `[reply to r-N from name]` in its inbox; a report from a round nobody asked for (the user chatted
 * with the worker directly and asked it to share) comes as `[report from name, not a request]`.
 */
export function connectRouters(queue: MessageQueue, hooks: SessionWorkerHooks): () => void {
  const reply = (r: QueueReply): void => {
    // A message that is no request (the intro of a worker created without a task) answers nobody.
    if (r.request === undefined) return
    const router = r.producer.session === undefined ? undefined : hooks.live(r.producer.session)
    // Not resident: the reply is not marked as told, so it comes again on the router's next recover.
    if (router === undefined) throw new Error(`router ${r.producer.session ?? r.producer.id} is not running`)
    const ledger = hooks.ledgerOf(router)
    const member = ledger.members.get(r.target)
    const name = member?.name ?? r.target
    const request = r.request
    if (r.state === 'answered') {
      hooks.settleRequest(router, request, { answer: r.text ?? '' })
      const mixed = r.mixed === true ? ' (the turn also answered the user, who spoke to it directly)' : ''
      hooks.toLead(router, `[reply to ${request} from ${name}${mixed}]\n${r.text ?? ''}`, r.target)
      return
    }
    const why = r.state === 'cancelled' ? 'cancelled before it was delivered' : (r.error ?? 'failed')
    hooks.settleRequest(router, request, { failed: why })
    hooks.toLead(router, `[request ${request} to ${name} failed: ${why}]`, r.target)
  }
  const report = (r: QueueReport): void => {
    const routerId = hooks.routerOfWorker(r.target)
    const router = routerId === undefined ? undefined : hooks.live(routerId)
    if (router === undefined) throw new Error(`the router of ${r.target} is not running`)
    const member = hooks.ledgerOf(router).members.get(r.target)
    hooks.toLead(router, `[report from ${member?.name ?? r.target}, not a request]\n${r.text}`, r.target)
  }
  const offReply = queue.onReply(ROUTER_PRODUCER, reply)
  const offReport = queue.onReport(report)
  return () => { offReply(); offReport() }
}

/**
 * Enqueue a router's request to a session worker.
 * @returns the queue id and whether it waits behind others.
 * @throws {QueueFull} through, as a clear refusal for the lead.
 */
export async function sendToSessionWorker(queue: MessageQueue, router: Agent, worker: string, request: string, text: string, opts: { notice?: boolean; hops?: number } = {}): Promise<{ qid: string; ahead: number }> {
  const before = queue.messagesTo(worker).filter(m => m.state === 'queued' || m.state === 'delivered' || m.state === 'claimed').length
  try {
    // A notice (an intro, a conversion) is no request: its turn answers nobody.
    const { qid } = await queue.enqueue({ target: worker, producer: { kind: ROUTER_PRODUCER, id: router.id, session: router.id }, dedupeKey: request, text, ...(opts.notice === true ? {} : { request }), ...(opts.hops === undefined ? {} : { hops: opts.hops }) })
    return { qid, ahead: before }
  } catch (error) {
    if (error instanceof QueueFull) throw new Error(`${error.message} (${error.code})`)
    throw error
  }
}

export type { SessionWorkerPort }
