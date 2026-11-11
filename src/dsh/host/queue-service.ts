/**
 * The queue as a host service for source plugins (design §8, experimental): a Feishu or GitHub
 * router enqueues into the same per-target queue and hears the outcome of its own messages.
 * Registered under `agentSchedulerQueue` on the global symbol registry, so a plugin that does not
 * depend on this package's types can still find it.
 * @module dsh-agent-scheduler/dsh/host/queue-service
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Enqueue, MessageQueue, QueueReply, QueueState } from '../../queue.js'

/** What a source plugin sees. */
export interface AgentSchedulerQueue {
  enqueue(e: Enqueue): Promise<{ qid: string; state: QueueState; duplicate: boolean }>
  cancel(qid: string): Promise<boolean>
  status(qid: string): QueueState | undefined
  /** The outcome of messages of one producer kind (answered, failed, cancelled). */
  onReply(kind: string, listener: (reply: QueueReply) => void | Promise<void>): () => void
}

export const QUEUE_SERVICE = Symbol.for('dsh-agent-scheduler/queue')

/**
 * Publish the queue for this process; returns its removal.
 * @param _ctx - the rule's context (the service lives as long as it).
 * @param queue - the queue.
 */
export function provideQueue(_ctx: Context, queue: MessageQueue): () => void {
  const service: AgentSchedulerQueue = {
    enqueue: e => {
      if (e.producer.kind === 'router') return Promise.reject(new Error('producer kind "router" is the scheduler\'s own'))
      return queue.enqueue(e)
    },
    cancel: qid => queue.cancel(qid),
    status: qid => queue.status(qid),
    onReply: (kind, listener) => queue.onReply(kind, listener),
  }
  const slot = globalThis as { [QUEUE_SERVICE]?: AgentSchedulerQueue }
  slot[QUEUE_SERVICE] = service
  return () => { if (slot[QUEUE_SERVICE] === service) delete slot[QUEUE_SERVICE] }
}
