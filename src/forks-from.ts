/**
 * The `fork-from` subagent provider: a worker created with `from: <worker>` starts from that
 * worker's conversation instead of from the lead. The manager reserves the child id before
 * preparation, so the scheduler registers the seed for that id first and preparation returns it.
 * Cold resume never consults a provider, so a seed is only kept until its child starts.
 *
 * The cut rule is the one `dsh-agent-team-member-fork` shipped and validated: the latest
 * `turn/end` at which the source's durable inbox is empty. The `inbox` projection folds every
 * `agent/inbox/spliced` event of the seed, so cutting where a message was queued but not yet
 * claimed would hand the source's pending work to the new worker as its own first turn.
 * @module dsh-agent-scheduler/forks-from
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContinuableCreateRequest, ContinuableCreateSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'

/** Provider name used by `agent_create({ from })`. */
export const FORK_FROM_PROVIDER = 'fork-from'

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
  if (event.type !== 'agent/inbox/spliced') return
  const { target, start, removedCount, inserted } = event.data
  fold[target].splice(start, removedCount ?? 0, ...inserted)
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
    if (event.type !== 'turn/end') continue
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

/** Seeds waiting for the manager to prepare a child; keyed by the reserved child id. */
const seeds = new Map<string, readonly SessionEvent[]>()

/**
 * Register the conversation a new child starts from, just before starting it.
 * @param childId - the reserved durable child id.
 * @param seed - from {@link forkSeed}.
 */
export function registerForkSeed(childId: string, seed: readonly SessionEvent[]): void { seeds.set(childId, seed) }

/**
 * Drop a seed after its start attempt, whatever the outcome; a retry registers it again.
 * @param childId - the reserved durable child id.
 */
export function forgetForkSeed(childId: string): void { seeds.delete(childId) }

/** Seeding provider. It inherits the parent's preset composition, so no preset can be chosen. */
class ForkFromProvider implements SubagentProvider {
  readonly name = FORK_FROM_PROVIDER
  readonly capabilities = { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }
  readonly inheritsParentContext = true

  /**
   * @param request - the reserved child id and its parent.
   * @returns the registered seed.
   * @throws when no seed was registered: starting an unrelated fresh child here would be silent.
   */
  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    const seed = seeds.get(String(request.sessionId))
    if (seed === undefined) return Promise.reject(new Error(`fork-from: no seed registered for ${String(request.sessionId)}`))
    return Promise.resolve({ seed })
  }
}

/**
 * Register the provider on the host composition, once per process.
 * @param ctx - host context with the subagent service.
 */
export function installForkFrom(ctx: Context): void {
  ctx.effect(() => ctx.subagents.registerProvider(new ForkFromProvider()), 'agent-scheduler: fork-from provider')
}
