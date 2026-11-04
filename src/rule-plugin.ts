/**
 * Preset-scoped half of the plugin. Mounted inside the `scheduler` preset, so its listeners and
 * command only reach agents bound to that preset; ordinary chat sessions never see it.
 * @module dsh-agent-scheduler/rule
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-query'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendForkModel, forkModelOf, type ForkModelSelection } from './records.js'
import { isMainSession, preStep, Scheduler, textOf } from './scheduler.js'
import { schedulerTools, sectionFor } from './tools.js'

export const name = 'agent-scheduler-rule'
export const inject = ['subagents', 'agents', 'commands', 'tools', 'systemPrompt', 'sessionQuery']

/** Plugin configuration. */
export interface Config {
  fork?: ForkModelSelection | undefined
  worker?: ForkModelSelection | undefined
  workerPreset?: string | undefined
}

const modelConfig = z.union([
  z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }),
  z.const(undefined),
])

export const Config: z<Config> = z.object({
  fork: modelConfig.description('Model for forks. Empty uses the lead\'s model and reuses its prompt cache.'),
  worker: modelConfig.description('Default model for workers. Empty uses the runtime default.'),
  workerPreset: z.string().description('Preset for new workers. Empty inherits this session\'s preset.'),
}) as unknown as z<Config>

/**
 * Parse `/fork model <provider>/<model> [effort]` and `/fork model default`.
 * @param raw - text after the command name.
 * @returns the selection, null to clear, or undefined when malformed.
 */
export function parseForkCommand(raw: string): ForkModelSelection | null | undefined {
  const parts = raw.trim().split(/\s+/u)
  if (parts[0] !== 'model' || parts[1] === undefined || parts.length > 3) return undefined
  if (parts[1] === 'default') return parts.length === 2 ? null : undefined
  const slash = parts[1].indexOf('/')
  if (slash <= 0 || slash === parts[1].length - 1) return undefined
  const base = { provider: parts[1].slice(0, slash), model: parts[1].slice(slash + 1) }
  return parts[2] === undefined ? base : { ...base, reasoningEffort: parts[2] }
}

/**
 * Execute `/fork`.
 * @param invocation - the parsed command.
 * @returns the command's outcome.
 */
export function runForkCommand(invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/fork only applies in the main session.' }
  if (invocation.rawInput.trim() === '') {
    const current = forkModelOf(invocation.agent.session.snapshotEvents())
    return { kind: 'success', text: current === null ? 'Forks use the default model.' : `Forks use ${current.provider}/${current.model}.` }
  }
  const selection = parseForkCommand(invocation.rawInput)
  if (selection === undefined) return { kind: 'error', text: 'Usage: /fork model <provider>/<model> [effort] | /fork model default' }
  appendForkModel(invocation.agent.session, selection)
  return { kind: 'success', text: selection === null ? 'Later forks use the default model.' : `Later forks use ${selection.provider}/${selection.model}.` }
}

/**
 * Install the input rule.
 * @param ctx - preset-scoped context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const scheduler = new Scheduler({
    subagents: ctx.subagents,
    agents: ctx.agents,
    readLog: async (id) => {
      using observed = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
      return { events: [...observed.events], inherited: Number(observed.inheritedEventCount) }
    },
    configuredModel: config.fork,
    configuredWorkerModel: config.worker,
    workerPreset: config.workerPreset,
    log: (message, error) => { ctx.logger('agent-scheduler').warn(message, error) },
  })
  ctx.effect(() => () => { scheduler.dispose() }, 'agent-scheduler: queue')
  // Session titles come from user messages; the input rule removes them, so name the session
  // from the first input. Optional: profiles without the title service keep working.
  let titles: { get(session: Session): unknown; rename(session: Session, title: string): unknown } | undefined
  ctx.inject(['sessionTitle'], (scoped) => {
    titles = scoped.sessionTitle
    scoped.effect(() => () => { titles = undefined }, 'agent-scheduler: titles')
  })
  const nameSession = (session: Session, text: string): void => {
    if (titles === undefined || titles.get(session) !== undefined) return
    const short = text.trim().replace(/\s+/gu, ' ').slice(0, 40)
    if (short === '') return
    try { titles.rename(session, short) } catch (error) { ctx.logger('agent-scheduler').warn('naming the session failed', error) }
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const took = scheduler.onInserted(agent, message)
    if (took && isMainSession(agent) && message.source.kind === 'user') nameSession(agent.session, textOf(message.content))
  })
  ctx.on('agent/pre-step', (payload, next) => preStep(scheduler, payload, next))
  ctx.on('agent/status', ({ agent, status }) => { scheduler.onStatus(agent, status) })
  ctx.on('agent/disposed', ({ agent }) => { if (isMainSession(agent)) scheduler.forget(agent.id); else if (scheduler.queued().length > 0) void scheduler.drain() })
  for (const tool of schedulerTools(scheduler, ctx.agents as never)) ctx.effect(() => ctx.tools.register(tool), `agent-scheduler: ${tool.name}`)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agent-scheduler',
    order: 900,
    text: (context) => context.agent === undefined ? '' : sectionFor(scheduler, context.agent),
  }), 'agent-scheduler: section')
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/fork'),
    name: 'fork',
    description: 'Show or set the model used by this session\'s forks',
    input: { hint: 'model <provider>/<model> [effort] | model default' },
    handler: runForkCommand,
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/role'),
    name: 'role',
    description: 'Show or set the lead\'s role',
    input: { hint: '[<role text>]' },
    handler: (invocation) => {
      if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/role only applies in the main session.' }
      const text = invocation.rawInput.trim()
      if (text === '') return { kind: 'success', text: scheduler.roleFor(invocation.agent) ?? 'No role set.' }
      scheduler.setRole(invocation.agent, text)
      return { kind: 'success', text: 'Role updated; it applies from the next step and to later forks.' }
    },
  })
}
