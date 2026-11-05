/**
 * Installing the plugin into a host composition: the services it injects, the hooks it listens
 * to, and every registration (tools, the fork guard, the system-prompt section, commands, the
 * roster projection). Each helper probes its service first; {@link missingRequired} says whether
 * this DSH can run scheduling at all.
 * @module dsh-agent-scheduler/dsh/host/services
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, CommandInvocation, CommandResult, PreStepDecision, Session, SessionEvent, SessionHeader, SessionLogOffset, ToolDefinition, UserMessage } from '../types.js'
import { features, hasFunction, warnOnce, type Feature } from '../compat.js'
import type { ModelChoice } from './runtime.js'
import { SessionId, type SessionLog } from './session.js'

export { defineTool }

/** Services the host row injects. */
export const HOST_SERVICES = ['subagents', 'sessionProjections']
/** Services the rule row injects. `sessionTitle` is optional and injected on its own. */
export const RULE_SERVICES = ['subagents', 'agents', 'commands', 'tools', 'systemPrompt', 'sessionQuery', 'llm']

/** What scheduling cannot run without, and the probe for each. */
const REQUIRED: ReadonlyArray<readonly [Feature, string[]]> = [
  ['subagents', ['subagents.startActivation', 'subagents.sendMessage', 'subagents.interrupt', 'subagents.drainChildren']],
  ['agents', ['agents.get']],
  ['tools', ['tools.register']],
  // Without the guard a fork could run any tool: no guard, no forks.
  ['tools.guard', ['tools.guard']],
  ['systemPrompt', ['systemPrompt.section']],
  ['commands', ['commands.register']],
  ['sessionQuery', ['sessionQuery.observeSession']],
]

/**
 * Probe every service scheduling needs.
 * @param ctx - the rule's context.
 * @returns the missing features; empty when this DSH can schedule.
 */
export function missingRequired(ctx: Context): Feature[] {
  const missing: Feature[] = []
  for (const [feature, paths] of REQUIRED) {
    const absent = paths.filter(path => !hasFunction(ctx, path))
    if (!features.record(feature, absent.length === 0, absent.join(', '))) missing.push(feature)
  }
  return missing
}

/**
 * Claim a process-wide slot, so a second copy of a row (an old profile patch that still mounts
 * the rule inside a preset, say) does nothing instead of handling every message twice.
 * @param key - the slot.
 * @param ctx - the claiming row; the slot is freed when it is disposed.
 * @returns whether this row got it.
 */
export function claimOnce(key: string, ctx: Context): boolean {
  const slots = ((globalThis as { [k: symbol]: Set<string> | undefined })[SLOTS] ??= new Set<string>())
  if (slots.has(key)) {
    warnOnce(`twice:${key}`, `${key} is mounted twice (an old profile patch that overrides a preset with this plugin's rule?); the second copy is off`)
    return false
  }
  slots.add(key)
  ctx.effect(() => () => { slots.delete(key) }, `agent-scheduler: ${key} slot`)
  return true
}
const SLOTS = Symbol.for('dsh-agent-scheduler/slots')

/** What the rule does at each point of an Agent's life. */
export interface AgentHooks {
  inserted(agent: Agent, message: UserMessage): void
  preStep(payload: { readonly agent: Agent; readonly messages: UserMessage[]; readonly step: number }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  status(agent: Agent, status: 'idle' | 'running'): void
  /** `resumed` is true when the Agent came back from its log (after a restart or release). */
  created(agent: Agent, resumed: boolean): void
  disposed(agent: Agent): void
}

/**
 * Listen to every Agent of the composition. A top-level row's listeners are untagged, so they
 * hear Agents of every preset (dsh-scope).
 * @param ctx - the rule's context.
 * @param hooks - the rule.
 */
export function onAgents(ctx: Context, hooks: AgentHooks): void {
  ctx.on('agent/inbox/inserted', ({ agent, message }) => { hooks.inserted(agent, message) })
  ctx.on('agent/pre-step', (payload, next) => hooks.preStep(payload, next))
  ctx.on('agent/status', ({ agent, status }) => { hooks.status(agent, status) })
  ctx.on('agent/created', ({ agent, source }) => { hooks.created(agent, source === 'resume'); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { hooks.disposed(agent) })
}

/**
 * @param ctx - the rule's context.
 * @param tool - a definition from {@link defineTool}.
 */
export function registerTool(ctx: Context, tool: ToolDefinition): void {
  ctx.effect(() => ctx.tools.register(tool), `agent-scheduler: ${tool.name}`)
}

/**
 * Install a tool guard: evaluated after every pre-execute policy and before any tool body, for
 * every call including nested `run_code` dispatches.
 * @param ctx - the rule's context.
 * @param guard - a refusal reason (the runtime prefixes it with "Error: "), or undefined to allow.
 * @returns false when this DSH has no guards.
 */
export function installGuard(ctx: Context, guard: (exec: { readonly name: string; readonly agent?: Agent | undefined }) => string | undefined): boolean {
  if (!features.record('tools.guard', hasFunction(ctx, 'tools.guard'))) return false
  ctx.effect(() => ctx.tools.guard(guard), 'agent-scheduler: fork guard')
  return true
}

/**
 * @param ctx - the rule's context.
 * @param name - section name.
 * @param order - its place in the prompt.
 * @param text - the text for one Agent; '' for none.
 */
export function promptSection(ctx: Context, name: string, order: number, text: (agent: Agent) => string): void {
  ctx.effect(() => ctx.systemPrompt.section({ name, order, text: (context) => context.agent === undefined ? '' : text(context.agent) }), `agent-scheduler: ${name} section`)
}

/** A slash command, independent of the runtime's registration shape. */
export interface CommandSpec {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Argument hint; omitted when empty (the runtime refuses an empty hint, and the composition then fails to load). */
  readonly hint?: string | undefined
  readonly run: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/**
 * @param ctx - the rule's context.
 * @param spec - the command.
 */
export function registerCommand(ctx: Context, spec: CommandSpec): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId(spec.id),
    name: spec.name,
    description: spec.description,
    ...(spec.hint === undefined || spec.hint.trim() === '' ? {} : { input: { hint: spec.hint } }),
    handler: spec.run,
  })
}

