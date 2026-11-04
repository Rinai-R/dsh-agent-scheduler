/**
 * What becomes of delegated work a DSH restart cut off. Everything here is read from logs, never
 * from what an agent says about itself:
 * - the main Session's plugin records say which requests are still open (`sent`) and to whom;
 * - each child's own log says whether the round that claimed a request ended, and how. A crash
 *   leaves an open turn that resume and cold reads close as `interrupted`; a shutdown cancels the
 *   child (`aborted`). A round that is still unsettled when the main Session comes back was cut
 *   by the restart: one cut while the main Session was live has already been settled.
 *
 * The policy is the host row's configuration (`dsh-agent-scheduler`), so it can be edited on the
 * plugin's page; the preset's rule row is nested in the standard preset, which the settings forms
 * cannot address.
 * @module dsh-agent-scheduler/recovery
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { cutByRestart, type Round } from './rounds.js'

/** How a request cut off by a restart is handled. */
export type OnInterrupted = 'fail' | 'resume'

/** Recovery policy. */
export interface RecoveryPolicy {
  /** `fail` (default): fail it and tell the lead. `resume`: continue it in the worker's own session. */
  readonly onInterrupted: OnInterrupted
  /** Resumes allowed per request before it fails as with `fail`. */
  readonly maxResumes: number
}

export const DEFAULT_RECOVERY: RecoveryPolicy = { onInterrupted: 'fail', maxResumes: 2 }

let current: () => RecoveryPolicy = () => DEFAULT_RECOVERY

/**
 * Install where the policy is read from; the host row does this while it is active.
 * @param read - reads the current policy.
 * @returns restores the default.
 */
export function setRecoveryPolicy(read: () => RecoveryPolicy): () => void {
  current = read
  return () => { if (current === read) current = () => DEFAULT_RECOVERY }
}

/** @returns the current policy, sanitized. */
export function recoveryPolicy(): RecoveryPolicy {
  const p = current()
  const max = Number.isSafeInteger(p.maxResumes) && p.maxResumes >= 0 ? p.maxResumes : DEFAULT_RECOVERY.maxResumes
  return { onInterrupted: p.onInterrupted === 'resume' ? 'resume' : 'fail', maxResumes: max }
}

/** The first line of a resume note; its attempt number makes each note findable in the log. */
export const resumeMarker = (request: string, attempt: number): string => `[request ${request} resumed after a DSH restart, attempt ${attempt}]`
const RESUME_LINE = /^\[request (r-\d+) resumed after a DSH restart, attempt (\d+)\]/u

/**
 * The note that continues a request in the worker's own session.
 * @param request - request id.
 * @param attempt - 1-based resume count.
 * @param max - the limit.
 * @returns the message text.
 */
export function resumeText(request: string, attempt: number, max: number): string {
  return [
    resumeMarker(request, attempt),
    `Your previous round working on request ${request} was cut off by a DSH restart (resume ${attempt} of at most ${max}).`,
    'Before continuing, check the current state: the worktree, `git status` and `git log`, files you were writing, and jobs you had started. Do not repeat anything you already did outside this session (commits, pushes, messages, deployments, remote changes); verify it instead.',
    `Then finish request ${request} and answer it as usual; this round's answer is the answer to ${request}.`,
  ].join('\n')
}

/** What the lead reads for a request a restart cut off. */
export const RESTART_DETAIL = 'interrupted by a DSH restart, not completed; resend it if it still matters'

/** What one child's log says about the deliveries the main Session recorded. */
export interface ChildTrace {
  /** Ids of messages still pending in its inbox. */
  readonly pending: ReadonlySet<string>
  /** Ids of messages its log took in (`user/message`). */
  readonly taken: ReadonlySet<string>
  /** Message ids by request id, found by the `[request r-N from …]` first line. */
  readonly requestMessages: ReadonlyMap<string, string>
  /** Resume notes by request id: attempt → message id. */
  readonly resumes: ReadonlyMap<string, ReadonlyMap<number, string>>
}

