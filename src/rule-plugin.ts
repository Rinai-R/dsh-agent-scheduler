/**
 * Preset-scoped half of the plugin. Mounted in the standard preset; each main Session switches it
 * with `/schedule on|off`, and a Session that is off behaves as an ordinary chat.
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
import { appendWorkerModel, workerModelOf, type ForkModelSelection } from './records.js'
import { isMainSession, preStep, Scheduler, textOf } from './scheduler.js'
import { parseModel, schedulerTools, sectionFor } from './tools.js'
import { forkGuard } from './fork-guard.js'
import { installMemberModels, type Validate } from './member-model.js'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'agent-scheduler-rule'
export const inject = ['subagents', 'agents', 'commands', 'tools', 'systemPrompt', 'sessionQuery', 'llm']

/** Plugin configuration. */
export interface Config {
  fork?: ForkModelSelection | undefined
  worker?: ForkModelSelection | undefined
  workerPreset?: string | undefined
  /** Sessions with no recorded switch schedule; only for the retired `scheduler` preset. */
  defaultOn?: boolean | undefined
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
  // Retired: forks always use the lead's model. Still accepted so an existing config loads.
  fork: modelConfig.description('Retired and ignored: forks always use the lead\'s model (and its prompt cache).'),
  worker: modelConfig.description('Default model for workers. Empty uses the runtime default.'),
  workerPreset: z.string().description('Preset for new workers. Empty inherits this session\'s preset.'),
  defaultOn: z.boolean().description('Schedule in sessions that never used /schedule. Only the retired scheduler preset sets it.'),
}) as unknown as z<Config>

/**
 * Parse `model <provider>/<model> [effort]` and `model default` (the `/worker` argument; `/fork`
 * parses it only to explain that forks have no model of their own).
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

const routeOf = (s: ForkModelSelection): string => `${s.provider}/${s.model}${s.reasoningEffort === undefined ? '' : ` (${s.reasoningEffort})`}`

/** What `/fork` says now: forks have no model of their own. */
export const FORK_MODEL_RETIRED = 'Forks always use the lead\'s model, so they reuse its prompt cache; a fork model can no longer be set. To give one task another model, ask the lead for a worker (see /worker model).'

/**
 * Execute `/fork`. Forks always run on the lead's model; the command stays registered only so
 * that typed or replayed `/fork model …` lines get an explanation instead of "unknown command".
 * Nothing is recorded, and an older `/fork model` record in the log has no effect.
 * @param invocation - the parsed command.
 * @returns the command's outcome: success for a bare `/fork` or `/fork model default`, else an error.
 */
export function runForkCommand(invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/fork only applies in the main session.' }
  const raw = invocation.rawInput.trim()
  if (raw === '' || parseForkCommand(raw) === null) return { kind: 'success', text: FORK_MODEL_RETIRED }
  return { kind: 'error', text: FORK_MODEL_RETIRED }
}

/**
 * Execute `/worker`: show or set the model later workers start with when the lead names none.
 * @param invocation - the parsed command.
 * @param validate - checks a selection is routable and its effort is one the model offers.
 * @returns the command's outcome.
 */
