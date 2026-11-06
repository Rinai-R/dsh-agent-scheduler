/**
 * The Agent Teams adapter (dsh-experimental-agent-team). The only module that touches
 * the experimental Team service. See docs/worker-teammate.md.
 *
 * Agent Teams treats a child session that carries a `subagent/descriptor` (every worker) as no
 * member at all, so a worker can neither lead a Team nor get the Team tools. There is no hook to
 * change that. This prototype wraps the service's private roster resolver at run time: a live
 * worker of this scheduler that is no one's teammate resolves as the Lead of its own Team. The
 * Team tools then install on it at `agent/created`, its teammates are its own children, and its
 * roster and task board live in its own log. Anything not shaped as expected leaves the service
 * untouched and warns once.
 * @module dsh-agent-scheduler/dsh/host/agent-team
 */
import { features } from '../compat.js'
import type { Agent } from '../types.js'

/** Team tool names the guard refers to. */
export const TEAM_TOOLS = {
  spawn: 'spawn_teammate',
  all: ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'],
} as const

interface Membership { root: Agent; id: string; role: 'lead' | 'teammate'; name: string }
interface Roster { tryMembership(agent: Agent): Membership | undefined }

const isRoster = (value: unknown): value is Roster => typeof (value as Roster | undefined)?.tryMembership === 'function'

/* eslint-disable @typescript-eslint/no-explicit-any -- the experimental service is untyped at this boundary */

/**
 * Let workers lead their own Team, while the Team service lives.
 * @param ctx - the rule row's context.
 * @param isWorker - whether a live agent is one of this scheduler's workers.
 */
export function installWorkerTeams(ctx: any, isWorker: (agent: Agent) => boolean): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['agentTeams'], (scoped: any) => {
    const roster = (scoped.agentTeams as { roster?: Roster } | undefined)?.roster
    // An experimental package: its private roster is checked for exactly the shape this wraps.
    if (!features.record('agentTeams.workerLead', isRoster(roster), 'Agent Teams has no agentTeams.roster.tryMembership; workers cannot lead Teams') || !isRoster(roster)) return
    const original = roster.tryMembership
    const wrapped = function (this: Roster, agent: Agent): Membership | undefined {
      const found = original.call(this, agent)
      if (found !== undefined) return found
      try {
        if (ctx.agents.get(agent.id) !== agent || !isWorker(agent)) return undefined
      } catch {
        return undefined
      }
      return { root: agent, id: agent.id, role: 'lead', name: 'lead' }
    }
    roster.tryMembership = wrapped
    scoped.effect(() => () => { if (roster.tryMembership === wrapped) roster.tryMembership = original }, 'agent-scheduler: worker team leads')
  })
}

/**
 * Whether Agent Teams is mounted here (its service is registered).
 * @param ctx - any context.
 * @returns true when `ctx.agentTeams` answers.
 */
export function hasAgentTeams(ctx: any): boolean {
  try {
    return typeof ctx?.agentTeams?.tryMembership === 'function'
  } catch {
    return false
  }
}

/** One teammate as the Agents page shows it. */
export interface TeamMemberView { readonly id: string; readonly name: string; readonly description: string; readonly status: string }
/** One task of a Team board. */
export interface TeamTaskView { readonly id: string; readonly subject: string; readonly status: string; readonly owner?: string; readonly blockedBy: readonly string[] }
/** A Team, as one agent leads it. */
export interface TeamSnapshot { readonly members: readonly TeamMemberView[]; readonly tasks: readonly TeamTaskView[] }

/** What the scheduler asks of Agent Teams; every answer is safe when Teams is absent. */
export interface TeamPort {
  /** Whether Agent Teams is mounted. */
  available(): boolean
  /** The Team a live agent leads, or undefined. */
  snapshot(agent: Agent): TeamSnapshot | undefined
  /** Whether a teammate of the Team this agent leads is running or still being created. */
  busy(agent: Agent): boolean
  /** Call `changed` with the Session id whose Team records changed. */
  watch(changed: (sessionId: string) => void): void
}

const str = (v: unknown): string => typeof v === 'string' ? v : ''

/**
 * The Team port of a context.
 * @param ctx - the rule row's context.
 * @returns the port; every method is a safe no-op without Agent Teams.
 */
export function teamPort(ctx: any): TeamPort {
  // Held while the Team service lives (an optional dependency: inject, never a direct property read).
  let held: any
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams'], (scoped: any) => {
      held = scoped.agentTeams
      scoped.effect(() => () => { if (held === scoped.agentTeams) held = undefined }, 'agent-scheduler: team port')
    })
  }
  const service = (): any => typeof held?.tryMembership === 'function' && typeof held.listMembers === 'function' ? held : undefined
  const members = (agent: Agent): any[] | undefined => {
    const teams = service()
    if (teams === undefined) return undefined
    try {
      const membership = teams.tryMembership(agent)
      if (membership?.role !== 'lead' || membership.root !== agent) return undefined
      const rows = teams.listMembers(agent)
      return Array.isArray(rows) ? rows : undefined
    } catch { return undefined }
  }
  return {
    available: () => service() !== undefined,
    snapshot(agent) {
      const rows = members(agent)
      if (rows === undefined) return undefined
      let tasks: any[] = []
      try { tasks = service().listTasks(agent) ?? [] } catch { tasks = [] }
      const byId = new Map(rows.map(r => [str(r.id), str(r.name)]))
      return {
        members: rows.filter(r => r.role === 'teammate').map(r => ({ id: str(r.id), name: str(r.name), description: str(r.description), status: str(r.status) })),
        tasks: (Array.isArray(tasks) ? tasks : []).map(t => ({
          id: str(t.id), subject: str(t.subject), status: str(t.status),
          ...(typeof t.ownerId === 'string' ? { owner: byId.get(t.ownerId) ?? t.ownerId } : typeof t.ownerName === 'string' ? { owner: t.ownerName } : {}),
          blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(str) : [],
        })),
      }
    },
    busy(agent) {
      return (members(agent) ?? []).some(r => r.role === 'teammate' && (r.status === 'running' || r.status === 'provisioning'))
    },
    watch(changed) {
      if (typeof ctx.on !== 'function') return
      // Team records are log-only events of the Team Lead's own Session (`team/member`, `team/task`).
      ctx.on('session/event', (session: any, event: any) => {
        if (typeof event?.type === 'string' && event.type.startsWith('team/') && typeof session?.id === 'string') changed(session.id)
      })
    },
  }
}
