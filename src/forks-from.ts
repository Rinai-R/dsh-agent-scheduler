/**
 * The `fork-from` subagent provider: a worker created with `from: <worker>` starts from the
 * other worker's completed-turn prefix instead of from the lead. The manager reserves the child
 * id before preparation, so the scheduler registers the seed for that id first; preparation then
 * returns it. Cold resume needs no provider, so the seed is dropped once the child starts.
 * @module dsh-agent-scheduler/forks-from
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContinuableCreateRequest, ContinuableCreateSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'

/** Provider name used by `agent_create({ from })`. */
export const FORK_FROM_PROVIDER = 'fork-from'

/** Seeds waiting for the manager to prepare a child; keyed by the reserved child id. */
const seeds = new Map<string, readonly SessionEvent[]>()

/**
 * Register the conversation a new child starts from.
 * @param childId - the reserved durable child id.
 * @param seed - the source worker's completed-turn prefix.
 */
export function registerForkSeed(childId: string, seed: readonly SessionEvent[]): void { seeds.set(childId, seed) }

/**
 * Drop a seed once its child started (or failed to start).
 * @param childId - the reserved durable child id.
 */
export function forgetForkSeed(childId: string): void { seeds.delete(childId) }

/**
 * The balanced completed-turn prefix of a session log: everything up to and including the last
 * `turn/end`. An unfinished inherited turn cannot be replayed as a valid child session.
 * @param events - the source Session's events.
 * @returns the seed, or an empty list before the source completed any turn.
 */
export function completedPrefix(events: readonly SessionEvent[]): readonly SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'turn/end') return events.slice(0, i + 1)
  }
  return []
}

/** Seeding provider; inherits the parent's preset composition, so no preset can be selected. */
class ForkFromProvider implements SubagentProvider {
  readonly name = FORK_FROM_PROVIDER
  readonly capabilities = { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }
  readonly inheritsParentContext = true

  /**
   * @param request - the reserved child id and its parent.
   * @returns the registered seed, if any.
   */
  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    const seed = seeds.get(String(request.sessionId))
    return Promise.resolve(seed === undefined ? {} : { seed })
  }
}

/**
 * Register the provider on the host composition.
 * @param ctx - host context with the subagent service.
 */
export function installForkFrom(ctx: Context): void {
  ctx.subagents.registerProvider(new ForkFromProvider())
}