export async function runWorkerModelCommand(invocation: CommandInvocation, validate?: Validate): Promise<CommandResult> {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/worker only applies in the main session.' }
  if (invocation.rawInput.trim() === '') {
    const current = workerModelOf(invocation.agent.session.snapshotEvents())
    return { kind: 'success', text: current === null ? 'Workers use the default model.' : `Workers use ${routeOf(current)}.` }
  }
  let selection = parseForkCommand(invocation.rawInput)
  if (selection === undefined) return { kind: 'error', text: 'Usage: /worker model <provider>/<model> [effort] | /worker model default' }
  if (selection !== null && validate !== undefined) {
    try {
      selection = await validate(selection)
    } catch (error) {
      return { kind: 'error', text: `${selection.provider}/${selection.model}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  appendWorkerModel(invocation.agent.session, selection)
  return { kind: 'success', text: selection === null ? 'Later workers use the default model.' : `Later workers use ${routeOf(selection)}.` }
}

/**
 * Execute `/schedule [on|off]`; no argument turns it on.
 * @param scheduler - the scheduler of this preset.
 * @param invocation - the parsed command.
 * @returns the command's outcome.
 */
export function runScheduleCommand(scheduler: Pick<Scheduler, 'setMode' | 'isOn'>, invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/schedule only applies in the main session.' }
  const arg = invocation.rawInput.trim().toLowerCase()
  if (arg !== '' && arg !== 'on' && arg !== 'off') return { kind: 'error', text: 'Usage: /schedule [on | off]' }
  const on = arg !== 'off'
  scheduler.setMode(invocation.agent, on)
  return { kind: 'success', text: on ? 'Scheduling is on: each later message goes to a fork.' : 'Scheduling is off. Existing forks and workers keep running.' }
}

/** What `/agents` accepts. */
export const AGENTS_USAGE = 'Usage: /agents new <name> [--cwd <dir>] [--model <provider>/<model>[:effort]] <role> | /agents rename <name> <new-name> | /agents archive <name> | /agents archive done | /agents seen <name> | /agents seen all'

/**
 * Split a command line into words; a double-quoted word may hold spaces.
 * @param raw - text after the command name.
 * @returns the words.
 */
export function words(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/gu
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) out.push(m[1] ?? m[2]!)
  return out
}

/**
 * Parse `/agents new …`: the name, then options, then the role (the rest of the line).
 * @param raw - text after `new`.
 * @returns the worker to create, or an error message.
 */
export function parseNewWorker(raw: string): { name: string; role: string; cwd?: string; model?: ForkModelSelection } | string {
  // Words are read one at a time so the role is the rest of the line exactly as typed.
  const re = /\s*(?:"([^"]*)"|(\S+))/uy
  let at = 0
  const next = (): string | undefined => {
    re.lastIndex = at
    const m = re.exec(raw)
    if (m === null) return undefined
    at = re.lastIndex
    return m[1] ?? m[2]!
  }
  const peek = (): string | undefined => { const keep = at; const word = next(); at = keep; return word }
  const name = next()
  if (name === undefined) return AGENTS_USAGE
  let cwd: string | undefined
  let model: ForkModelSelection | undefined
  while (peek() === '--cwd' || peek() === '--model') {
    const flag = next()!
    const value = next()
    if (value === undefined || value === '') return `${flag} needs a value`
    if (flag === '--cwd') cwd = value
    else {
      try { model = parseModel(value) } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
  }
  const role = raw.slice(at).trim()
  if (role === '') return 'Say what the worker is for: /agents new <name> <role>'
  return { name, role, ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }) }
}

/**
 * Execute `/agents`: create or rename a worker the user names, archive a fork or worker, archive
 * every fork that has concluded, or mark a member's report read (`seen`, sent by the Agents page
 * when the user opens a member). A worker the user creates gets no task; the user talks
 * to it in its own chat, or the lead sends it requests like any other worker.
 * @param scheduler - the scheduler of this preset.
 * @param invocation - the parsed command.
 * @param validate - checks a `--model` selection is routable.
 * @returns the command's outcome.
 */
export async function runAgentsCommand(scheduler: Pick<Scheduler, 'archive' | 'archiveConcluded' | 'createWorker' | 'rename' | 'markSeen'>, invocation: CommandInvocation, validate?: Validate): Promise<CommandResult> {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: '/agents only applies in the main session.' }
  const raw = invocation.rawInput.trim()
  const verb = raw.split(/\s+/u)[0] ?? ''
  const rest = raw.slice(verb.length).trim()
  try {
    if (verb === 'new') {
      const parsed = parseNewWorker(rest)
      if (typeof parsed === 'string') return { kind: 'error', text: parsed }
      let model = parsed.model
      if (model !== undefined && validate !== undefined) model = await validate(model)
      const made = await scheduler.createWorker(invocation.agent, { ...parsed, ...(model === undefined ? {} : { model }) })
      return { kind: 'success', text: made.queued ? `Created worker ${made.name}; it starts when a slot frees.` : `Created worker ${made.name}.` }
    }
    if (verb === 'rename') {
      const [from, to, ...extra] = words(rest)
      if (from === undefined || to === undefined || extra.length > 0) return { kind: 'error', text: 'Usage: /agents rename <name> <new-name>' }
      const done = await scheduler.rename(invocation.agent, from, to)
      return { kind: 'success', text: done.from === done.to ? `${done.to} already has that name.` : `Renamed ${done.from} to ${done.to}.` }
    }
    const [target, ...extra] = words(rest)
    if ((verb !== 'archive' && verb !== 'seen') || target === undefined || extra.length > 0) return { kind: 'error', text: AGENTS_USAGE }
    if (verb === 'seen') {
      const marked = scheduler.markSeen(invocation.agent, target)
      if (target === 'all') return { kind: 'success', text: marked ? 'Marked every report as read.' : 'Nothing unread.' }
      return { kind: 'success', text: marked ? `Marked ${target} as read.` : `Nothing new from ${target}.` }
    }
    if (target === 'done') {
      const names = await scheduler.archiveConcluded(invocation.agent)
      return { kind: 'success', text: names.length === 0 ? 'No concluded fork to archive.' : `Archived ${names.join(', ')}.` }
    }
    await scheduler.archive(invocation.agent, target)
    return { kind: 'success', text: `Archived ${target}.` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
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
    configuredWorkerModel: config.worker,
    workerPreset: config.workerPreset,
    defaultOn: config.defaultOn,
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
  // A main Session coming back after a restart settles what the restart cut off (src/recovery.ts).
  // After creation resolves: the runtime only delivers to children of a published parent.
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'resume' || !isMainSession(agent)) return undefined
    setTimeout(() => {
      if (ctx.agents.get(agent.id) !== agent || scheduler.ledgerOf(agent).state.members.length === 0) return
      void scheduler.recover(agent).catch((error: unknown) => { ctx.logger('agent-scheduler').warn('restart recovery failed', error) })
    }, 0)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { if (isMainSession(agent)) scheduler.forget(agent.id); else if (scheduler.queued().length > 0) void scheduler.drain() })
  for (const tool of schedulerTools(scheduler, ctx.agents as never)) ctx.effect(() => ctx.tools.register(tool), `agent-scheduler: ${tool.name}`)
  // Forks route only: every working tool is refused at dispatch (src/fork-guard.ts).
  ctx.effect(() => ctx.tools.guard(forkGuard(agent => scheduler.forkNameOf(agent))), 'agent-scheduler: fork guard')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agent-scheduler',
    order: 900,
    text: (context) => context.agent === undefined ? '' : sectionFor(scheduler, context.agent),
  }), 'agent-scheduler: section')
  installMemberModels(ctx, scheduler)
  // Same check as the runtime's own selector: the route must resolve and the effort must be one
  // the model advertises (an unknown effort is refused here rather than at the first call).
  const validate: Validate = async (selection) => {
    const resolved = await ctx.llm.resolveCallConfig({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) })
    return { provider: resolved.provider, model: resolved.model, ...(selection.reasoningEffort === undefined || resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }) }
  }
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/schedule'),
    name: 'schedule',
    description: 'Hand each later message to a fork of this session (on), or stop (off)',
    input: { hint: '[on | off]' },
    handler: (invocation) => runScheduleCommand(scheduler, invocation),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/agents'),
    name: 'agents',
    description: 'Create or rename a worker, archive a fork or worker, or archive every fork that has concluded; mark one\'s report read',
    input: { hint: 'new <name> [--cwd <dir>] <role> | rename <name> <new-name> | archive <name> | archive done | seen <name> | seen all' },
    handler: (invocation) => runAgentsCommand(scheduler, invocation, validate),
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/fork'),
    name: 'fork',
    description: 'Forks always use the lead\'s model; says so (a fork model can no longer be set)',
    // No `input`: it takes no arguments, and the runtime rejects an empty hint (the whole preset
    // then fails to load, see tests/input.spec.ts).
    handler: runForkCommand,
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/worker'),
    name: 'worker',
    description: 'Show or set the model new workers use when the lead names none',
    input: { hint: 'model <provider>/<model> [effort] | model default' },
    handler: (invocation) => runWorkerModelCommand(invocation, validate),
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
