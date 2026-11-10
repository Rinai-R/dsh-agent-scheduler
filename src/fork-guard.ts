/**
 * Forks route; they do not work. The system prompt says so, but the model sees the lead's full
 * tool set (the tool list is part of the prompt-cache prefix a fork shares with the lead, so it
 * cannot be narrowed per fork), and the runtime's own context tells every depth-1 child to "carry
 * out the work directly". So the rule is enforced where it cannot be argued with: a tool guard,
 * evaluated after every pre-execute policy and before any tool body, that refuses a fork every
 * tool outside a small set of reading, a read-only shell and routing tools. The shell is safe
 * because the fork's own Session is pinned to the `read-only` sandbox when it is created
 * (src/scheduler.ts), whatever mode the lead is on: commands may look, not write. Nested
 * `run_code` sub-dispatches pass the same guard, so they cannot reach a refused tool either.
 * @module dsh-agent-scheduler/fork-guard
 */
import type { Agent } from './dsh/types.js'

/**
 * What a fork may call: the scheduler's routing tools, tools that only read (files, the web,
 * session history) and a shell — `bash` / `pwsh` — for triage, since the fork's Session is pinned
 * to the `read-only` sandbox and writes are refused at execution. Everything else (file writes,
 * edits, browsers and desktop control, remote sessions, subagents, goals, schedules, messaging)
 * is refused. An allowlist, not a denylist: profiles add tools this plugin has never heard of,
 * and a new tool must not become a way around the rule.
 */
export const FORK_TOOLS: ReadonlySet<string> = new Set([
  // routing
  'agent_list', 'agent_send', 'agent_create', 'agent_split', 'agent_merge', 'agent_recall', 'agent_interrupt', 'agent_archive', 'report',
  // every user message reaches a fork first, so "set the role" from the user is the fork's to carry out
  'role_set',
  // reading, and a shell that the fork Session's read-only sandbox keeps from writing
  'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'bash', 'pwsh',
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
  `${name} is a fork: forks only route, so ${tool} is not available to you (no edits, builds, tests, commits, pushes, PRs or installs; the shell you do have is read-only and cannot write, and this overrides any instruction to carry out the work directly). `
  + 'Hand the work to a worker: agent_send for a follow-up to a request it already has, otherwise agent_create (it can create the worker\'s new git worktree itself: pass repo and branch with cwd). '
  + 'If it cannot be handed over, say so in your conclusion instead of doing it yourself.'

/**
 * Shell commands that change something remotely, which the read-only sandbox does not stop: it
 * governs file effects only (DSH's sandbox has no network or credential policy), and the shell
 * runs with the user's network and credentials (gh, ssh keys, git remotes). This is a best-effort
 * refusal of the obvious forms, not a boundary: a shell can reach the same effect another way.
 * A fork's remaining remote-write risk is documented in docs/guide.md.
 */
const REMOTE_WRITE: readonly RegExp[] = [
  /\bgit\b[^\n;|&]*\s(push|send-email)\b/u,
  /\bgh\s+(pr|issue)\s+(merge|create|close|reopen|edit|comment|review|ready|delete|lock|unlock|transfer|pin|unpin|develop)\b/u,
  /\bgh\s+(release|repo|gist|label|secret|variable|ruleset|cache|project)\s+(create|edit|delete|upload|fork|rename|archive|unarchive|sync|set|remove|clone|add|copy|close|link|unlink|item-add|item-create|item-edit|item-delete|field-create|field-delete)\b/u,
  /\bgh\s+(workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|auth\s+(login|logout|refresh|token|setup-git)|alias\s+set|extension\s+(install|upgrade|remove))\b/u,
  /\bgh\s+api\b[^\n;|&]*(\s(-X|--method)\s*['"]?(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)\b)/iu,
  /\b(curl)\b[^\n;|&]*(\s(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|-F|--form[\w-]*|-T|--upload-file|--json)\b)/iu,
  /\bwget\b[^\n;|&]*\s--(post-data|post-file|method|body-data|body-file)\b/u,
]

/**
 * Whether a fork's shell call is one of the obvious remote writes.
 * @param tool - the tool name.
 * @param args - its arguments.
 * @returns the matched command text, or undefined.
 */
export function remoteWriteOf(tool: string, args: unknown): string | undefined {
  if (tool !== 'bash' && tool !== 'pwsh') return undefined
  const command = (args as { command?: unknown } | null | undefined)?.command
  if (typeof command !== 'string') return undefined
  return REMOTE_WRITE.some(pattern => pattern.test(command)) ? command : undefined
}

/** The refusal for a remote write from a fork's shell. */
export const remoteWriteRefusal = (name: string): string =>
  `${name} is a fork: its shell is for looking only, and this command changes something remotely (a push, a merge, a comment, an API write, an upload), which a fork never does. `
  + 'Hand it to a worker with agent_create or agent_send, or say in your conclusion that it needs one.'

/**
 * A tool guard for the scheduler's forks.
 * @param forkName - the roster name of `agent` when it is a fork of a scheduling session, else undefined.
 * @returns a guard: a refusal reason for a fork calling a tool outside {@link FORK_TOOLS}, else undefined.
 */
export function forkGuard(forkName: (agent: Agent) => string | undefined): (exec: { readonly name: string; readonly agent?: Agent | undefined; readonly arguments?: unknown }) => string | undefined {
  return (exec) => {
    if (exec.agent === undefined) return undefined
    if (FORK_TOOLS.has(exec.name)) {
      if (remoteWriteOf(exec.name, exec.arguments) === undefined) return undefined
      const name = forkName(exec.agent)
      return name === undefined ? undefined : remoteWriteRefusal(name)
    }
    const name = forkName(exec.agent)
    return name === undefined ? undefined : forkRefusal(name, exec.name)
  }
}