/** The first line of a delivered message, past the runtime's `Agent <id> sent a message: ` block. */
const firstLine = (content: unknown): string => {
  const blocks = Array.isArray(content) ? content as { type?: string; text?: string }[] : []
  const text = blocks.flatMap(b => b.type === 'text' && b.text !== undefined ? [b.text] : []).join('')
  return (text.replace(/^Agent \S+ sent a message: /u, '').split('\n', 1)[0]) ?? ''
}

/**
 * Index a child's log: what it took in, what still waits in its inbox, and which messages carry
 * which request or resume note.
 * @param events - the child's log.
 * @returns the trace.
 */
export function traceChild(events: readonly SessionEvent[]): ChildTrace {
  const inbox = { 'next-turn': [] as { id: string; content: unknown }[], 'next-step': [] as { id: string; content: unknown }[] }
  const taken = new Set<string>()
  const seen: { id: string; content: unknown }[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      taken.add(event.data.id)
      seen.push({ id: event.data.id, content: event.data.content })
    } else if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount, inserted } = event.data
      inbox[target].splice(start, removedCount ?? 0, ...inserted.map(m => ({ id: m.id, content: m.content })))
      seen.push(...inserted.map(m => ({ id: m.id, content: m.content })))
    }
  }
  const pendingList = [...inbox['next-turn'], ...inbox['next-step']]
  const requestMessages = new Map<string, string>()
  const resumes = new Map<string, Map<number, string>>()
  for (const message of seen) {
    const line = firstLine(message.content)
    const request = /^\[request (r-\d+) from /u.exec(line)
    if (request !== null && !requestMessages.has(request[1]!)) requestMessages.set(request[1]!, message.id)
    const resume = RESUME_LINE.exec(line)
    if (resume !== null) {
      const byAttempt = resumes.get(resume[1]!) ?? new Map<number, string>()
      if (!byAttempt.has(Number(resume[2]))) byAttempt.set(Number(resume[2]), message.id)
      resumes.set(resume[1]!, byAttempt)
    }
  }
  return { pending: new Set(pendingList.map(m => m.id)), taken, requestMessages, resumes }
}

/** Where an open request stands after a restart. */
export type RequestFate =
  /** A completed round claimed it: ordinary settlement answers it. */
  | { readonly kind: 'answered' }
  /** The round that claimed it ended without answering; `byRestart` when the restart cut it. */
  | { readonly kind: 'cut'; readonly messageId: string; readonly byRestart: boolean }
  /** Delivered, still waiting in the child's inbox: the child was never woken again. */
  | { readonly kind: 'pending'; readonly messageId: string; readonly byRestart: true }
  /** Never reached the child (it waited for a slot, or the record of its delivery was lost). */
  | { readonly kind: 'lost' }

/**
 * Classify one open request against the child's unsettled rounds and its log.
 * @param request - the request's id and recorded message id.
 * @param rounds - the child's rounds completed since its last settlement.
 * @param trace - the child's log index.
 * @returns where it stands.
 */
export function fateOf(request: { id: string; messageId?: string | undefined }, rounds: readonly Round[], trace: ChildTrace): RequestFate {
  // The latest resume note stands for the request once one was delivered.
  const notes = trace.resumes.get(request.id)
  const latestNote = notes === undefined ? undefined : notes.get(Math.max(...notes.keys()))
  const ids = [request.messageId, latestNote, trace.requestMessages.get(request.id)].filter((id): id is string => id !== undefined)
  for (const id of ids) {
    const round = rounds.find(r => r.claimed.has(id))
    if (round !== undefined) return round.stopped === undefined ? { kind: 'answered' } : { kind: 'cut', messageId: id, byRestart: cutByRestart(round) }
  }
  for (const id of ids) if (trace.pending.has(id)) return { kind: 'pending', messageId: id, byRestart: true }
  // Taken in a round still open in a log nobody closed, or in an earlier settled round that did
  // not answer it: nothing will answer it now.
  for (const id of ids) if (trace.taken.has(id)) return { kind: 'cut', messageId: id, byRestart: true }
  return { kind: 'lost' }
}
