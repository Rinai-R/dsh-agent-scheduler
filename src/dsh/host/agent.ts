/**
 * What the plugin reads and changes on a live Agent: its place in the Session tree, its inbox,
 * its status, and the follow-up queue the lead receives results through (dsh-agent).
 * @module dsh-agent-scheduler/dsh/host/agent
 */
import type { Agent, UserMessage } from '../types.js'
import { relayMessage } from './session.js'

/** Live Agents by Session id: `ctx.agents`, narrowed. */
export interface AgentLookup { get(id: never): Agent | undefined }

/** `FiberState.ACTIVE` of Cordis (a const enum, so not importable at run time). */
const FIBER_ACTIVE = 2

/**
 * Whether an agent captured before an await can still take writes to its Session.
 *
 * Its Session may have been released meanwhile: DSH shut down, or the Session was closed and
 * maybe reopened as a new Agent. Appending to the released one is never right: DSH ≥ 0.2.2
 * refuses it (`cannot append outside a SessionStore`), and 0.2.1 takes the event into a log
 * nobody owns any more, so the stored log ends up with a seq gap after a reopen.
 * @param agent - the agent as captured.
 * @param agents - live agents.
 * @returns true while `agent` is the exact agent registered for its Session and its scope is not
 *   being torn down. Teardown disposes the scope and closes the log before it unregisters the
 *   agent, so the registry alone answers too late.
 */
export function isLive(agent: Agent, agents: AgentLookup): boolean {
  if (agents.get(agent.id as never) !== agent) return false
  const state = (agent.ctx as { fiber?: { state?: unknown } } | undefined)?.fiber?.state
  return state === undefined || state === FIBER_ACTIVE
}

// ------------------------------------------------------------------ session workers

/** The record a top-level worker Session carries: the router (main Session) it belongs to. */
export const OWNER_RECORD = 'plugin:dsh-agent-scheduler/owner'
/** Which router a top-level Session works for; `null` when it is none (checked once per Session). */
const routers = new WeakMap<object, string | null>()

/**
 * The router a top-level worker Session belongs to. Only this plugin appends the owner record, and
 * it says so through {@link markRouter}, so a Session read once without one stays a router.
 * @param agent - any agent.
 * @returns the router's Session id, or undefined.
 */
export function routerOf(agent: Agent): string | undefined {
  if (agent.session.header.parentSession !== undefined) return undefined
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const known = routers.get(agent.session)
  if (known !== undefined) return known ?? undefined
  let found: string | null = null
  for (const event of agent.session.snapshotEvents()) {
    if (String(event.type) !== OWNER_RECORD) continue
    const router = (event.data as { router?: unknown }).router
    if (typeof router === 'string') found = router
  }
  routers.set(agent.session, found)
  return found ?? undefined
}

/** Remember that a Session now works for `router` (its owner record was just appended). */
export function markRouter(agent: Agent, router: string): void { routers.set(agent.session, router) }

/**
 * A top-level Session. Every one of them is a session of its own to the scheduler: it has its own
 * roster, inbox and switch, and may create and message workers. The plugin does not tell routers
 * and workers apart; a Session another one created ({@link isSessionWorker}) is still a top-level
 * Session that can have workers of its own.
 */
export const isMainSession = (agent: Agent): boolean => agent.session.header.parentSession === undefined

/** A top-level Session that another Session created as its worker (it carries an owner record). */
export const isSessionWorker = (agent: Agent): boolean => routerOf(agent) !== undefined

/**
 * @param agent - a top-level Session, or one of its children (a fork, an old subagent worker).
 * @returns the id of the top-level Session whose roster it belongs to.
 */
export const mainIdOf = (agent: Agent): string => agent.session.header.parentSession ?? agent.id

/**
 * @param agent - any agent.
 * @returns the directory its Session was created in, if recorded.
 */
export const cwdOf = (agent: Agent): string | undefined => agent.session.header.cwd

/**
 * @param agent - any agent.
 * @returns messages waiting for its next step, then its next turn.
 */
export const pendingOf = (agent: Agent): UserMessage[] => [...agent.inbox.nextStep, ...agent.inbox.nextTurn]

/**
 * @param agent - any agent.
 * @param id - a message id.
 * @returns whether that message is still waiting in its inbox.
 */
export const isPending = (agent: Agent, id: string): boolean => pendingOf(agent).some(m => m.id === id)

/**
 * @param agent - any agent.
 * @param id - a message id.
 * @returns whether it was removed.
 */
export const removePending = (agent: Agent, id: string): boolean => agent.inbox.remove(id as never)

/**
 * Wake an idle agent for what still waits in its inbox. DSH starts a driver only when a message is
 * sent: one sent while a turn is closing (after its last claim, before the driver goes idle) waits
 * with no driver. Sending those messages again, in order, wakes it; nothing is added or dropped.
 * @param agent - any agent, idle.
 * @returns how many messages were sent again.
 */
export function wakeForPending(agent: Agent): number {
  if (agent.status !== 'idle') return 0
  const waiting = pendingOf(agent)
  for (const message of waiting) agent.inbox.remove(message.id as never)
  for (const message of waiting) agent.followup(message)
  return waiting.length
}

/**
 * @param agent - any agent.
 * @param message - the new content of a message still waiting, same id.
 * @returns whether it was replaced.
 */
export const replacePending = (agent: Agent, message: UserMessage): boolean => agent.inbox.replace(message.id, message)

/**
 * @param agents - live agents.
 * @param id - a Session id.
 * @returns `running` or `idle` for a resident agent, undefined when it is not resident.
 */
export const statusOf = (agents: AgentLookup, id: string): 'running' | 'idle' | undefined => {
  const status = agents.get(id as never)?.status
  return status === undefined ? undefined : status === 'running' ? 'running' : 'idle'
}

/**
 * Give the lead a message from a member outside a step it is admitting: queued for its next turn.
 * @param main - the main agent.
 * @param text - what the lead reads.
 * @param sender - the member's Session id.
 */
export function toLead(main: Agent, text: string, sender: string): void {
  main.followup(relayMessage(text, sender))
}

/**
 * Give the lead a message from a member inside the turn it is running: taken at its next step.
 * @param main - the main agent.
 * @param text - what the lead reads.
 * @param sender - the member's Session id.
 */
export function steerLead(main: Agent, text: string, sender: string): void {
  main.steer(relayMessage(text, sender))
}
