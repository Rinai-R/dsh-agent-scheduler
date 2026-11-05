<p align="center">
  <img src="icon.svg" width="64" height="64" alt="Agent Scheduler logo">
</p>

<h1 align="center">Agent Scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">Every message gets its own fork; every area gets its own worker.</p>

Agent Scheduler is an open source plugin for DeepSeek Harness (dsh). It turns the main
conversation into a dispatcher: with scheduling on, each user message leaves the lead's inbox on
arrival and a fresh fork takes it, while long-lived workers keep their own sessions, directories
and models. Forks route, workers work, and every request, reply and conclusion reports back to the
lead — the only agent whose replies you read.

- **Every message, its own fork.** While scheduling is on, the input leaves the lead's inbox the
  moment it is inserted, so the lead is never blocked by an input. The fork inherits the lead's
  completed turns, handles that one message, and is archived when it concludes; its session stays,
  and you can open it from the status card under your message.
- **Workers that stay.** `agent_create` starts a long-lived worker with its own session, role, and
  optionally a directory, preset, model and `from` (continue another worker's conversation). A task
  becomes its first request. Two active workers cannot declare the same `cwd`.
- **Requests with receipts.** Every delegated piece of work is an `r-N` request. Each completed
  round of the agent that took it answers the requests its messages claimed, read from the agent's
  own log: the `report` summary, or else its closing text. Answers arrive as
  `[reply to r-N from name, asked by …]`.
- **One pipeline, ending at the lead.** A fork's conclusion, a worker's answer, a `report` and a
  failed request all go straight to the lead, tagged with who asked and for which input. No agent is
  woken again just to relay a result.
- **Busy worker, new worktree.** A follow-up goes to the worker that already has the request. A new
  task in an area whose worker is running or already has open requests goes to a new worker
  continued from that owner (`from`), with its own worktree as `cwd`, so it runs in parallel
  instead of queueing. A fork never waits for its workers.
- **A roster in the sidebar.** The Agents page lists forks and workers with live state and open
  requests, and opens any of them as an embedded conversation beside the roster. Both the page and
  the chats stay mounted, so switching tabs does not reload a conversation.
- **Models where they belong.** Forks always run on the lead's model, so they reuse its prompt
  cache. A worker takes an explicit `model`, then the `/worker model` default (also in the Agents
  page), then the plugin config, then the runtime default; each worker can override its own from
  its chat.
- **Restart-aware.** A request cut off by a dsh restart either fails and is reported, or resumes in
  the worker's own session, according to the recovery policy.

## Getting Started

### Prerequisites

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`, the range required by `engines.dsh`.
- A dsh profile to install into; the desktop app's default profile works.

### Plugin

In dsh, open **Plugins → Install a third-party plugin** and enter `dsh-agent-scheduler`. Or from a
terminal:

```bash
dsh plugin add dsh-agent-scheduler                   # latest release from npm
dsh plugin add dsh-agent-scheduler@next              # latest prerelease
dsh plugin add ./dsh-agent-scheduler-0.1.0-rc.2.tgz  # the tarball attached to a release
dsh plugin --profile web add dsh-agent-scheduler     # into a specific profile
```

Give a reinstalled tarball a new file name: the package manager does not replace the contents of a
same-named tarball. Restart dsh (quit and reopen the desktop app) after installing or updating. A
session that was already open before the install keeps its old preset; after the restart, reopen it
or start a new session to get the 「调度」 (Scheduling) chip.

### Turn scheduling on

New sessions in the default preset start with scheduling off and behave as an ordinary chat. In
the composer's mode row, next to access mode and Plan, click 「调度」 (Scheduling); a bare
`/schedule` also turns it on. The chip turns blue, and an Agents button appears beside it with the
most urgent count — `N 等你` (waiting), `N 在跑` (running), `N 排队` (queued), `N 失败` (failed) —
or the number of agents.

Click the chip again (its fork glyph becomes × on hover) or run `/schedule off`. Later messages go
back to the lead; forks and workers already running keep running and still report their results.
Switching changes the lead's system prompt, so the next lead request misses the prompt cache once.

The scheduler tools are registered in every session of the preset (a stable tool list keeps the
prompt cache) and refuse while scheduling is off.

### The Agents page

Open the page from the Agents button. A handed-off message's status card opens that fork directly
(「查看」). The page groups 「分身」 (forks), 「Worker」, 「已交回」 (concluded forks), and 「已归档」
(archived). A row shows live state — 在跑, 在等你, 空闲, 已交回, 排队中, 失败, 已归档 — the requests
it still owes (`N 个请求待回答`), and a second line: why it failed, else its oldest open request,
else what a fork was asked or a worker's directory and duty. Archived rows are one compact line, and
past eight of them the rest fold behind 「再显示 N 个」.

Click a row to open that agent's own native conversation in the other pane, with the roster keeping
a narrow column of its own. At most two horizontal panes are allowed, so the page arranges the split
the way you could by hand: the roster on the left, agent chats as tabs on the right. Both the Agents
page and the chats are `keepMounted`: switching tabs or closing a neighbour does not remount a chat
and reload its conversation from the top.

Archive a row from the button that appears on hover; archived names are never reused. 「全部归档」
(or `/agents archive done`) archives every concluded fork that owes no answer. The 「Worker 默认模型」
menu at the top sets the `/worker model` default.

### Models

**Forks always use the lead's model.** A fork replays the lead's history, so sharing the model also
shares its prompt cache. There is no per-fork model: `/fork` explains this, and `/agent-model`
refuses a fork. To run a task on another model, give it to a worker.

**Workers** take a model in this order: the `model` given to `agent_create`, then the `/worker model`
default (also set from the Agents page), then the plugin's `worker` config, then the runtime default.
`/worker model <provider>/<model> [effort]` sets it; `/worker model default` clears it.

**One worker's own model** is set with `/agent-model <name> <provider>/<model> [effort]`, or from the
model menu in that worker's chat composer. It applies from its next model call, is read back from
the main session log when the worker is created again after a restart or resume, and
`/agent-model <name> default` returns it to the model it started with.

### Commands

All of these run in the main session.

| Command | Purpose |
|---|---|
| `/schedule [on \| off]` | Turn scheduling on (bare is on) or off for this session. |
| `/agents archive <name>` | Archive a fork or worker; requests it still owes fail and the lead is told. |
| `/agents archive done` | Archive every concluded fork that owes no answer. |
| `/worker` | Show the model later workers start with. |
| `/worker model <provider>/<model> [effort]` | Set the default model for later workers. |
| `/worker model default` | Back to the runtime default. |
| `/agent-model <name> <provider>/<model> [effort]` | One worker's own model, from its next model call. |
| `/agent-model <name> default` | Back to the model the worker started with. |
| `/role [text]` | Show or set the lead's role. It applies from the next step and to later forks. |
| `/fork` | Explains that forks always use the lead's model; a fork model can no longer be set. |

## Tools

| Tool | Purpose |
|---|---|
| `agent_create` | Start a worker: `name`, `role`, optional `cwd`, `preset`, `model`, `from` (continue another worker's conversation), `task`. |
| `agent_send` | Send a request to a fork or worker; its answer arrives as `[reply to r-N from …]`. Use it for a follow-up to work the target already has, not for a new parallel task. |
| `agent_list` | The workers and the open requests, with `open` counts; pass `forks: true` to see the one-message forks too. |
| `agent_interrupt` | Stop an agent's current round; its pending inbox is kept. |
| `agent_archive` | Archive an agent; its session is kept and its name is never reused. |
| `role_set` | Set the lead's or a worker's role, only when the user asks for it. |
| `report` | Give this round's conclusion explicitly instead of the final message. |

## How it works

**Input rule.** A user message inserted into a scheduled main session is logged once for the
composer when the log can hold it — so your chat keeps its bubble, images included — then shadowed
from the lead's model input and removed from its inbox. The lead's model input never contains them;
at most it leaves a one-line note. A fork of the lead inherits its completed turns at that moment
(not the round in progress), routes the message, and concludes; the conclusion reaches the lead as
`The user said: … / Its conclusion: …`. A fork is archived after concluding; speaking to it in its
chat wakes it, and it reports to the lead again. The session takes its title from the first input if
it has none.

**Requests and settlement.** Delegated work is a request with an id (`r-N`). A completed round
answers every open request whose message it claimed, with the summary it gave `report` or else its
closing text, read from the agent's own log. Attribution happens when the agent goes idle and is
recorded as a watermark, so it survives restarts and does not depend on when the runtime's
settlement notice arrives. Archiving an agent that still owes answers fails those requests and tells
the lead, so nobody waits forever. When the runtime refuses a child for its residency limit, the
start or delivery waits in a FIFO queue and is retried when a slot frees; the input card (for a
fork) or the roster row (for a worker) shows 排队中 instead of failing. Other failures are reported,
not retried.

**One pipeline.** Every fork and worker is a direct child of the main session, which sends on
everyone's behalf. A fork's conclusion, a worker's answer and a failure all end at the lead; a fork
delegates and concludes instead of waiting for its workers, and no agent is woken again just to
relay a result.

**State.** The plugin's records in the main session log are the only durable state. The host's
ledger and the client's `agentScheduler` projection are the same fold over those records, so what
the sidebar draws and what the scheduler routes by cannot drift apart. Child sessions are native;
restart recovery reads their logs rather than trusting what an agent says about itself.

**Preset and switch.** The plugin overrides the shipped `standard` preset with its rows unchanged
plus the scheduler rule, so every new session can schedule. The retired `调度（旧会话）` preset stays
only so sessions created with it still open; those start with scheduling on. Turning the switch off
returns later messages to the lead; existing forks and workers keep running and still answer to it.

## Configuration

### Restart recovery

On the Plugins page, open **Agent Scheduler**'s configuration. The two settings live on the plugin's
host row and apply live.

| Setting | Meaning | Default |
|---|---|---|
| `recovery.onInterrupted` | `fail`: mark work cut off by a restart failed and tell the lead. `resume`: continue it in the worker's own session. | `fail` |
| `recovery.maxResumes` | With `resume`, how many times one request may resume before it fails. | `2` |

With `fail`, the lead gets `interrupted by a DSH restart, not completed; resend it if it still
matters`, and nothing is resumed for it after the restart. With `resume`, only a worker is woken: it
gets a note in its own session to check the worktree, `git status` and `git log`, files and jobs it
had started, and to verify rather than repeat anything already done outside the session; then it
finishes the request and answers as usual. Each request resumes at most `maxResumes` times (0–10);
after that it fails as with `fail`. Forks are never resumed — they only route.

A restart also loses work still waiting in the queue: a start that never got a slot fails (a worker
together with its first request). A request that never reached its child fails. Rounds that
completed before the restart still settle normally. Recovery runs when a main session comes back and
reads only logs: open requests and member states from this session's plugin records, how each
child's rounds ended from the child's own log.

### Advanced configuration

Normal use needs no config file: `/worker model` and the Agents page record the worker default in
the session. The preset's rule row in the profile config still accepts `worker` (a fallback model
for new workers when neither `agent_create` nor `/worker model` names one) and `workerPreset` (the
preset for new workers; empty inherits the session's). `fork` is retired and ignored: forks always
use the lead's model. `defaultOn` belongs only to the retired `scheduler` preset.

## Known limitations

- The `standard` override copies its rows from the dsh version that generated `cordis.patch.yml`
  (currently `0.2.1-rc.5`). Regenerate after a dsh upgrade with `npm run gen:preset -- <dump.yml>`,
  or the preset keeps the old rows. Another bundle that also overrides `standard` conflicts with
  this one.
- Switching changes the lead's system prompt (the scheduler section appears or goes), so the next
  lead request misses the prompt cache once.
- A fork inherits only the lead's completed turns at fork time, not the round in progress.
- The lead does not see your raw words; it sees them quoted in each conclusion.
- A fork or worker cannot ask you a question directly: the runtime refuses human interaction for an
  agent owned by another live agent. A decision it needs travels back in its conclusion and
  surfaces through the lead.
- The busy-worker reroute is guidance, not a hard block: `agent_send` still delivers to a busy
  worker and steers the request into its current round, where it is answered at the end of that
  round. The scheduler never creates a worktree itself; the fork or lead runs `git worktree add`
  and passes the resulting `cwd`.
- Only two horizontal panes are allowed by the runtime's docking kit.

## Development

Requires Node.js `^22.19.0 || >=24`.

- `src/index.ts`: the host row — the `fork-from` provider, the roster projection and recovery policy.
- `src/rule-plugin.ts`: the preset row — commands, system-prompt section and tool registration.
- `src/scheduler.ts`: the input rule, queue, requests, settlement and restart recovery.
- `src/client/`: the browser half — input cards, the composer switch, the Agents page and model
  pickers.
- `tests/`: vitest specs for the host and client halves.

```bash
npm install
npm run build          # compile the host half and bundle dist/client.js
npm run typecheck
npm test
npm pack --dry-run
```

`npm run gen:preset -- <dump.yml>` rebuilds `cordis.patch.yml` from the output of
`dsh --profile web --dump-default-config`; the `standard` rows come from the dsh version that
produced the dump. CI runs typecheck, build, test and `npm pack --dry-run` on Node 24.

## License

MIT.
