/**
 * The queue's durable store on the host's storage domain (`ctx.storageDomain`), as dsh-schedule
 * keeps its tasks. Spike (design §1, `spike/out.jsonl`): a third-party plugin opens its own domain,
 * `layout: 'per-record'` keeps one file per record under `<DSH_HOME>/storages/<name>/<table>/`,
 * and records read back after a full host restart.
 * @module dsh-agent-scheduler/dsh/host/queue-store
 */
import type { Context } from '@deepseek-ai/cordis'
import { features } from '../compat.js'
import type { QueueMessage, QueueStore, QueueTarget } from '../../queue.js'

/**
 * The storage domain parses each stored record with `valueSchema.parse` (a zod schema in DSH's
 * own packages). This plugin carries no zod: a plain validator with the same `parse` does, and the
 * contract test checks the spec against the real `defineDomain` (tests/contract/queue-store.spec.ts).
 */
function schema<T>(name: string, check: (value: Record<string, unknown>) => string | undefined): { parse(raw: unknown): T; safeParse(raw: unknown): { success: boolean } } {
  const parse = (raw: unknown): T => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name}: not an object`)
    const problem = check(raw as Record<string, unknown>)
    if (problem !== undefined) throw new Error(`${name}: ${problem}`)
    return raw as T
  }
  return { parse, safeParse: raw => { try { parse(raw); return { success: true } } catch { return { success: false } } } }
}
const str = (v: unknown) => typeof v === 'string'
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const opt = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v)
const STATES = new Set(['queued', 'delivered', 'claimed', 'answered', 'failed', 'cancelled'])

const messageSchema = schema<QueueMessage>('queue message', m => {
  if (![m.qid, m.target, m.dedupeKey, m.text, m.createdAt].every(str)) return 'qid, target, dedupeKey, text and createdAt are strings'
  if (!num(m.seq) || !num(m.attempts)) return 'seq and attempts are numbers'
  if (m.mode !== 'turn' && m.mode !== 'step') return 'mode is turn or step'
  if (!STATES.has(String(m.state))) return `unknown state ${String(m.state)}`
  const p = m.producer as Record<string, unknown> | undefined
  if (p === undefined || !str(p.kind) || !str(p.id) || !opt(p.session, str)) return 'producer is { kind, id, session? }'
  for (const k of ['inboxMessageId', 'deliveredAt', 'settledAt', 'answer', 'error', 'request']) if (!opt(m[k], str)) return `${k} is a string`
  if (!opt(m.claimedTurn, num)) return 'claimedTurn is a number'
  return undefined
})
const targetSchema = schema<QueueTarget>('queue target', t => num(t.nextSeq) && opt(t.settledThrough, num) ? undefined : 'nextSeq (and settledThrough) are numbers')

/**
 * The domain: `<DSH_HOME>/storages/agent_scheduler_queue/{messages,targets}/<key>.json` on the json
 * backend. The literal `defineDomain` would return (it validates and returns its argument).
 */
export const QUEUE_DOMAIN = {
  name: 'agent_scheduler_queue',
  version: 1,
  layout: 'per-record' as const,
  tables: { messages: { valueSchema: messageSchema }, targets: { valueSchema: targetSchema } },
}

interface DomainTable<T> { get(key: string): T | undefined; entries(): Iterable<[string, T]>; put(key: string, value: T): Promise<void> }
interface OpenDomain { table(name: 'messages'): DomainTable<QueueMessage>; table(name: 'targets'): DomainTable<QueueTarget>; close(): Promise<void> }

/** Drop keys whose value is undefined: the schema treats them as absent, JSON would write null. */
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

/**
 * Open the queue's store once the storage domain is mounted; closed when it goes away.
 * @param ctx - the rule's context (storageDomain is optional, so injected here).
 * @param ready - receives the store (or undefined while there is none).
 */
export function watchQueueStore(ctx: Context, ready: (store: QueueStore | undefined) => void, log: (message: string, error?: unknown) => void): void {
  ctx.inject(['storageDomain'] as never, (scoped: Context) => {
    let closed = false
    let close: (() => Promise<void>) | undefined
    void openQueueStore(scoped).then(opened => {
      if (opened === undefined) return
      if (closed) { void opened.close(); return }
      close = opened.close
      ready(opened.store)
    }, error => { log('opening the agent-scheduler queue failed', error) })
    scoped.effect(() => () => { closed = true; ready(undefined); void close?.() }, 'agent-scheduler: queue store')
  })
}

/**
 * Open the queue's domain.
 * @param ctx - a context that injects `storageDomain`.
 * @returns the store, or undefined on a DSH without the storage domain (then the caller says why).
 */
export async function openQueueStore(ctx: Context): Promise<{ store: QueueStore; close: () => Promise<void> } | undefined> {
  const facility = (ctx as unknown as { storageDomain?: { open(spec: unknown): Promise<OpenDomain> }; get(name: string): { open(spec: unknown): Promise<OpenDomain> } | undefined }).storageDomain
    ?? (ctx as unknown as { get(name: string): { open(spec: unknown): Promise<OpenDomain> } | undefined }).get('storageDomain')
  if (!features.record('storageDomain', facility !== undefined && typeof facility.open === 'function', 'storageDomain.open')) return undefined
  const domain = await facility!.open(QUEUE_DOMAIN)
  const messages = domain.table('messages')
  const targets = domain.table('targets')
  const store: QueueStore = {
    message: qid => messages.get(qid),
    messages: () => [...messages.entries()].map(([, m]) => m),
    // The domain validates on load, not on write: refuse here what a later open would refuse.
    putMessage: async m => { const value = clean(m); messageSchema.parse(value); await messages.put(m.qid, value) },
    target: id => targets.get(id),
    putTarget: async (id, t) => { const value = clean(t); targetSchema.parse(value); await targets.put(id, value) },
  }
  return { store, close: () => domain.close() }
}
