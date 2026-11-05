/**
 * Model tools. Every agent of the preset gets the same set; the lead (scheduling on or off), its
 * forks and its workers may use it.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DispatchRefused, FORK_NOTICE, isMainSession, LEAD_NOTICE, LEAD_OFF_NOTICE, type Scheduler } from './scheduler.js'
import type { ForkModelSelection } from './records.js'

type Live = { get(id: never): Agent | undefined }

const OK = { type: 'object', additionalProperties: true, properties: {} } as const
/** The calling agent; tools only run inside an agent. */
function callerOf(exec: { agent?: Agent | undefined }): Agent {
  if (exec.agent === undefined) throw new Error('agent tools need a calling agent')
  return exec.agent
}
const json = (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
const VERSION = { type: 'string', description: 'The rosterVersion from your latest agent_list (or the previous agent_create/agent_send result). Required: refused when missing or when the roster has changed since, with the current roster to decide again.' } as const

/**
 * Parse "provider/model[:effort]".
 * @param value - the model string.
 * @returns the selection.
 */
export function parseModel(value: string): ForkModelSelection {
  const [route, effort] = value.split(':')
  const slash = route?.indexOf('/') ?? -1
  if (route === undefined || slash <= 0 || slash === route.length - 1) throw new Error('model must be "provider/model" or "provider/model:effort"')
  return { provider: route.slice(0, slash), model: route.slice(slash + 1), ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * Build the tool set.
 * @param scheduler - the scheduler.
 * @param agents - live agents, to describe status.
 * @returns tool definitions.
 */
export function schedulerTools(scheduler: Scheduler, agents: Live): ToolDefinition[] {
  const status = (id: string): string => (agents.get(id as never)?.status) ?? 'idle'
  // Registered in every session of the preset so the tool list never changes with the switch.
  // The lead keeps them with scheduling off: the switch decides only who takes user messages.
  // Ordinary subagents of the preset are not members and are refused.
  const caller = (exec: { agent?: Agent | undefined }): Agent => {
    const agent = callerOf(exec)
    scheduler.assertTakesPart(agent)
    return agent
  }
  // Without a version the caller decides on a roster it has not read (or read long ago).
  const requireVersion = (agent: Agent, version: string | undefined): void => {
    if (version !== undefined && version !== '') return
    throw new DispatchRefused('rosterVersion is required: call agent_list first and decide from the roster it returns (who already has this work), then pass its rosterVersion.', scheduler.rosterSummary(scheduler.ledgerOf(agent)))
  }
  return [
    defineTool({
      name: 'agent_create',
      description: 'Create a long-lived worker agent with its own session, for one repository or area. Give it a role, optionally a working directory (one worker per directory or worktree), a model ("provider/model"), a preset, and a first task; the task becomes a request whose answer goes to the lead, not back to you. Call agent_list first and pass its rosterVersion: creations and deliveries of this session run one at a time, and one made on a roster that changed since is refused with the current roster. A fork creates at most one worker for its message; the lead names with for the fork-N or r-N it acts on, which also gets at most one (optional while scheduling is off, when the user talks to the lead directly).',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case name, never reused.' },
        role: { type: 'string', required: true, description: 'What this worker is responsible for.' },
        cwd: { type: 'string', description: 'Working directory or worktree, not shared with another active worker; omit to use the session\'s. Required with from when the source worker has one: a new worktree of its own. With repo and branch, it is created for you as a new git worktree.' },
        repo: { type: 'string', description: 'With branch: an existing checkout of the repository; cwd (which must not exist yet) is created from it as a new git worktree on a new branch. Use it instead of running git yourself.' },
        branch: { type: 'string', description: 'New branch for the worktree at cwd, e.g. feat/<slug> or fix/<slug>.' },
        base: { type: 'string', description: 'What the new branch starts from; default origin/main (fetched first).' },
        preset: { type: 'string', description: 'Optional agent preset; default is this session\'s preset.' },
        model: { type: 'string', description: 'Optional "provider/model"; default is the user\'s worker model (Agents page or /worker model), then the configured worker model, then the runtime default.' },
        from: { type: 'string', description: 'Existing worker name: the new worker continues its conversation (then no preset). Use it for a new task in that worker\'s area that should run in parallel (the owner is running or has open requests, or the task needs its own branch): fork the owner and give the new worker a new worktree of its own as cwd, never the owner\'s directory.' },
        task: { type: 'string', description: 'Optional first request.' },
        rosterVersion: VERSION,
        for: { type: 'string', description: 'The lead only (a fork always creates for its own message): the fork-N whose conclusion or the r-N whose reply this worker is for; each gets at most one worker. Required for the lead while scheduling is on; optional while it is off (the user then talks to the lead directly, with no fork in between).' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { name: string; role: string; cwd?: string; preset?: string; model?: string; from?: string; task?: string; repo?: string; branch?: string; base?: string; rosterVersion?: string; for?: string }
        if ((a.repo === undefined) !== (a.branch === undefined)) throw new Error('repo and branch go together: both create the new worktree at cwd')
        if (a.base !== undefined && a.repo === undefined) throw new Error('base only applies with repo and branch')
        const worktree = a.repo === undefined || a.branch === undefined ? undefined : { repo: a.repo, branch: a.branch, base: a.base }
        const agent = caller(exec)
        requireVersion(agent, a.rosterVersion)
        const named = a.for === '' ? undefined : a.for
        // With scheduling on, every user message reaches the lead through a fork, so the lead acts
        // on a fork-N or r-N and must name it. Off, it acts on the user's own words: nothing to name.
        if (isMainSession(agent) && named === undefined && scheduler.isOn(agent)) throw new DispatchRefused('The lead must say what this worker is for: pass for: the fork-N whose conclusion or the r-N whose reply you act on. If that fork already created a worker, agent_send it instead.', scheduler.rosterSummary(scheduler.ledgerOf(agent)))
        return scheduler.createWorker(agent, { name: a.name, role: a.role, cwd: a.cwd, preset: a.preset, task: a.task, from: a.from, worktree, model: a.model === undefined ? undefined : parseModel(a.model), rosterVersion: a.rosterVersion, for: named })
      },
    }),
    defineTool({
      name: 'agent_send',
      description: 'Send a request to a worker or fork by name, passing the rosterVersion from agent_list (refused when missing or stale, with the current roster). Its answer goes to the lead as "[reply to r-N from name]", not back to you: do not wait for it. Use it only for a follow-up to a request the target already has (rework, a question, review comments, a change of direction). If the target is running or has open requests, anything else piles up behind that work: for a new task in the same area, even in the same files, agent_create with from: <that worker> and a new worktree as cwd instead, so it runs in parallel.',
      parameters: {
        to: { type: 'string', required: true, description: 'Name of the worker or fork.' },
        message: { type: 'string', required: true, description: 'Self-contained request.' },
        rosterVersion: VERSION,
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { to: string; message: string; rosterVersion?: string }
        const agent = caller(exec)
        requireVersion(agent, a.rosterVersion)
        return scheduler.send(agent, a.to, a.message, { rosterVersion: a.rosterVersion })
      },
    }),
    defineTool({
      name: 'agent_list',
      description: 'List this session\'s workers with their state (and "open": how many requests each has not answered yet, "createdFor": the fork-N or r-N it was created for), the open requests, and the rosterVersion that agent_create and agent_send require. Forks are the router\'s own one-message agents, not workers, and are left out unless you ask for them with forks: true.',
      parameters: {
        forks: { type: 'boolean', description: 'Also list forks, archived ones included: a debugging view, not part of routing.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const withForks = (args as { forks?: boolean }).forks === true
        const ledger = scheduler.ledgerOf(caller(exec))
        return {
          agents: [...ledger.members.values()].filter(m => withForks || m.kind === 'worker').map(m => ({
            name: m.name, kind: m.kind, state: m.state === 'started' ? status(m.id) : m.state,
            ...(m.kind === 'fork' ? { input: m.text.slice(0, 120) } : { role: m.role ?? '' }),
            ...(m.cwd === undefined ? {} : { cwd: m.cwd }),
            ...(m.model === undefined ? {} : { model: m.model }),
            ...(m.createdFor === undefined ? {} : { createdFor: m.createdFor }),
            // Requests it has not answered yet: a backlog to fork around, not to add to.
            ...(() => { const open = ledger.openTo(m.id).length; return open > 0 ? { open } : {} })(),
          })),
          openRequests: [...ledger.requests.values()].filter(r => r.state === 'sent').map(r => ({ id: r.id, from: ledger.nameOf(r.from), to: ledger.nameOf(r.to), text: r.text.slice(0, 120) })),
          queued: scheduler.queued(ledger.mainId),
          rosterVersion: scheduler.rosterVersion(ledger),
        }
      },
    }),
    defineTool({
      name: 'agent_interrupt',
      description: 'Stop the current round of a worker or fork. Its pending inbox is kept.',
      parameters: { name: { type: 'string', required: true } },
      output: { schema: OK, render: json },
      execute: async (args, exec) => { scheduler.interrupt(caller(exec), (args as { name: string }).name); return { interrupted: true } },
    }),
    defineTool({
      name: 'agent_archive',
      description: 'Archive a worker or fork you no longer need. Its session is kept; its name is never reused.',
      parameters: { name: { type: 'string', required: true } },
      output: { schema: OK, render: json },
      execute: async (args, exec) => { await scheduler.archive(caller(exec), (args as { name: string }).name); return { archived: true } },
    }),
    defineTool({
      name: 'role_set',
      description: 'Set the lead\'s role (omit agent) or a worker\'s role, only when the user asks for it. It applies from the next step and to later forks.',
      parameters: {
        text: { type: 'string', required: true },
        agent: { type: 'string', description: 'Worker name; omit for the lead.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { text: string; agent?: string }
        scheduler.setRole(caller(exec), a.text, a.agent)
        return { role: a.agent ?? 'lead' }
      },
    }),
    defineTool({
      name: 'report',
      description: 'Give the conclusion of this round explicitly; it goes to the lead in place of your final message. In a round answering requests it is their answer; in a round with no request (the user spoke to you directly) only a report reaches the lead, so call it when the user asks you to tell the lead.',
      parameters: { summary: { type: 'string', required: true } },
      output: { schema: OK, render: json },
      // The call itself is the record: the scheduler reads the summary from this round's log.
      execute: async (_args, exec) => { caller(exec); return { reported: true } },
    }),
  ]
}

/**
 * The system-prompt section. Identical for the lead and its forks so a fork keeps the lead's
 * cache prefix; workers get their own.
 * @param scheduler - the scheduler.
 * @param agent - the agent being assembled.
 * @returns section text.
 */
export function sectionFor(scheduler: Scheduler, agent: Agent): string {
  if (!scheduler.takesPart(agent)) return ''
  const role = scheduler.roleFor(agent)
  const ledger = scheduler.ledgerOf(agent)
  const isWorker = ledger.members.get(agent.id)?.kind === 'worker'
  // The lead with scheduling off talks to the user itself. A plain chat (no forks or workers yet)
  // gets no section at all, so the switch costs nothing until the lead first creates a worker;
  // the tool descriptions say enough for that first creation.
  if (isMainSession(agent) && !scheduler.isOn(agent)) {
    if (ledger.state.members.length === 0) return ''
    return ['# Agent Scheduler', LEAD_OFF_NOTICE, ...(role !== undefined && role !== '' ? [`Role:\n${role}`] : [])].join('\n')
  }
  const lines = isWorker
    ? [
        '# Agent Scheduler: worker',
        `Your name is "${scheduler.ledgerOf(agent).members.get(agent.id)?.name ?? ''}" (the user may rename you; this is the current one).`,
        'You are a long-lived worker. Requests arrive as "[request r-N from name]". Answer each, then end your turn: your final message (or report) goes to the lead automatically as the answer. The user may also talk to you directly; those messages are not requests and your replies stay in your chat, except a report, which goes to the lead as "[report from <your name>, not a request]". You may delegate with agent_send; that answer also goes to the lead. Do not use send_message.',
      ]
    : [
        '# Agent Scheduler',
        'The user talks to a lead; every user message is handed to a fresh fork of the lead.',
        FORK_NOTICE,
        LEAD_NOTICE,
        'Workers are long-lived agents with their own sessions. Use agent_list to see them, agent_create to make one, agent_send to delegate; both take the rosterVersion from agent_list and run one at a time per session. Every answer comes to the lead as "[reply to r-N from name, asked by ...]"; forks do not wait for them. Do not use send_message or the subagent tools for this.',
      ]
  if (role !== undefined && role !== '') lines.push(`Role:\n${role}`)
  return lines.join('\n')
}