/**
 * Read a Session's log whether or not it is resident.
 * @param ctx - the rule's context.
 * @returns the reader.
 */
export function logReader(ctx: Context): (id: string) => Promise<SessionLog> {
  return async (id) => {
    using observed = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
    return { events: [...observed.events], inherited: Number(observed.inheritedEventCount) }
  }
}

/** Session titles, when the profile has the title service. */
export interface Titles {
  /** Name a Session that has no title yet. */
  name(session: Session, text: string): void
  /** Set a Session's title. */
  rename(session: Session, title: string): void
}

/**
 * @param ctx - the rule's context.
 * @param log - where failures go.
 * @returns titles that do nothing while the service is absent.
 */
export function titles(ctx: Context, log: (message: string, error?: unknown) => void): Titles {
  let service: { get(session: Session): unknown; rename(session: Session, title: string): unknown } | undefined
  ctx.inject(['sessionTitle'], (scoped) => {
    service = scoped.sessionTitle
    scoped.effect(() => () => { service = undefined }, 'agent-scheduler: titles')
  })
  return {
    name(session, text) {
      if (service === undefined || service.get(session) !== undefined) return
      const short = text.trim().replace(/\s+/gu, ' ').slice(0, 40)
      if (short === '') return
      try { service.rename(session, short) } catch (error) { log('naming the session failed', error) }
    },
    rename(session, title) {
      if (service === undefined) return
      service.rename(session, title)
    },
  }
}

/**
 * The runtime's own route check: the provider and model must resolve and the effort must be one
 * the model offers (an unknown effort is refused here rather than at the first call).
 * @param ctx - the rule's context.
 * @param effort - `asked`: the result carries an effort only when one was asked for (the worker
 *   default); `resolved`: it carries whatever effort the route resolves to (a member's own model).
 * @returns a validator that throws when the model is unroutable and returns the resolved choice.
 */
export function modelValidator(ctx: Context, effort: 'asked' | 'resolved' = 'asked'): (choice: ModelChoice) => Promise<ModelChoice> {
  return async (choice) => {
    const resolved = await ctx.llm.resolveCallConfig({ provider: choice.provider, model: choice.model, ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) }) })
    const keep = resolved.reasoningEffort !== undefined && (effort === 'resolved' || choice.reasoningEffort !== undefined)
    return { provider: resolved.provider, model: resolved.model, ...(keep ? { reasoningEffort: String(resolved.reasoningEffort) } : {}) }
  }
}

/** A validator for persisted or wire values: returns the value or throws. */
export interface Parser<T> { parse(value: unknown): T }

/** A session projection, as this plugin declares it. */
export interface ProjectionSpec<S, V> {
  readonly key: string
  readonly stateVersion: number
  readonly state: Parser<S>
  readonly view: Parser<V>
  /** State every log starts from; receives the Session header and inherited prefix length. */
  readonly init: (header: SessionHeader, inherited: SessionLogOffset) => S
  /** The next state; an unrelated event must return the same reference. */
  readonly apply: (state: S, event: SessionEvent) => S
  readonly toView: (state: S) => V
}

/**
 * The registry types its schemas as zod; it calls only `parse` (checked by
 * tests/contract/host-api.spec.ts). Offering `safeParse` too keeps a registry that switches to
 * it working, without adding zod to the published dependencies.
 */
function schema<T>(parser: Parser<T>): never {
  return {
    parse: (value: unknown) => parser.parse(value),
    safeParse: (value: unknown) => {
      try { return { success: true, data: parser.parse(value) } } catch (error) { return { success: false, error } }
    },
  } as never
}

/**
 * Register a session projection for the whole process.
 * @param ctx - the host row's context.
 * @param spec - the projection.
 */
export function registerProjection<S, V>(ctx: Context, spec: ProjectionSpec<S, V>): void {
  const definition = {
    key: spec.key,
    stateVersion: spec.stateVersion,
    stateSchema: schema(spec.state),
    init: spec.init,
    apply: spec.apply,
    wire: { viewSchema: schema(spec.view), view: spec.toView },
  }
  ctx.effect(() => ctx.sessionProjections.register(definition as never), `agent-scheduler: ${spec.key} projection`)
}

/**
 * The host's logger for this plugin, also receiving the adapter's once-only warnings.
 * @param ctx - any context of the plugin.
 * @returns warn.
 */
export function hostLog(ctx: Context): (message: string, error?: unknown) => void {
  const logger = ctx.logger('agent-scheduler')
  return (message, error) => { if (error === undefined) logger.warn(message); else logger.warn(message, error) }
}
