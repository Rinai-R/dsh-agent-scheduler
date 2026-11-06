/**
 * Where a worker created with `from: <worker>` starts: a prefix of that worker's conversation,
 * handed to the `fork-from` subagent provider (src/dsh/host/runtime.ts).
 *
 * The cut rule is the one `dsh-agent-team-member-fork` shipped and validated: the latest
 * `turn/end` at which the source's durable inbox is empty. The `inbox` projection folds every
 * `agent/inbox/spliced` event of the seed, so cutting where a message was queued but not yet
 * claimed would hand the source's pending work to the new worker as its own first turn.
 * @module dsh-agent-scheduler/forks-from
 */
import type { SessionEvent } from './dsh/types.js'
import { inboxSpliceOf, isTurnEnd } from './dsh/host/index.js'

// The provider itself and its seed registry belong to the adapter (src/dsh/host/runtime.ts).
export { FORK_FROM_PROVIDER, forgetForkSeed, installForkFrom, registerForkSeed } from './dsh/host/index.js'

/** Why a source log cannot seed a new worker. */
export class ForkSeedError extends Error {
  override readonly name = 'ForkSeedError'
  /**
   * @param message - what to tell the agent that asked.
   * @param code - stable reason.
   */
  constructor(message: string, readonly code: 'NO_COMPLETED_TURN' | 'PENDING_INBOX' | 'NON_CONTIGUOUS_LOG') {
    super(message)
  }
}

interface InboxFold { 'next-turn': unknown[]; 'next-step': unknown[] }

function applyInbox(fold: InboxFold, event: SessionEvent): void {
  const splice = inboxSpliceOf(event)
  if (splice === undefined) return
  fold[splice.target].splice(splice.start, splice.removed, ...splice.inserted)
}

/**
 * Cut a source log at its latest completed turn whose inbox is empty.
 * @param events - the source's complete log, contiguous from seq 0 (inherited prefix included).
 * @param source - the source's display name, for messages.
 * @returns the seed.
 * @throws {ForkSeedError} when no such turn exists or the log is not contiguous.
 */
export function forkSeed(events: readonly SessionEvent[], source: string): SessionEvent[] {
  const fold: InboxFold = { 'next-turn': [], 'next-step': [] }
  let clean = -1
  let turnEnds = 0
  for (const [index, event] of events.entries()) {
    applyInbox(fold, event)
    if (!isTurnEnd(event)) continue
    turnEnds += 1
    if (fold['next-turn'].length + fold['next-step'].length === 0) clean = index
  }
  if (turnEnds === 0) throw new ForkSeedError(`"${source}" has not completed a round yet; there is nothing to continue from`, 'NO_COMPLETED_TURN')
  if (clean < 0) {
    throw new ForkSeedError(`every completed round of "${source}" leaves a message it has not taken yet, which the new worker would inherit; retry when "${source}" is idle`, 'PENDING_INBOX')
  }
  const seed = events.slice(0, clean + 1)
  for (const [index, event] of seed.entries()) {
    if (event.seq !== index) throw new ForkSeedError(`the log of "${source}" is not contiguous from seq 0 (index ${index} has seq ${event.seq})`, 'NON_CONTIGUOUS_LOG')
  }
  return seed
}
