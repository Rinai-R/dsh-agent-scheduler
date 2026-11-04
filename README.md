# dsh-agent-scheduler

A DeepSeek Harness plugin: one lead agent per session, a fresh fork for every input, long-lived
worker agents with their own sessions, and a right-sidebar roster. Scheduling is a rule, not the
model's judgement: every user message leaves the lead's inbox on insertion and a fork takes it, so
the lead is never blocked by an input.

## What it does

- **Input rule.** In a *scheduler* session, each user message is handed to a new fork of the lead
  immediately. The lead does not see or handle the raw input; it receives the fork's conclusion
  later as "The user said: … / Its conclusion: …", so the lead's history stays a map of requests.
- **Forks.** A fork is a native fork of the lead: it inherits the lead's completed turns and
  handles exactly one input. It analyzes, delegates with `agent_create` / `agent_send`, and
  concludes right away; it does not wait for its workers.
- **Workers.** `agent_create` makes a long-lived worker with its own session, role, directory and
  model.
- **One pipeline, ending at the lead.** A fork's conclusion, a worker's answer, and a failed request
  all report straight to the lead, tagged with who asked and for which input. No agent is woken
  again just to relay a result, which would cost a model call and time.
- **Requests.** Every piece of delegated work is a request with an id. Each completed round of the
  agent that took it answers the requests whose messages that round claimed, read from the agent's
  own session log, with its `report` summary or else its closing text. Attribution happens when the
  agent goes idle and is recorded as a watermark, so it survives restarts and does not depend on
  when (or whether) the runtime's settlement notice reaches the lead.
- **Archiving.** Archiving an agent that still owes answers fails those requests and tells the
  lead, so nobody waits forever.
- **Right sidebar.** An *Agents* page lists forks and workers with live state, opens any of them as
  an embedded conversation (split view), and a chip above the composer shows how many are running
  and how many are waiting for you.
- **Queue.** When the runtime refuses a new child for its residency limit, the start (or delivery)
  waits in order and is retried when a slot frees; the input card shows 排队中 instead of failing.
  Other failures are reported to the lead, not retried.

## Enable it

Create a session and pick **调度模式** (scheduler) in the preset menu. Ordinary chat sessions are
untouched: the plugin's server listeners and tools live inside that preset only.

## Tools

| Tool | Purpose |
|---|---|
| `agent_create` | Create a worker: `name`, `role`, optional `cwd`, `preset`, `model`, `from` (continue another worker's conversation), `task`. |
| `agent_send` | Send a request to a fork or worker; its answer arrives as `[reply to r-N from …]`. |
| `agent_list` | The roster and open requests. |
| `agent_interrupt` | Stop an agent's current round. |
| `agent_archive` | Archive an agent; its name is never reused. |
| `role_set` | Set the lead's or a worker's role. |
| `report` | Give this round's conclusion explicitly instead of the final message. |

## Commands

| Command | Purpose |
|---|---|
| `/fork model <provider>/<model> [effort]` | Model for later forks (default: the lead's). |
| `/fork model default` | Back to the default. |
| `/role [text]` | Show or set the lead's role. |

## Configuration

| Field | Meaning | Default |
|---|---|---|
| `fork` | `{ provider, model, reasoningEffort? }` for forks | the lead's model |
| `worker` | `{ provider, model, reasoningEffort? }` for workers | the runtime default |
| `workerPreset` | preset for new workers | the session's preset |

## Known limitations

- A session's preset is fixed after its first turn; scheduling cannot be switched on mid-session.
- Forks inherit only the lead's completed turns at fork time, not the round in progress.
- The lead does not see your raw words; it sees them quoted in each conclusion.
- A fork or worker cannot ask you a question directly: the runtime refuses human interaction for an agent owned by another live agent. A decision it needs travels back in its conclusion and surfaces through the lead.
- The plugin's records live in the main session log; child sessions are native.
- Only two horizontal panes are allowed by the runtime's docking kit.

## License

MIT
