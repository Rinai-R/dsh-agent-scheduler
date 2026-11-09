/**
 * Per-worker access mode: the permission preset (sandbox + approval) a worker runs under, chosen
 * from its own chat's footer, from the Agents page, by `/agent-access`, or by the lead's
 * `agent_access` tool. Like the per-member model, the choice lives in the main Session's log and
 * is applied to the child Session now and on every creation.
 *
 * Delegated children are born with the approval policy pinned to `never`, which matches no
 * preset, so they read `custom`; a worker we create is given the lead's current mode instead.
 * The lead may narrow a worker, or bring it up to the user's own current mode, never past it.
 * @module dsh-agent-scheduler/member-access
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CommandInvocation, CommandResult, SessionEvent } from './dsh/types.js'
import { isMainSession, recordOf as pluginRecordOf, registerCommand, type AccessMode, type AccessPort } from './dsh/host/index.js'
import { MEMBER_ACCESS_RECORD } from './records.js'
import type { Scheduler } from './scheduler.js'
import { t } from './i18n/index.js'
import { menuDescription, menuHint } from './menu.js'

/** Command name; run in the main Session, naming the worker. */
export const MEMBER_ACCESS_COMMAND = 'agent-access'

/** Plugin record in the main Session's log. */
export { MEMBER_ACCESS_RECORD }

/** One worker's access choice. */
export interface MemberAccessRecord {
  readonly version: 1
  /** The worker's Session id. */
  readonly agent: string
  /** The preset it was switched to; null = follow the lead's mode at creation. */
  readonly preset: string | null
  /** Who chose it: the user's command/page, the lead's tool, or inheritance at creation. */
  readonly by?: 'user' | 'lead' | 'inherited'
}

// Its entry in DSH's PluginRecordMap is declared in src/dsh/host/augment.ts.

/**
 * Read one member-access record.
 * @param event - any event.
 * @returns the choice, or undefined when the event is not a valid record.
 */
export function memberAccessRecordOf(event: SessionEvent): { agent: string; preset: string | null; by?: MemberAccessRecord['by'] } | undefined {
  const record = pluginRecordOf(event)
  if (record?.type !== MEMBER_ACCESS_RECORD) return undefined
  const data = record.data as { version?: unknown; agent?: unknown; preset?: unknown; by?: unknown } | null
  if (data?.version !== 1 || typeof data.agent !== 'string') return undefined
  if (data.preset !== null && typeof data.preset !== 'string') return undefined
  const by = data.by === 'user' || data.by === 'lead' || data.by === 'inherited' ? data.by : undefined
  return { agent: data.agent, preset: data.preset, ...(by === undefined ? {} : { by }) }
}

/** Sandbox modes from narrowest to widest; anything unknown cannot be compared. */
const SANDBOX_RANK: Readonly<Record<string, number>> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/**
 * How wide a mode is.
 * @param mode - one selectable mode.
 * @returns its rank, or undefined for a sandbox mode this plugin does not know.
 */
export const rankOf = (mode: AccessMode | undefined): number | undefined => {
  if (mode === undefined) return undefined
  // DSH's experimental Auto runs with full access but has every call reviewed: narrower than
  // danger-full-access, wider than workspace-write.
  if (mode.name === 'auto') return 1.5
  return SANDBOX_RANK[mode.sandbox]
}

/**
 * Whether a target mode stays within a ceiling: no wider than it. Width is the sandbox (with
 * Auto between workspace-write and danger-full-access). The approval policy is not a widening
 * either way: `ask` puts each escalation in front of the user, `never` rejects it, so narrowing a
 * full-access worker to a mode that asks is allowed.
 * @returns why it does not, or undefined when it does.
 */
export function wideningReason(target: AccessMode | undefined, ceiling: AccessMode | undefined): string | undefined {
  if (target === undefined) return 'that access mode no longer exists'
  if (ceiling === undefined) return `the session's access mode is not one of the offered presets; pick one of: see agent_list`
  const [t, c] = [rankOf(target), rankOf(ceiling)]
  if (t === undefined || c === undefined) return `cannot compare access modes "${target.sandbox}" and "${ceiling.sandbox}"`
  if (t > c) return `that is wider than the user's own mode ("${ceiling.name}"); the lead may narrow a worker or match the user's choice, never widen it — ask the user to switch their own mode first`
  return undefined
}

/**
 * Parse `/agent-access <member> <preset> | <member> default`.
 * @param raw - text after the command name.
 * @returns the member key and preset (null = the lead's current mode), or undefined when malformed.
 */
export function parseMemberAccess(raw: string): { member: string; preset: string | null } | undefined {
  const parts = raw.trim().split(/\s+/u)
  if (parts.length !== 2) return undefined
  const [member, preset] = parts as [string, string]
  if (member === '' || preset === '') return undefined
  return { member, preset: preset === 'default' ? null : preset }
}

/**
 * The user's own mode for a main Session, as the ceiling a lead may not pass.
 * @param access - the host's presets.
 * @param main - the main Session's Agent.
 * @returns the mode, or undefined when the Session is on a custom combination.
 */
export const ceilingOf = (access: AccessPort, main: Agent): AccessMode | undefined => {
  const current = access.current(main.session)
  return access.modes().find(mode => mode.name === current)
}

/** Apply one access mode to a live member's Session (no record is written here). */
export function applyMemberAccess(access: AccessPort, agent: Agent, preset: string): boolean {
  if (!access.available) return false
  access.set(agent.session, preset)
  return true
}

/** What the Agents page and `agent_list` show for one member. */
export interface MemberAccessView {
  /** The preset recorded for it, when there is one. */
  readonly preset?: string | undefined
  /** The preset its Session is actually on now (`custom` when nothing matches). */
  readonly current: string
  readonly by?: 'user' | 'lead' | 'inherited' | undefined
}

/**
 * Register `/agent-access <member> <preset> | <member> default` (run in the main Session).
 * @param ctx - the rule's context.
 * @param scheduler - the scheduler.
 * @param access - the host's presets.
 */
export function installMemberAccess(ctx: Context, scheduler: Scheduler, access: AccessPort): void {
  registerCommand(ctx, {
    id: 'dsh-agent-scheduler/agent-access',
    name: MEMBER_ACCESS_COMMAND,
    description: () => menuDescription('agent-access'),
    hint: () => menuHint('agent-access'),
    run: (invocation: CommandInvocation): CommandResult => runMemberAccessCommand(scheduler, access, invocation),
  })
}

/**
 * Execute the command: the user's own choice, so every offered mode is allowed, including wider
 * than their current one (they are the user).
 * @returns the outcome.
 */
export function runMemberAccessCommand(scheduler: Pick<Scheduler, 'setMemberAccess'>, access: AccessPort, invocation: CommandInvocation): CommandResult {
  if (!isMainSession(invocation.agent)) return { kind: 'error', text: t('cmd.mainOnly', { command: MEMBER_ACCESS_COMMAND }) }
  if (!access.available) return { kind: 'error', text: t('cmd.access.unsupported') }
  const parsed = parseMemberAccess(invocation.rawInput)
  if (parsed === undefined) return { kind: 'error', text: t('cmd.access.usage', { command: MEMBER_ACCESS_COMMAND, modes: access.modes().map(m => m.name).join(', ') }) }
  try {
    const result = scheduler.setMemberAccess(invocation.agent, { name: parsed.member, preset: parsed.preset, by: 'user' })
    return { kind: 'success', text: t('cmd.access.set', { name: result.name, mode: result.preset }) }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}
