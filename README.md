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
- **Coarse workers that split on a collision.** A new area gets one worker for the whole repository
  or module. A follow-up goes to the worker that already has the request, and a new task to an idle
  owner. A new task in an area whose worker is running or already has open requests splits it:
  `agent_split` renames the owner to the work it keeps and forks a new worker for the new task in
  its own worktree, both sharing the area, so it runs in parallel instead of queueing. A fork never
  waits for its workers.
- **A roster in the sidebar.** The Agents page lists forks and workers with live state and open
  requests, and opens any of them as an embedded conversation beside the roster. Both the page and
  the chats stay mounted, so switching tabs does not reload a conversation.
- **Know what to review.** A member that reported and that you have not opened yet keeps a solid
  dot: green for a result, red for a failure; yellow while a permission prompt or question waits for
  you. Opening it clears the mark, and the read is recorded in the session, so a restart does not
  bring it back.
- **Models where they belong.** Forks always run on the lead's model, so they reuse its prompt
  cache. A worker takes an explicit `model`, then the `/worker model` default (also in the Agents
  page), then the plugin config, then the runtime default; each worker can override its own from
  its chat.
- **Restart-aware.** A request cut off by a dsh restart either fails and is reported, or resumes in
  the worker's own session, according to the recovery policy.

## Getting Started

The plugin's interface and command replies follow DeepSeek Harness's language setting (Chinese or English), switching without a reload; prompts and tool descriptions for the model stay English.

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
same-named tarball. Restart dsh (quit and reopen the desktop app) after installing or updating; the
「调度」 (Scheduling) chip then appears in every session, whatever its preset.

### Turn scheduling on

New sessions start with scheduling off and behave as an ordinary chat. In
the composer's mode row, next to access mode and Plan, click 「调度」 (Scheduling); a bare
`/schedule` also turns it on. The chip turns blue, and an Agents button appears beside it with the
most urgent count — `N 等你` (waiting), `N 在跑` (running), `N 排队` (queued), `N 失败` (failed) —
or the number of agents.

Click the chip again (its fork glyph becomes × on hover) or run `/schedule off`. Later messages go
back to the lead; forks and workers already running keep running and still report their results.
Switching changes the lead's system prompt, so the next lead request misses the prompt cache once.

The switch decides one thing only: whether each user message is handed to a new fork. With it
off, the user talks to the lead directly and the lead answers itself, but it keeps every worker
tool — `agent_list`, `agent_create`, `agent_split`, `agent_send`, `agent_interrupt`,
`agent_archive`, `role_set` and `report` — under the same dispatch lock and `rosterVersion` check. Workers' answers, reports
and failures still come to the lead. Because there is no fork in between, `for` is optional on the
lead's `agent_create` and `agent_split` while scheduling is off (a named `fork-N` or `r-N` is still checked and
still gets one worker); with it on, the lead must name one as before. A fork created while
scheduling was on stays a router after the switch goes off. The tools are registered in every
session of the preset (a stable tool list keeps the prompt cache); an off session with no forks or
workers has no scheduler section in its system prompt, and gets a short lead-only one from its
first worker on.

### The Agents page

Open the page from the Agents button. A handed-off message's status card opens that fork directly
(「查看」). The page groups 「分身」 (forks), 「Worker」, 「已交回」 (concluded forks), and 「已归档」
(archived). A row shows live state — 在跑, 在等你, 空闲, 已交回, 排队中, 失败, 已归档 — the requests
it still owes (`N 个请求待回答`), and a second line: why it failed, else its oldest open request,
else what a fork was asked or a worker's duty (prefixed with its area after a split); a worker's
directory is in the row's tooltip. Archived rows are one compact line, and past eight of them the
rest fold behind 「再显示 N 个」. When the list runs past the bottom, a pinned hint says
「下面还有 N 个 · M 个等你 · K 个未读」; clicking it scrolls to the first hidden row.

Click a row to open that agent's own native conversation in the other pane, with the roster keeping
a narrow column of its own. At most two horizontal panes are allowed, so the page arranges the split
the way you could by hand: the roster on the left, agent chats as tabs on the right. Both the Agents
page and the chats are `keepMounted`: switching tabs or closing a neighbour does not remount a chat
and reload its conversation from the top.

