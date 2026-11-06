/**
 * Starting, messaging, stopping and releasing children through the runtime's subagent service
 * (dsh-subagent), and the `fork-from` provider that seeds a worker with another worker's
 * conversation. The scheduler talks to children only through {@link subagentPort}.
 * @module dsh-agent-scheduler/dsh/host/runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, ContentBlock, ContinuableCreateRequest, ContinuableCreateSpec, SessionEvent, SubagentProvider, SubagentRuntime } from '../types.js'
import { warnOnce } from '../compat.js'
import { SessionId } from './session.js'

/** The part of the runtime's subagent service the scheduler needs; tests pass the real one. */
export type SubagentService = Pick<SubagentRuntime, 'startActivation' | 'sendMessage' | 'interrupt' | 'drainChildren'>

/** A model for a new worker. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * @param choice - a provider/model pair.
 * @returns agent options carrying it.
 */
export function agentOptionsOf(choice: ModelChoice): AgentOptions {
  const { provider, model, reasoningEffort } = choice
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as NonNullable<AgentOptions['reasoningEffort']> }) }
}

/** What the scheduler does with children. Every child is a direct child of the main Session. */
export interface SubagentPort {
  /** Start a fork of the lead holding its conversation, given the user's message. */
  startFork(main: Agent, start: { childId: string; label: string; prompt: readonly ContentBlock[] }): Promise<void>
  /**
   * Start a worker: fresh (`spawn`), or continuing a seed log (`fork-from`, then no preset).
   * @returns the id of its first message, which the round that answers it claims.
   */
  startWorker(main: Agent, start: {
    childId: string; label: string; text: string; seed?: readonly SessionEvent[] | undefined
    cwd?: string | undefined; preset?: string | undefined; model?: ModelChoice | undefined
  }): Promise<{ messageId: string }>
  /** @returns the inbox id of the delivered message. */
  send(main: Agent, to: string, text: string): Promise<string>
  /** Stop a child's current round on the main Session's authority. */
  interrupt(main: Agent, child: string): void
  /** Release children: they stop, and settle, before this resolves. */
  drain(main: Agent, children: readonly string[]): Promise<void>
}

const never = (): AbortSignal => new AbortController().signal

/**
 * @param service - `ctx.subagents`.
 * @returns the port.
 */
export function subagentPort(service: SubagentService): SubagentPort {
  return {
    async startFork(main, { childId, label, prompt }) {
      await service.startActivation({
        provider: 'fork', label, childId: SessionId(childId), signal: never(), delivery: 'parent',
        request: { parent: main, prompt: [...prompt] },
      })
    },
    async startWorker(main, { childId, label, text, seed, cwd, preset, model }) {
      if (seed !== undefined) registerForkSeed(childId, seed)
      try {
        const started = await service.startActivation({
          provider: seed === undefined ? 'spawn' : FORK_FROM_PROVIDER, label, childId: SessionId(childId), signal: never(), delivery: 'parent',
          request: {
            parent: main, prompt: [{ type: 'text', text }],
            ...(cwd === undefined ? {} : { cwd }),
            ...(preset === undefined ? {} : { agentPreset: preset }),
            ...(model === undefined ? {} : { agentOptions: agentOptionsOf(model) }),
          },
        })
        if (started.messageId === undefined) warnOnce('subagents.messageId', 'startActivation returned no messageId: a worker\'s first request cannot be matched to the round that answers it')
        return { messageId: started.messageId as string }
      } finally {
        forgetForkSeed(childId)
      }
    },
    async send(main, to, text) {
      return service.sendMessage(main, SessionId(to), [{ type: 'text', text }], { signal: never() })
    },
    interrupt(main, child) {
      service.interrupt(SessionId(child), { kind: 'ancestor', agent: main })
    },
    async drain(main, children) {
      await service.drainChildren(main, children.map(id => SessionId(id)))
    },
  }
}

// ------------------------------------------------------------------ fork-from provider

/** Provider name used by `agent_create({ from })`. */
export const FORK_FROM_PROVIDER = 'fork-from'

/** Seeds waiting for the manager to prepare a child; keyed by the reserved child id. */
const seeds = new Map<string, readonly SessionEvent[]>()

/**
 * Register the conversation a new child starts from, just before starting it. The manager
 * reserves the child id before preparation, so preparation finds the seed by that id.
 * @param childId - the reserved durable child id.
 * @param seed - the log prefix it continues.
 */
export function registerForkSeed(childId: string, seed: readonly SessionEvent[]): void { seeds.set(childId, seed) }

/**
 * Drop a seed after its start attempt, whatever the outcome; a retry registers it again.
 * Cold resume never consults a provider, so a seed is only kept until its child starts.
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
