/** Model tools. Every agent of the preset (lead, forks, workers) gets the same set. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FORK_NOTICE, LEAD_NOTICE, type Scheduler } from './scheduler.js'
import type { ForkModelSelection } from './records.js'

type Live = { get(id: never): Agent | undefined }

const OK = { type: 'object', additionalProperties: true, properties: {} } as const
/** The calling agent; tools only run inside an agent. */
function caller(exec: { agent?: Agent | undefined }): Agent {
  if (exec.agent === undefined) throw new Error('agent tools need a calling agent')
  return exec.agent
}
const json = (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

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
  return [
    defineTool({
      name: 'agent_create',
      description: 'Create a long-lived worker agent with its own session, for one repository or area. Give it a role, optionally a working directory (one worker per directory or worktree), a model ("provider/model"), a preset, and a first task; the task becomes a request whose answer goes to the lead, not back to you.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case name, never reused.' },
        role: { type: 'string', required: true, description: 'What this worker is responsible for.' },
        cwd: { type: 'string', description: 'Working directory or worktree, not shared with another active worker; omit to use the session\'s.' },
        preset: { type: 'string', description: 'Optional agent preset; default is this session\'s preset.' },
        model: { type: 'string', description: 'Optional "provider/model"; default is the configured worker model, then the runtime default.' },
        from: { type: 'string', description: 'Existing worker name: the new worker continues its conversation (then no preset).' },
        task: { type: 'string', description: 'Optional first request.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { name: string; role: string; cwd?: string; preset?: string; model?: string; from?: string; task?: string }
        return scheduler.createWorker(caller(exec), { name: a.name, role: a.role, cwd: a.cwd, preset: a.preset, task: a.task, from: a.from, model: a.model === undefined ? undefined : parseModel(a.model) })
      },
    }),
    defineTool({
      name: 'agent_send',
      description: 'Send a request to a worker or fork by name. Its answer goes to the lead as "[reply to r-N from name]", not back to you: do not wait for it.',
      parameters: {
        to: { type: 'string', required: true, description: 'Name of the worker or fork.' },
        message: { type: 'string', required: true, description: 'Self-contained request.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { to: string; message: string }
        return scheduler.send(caller(exec), a.to, a.message)
      },
    }),
    defineTool({
      name: 'agent_list',
      description: 'List forks and workers of this session with their state, and open requests.',
      parameters: {},
      output: { schema: OK, render: json },
      execute: async (_args, exec) => {
        const ledger = scheduler.ledgerOf(caller(exec))
        return {
          agents: [...ledger.members.values()].map(m => ({
            name: m.name, kind: m.kind, state: m.state === 'started' ? status(m.id) : m.state,
            ...(m.kind === 'fork' ? { input: m.text.slice(0, 120) } : { role: m.role ?? '' }),
            ...(m.cwd === undefined ? {} : { cwd: m.cwd }),
            ...(m.model === undefined ? {} : { model: m.model }),
          })),
          openRequests: [...ledger.requests.values()].filter(r => r.state === 'sent').map(r => ({ id: r.id, from: ledger.nameOf(r.from), to: ledger.nameOf(r.to), text: r.text.slice(0, 120) })),
          queued: scheduler.queued(ledger.mainId),
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
      description: 'Give the conclusion of this round explicitly. It replaces your final message as what goes to the lead.',
      parameters: { summary: { type: 'string', required: true } },
      output: { schema: OK, render: json },
      // The call itself is the record: the scheduler reads the summary from this round's log.
      execute: async () => ({ reported: true }),
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
  const role = scheduler.roleFor(agent)
  const isWorker = scheduler.ledgerOf(agent).members.get(agent.id)?.kind === 'worker'
  const lines = isWorker
    ? [
        '# Agent Scheduler: worker',
        'You are a long-lived worker. Requests arrive as "[request r-N from name]". Answer each, then end your turn: your final message (or report) goes to the lead automatically. You may delegate with agent_send; that answer also goes to the lead. Do not use send_message.',
      ]
    : [
        '# Agent Scheduler',
        'The user talks to a lead; every user message is handed to a fresh fork of the lead.',
        FORK_NOTICE,
        LEAD_NOTICE,
        'Workers are long-lived agents with their own sessions. Use agent_list to see them, agent_create to make one, agent_send to delegate. Every answer comes to the lead as "[reply to r-N from name, asked by ...]"; forks do not wait for them. Do not use send_message or the subagent tools for this.',
      ]
  if (role !== undefined && role !== '') lines.push(`Role:\n${role}`)
  return lines.join('\n')
}