The **+** at the top opens a small form (name, duty, optional directory) that runs `/agents new`;
the pencil on a worker row renames it in place (`/agents rename`; Enter saves, Esc cancels). A
renamed worker keeps its old names reserved, and they still reach it.

Archive a row from the button that appears on hover; archived names are never reused. 「全部归档」
(or `/agents archive done`) archives every concluded fork that owes no answer. The 「Worker 默认模型」
menu at the top sets the `/worker model` default.

**Unread reports.** After a member reports (an answer or failure, a fork's conclusion, a failed
start) its dot turns solid with a halo until you open it (or its pill in the main chat): green for
a result, red for a failure; yellow while it waits for you on a permission prompt or question, read
or not. Opening it sends `/agents seen`, a `seen` record, so a restart does not light it again;
「全部已读」 at the top (`/agents seen all`) reads them all at once.
Unread members stay in 分身 / Worker even when archived; the folds hold only what was read. Section
titles and the composer's Agents button count them.

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
| `/agents new <name> [--cwd <dir>] [--model <provider>/<model>[:effort]] <role>` | Create a worker you name yourself, with no task; talk to it in its chat, or the lead sends it requests. The Agents page's **+** does the same. |
| `/agents rename <name> <new-name>` | Rename a worker (not a fork, not an archived one). The old name stays reserved and still reaches it. The pencil on a worker row does the same. |
| `/agents archive <name>` | Archive a fork or worker; requests it still owes fail and the lead is told. |
| `/agents archive done` | Archive every concluded fork that owes no answer. |
| `/agents seen <name>` | Mark a member's latest report read (the Agents page sends it when you open the member). |
| `/agents seen all` | Mark every unread report read (the Agents page's 「全部已读」). A session from before review marks shows its past reports unread once. |
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
| `agent_create` | Start a worker: `name`, `role`, `rosterVersion` (from `agent_list`), optional `cwd`, `preset`, `model`, `from` (continue another worker's conversation), `task`; the lead also passes `for` (the `fork-N` or `r-N` it acts on); `repo` + `branch` (+ `base`, default `origin/main`) first create `cwd` as a new git worktree. |
| `agent_split` | Split a busy worker's area for a new task: `owner`, `ownerName` + `ownerRole` (the narrower work it keeps), `name` + `role` + `task` for the new worker, `cwd` (or `repo` + `branch`), `rosterVersion`, and `for` from the lead. The owner is renamed like `/agents rename` (its old names stay reserved); the new worker continues its conversation, or starts fresh while the owner has no completed round. Both carry the `area`; the Agents page keeps them together. |
| `agent_send` | Send a request to a fork or worker, with `rosterVersion`; its answer arrives as `[reply to r-N from …]`. Use it for a follow-up to work the target already has, not for a new parallel task. |
| `agent_list` | The workers (with `createdFor`) and the open requests, with `open` counts and the `rosterVersion`; pass `forks: true` to see the one-message forks too. |
| `agent_interrupt` | Stop an agent's current round; its pending inbox is kept. |
| `agent_archive` | Archive an agent; its session is kept and its name is never reused. |
| `role_set` | Set the lead's or a worker's role, only when the user asks for it. |
| `report` | Give this round's conclusion explicitly instead of the final message. |

### Dispatch lock

`agent_create` and `agent_send` of one main session (lead, forks and workers alike) run one at a
time, in arrival order, each reading the roster, checking, creating or delivering, and recording
inside the lock; a failure releases it. Both require the `rosterVersion` from `agent_list` (or from
the previous dispatch); it changes whenever a worker is added or changes state or a request is sent
or settled, and a dispatch made on an older version is refused with the current roster (workers,
their state and backlog, and the newest creations with who made them for which input). Each input
gets at most one worker: a fork creates at most one for its own message, and the lead names with
`for` the `fork-N` or `r-N` it acts on, so a worker a fork already created is not created again
from its conclusion.

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

**Rows and switch.** `cordis.patch.yml` inserts two top-level rows: the host row and the scheduler
rule. A top-level row reaches the Agents of every preset, so the plugin changes no preset and a dsh
upgrade leaves it alone. Turning the switch off returns later messages to the lead, which can still
create and use workers; existing forks and workers keep running and still answer to it.

**DSH adapter.** Everything that depends on DeepSeek Harness itself (its services, event and
message formats, runtime wording, the sidebar's DOM and layout) lives in `src/dsh/`; the rest of
the plugin calls only that layer. On a dsh that lacks a service scheduling needs (the tool guard
above all), the rule schedules nothing and every command says what is missing. See
[docs/dsh-adapter.md](docs/dsh-adapter.md).

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
the session. The rule row (`agent-scheduler-rule`) in the profile config still accepts `worker` (a
fallback model for new workers when neither `agent_create` nor `/worker model` names one) and
`workerPreset` (the preset for new workers; empty inherits the session's). `fork` is retired and
ignored: forks always use the lead's model.

## Known limitations

- The scheduler's tools, commands and switch are present in sessions of every preset, not only
  `standard`. With scheduling off and no workers the system prompt has no scheduler section and
  no message is forked, but the eight tools (`agent_*`, `role_set`, `report`) are still in every
  request's tool list (about 8.6 KB of definitions, e.g. 3 → 11 tools in the minimal preset), and
  since the switch only decides who takes user messages, the lead there can use them.
- Sessions created with the retired `调度（旧会话）` preset (plugin versions before 0.1.0-rc.3) no
  longer open: that preset was removed with the `standard` override.
- Switching changes the lead's system prompt (the scheduler section appears or goes), so the next
  lead request misses the prompt cache once.
- Forks only route. A tool guard refuses a fork every tool except reading (`read`, `glob`, `grep`,
  web and session search) and the `agent_*`, `role_set` and `report` tools, so a fork cannot run
  commands, edit files, commit, push or start subagents; the refusal tells it to hand the work to a
  worker or say in its conclusion that it could not.
- A fork inherits only the lead's completed turns at fork time, not the round in progress.
- The lead does not see your raw words; it sees them quoted in each conclusion.
- A fork or worker cannot ask you a question directly: the runtime refuses human interaction for an
  agent owned by another live agent. A decision it needs travels back in its conclusion and
  surfaces through the lead.
- The busy-worker reroute is guidance, not a hard block: `agent_send` still delivers to a busy
  worker and steers the request into its current round, where it is answered at the end of that
  round. A new worktree is created only when `agent_create` is given `repo` and `branch`; `cwd`
  must not exist yet, and an existing directory or branch is refused with git's own message.
- Only two horizontal panes are allowed by the runtime's docking kit.

## Development

Requires Node.js `^22.19.0 || >=24`.

- `src/index.ts`: the host row — the `fork-from` provider, the roster projection and recovery policy.
- `src/rule-plugin.ts`: the rule row — commands, system-prompt section and tool registration.
- `src/dsh/`: the DSH adapter — host (`host/`) and browser (`client/`) halves, the only code that
  touches DeepSeek Harness directly.
- `src/scheduler.ts`: the input rule, queue, requests, settlement and restart recovery.
- `src/client/`: the browser half — input cards, the composer switch, the Agents page and model
  pickers.
- `tests/`: vitest specs for the host and client halves; `tests/contract/` checks every DSH
  dependency against a real DSH release.

```bash
npm install
npm run build          # compile the host half and bundle dist/client.js
npm run typecheck
npm test
npm run contract       # contract tests against the pinned dsh (fetches its browser bundles)
npm run contract:next  # the same against npm's `next` dsh (reinstalls, then restores)
npm pack --dry-run
```

CI runs typecheck, build, test and `npm pack --dry-run` on Node 24, and the contract tests against
the pinned dsh and against `next` (advisory) on every PR and weekly. When a new dsh is released:
run `npm run contract:next`, fix what fails in `src/dsh/`, then widen `engines.dsh` and the peer
ranges together (`DSH_RANGE` in `src/dsh/host/version.ts` must match).

## License

MIT.
