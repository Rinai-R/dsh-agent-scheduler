/**
 * The scheduling half of the plugin: a top-level row, so it reaches the Agents of every preset
 * (cordis.patch.yml). Each main Session switches it with `/schedule on|off`; a Session that is off
 * behaves as an ordinary chat. If this DSH lacks a service scheduling needs, the row registers
 * only commands that say so (src/dsh/host/services.ts `missingRequired`).
 * @module dsh-agent-scheduler/rule
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from './dsh/types.js'
import {
  claimOnce, eventsOf, installWorkerTeams, teamPort, followHostLocale, hostLog, isUserInput, hostVersion, installGuard, logReader, missingRequired, modelValidator, onAgents, promptSection, registerCommand,
  registerTool, RULE_SERVICES, setWarnSink, titles as titleService, DSH_RANGE,
} from './dsh/host/index.js'
import { appendWorkerModel, workerModelOf, type ForkModelSelection } from './records.js'
import { isMainSession, preStep, Scheduler, textOf } from './scheduler.js'
import { parseModel, schedulerTools, sectionFor } from './tools.js'
import { forkGuard } from './fork-guard.js'
import { teamGuard } from './team-guard.js'
import { list, t } from './i18n/index.js'
import { installMemberModels, restoreMemberModel, type Validate } from './member-model.js'

export const name = 'agent-scheduler-rule'
export const inject = RULE_SERVICES

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
  // Retired: forks always use the lead's model. Still accepted so an existing config loads.
  fork: modelConfig.description('Retired and ignored: forks always use the lead\'s model (and its prompt cache).'),
  worker: modelConfig.description('Default model for workers. Empty uses the runtime default.'),
  workerPreset: z.string().description('Preset for new workers. Empty inherits this session\'s preset.'),
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

/** What `/fork` says now, in DSH's language: forks have no model of their own. */
export const forkModelRetired = (): string => t('cmd.fork.retired')
/** A command run outside the main Session. */
const mainOnly = (command: string): CommandResult => ({ kind: 'error', text: t('cmd.mainOnly', { command }) })

/**
 * Execute `/fork`. Forks always run on the lead's model; the command stays registered only so
 * that typed or replayed `/fork model …` lines get an explanation instead of "unknown command".
 * Nothing is recorded, and an older `/fork model` record in the log has no effect.
 * @param invocation - the parsed command.
 * @returns the command's outcome: success for a bare `/fork` or `/fork model default`, else an error.
 */
export function runForkCommand(invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return mainOnly('fork')
  const raw = invocation.rawInput.trim()
  if (raw === '' || parseForkCommand(raw) === null) return { kind: 'success', text: forkModelRetired() }
  return { kind: 'error', text: forkModelRetired() }
}

/**
 * Execute `/worker`: show or set the model later workers start with when the lead names none.
 * @param invocation - the parsed command.
 * @param validate - checks a selection is routable and its effort is one the model offers.
 * @returns the command's outcome.
 */
