/**
 * Per-member model: the model one fork or worker uses for its own later requests, chosen from
 * its chat's composer. The runtime's own model selection refuses subagent Sessions (the Remote
 * agent lookup rejects them, and the composer seat hides itself for addressed subagents), so the
 * main Session owns the choice: a plugin record in the main log, folded into the roster (so the
 * chat composer can show it), and applied to the child Agent with the runtime's own
 * model selection (src/dsh/host/model.ts) now if it is live and again every time it is created (an idle member
 * is released, and a host restart recreates it from its log). The runtime's `model/selection`
 * event is not used: subagent Sessions never install the controller's selection that reads it.
 * @module dsh-agent-scheduler/member-model
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CommandInvocation, CommandResult, SessionEvent } from './dsh/types.js'
import {
  appendRecord as appendPluginRecord, applyModelSelection, canSelectModel, isMainSession, lastEvent, modelValidator, recordOf as pluginRecordOf, registerCommand, SessionId,
  type AgentLookup,
} from './dsh/host/index.js'
import type { Scheduler } from './scheduler.js'
import { t } from './i18n/index.js'
import { menuDescription, menuHint } from './menu.js'

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

// Its entry in DSH's PluginRecordMap is declared in src/dsh/host/augment.ts.

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


/**
 * Point a live member's later requests at a selection; `null` returns it to the model it was
 * started with. The step already assembling keeps its model, as with the runtime's selector.
 * @param agent - the member Agent.
 * @param selection - the selection, or null.
 * @returns false when this DSH cannot switch one Agent's model.
 */
export const applyMemberModel = (agent: Agent, selection: MemberModel): boolean => applyModelSelection(agent, selection)

/**
 * Execute `/agent-model <member> <provider>/<model> [effort] | <member> default` in the main Session.
 * @param scheduler - the scheduler, for the member roster.
 * @param agents - live Agents by Session id.
 * @param invocation - the parsed command.
 * @returns the outcome.
 */
export function runMemberModelCommand(
  scheduler: Pick<Scheduler, 'ledgerOf'>,
  agents: AgentLookup,
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
export async function setMemberModel(scheduler: Pick<Scheduler, 'ledgerOf'>, agents: AgentLookup, main: Agent, rawInput: string, validate?: Validate): Promise<CommandResult> {
  if (!isMainSession(main)) return { kind: 'error', text: t('cmd.mainOnly', { command: MEMBER_MODEL_COMMAND }) }
  const parsed = parseMemberModel(rawInput)
  if (parsed === undefined) return { kind: 'error', text: t('cmd.model.usage', { command: MEMBER_MODEL_COMMAND }) }
  const member = scheduler.ledgerOf(main).find(parsed.member)
  if (member === undefined) return { kind: 'error', text: t('cmd.model.noMember', { name: parsed.member }) }
  // An archived member is released but still answers when spoken to in its chat; the choice
  // applies when that wakes it (agent/created restores it). One that failed never started.
  if (member.state === 'failed') return { kind: 'error', text: t('cmd.model.failed', { name: member.name }) }
  // A fork always runs on the lead's model (it replays the lead's history and its prompt cache).
  if (member.kind === 'fork') return { kind: 'error', text: t('cmd.model.fork', { name: member.name }) }
  let selection = parsed.selection
  if (selection !== null && validate !== undefined) {
    try {
      selection = await validate(selection)
    } catch (error) {
      return { kind: 'error', text: `${parsed.selection!.provider}/${parsed.selection!.model}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (!canSelectModel()) return { kind: 'error', text: t('cmd.model.unsupported') }
  const ledger = scheduler.ledgerOf(main)
  appendPluginRecord(main.session, MEMBER_MODEL_RECORD, { version: 1, agent: member.id, selection })
  ledger.apply(lastEvent(main.session))
  const child = agents.get(SessionId(member.id) as never)
  if (child !== undefined) applyMemberModel(child, selection)
  return {
    kind: 'success',
    text: selection === null
      ? t('cmd.model.reset', { name: member.name })
      : t('cmd.model.set', { name: member.name, route: `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`}` }),
  }
}

/**
 * Apply a member's recorded model to its freshly created Agent.
 * @param scheduler - for the roster of its main Session.
 * @param agent - any created Agent; main Sessions and non-members are left alone.
 */
export function restoreMemberModel(scheduler: Pick<Scheduler, 'ledgerOf'>, agent: Agent): void {
  if (isMainSession(agent)) return
  const member = scheduler.ledgerOf(agent).members.get(agent.id)
  // Only a worker has a model of its own. Its state is re-asserted on every creation, including
  // "none" (a runtime that keeps the choice in the member's own log would otherwise bring back
  // one the user cleared while the member was released).
  if (member?.kind === 'worker') applyMemberModel(agent, member.pickedModel ?? null)
}

/**
 * Register `/agent-model`. Restoring each member's own selection whenever its Agent is created
 * (first start, host restart, resume after release) is the rule's `created` hook
 * ({@link restoreMemberModel}).
 * @param ctx - the rule's context.
 * @param scheduler - the scheduler.
 * @param agents - live Agents.
 */
export function installMemberModels(ctx: Context, scheduler: Pick<Scheduler, 'ledgerOf'>, agents: AgentLookup): void {
  const validate = modelValidator(ctx, 'resolved')
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/agent-model',
    name: MEMBER_MODEL_COMMAND,
    description: () => menuDescription('agent-model'),
    hint: () => menuHint('agent-model'),
    run: (invocation) => runMemberModelCommand(scheduler, agents, invocation, validate),
  })
}
