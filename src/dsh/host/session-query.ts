/**
 * Reading one Session's history for recall (`agent_recall`): a literal scan of its events and a
 * window around one of them, through the public session-query API (dsh-session-query). Full-text
 * search (`searchEvents`) is not used: the host's provider keeps it disabled (`openAt: never` in
 * dsh-base), and the session-search bundle's own provider is isolated from plugins.
 * @module dsh-agent-scheduler/dsh/host/session-query
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from './session.js'
import { features, hasFunction } from '../compat.js'

/** One matching event: where it is, and a piece of its text around the first term. */
export interface RecallHit {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly snippet: string
}

/** One event and the events around it. */
export interface RecallWindow {
  readonly seq: number
  readonly target: { readonly seq: number; readonly type: string; readonly text: string }
  readonly around: ReadonlyArray<{ readonly seq: number; readonly type: string; readonly text: string }>
}

/** The parts of `ctx.sessionQuery` recall uses. */
export interface HistoryPort {
  /** Whether this DSH offers the reads recall needs. */
  readonly available: boolean
  /** Events of a Session's own log (not inherited from a split) that hold every term. */
  find(sessionId: string, terms: readonly string[], opts: { fromSeq: number; toSeq?: number | undefined; limit: number; signal: AbortSignal }): Promise<{ hits: RecallHit[]; total: number }>
  /** One event in full and `n` events either side, in brief. */
  window(sessionId: string, seq: number, n: number): Promise<RecallWindow>
  /** Index of the first event the Session wrote itself; earlier ones it inherited. */
  ownedFrom(sessionId: string): Promise<number>
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the query service is reached through the untyped context */

const SNIPPET = 150
const BRIEF = 400

/** Text of an event's data, for snippets and windows (the scan itself matches the host's own text). */
function textOf(data: unknown): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { out.push(v); return }
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'id' && k !== 'signature') walk(x)
  }
  walk(data)
  return out.join(' ').replace(/\s+/gu, ' ').trim()
}

/**
 * A piece of text around the first term, in one line.
 * @param text - the whole text.
 * @param term - the term (matched case-insensitively).
 * @returns at most about 2 × {@link SNIPPET} characters.
 */
export function snippetOf(text: string, term: string | undefined): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const at = term === undefined ? -1 : flat.toLowerCase().indexOf(term.toLowerCase())
  if (at < 0) return flat.length > 2 * SNIPPET ? `${flat.slice(0, 2 * SNIPPET)}…` : flat
  const start = Math.max(0, at - SNIPPET)
  const end = Math.min(flat.length, at + term!.length + SNIPPET)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

const brief = (t: string): string => (t.length > BRIEF ? `${t.slice(0, BRIEF)}…` : t)

/**
 * The recall port over `ctx.sessionQuery`. On a DSH without `filterEvents`/`readEvent` it says so
 * (`available: false`) and warns once; the tool then tells the model recall is unavailable.
 * @param ctx - the rule's context.
 * @returns the port.
 */
export function historyPort(ctx: Context): HistoryPort {
  const q = (ctx as any).sessionQuery
  const available = features.record('sessionQuery.filterEvents', hasFunction(ctx, 'sessionQuery.filterEvents') && hasFunction(ctx, 'sessionQuery.readEvent'), 'sessionQuery.filterEvents')
  return {
    available,
    async find(sessionId, terms, opts) {
      const filters: unknown[] = [{ kind: 'seq', from: opts.fromSeq, ...(opts.toSeq === undefined ? {} : { to: opts.toSeq }) }, ...terms.map(text => ({ kind: 'text', text }))]
      // The scan has no signal of its own: race it, so a huge log cannot hold the tool past its budget.
      const scan = q.filterEvents(SessionId(sessionId), filters) as Promise<Array<{ seq: number; type: string; time: number; text: string }>>
      const docs = await new Promise<Array<{ seq: number; type: string; time: number; text: string }>>((resolve, reject) => {
        const abort = () => { reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('recall timed out')) }
        if (opts.signal.aborted) { abort(); return }
        opts.signal.addEventListener('abort', abort, { once: true })
        scan.then(resolve, reject).finally(() => { opts.signal.removeEventListener('abort', abort) })
      })
      const newest = [...docs].sort((a, b) => b.seq - a.seq).slice(0, opts.limit)
      return { total: docs.length, hits: newest.map(d => ({ seq: Number(d.seq), type: String(d.type), time: Number(d.time), snippet: snippetOf(String(d.text ?? ''), terms[0]) })) }
    },
    async window(sessionId, seq, n) {
      const w = await q.readEvent({ sessionId: SessionId(sessionId), seq: seq as never, before: n, after: n })
      const view = (e: { seq: number; type: string; data: unknown }) => ({ seq: Number(e.seq), type: String(e.type), text: textOf(e.data) })
      const target = view(w.target)
      return { seq, target, around: (w.events as Array<{ seq: number; type: string; data: unknown }>).filter(e => Number(e.seq) !== seq).map(e => { const v = view(e); return { ...v, text: brief(v.text) } }) }
    },
    async ownedFrom(sessionId) {
      using observed = await q.observeSession(SessionId(sessionId), { projectionMode: 'none' })
      return Number(observed.inheritedEventCount)
    },
  }
}
