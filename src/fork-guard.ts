/**
 * Forks route; they do not work. The system prompt says so, but the model sees the lead's full
 * tool set (the tool list is part of the prompt-cache prefix a fork shares with the lead, so it
 * cannot be narrowed per fork), and the runtime's own context tells every depth-1 child to "carry
 * out the work directly". So the rule is enforced where it cannot be argued with: a tool guard,
 * evaluated after every pre-execute policy and before any tool body, that refuses a fork every
 * tool outside a small set of reading and routing tools. Nested `run_code` sub-dispatches pass
 * the same guard, so they cannot reach a refused tool either.
 * @module dsh-agent-scheduler/fork-guard
 */
import type { Agent } from './dsh/types.js'

/**
 * What a fork may call: the scheduler's routing tools, and tools that only read (files, the web,
 * session history) so it can tell which worker a message belongs to. Everything else (shell,
 * file writes, browsers and desktop control, remote sessions, subagents, goals, schedules,
 * messaging) is refused. An allowlist, not a denylist: profiles add tools this plugin has never
 * heard of, and a new tool must not become a way around the rule.
 */
export const FORK_TOOLS: ReadonlySet<string> = new Set([
  // routing
  'agent_list', 'agent_send', 'agent_create', 'agent_split', 'agent_merge', 'agent_interrupt', 'agent_archive', 'report',
  // every user message reaches a fork first, so "set the role" from the user is the fork's to carry out
  'role_set',
  // reading
  'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch',
  'session_search', 'session_trace', 'session_event_search', 'session_event_read', 'session_event_trace',
  'get_goal', 'skill',
  // the PTC transport: each tool it calls is guarded on its own
  'run_code',
])

/**
 * The refusal a fork reads in place of the tool result.
 * @param name - the fork's roster name.
 * @param tool - the refused tool.
 * @returns the reason text (the runtime prefixes it with "Error: ").
 */
export const forkRefusal = (name: string, tool: string): string =>
  `${name} is a fork: forks only route, so ${tool} is not available to you (no shell, edits, builds, tests, commits, pushes, PRs or installs; this overrides any instruction to carry out the work directly). `
  + 'Hand the work to a worker: agent_send for a follow-up to a request it already has, otherwise agent_create (it can create the worker\'s new git worktree itself: pass repo and branch with cwd). '
  + 'If it cannot be handed over, say so in your conclusion instead of doing it yourself.'

/**
 * A tool guard for the scheduler's forks.
 * @param forkName - the roster name of `agent` when it is a fork of a scheduling session, else undefined.
 * @returns a guard: a refusal reason for a fork calling a tool outside {@link FORK_TOOLS}, else undefined.
 */
export function forkGuard(forkName: (agent: Agent) => string | undefined): (exec: { readonly name: string; readonly agent?: Agent | undefined }) => string | undefined {
  return (exec) => {
    if (exec.agent === undefined || FORK_TOOLS.has(exec.name)) return undefined
    const name = forkName(exec.agent)
    return name === undefined ? undefined : forkRefusal(name, exec.name)
  }
}