export async function runWorkerModelCommand(invocation: CommandInvocation, validate?: Validate): Promise<CommandResult> {
  if (!isMainSession(invocation.agent)) return mainOnly('worker')
  if (invocation.rawInput.trim() === '') {
    const current = workerModelOf(eventsOf(invocation.agent.session))
    return { kind: 'success', text: current === null ? t('cmd.worker.currentDefault') : t('cmd.worker.current', { route: routeOf(current) }) }
  }
  let selection = parseForkCommand(invocation.rawInput)
  if (selection === undefined) return { kind: 'error', text: t('cmd.worker.usage') }
  if (selection !== null && validate !== undefined) {
    try {
      selection = await validate(selection)
    } catch (error) {
      return { kind: 'error', text: `${selection.provider}/${selection.model}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  appendWorkerModel(invocation.agent.session, selection)
  return { kind: 'success', text: selection === null ? t('cmd.worker.setDefault') : t('cmd.worker.set', { route: routeOf(selection) }) }
}

/**
 * Execute `/schedule [on|off]`; no argument turns it on.
 * @param scheduler - the scheduler of this preset.
 * @param invocation - the parsed command.
 * @returns the command's outcome.
 */
export function runScheduleCommand(scheduler: Pick<Scheduler, 'setMode' | 'isOn'>, invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return mainOnly('schedule')
  const arg = invocation.rawInput.trim().toLowerCase()
  if (arg !== '' && arg !== 'on' && arg !== 'off') return { kind: 'error', text: t('cmd.schedule.usage') }
  const on = arg !== 'off'
  scheduler.setMode(invocation.agent, on)
  return { kind: 'success', text: t(on ? 'cmd.schedule.on' : 'cmd.schedule.off') }
}

/** What `/agents` accepts, in DSH's language. */
export const agentsUsage = (): string => t('cmd.agents.usage')

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
  if (name === undefined) return agentsUsage()
  let cwd: string | undefined
  let model: ForkModelSelection | undefined
  while (peek() === '--cwd' || peek() === '--model') {
    const flag = next()!
    const value = next()
    if (value === undefined || value === '') return t('cmd.agents.needsValue', { flag })
    if (flag === '--cwd') cwd = value
    else {
      try { model = parseModel(value) } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
  }
  const role = raw.slice(at).trim()
  if (role === '') return t('cmd.agents.roleMissing')
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
export async function runAgentsCommand(scheduler: Pick<Scheduler, 'archive' | 'archiveConcluded' | 'createWorker' | 'rename' | 'markSeen' | 'arrangeMail'>, invocation: CommandInvocation, validate?: Validate): Promise<CommandResult> {
  if (!isMainSession(invocation.agent)) return mainOnly('agents')
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
      return { kind: 'success', text: t(made.queued ? 'cmd.agents.createdQueued' : 'cmd.agents.created', { name: made.name }) }
    }
    if (verb === 'rename') {
      const [from, to, ...extra] = words(rest)
      if (from === undefined || to === undefined || extra.length > 0) return { kind: 'error', text: t('cmd.agents.renameUsage') }
      const done = await scheduler.rename(invocation.agent, from, to)
      return { kind: 'success', text: done.from === done.to ? t('cmd.agents.sameName', { name: done.to }) : t('cmd.agents.renamed', { from: done.from, to: done.to }) }
    }
    if (verb === 'inbox') {
      const [action, id, before, ...extra] = words(rest)
      const actions = ['pin', 'unpin', 'hold', 'release', 'move', 'now'] as const
      const known = actions.find(a => a === action)
      if (known === undefined || id === undefined || extra.length > 0 || (known !== 'move' && before !== undefined) || (id === 'all' && known !== 'now')) return { kind: 'error', text: t('cmd.agents.inboxUsage') }
      const done = scheduler.arrangeMail(invocation.agent, known, id, before === 'end' ? undefined : before)
      if (known !== 'now') return { kind: 'success', text: t('cmd.agents.inboxDone', { id }) }
      return { kind: 'success', text: done.length === 0 ? t('cmd.agents.inboxNothing') : t('cmd.agents.inboxHanded', { ids: list(done) }) }
    }
    const [target, ...extra] = words(rest)
    if ((verb !== 'archive' && verb !== 'seen') || target === undefined || extra.length > 0) return { kind: 'error', text: agentsUsage() }
    if (verb === 'seen') {
      const marked = scheduler.markSeen(invocation.agent, target)
      if (target === 'all') return { kind: 'success', text: t(marked ? 'cmd.agents.seenAll' : 'cmd.agents.nothingUnread') }
      return { kind: 'success', text: t(marked ? 'cmd.agents.seen' : 'cmd.agents.nothingNew', { name: target }) }
    }
    if (target === 'done') {
      const names = await scheduler.archiveConcluded(invocation.agent)
      return { kind: 'success', text: names.length === 0 ? t('cmd.agents.noneConcluded') : t('cmd.agents.archived', { names: list(names) }) }
    }
    await scheduler.archive(invocation.agent, target)
    return { kind: 'success', text: t('cmd.agents.archived', { names: target }) }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** What every command says when this DSH cannot run scheduling. */
export function incompatible(missing: readonly string[], version = hostVersion()): string {
  const params = { missing: missing.join(', '), range: DSH_RANGE }
  return version === undefined ? t('cmd.incompatible', params) : t('cmd.incompatibleVersion', { ...params, version })
}

/** The plugin's slash commands, as the composer lists them. */
const COMMANDS = ['schedule', 'agents', 'fork', 'worker', 'role', 'agent-model'] as const

/**
 * Install the input rule.
 * @param ctx - the rule row's context (top level: it sees every Agent).
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const log = hostLog(ctx)
  ctx.effect(() => setWarnSink(log), 'agent-scheduler: warnings')
  // A second copy (an old profile patch that still mounts the rule in a preset) stays off.
  if (!claimOnce('agent-scheduler-rule', ctx)) return
  // Command replies follow DSH's language (src/dsh/host/locale.ts); prompts and tools stay English.
  followHostLocale(ctx)
  // Scheduling never runs on a DSH that lacks what it needs: no guard means no forks at all.
  const missing = missingRequired(ctx)
  if (missing.length > 0) {
    const text = incompatible(missing)
    log(text)
    if (typeof ctx.commands?.register === 'function') {
      for (const name of COMMANDS) registerCommand(ctx, { id: `dsh-agent-scheduler/${name}`, name, description: 'Unavailable: this DeepSeek Harness is not supported', run: () => ({ kind: 'error', text: incompatible(missing) }) })
    }
    return
  }
  const names = titleService(ctx, log)
  const scheduler = new Scheduler({
    subagents: ctx.subagents,
    agents: ctx.agents as never,
    readLog: logReader(ctx),
    configuredWorkerModel: config.worker,
    workerPreset: config.workerPreset,
    log,
    // A worker renamed in a split gets a title to match, when it is resident and titles exist.
    team: teamPort(ctx),
    renameSession: (id, title) => {
      const session = ctx.agents.get(id as never)?.session
      if (session !== undefined) names.rename(session, title)
    },
  })
  ctx.effect(() => () => { scheduler.dispose() }, 'agent-scheduler: queue')
  onAgents(ctx, {
    inserted: (agent, message) => {
      // Session titles come from user messages; the input rule removes them, so name the session
      // from the first input. Optional: profiles without the title service keep working.
      const took = scheduler.onInserted(agent, message)
      if (took && isMainSession(agent) && isUserInput(message)) names.name(agent.session, textOf(message.content))
    },
    preStep: (payload, next) => preStep(scheduler, payload, next),
    status: (agent, status) => { scheduler.onStatus(agent, status) },
    created: (agent, resumed) => {
      restoreMemberModel(scheduler, agent)
      // A main Session coming back after a restart settles what the restart cut off (src/recovery.ts).
      // After creation resolves: the runtime only delivers to children of a published parent.
      if (!resumed || !isMainSession(agent)) return
      setTimeout(() => {
        if (ctx.agents.get(agent.id) !== agent || scheduler.ledgerOf(agent).state.members.length === 0) return
        void scheduler.recover(agent).catch((error: unknown) => { log('restart recovery failed', error) })
      }, 0)
    },
    disposed: (agent) => { if (isMainSession(agent)) scheduler.forget(agent.id); else if (scheduler.queued().length > 0) void scheduler.drain() },
  })
  for (const tool of schedulerTools(scheduler, ctx.agents as never)) registerTool(ctx, tool)
  // Forks route only: every working tool is refused at dispatch (src/fork-guard.ts).
  installGuard(ctx, forkGuard(agent => scheduler.forkNameOf(agent)))
  // Agent Teams, when mounted: who may form a team (src/team-guard.ts), and workers as Team Leads.
  installGuard(ctx, teamGuard({ isMain: isMainSession, isOn: agent => scheduler.isOn(agent), forkName: agent => scheduler.forkNameOf(agent), isWorker: agent => scheduler.isWorker(agent) }))
  installWorkerTeams(ctx, agent => scheduler.isWorker(agent))
  teamPort(ctx).watch(id => { scheduler.onTeamRecord(id) })
  promptSection(ctx, 'agent-scheduler', 900, agent => sectionFor(scheduler, agent))
  installMemberModels(ctx, scheduler, ctx.agents as never)
  const validate: Validate = modelValidator(ctx)
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/schedule',
    name: 'schedule',
    description: 'Hand each later message to a fork of this session (on), or stop (off)',
    hint: '[on | off]',
    run: (invocation) => runScheduleCommand(scheduler, invocation),
  })
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/agents',
    name: 'agents',
    description: 'Create or rename a worker, archive a fork or worker, or archive every fork that has concluded; mark one\'s report read; arrange the lead\'s inbox',
    hint: 'new <name> [--cwd <dir>] <role> | rename <name> <new-name> | archive <name> | archive done | seen <name> | seen all | inbox pin|unpin|hold|release|now|move <m-N>',
    run: (invocation) => runAgentsCommand(scheduler, invocation, validate),
  })
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/fork',
    name: 'fork',
    description: 'Forks always use the lead\'s model; says so (a fork model can no longer be set)',
    // No hint: it takes no arguments (registerCommand omits an empty one, see tests/input.spec.ts).
    run: runForkCommand,
  })
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/worker',
    name: 'worker',
    description: 'Show or set the model new workers use when the lead names none',
    hint: 'model <provider>/<model> [effort] | model default',
    run: (invocation) => runWorkerModelCommand(invocation, validate),
  })
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/role',
    name: 'role',
    description: 'Show or set the lead\'s role',
    hint: '[<role text>]',
    run: (invocation) => {
      if (!isMainSession(invocation.agent)) return mainOnly('role')
      const text = invocation.rawInput.trim()
      if (text === '') return { kind: 'success', text: scheduler.roleFor(invocation.agent) ?? t('cmd.role.none') }
      scheduler.setRole(invocation.agent, text)
      return { kind: 'success', text: t('cmd.role.updated') }
    },
  })
}
