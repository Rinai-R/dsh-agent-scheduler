/**
 * Who may form an Agent Team, by role and by the scheduling switch, enforced at dispatch:
 * - the lead, while scheduling is off: yes (Agent Teams' own tools);
 * - the lead, while scheduling is on: no new teammates (its existing team keeps every other tool);
 *   forming teams is the workers' job then;
 * - a fork: no Team tool at all (forks only route);
 * - a worker: always, as the Lead of its own team (src/dsh/host/agent-team.ts);
 * - a worker's teammate: no teammates of its own (teams do not nest).
 * @module dsh-agent-scheduler/team-guard
 */
import type { Agent } from './dsh/types.js'
import { TEAM_TOOLS } from './dsh/host/index.js'

/** What the guard needs to know about an agent. */
export interface TeamRoles {
  isMain(agent: Agent): boolean
  isOn(agent: Agent): boolean
  forkName(agent: Agent): string | undefined
  isWorker(agent: Agent): boolean
}

const TEAM = new Set<string>(TEAM_TOOLS.all)

/**
 * @param roles - the scheduler's view of an agent.
 * @returns a tool guard: a refusal reason, or undefined to let the call run.
 */
export function teamGuard(roles: TeamRoles): (exec: { readonly name: string; readonly agent?: Agent | undefined }) => string | undefined {
  return (exec) => {
    const agent = exec.agent
    if (agent === undefined || !TEAM.has(exec.name)) return undefined
    const fork = roles.forkName(agent)
    if (fork !== undefined) return `${fork} is a fork: forks only route and do not use Agent Team tools. Hand the work to a worker with agent_create or agent_send; a worker forms its own team.`
    if (exec.name !== TEAM_TOOLS.spawn) return undefined
    if (roles.isMain(agent)) {
      return roles.isOn(agent)
        ? 'Scheduling is on: the lead does not form teams; workers do. Create a worker with agent_create and let it form its team. Your existing teammates keep messages, tasks and interrupts.'
        : undefined
    }
    if (roles.isWorker(agent)) return undefined
    // A top-level Session (a session worker, or any ordinary chat) leads its own team natively.
    if (agent.session.header.parentSession === undefined) return undefined
    return 'Teams do not nest: a teammate cannot create teammates of its own. Ask your Team Lead (send_message to "lead").'
  }
}
