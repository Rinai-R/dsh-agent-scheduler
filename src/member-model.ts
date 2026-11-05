/**
 * Per-member model: the model one fork or worker uses for its own later requests, chosen from
 * its chat's composer. The runtime's own model selection refuses subagent Sessions (the Remote
 * agent lookup rejects them, and the composer seat hides itself for addressed subagents), so the
 * main Session owns the choice: a plugin record in the main log, folded into the roster (so the
 * chat composer can show it), and applied to the child Agent with the runtime's own
 * `installModelSelection` now if it is live and again every time it is created (an idle member
 * is released, and a host restart recreates it from its log). The runtime's `model/selection`
 * event is not used: subagent Sessions never install the controller's selection that reads it.
 * @module dsh-agent-scheduler/member-model
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Scheduler } from './scheduler.js'

/** Command name; run in the main Session, naming the member. */
export const MEMBER_MODEL_COMMAND = 'agent-model'

/** A member's selection: provider route, model, optional effort; `null` restores its start model. */
export type MemberModel = { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null

/**
 * Parse `<member> <provider>/<model> [effort]` or `<member> default`.
 * @param raw - text after the command name.
 * @returns the member key and selection, or undefined when malformed.
 */
export function parseMemberModel(raw: string): { member: string; selection: MemberModel } | undefined {
  const parts = raw.trim().split(/\s+/u)
  const [member, route, effort, ...rest] = parts
  if (member === undefined || member === '' || route === undefined || rest.length > 0) return undefined
  if (route === 'default') return effort === undefined ? { member, selection: null } : undefined
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) return undefined
  const base = { provider: route.slice(0, slash), model: route.slice(slash + 1) }
  return { member, selection: effort === undefined ? base : { ...base, reasoningEffort: effort } }
}

const isSelection = (data: unknown): data is { provider: string; model: string; reasoningEffort?: string } => {
  const d = data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  return typeof d?.provider === 'string' && typeof d.model === 'string' && (d.reasoningEffort === undefined || typeof d.reasoningEffort === 'string')
}

/** Plugin record in the main Session's log. */
export const MEMBER_MODEL_RECORD = 'plugin:dsh-agent-scheduler/member-model'

/** One choice; `selection: null` returns the member to the model it started with. */
export interface MemberModelRecord {
  readonly version: 1
  /** The member's Session id. */
  readonly agent: string
  readonly selection: MemberModel
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-agent-scheduler/member-model': MemberModelRecord
  }
}

/**
 * Read one member-model record.
 * @param event - any event.
 * @returns the selection (possibly null), or undefined when the event is not a valid record.
 */
export function memberModelRecordOf(event: SessionEvent): { agent: string; selection: MemberModel } | undefined {
  const record = pluginRecordOf(event)
  if (record?.type !== MEMBER_MODEL_RECORD) return undefined
  const data = record.data as { version?: unknown; agent?: unknown; selection?: unknown } | null
  if (data?.version !== 1 || typeof data.agent !== 'string') return undefined
  if (data.selection === null) return { agent: data.agent, selection: null }
  return isSelection(data.selection) ? { agent: data.agent, selection: { ...data.selection } } : undefined
}


const toAgentSelection = (selection: NonNullable<MemberModel>): ModelSelection => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
})

/** One installed selection per live member Agent. */
const installed = new WeakMap<Agent, ModelSelectionRef>()

/**
 * Point a live member's later requests at a selection; `null` returns it to the model it was
 * started with. The step already assembling keeps its model, as with the runtime's selector.
 * @param agent - the member Agent.
 * @param selection - the selection, or null.
 */
export function applyMemberModel(agent: Agent, selection: MemberModel): void {
  let ref = installed.get(agent)
  if (ref === undefined) {
    if (selection === null) return
    ref = { current: undefined, assembled: undefined }
    installed.set(agent, ref)
    const dispose = installModelSelection(agent.ctx, ref)
    agent.ctx.effect(() => dispose, 'agent-scheduler: member model')
  }
  ref.current = selection === null ? undefined : toAgentSelection(selection)
}

/**
 * Execute `/agent-model <member> <provider>/<model> [effort] | <member> default` in the main Session.
 * @param scheduler - the scheduler, for the member roster.
 * @param agents - live Agents by Session id.
 * @param invocation - the parsed command.
 * @returns the outcome.
 */
