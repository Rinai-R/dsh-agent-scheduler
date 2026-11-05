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
  an embedded conversation (split view) beside the roster, which keeps a column of its own.
- **Switch.** 「调度」 in the composer's mode row (next to access mode and Plan) turns scheduling on
  or off at any time, also `/schedule on|off`. While on it is a blue chip with live counts: click
  it for the Agents page, click its glyph (× on hover) to turn it off.
- **Queue.** When the runtime refuses a new child for its residency limit, the start (or delivery)
  waits in order and is retried when a slot frees; the input card shows 排队中 instead of failing.
  Other failures are reported to the lead, not retried.

## Install

Requires DeepSeek Harness `>=0.2.1-rc.5 <0.3.0` (see `engines.dsh`).

```bash
dsh plugin add dsh-agent-scheduler            # latest release from npm
dsh plugin add dsh-agent-scheduler@next       # latest prerelease
dsh plugin --profile web add dsh-agent-scheduler   # into a specific profile
```

Each GitHub Release also carries the packed `.tgz`; install it with
`dsh plugin add ./dsh-agent-scheduler-<version>.tgz`. When reinstalling a tarball, give it a new
file name: the package manager does not replace the contents of a same-named tarball. Restart
`dsh` (or the desktop app) afterwards.

## Enable it

The plugin overrides the shipped `standard` preset with its own rows unchanged plus the scheduler
rule, so every new session can schedule. Each session starts off and behaves as an ordinary chat
until you turn 「调度」 on; turning it off returns later messages to the lead, and forks and
workers already there keep running and still answer to it. The scheduler tools are listed in every
session (a stable tool list keeps the prompt cache) and refuse while the switch is off.

The old **调度（旧会话）** preset stays only so sessions created with it still open; those sessions
start with the switch on.

## Tools

| Tool | Purpose |
|---|---|
| `agent_create` | Create a worker: `name`, `role`, optional `cwd`, `preset`, `model`, `from` (continue another worker's conversation), `task`. |
| `agent_send` | Send a request to a fork or worker; its answer arrives as `[reply to r-N from …]`. |
| `agent_list` | The workers, their backlog and the open requests (`forks: true` adds the transient forks). |
| `agent_interrupt` | Stop an agent's current round. |
| `agent_archive` | Archive an agent; its name is never reused. |
| `role_set` | Set the lead's or a worker's role. |
| `report` | Give this round's conclusion explicitly instead of the final message. |

## Commands

| Command | Purpose |
|---|---|
| `/fork` | Explains that forks always use the lead's model (and its prompt cache); forks have no model setting. |
| `/worker model <provider>/<model> [effort]` | Model for later workers when the lead names none (default: the runtime default). |
| `/worker model default` | Back to the default. |
| `/role [text]` | Show or set the lead's role. |

## Configuration

| Field | Meaning | Default |
|---|---|---|
| `fork` | Retired and ignored: forks always use the lead's model | — |
| `worker` | `{ provider, model, reasoningEffort? }` for workers | the runtime default |
| `workerPreset` | preset for new workers | the session's preset |

## Known limitations

- Overriding `standard` copies its rows from the dsh version the patch was generated for
  (`scripts/gen-preset.mjs`); regenerate after a dsh upgrade, or the preset keeps the old rows.
  Another bundle that also overrides `standard` conflicts with this one.
- Switching changes the lead's system prompt (the scheduler section appears or goes), so the next
  lead request misses the prompt cache once.
- Forks inherit only the lead's completed turns at fork time, not the round in progress.
- The lead does not see your raw words; it sees them quoted in each conclusion.
- A fork or worker cannot ask you a question directly: the runtime refuses human interaction for an agent owned by another live agent. A decision it needs travels back in its conclusion and surfaces through the lead.
- The plugin's records live in the main session log; child sessions are native.
- Only two horizontal panes are allowed by the runtime's docking kit.

## License

MIT