export function runMemberModelCommand(
  scheduler: Pick<Scheduler, 'ledgerOf'>,
  agents: { get(id: SessionId): Agent | undefined },
  invocation: CommandInvocation,
  validate?: Validate,
): Promise<CommandResult> {
  return setMemberModel(scheduler, agents, invocation.agent, invocation.rawInput, validate)
}

/** Checks a selection the way the runtime's own selector does before installing it; throws when unroutable. */
export type Validate = (selection: NonNullable<MemberModel>) => Promise<NonNullable<MemberModel>>

/**
 * Record a member's model in the main Session and apply it to the member if it is live.
 * @returns the command outcome.
 */
export async function setMemberModel(scheduler: Pick<Scheduler, 'ledgerOf'>, agents: { get(id: SessionId): Agent | undefined }, main: Agent, rawInput: string, validate?: Validate): Promise<CommandResult> {
  if (main.session.header.parentSession !== undefined) return { kind: 'error', text: `/${MEMBER_MODEL_COMMAND} only applies in the main session.` }
  const parsed = parseMemberModel(rawInput)
  if (parsed === undefined) return { kind: 'error', text: `Usage: /${MEMBER_MODEL_COMMAND} <name> <provider>/<model> [effort] | <name> default` }
  const member = scheduler.ledgerOf(main).find(parsed.member)
  if (member === undefined) return { kind: 'error', text: `no fork or worker named "${parsed.member}"` }
  // An archived member is released but still answers when spoken to in its chat; the choice
  // applies when that wakes it (agent/created restores it). One that failed never started.
  if (member.state === 'failed') return { kind: 'error', text: `${member.name} is ${member.state}` }
  // A fork always runs on the lead's model (it replays the lead's history and its prompt cache).
  if (member.kind === 'fork') return { kind: 'error', text: `${member.name} is a fork: forks always use the lead's model. Give the task to a worker to run it on another model.` }
  let selection = parsed.selection
  if (selection !== null && validate !== undefined) {
    try {
      selection = await validate(selection)
    } catch (error) {
      return { kind: 'error', text: `${parsed.selection!.provider}/${parsed.selection!.model}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const ledger = scheduler.ledgerOf(main)
  appendPluginRecord(main.session, MEMBER_MODEL_RECORD, { version: 1, agent: member.id, selection })
  ledger.apply(main.session.snapshotEvents().at(-1)!)
  const child = agents.get(SessionId(member.id))
  if (child !== undefined) applyMemberModel(child, selection)
  return {
    kind: 'success',
    text: selection === null
      ? `${member.name} goes back to the model it started with from its next model call.`
      : `${member.name} uses ${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`} from its next model call.`,
  }
}

/**
 * Apply a member's recorded model to its freshly created Agent.
 * @param scheduler - for the roster of its main Session.
 * @param agent - any created Agent; main Sessions and non-members are left alone.
 */
export function restoreMemberModel(scheduler: Pick<Scheduler, 'ledgerOf'>, agent: Agent): void {
  if (agent.session.header.parentSession === undefined) return
  const selection = scheduler.ledgerOf(agent).members.get(agent.id)?.pickedModel
  if (selection !== undefined) applyMemberModel(agent, selection)
}

/**
 * Register the command, and restore each member's own selection whenever its Agent is created
 * (first start, host restart, resume after release).
 * @param ctx - preset-scoped context.
 * @param scheduler - the scheduler of this preset.
 */
export function installMemberModels(ctx: Context, scheduler: Pick<Scheduler, 'ledgerOf'>): void {
  ctx.on('agent/created', ({ agent }) => { restoreMemberModel(scheduler, agent); return undefined })
  ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-agent-scheduler/agent-model'),
    name: MEMBER_MODEL_COMMAND,
    description: 'Set the model one fork or worker uses from its next step',
    input: { hint: '<name> <provider>/<model> [effort] | <name> default' },
    handler: (invocation) => runMemberModelCommand(scheduler, ctx.agents as never, invocation, async (selection) => {
      const resolved = await ctx.llm.resolveCallConfig({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) })
      return { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }) }
    }),
  })
}
