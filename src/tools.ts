/**
 * Model tools. Every agent gets the same set (a stable tool list keeps the prompt cache); the lead (scheduling on or off), its
 * forks and its workers may use it.
 */
import type { Agent, ToolDefinition } from './dsh/types.js'
import { defineTool, statusOf, type AgentLookup } from './dsh/host/index.js'
import { ownerOf } from './dsh/host/index.js'
import { DispatchRefused, FORK_NOTICE, isMainSession, LEAD_NOTICE, LEAD_OFF_NOTICE, type Scheduler } from './scheduler.js'
import type { ForkModelSelection } from './records.js'
import { mailPreview } from './projection.js'

type Live = AgentLookup

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
/**
 * @param scheduler - the scheduler.
 * @param agents - live Agents.
 * @param deps - a model validator (the host's own routability check); without one, a model the
 *   lead names is recorded as given.
 */
export function schedulerTools(scheduler: Scheduler, agents: Live, deps: { validateModel?: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<{ provider: string; model: string; reasoningEffort?: string }> } = {}): ToolDefinition[] {
  const status = (id: string): string => statusOf(agents, id) ?? 'idle'
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
  // The lead names what it acts on while scheduling is on, as with agent_create.
  const requireFor = (agent: Agent, named: string | undefined): void => {
    if (isMainSession(agent) && (named === undefined || named === '') && scheduler.isOn(agent)) throw new DispatchRefused('The lead must say what this is for: pass for: the fork-N whose conclusion or the r-N whose reply you act on.', scheduler.rosterSummary(scheduler.ledgerOf(agent)))
  }
  return [
    defineTool({
      name: 'agent_create',
      description: 'Create a long-lived worker: a session of its own in this workspace, which the user can also open and talk to directly. Start coarse, one worker per repository or module, named and described after it. Give it a role, optionally a worktree (cwd, created for you with repo and branch; it must be inside this workspace, and the worker may also work in other worktrees there), a model ("provider/model"), a preset, and a first task; the task becomes a request whose answer goes to the lead, not back to you. Call agent_list first and pass its rosterVersion: creations and deliveries of this session run one at a time, and one made on a roster that changed since is refused with the current roster. A fork creates at most one worker for its message; the lead names with for the fork-N or r-N it acts on, which also gets at most one (optional while scheduling is off, when the user talks to the lead directly).',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case name, never reused.' },
        role: { type: 'string', required: true, description: 'What this worker is responsible for.' },
        cwd: { type: 'string', description: 'A worktree for its first work, inside this workspace (a worker writes only inside the workspace its session was created in). With repo and branch, it is created for you as a new git worktree. Informational: the worker is not bound to it.' },
        repo: { type: 'string', description: 'With branch: an existing checkout of the repository; cwd (which must not exist yet) is created from it as a new git worktree on a new branch. Use it instead of running git yourself.' },
        branch: { type: 'string', description: 'New branch for the worktree at cwd, e.g. feat/<slug> or fix/<slug>.' },
        base: { type: 'string', description: 'What the new branch starts from; default origin/main (fetched first).' },
        preset: { type: 'string', description: 'Optional agent preset; default is this session\'s preset.' },
        model: { type: 'string', description: 'Optional "provider/model"; default is the user\'s worker model (Agents page or /worker model), then the configured worker model, then the runtime default.' },
        from: { type: 'string', description: 'Existing worker name: the new worker starts as a copy of its session (its conversation so far), then goes its own way.' },
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
      description: 'Send a request to a worker or fork by name, passing the rosterVersion from agent_list (refused when missing or stale, with the current roster). Its answer goes to the lead as "[reply to r-N from name]", not back to you: do not wait for it. Requests to one worker queue up and run in order, each as a turn of its own; a busy worker takes the next when its current turn ends. For work that should run in parallel, create another worker (agent_create, with from to start from this one\'s conversation).',
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
      description: 'List this session\'s workers with their state (and "open": how many requests each has not answered yet, "createdFor": the fork-N or r-N it was created for, "area": workers split from one area share it, "formerNames": names it had), the open requests, the lead\'s inbox (answers waiting for the lead, each summarized; the whole text reaches the lead when it is free), "history": archived and merged members with their session ids (agent_recall reads them), and the rosterVersion that agent_create and agent_send require. Forks are the router\'s own one-message agents, not workers, and are left out unless you ask for them with forks: true.',
      parameters: {
        forks: { type: 'boolean', description: 'Also list forks, archived ones included: a debugging view, not part of routing.' },
        history: { type: 'boolean', description: 'List every archived and merged member under history, not only the latest 20.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const withForks = (args as { forks?: boolean }).forks === true
        const allHistory = (args as { history?: boolean }).history === true
        const ledger = scheduler.ledgerOf(caller(exec))
        const effectiveModel = scheduler.effectiveModels(caller(exec))
        // Archived and merged workers move to history: their sessions stay readable (agent_recall).
        const past = [...ledger.members.values()].filter(m => m.kind === 'worker' && (m.state === 'archived' || m.mergedInto !== undefined))
        const shown = allHistory ? past : past.slice(-20)
        return {
          agents: [...ledger.members.values()].filter(m => (withForks || m.kind === 'worker') && !(m.kind === 'worker' && past.includes(m))).map(m => ({
            name: m.name, kind: m.kind, state: m.state === 'started' ? status(m.id) : m.state, session: m.id,
            ...(m.mergedFrom === undefined ? {} : { mergedFrom: m.mergedFrom.map(f => ({ name: f.name, session: f.session })) }),
            ...(m.kind === 'fork' ? { input: m.text.slice(0, 120) } : { role: m.role ?? '' }),
            ...(m.area === undefined ? {} : { area: m.area }),
            // v2: a top-level Session the user can open; v1 workers only finish what they have.
            ...(m.kind === 'worker' ? { workerKind: m.session === true ? 'session' : 'subagent (old: finishes open requests; /agents convert to keep it)' } : {}),
            ...(m.worktrees === undefined ? {} : { worktrees: [...m.worktrees] }),
            ...(m.session === true ? { queue: scheduler.queueSummary(m.id) } : {}),
            ...(m.formerNames === undefined ? {} : { formerNames: [...m.formerNames] }),
            ...(m.cwd === undefined ? {} : { cwd: m.cwd }),
            // The model in effect: its own choice (agent_model / agent-model) over the start model.
            ...(() => { const effective = effectiveModel.get(m.id); return effective === undefined ? {} : { model: effective, ...(m.pickedModel === undefined ? {} : { modelChoice: 'picked' }) } })(),
            ...(m.accessPreset === undefined ? {} : { access: m.accessPreset }),
            ...(m.createdFor === undefined ? {} : { createdFor: m.createdFor }),
            // Requests it has not answered yet: a backlog to fork around, not to add to.
            ...(() => { const open = ledger.openTo(m.id).length; return open > 0 ? { open } : {} })(),
          })),
          openRequests: [...ledger.requests.values()].filter(r => r.state === 'sent').map(r => ({ id: r.id, from: ledger.nameOf(r.from), to: ledger.nameOf(r.to), text: r.text.slice(0, 120) })),
          queued: scheduler.queued(ledger.mainId),
          ...(() => {
            const merging = ledger.merges.filter(m => m.state === 'requested' || m.state === 'handoff' || m.state === 'settled')
            return merging.length === 0 ? {} : { merging: merging.map(m => ({ id: m.id, absorbed: ledger.nameOf(m.absorbed), into: ledger.nameOf(m.survivor), state: m.state })) }
          })(),
          // Only the lead's own: what waits for it, summarized; the whole text comes when it is free.
          ...(isMainSession(caller(exec)) ? { inbox: ledger.mail.map(m => ({
            id: m.id, from: ledger.nameOf(m.from), kind: m.kind, ...(m.request === undefined ? {} : { request: m.request }),
            at: new Date(m.at).toISOString(), preview: mailPreview(m.text),
            ...(m.pinned === true ? { pinned: true } : {}), ...(m.held === true ? { held: true } : {}),
          })) } : {}),
          ...(past.length === 0 ? {} : {
            history: shown.map(m => ({
              name: m.name, session: m.id, state: m.mergedInto === undefined ? 'archived' : 'merged',
              ...(m.mergedInto === undefined ? {} : { mergedInto: ledger.nameOf(m.mergedInto) }),
              ...(m.formerNames === undefined ? {} : { formerNames: [...m.formerNames] }),
            })),
            ...(shown.length < past.length ? { historyMore: past.length - shown.length } : {}),
          }),
          ...(isMainSession(caller(exec)) ? { accessModes: scheduler.accessModes() } : {}),
          rosterVersion: scheduler.rosterVersion(ledger),
        }
      },
    }),
    defineTool({
      name: 'agent_recall',
      description: 'Look a detail up in the history of an agent in this session: the lead, a worker or fork, also an archived one, or a worker merged into another (whose handoff only summarized). Give name (current, former or merged-away; an ambiguous one lists the sessions to pick from) or session (from agent_list), and query: words that must all appear in one event (literal, case-insensitive, no regex). Returns the newest matching events of that agent\'s own log (not what it inherited from a split) with seq numbers and snippets; then pass around: <seq> for that event in full and its neighbours. It reads what the user and the other agents of this session said there, including what the user told another member directly; it never reads another session.',
      parameters: {
        name: { type: 'string', description: 'The agent: current name, a former name, or the name of a worker merged away.' },
        session: { type: 'string', description: 'Its session id, from agent_list or a handoff.' },
        query: { type: 'string', description: 'Words that must all appear in one event.' },
        limit: { type: 'number', description: 'At most this many events, newest first; default 10, at most 50.' },
        around: { type: 'number', description: 'A seq from an earlier result: that event in full and three events either side.' },
        includeInherited: { type: 'boolean', description: 'Also search what it inherited when it was split off another worker.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => JSON.parse(JSON.stringify(await scheduler.recall(caller(exec), args as { name?: string; session?: string; query?: string; limit?: number; around?: number; includeInherited?: boolean }))) as Record<string, never>,
    }),
    defineTool({
      name: 'agent_model',
      description: 'Choose the model a worker uses for its later requests, like /worker model but for one worker: "provider/model[:effort]", or "default" to go back to the model it started with. Forks always run on the lead\'s model and have none of their own. Pass the rosterVersion from agent_list; the lead passes for while scheduling is on.',
      parameters: {
        name: { type: 'string', required: true, description: 'The worker.' },
        model: { type: 'string', required: true, description: '"provider/model" with an optional ":effort", or "default".' },
        rosterVersion: VERSION,
        for: { type: 'string', description: 'The lead only, as for agent_create; optional while scheduling is off.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { name: string; model: string; rosterVersion?: string; for?: string }
        const agent = caller(exec)
        requireVersion(agent, a.rosterVersion)
        requireFor(agent, a.for)
        const raw = a.model.trim()
        let selection: { provider: string; model: string; reasoningEffort?: string } | null = null
        if (raw !== 'default') {
          const slash = raw.indexOf('/')
          if (slash <= 0 || slash === raw.length - 1) throw new Error('model must be "provider/model" with an optional ":effort", or "default"')
          const [route, effort] = [raw.slice(0, slash), raw.slice(slash + 1)]
          const colon = effort.indexOf(':')
          const base = colon < 0 ? { provider: route, model: effort } : { provider: route, model: effort.slice(0, colon), reasoningEffort: effort.slice(colon + 1) }
          if (base.provider === '' || base.model === '' || (base.reasoningEffort ?? 'x') === '') throw new Error('model must be "provider/model" with an optional ":effort", or "default"')
          selection = deps.validateModel === undefined ? base : await deps.validateModel(base)
        }
        const out = scheduler.setMemberModel(agent, { name: a.name, selection, by: 'lead' })
        return { worker: out.name, model: out.selection === null ? 'default' : `${out.selection.provider}/${out.selection.model}${out.selection.reasoningEffort === undefined ? '' : `:${out.selection.reasoningEffort}`}` }
      },
    }),
    defineTool({
      name: 'agent_access',
      description: 'Choose a worker\'s access mode (sandbox + approval bundle: e.g. read-only, workspace-write, danger-full-access). "default" gives it the lead\'s current mode. You may narrow a worker or bring it up to the user\'s own current mode, never past it: a wider mode is refused, ask the user to switch their own mode first. Forks have no access mode of their own. Pass the rosterVersion from agent_list; the lead passes for while scheduling is on.',
      parameters: {
        name: { type: 'string', required: true, description: 'The worker.' },
        mode: { type: 'string', required: true, description: 'An access mode name from agent_list, or "default" for the lead\'s current mode.' },
        rosterVersion: VERSION,
        for: { type: 'string', description: 'The lead only, as for agent_create; optional while scheduling is off.' },
      },
      output: { schema: OK, render: json },
      execute: async (args, exec) => {
        const a = args as { name: string; mode: string; rosterVersion?: string; for?: string }
        const agent = caller(exec)
        requireVersion(agent, a.rosterVersion)
        requireFor(agent, a.for)
        const mode = a.mode.trim()
        const out = scheduler.setMemberAccess(agent, { name: a.name, preset: mode === 'default' ? null : mode, by: 'lead' })
        return { worker: out.name, access: out.preset }
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

/** The sentence of LEAD_OFF_NOTICE that Agent Teams changes: its send_message is the lead's own. */
const TOOLS_CAVEAT = 'Do not use send_message or the subagent tools for this.'
const TEAM_OFF_CAVEAT = 'Agent Teams is on: spawn_teammate, send_message, list_agents and the team_task tools are your own Team (teammates share your working directory); use them for help inside this conversation, and agent_create / agent_send for workers.'
/** A worker leads its own Agent Team (src/dsh/host/agent-team.ts). */
export const WORKER_TEAM_NOTICE = 'You are the Team Lead of your own Agent Team: spawn_teammate creates teammates (they share your working directory), send_message and the team_task tools coordinate them, wait_agent waits for them. Their answers come to you, not to the lead; once they have answered, end your turn with a summary: that is your answer to the request. Teammates cannot form teams of their own.'
/** While scheduling is on, the lead and forks do not form teams. */
const ON_TEAM_NOTICE = 'Agent Teams is on, but while scheduling is on the lead and forks do not form teams (spawn_teammate is refused): workers do. Existing teammates of the lead keep messages, tasks and interrupts.'

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
  // A session worker whose router is not resident still knows who it is from its own owner record.
  const owner = ownerOf(agent)
  const listed = ledger.members.get(agent.id)
  const isWorker = listed?.kind === 'worker' || owner !== undefined
  // A worker renamed in a split: its conversation still shows its old name, the prompt its new one.
  const self = listed ?? (owner === undefined ? undefined : { id: agent.id, name: owner.name, kind: 'worker' as const, state: 'started' as const, text: owner.role, role: owner.role, session: true as const, ...(owner.worktrees === undefined ? {} : { worktrees: owner.worktrees }) })
  // The lead with scheduling off talks to the user itself. A plain chat (no forks or workers yet)
  // gets no section at all, so the switch costs nothing until the lead first creates a worker;
  // the tool descriptions say enough for that first creation.
  const teams = scheduler.teamsAvailable()
  if (isMainSession(agent) && !scheduler.isOn(agent)) {
    if (ledger.state.members.length === 0) return ''
    return ['# Agent Scheduler', teams ? LEAD_OFF_NOTICE.replace(TOOLS_CAVEAT, TEAM_OFF_CAVEAT) : LEAD_OFF_NOTICE, ...(role !== undefined && role !== '' ? [`Role:\n${role}`] : [])].join('\n')
  }
  const lines = isWorker
    ? [
        '# Agent Scheduler: worker',
        `Your name is "${self?.name ?? ''}" (the user may rename you; this is the current one).`,
        self?.session === true
          ? 'You are a long-lived worker with a session of your own; your router sent you here. Requests arrive as "[request r-N from name]": answer each, then end your turn, and your closing message (or report) goes back to the router as the answer. The user may also talk to you here directly: nothing of that goes to the router, unless the user asks you to share or push something, then call report with a summary (and where in this session the details are; the router can read them with agent_recall).'
          : 'You are a long-lived worker. Requests arrive as "[request r-N from name]". Answer each, then end your turn: your final message (or report) goes to the lead automatically as the answer. The user may also talk to you directly; those messages are not requests and your replies stay in your chat, except a report, which goes to the lead as "[report from <your name>, not a request]". You may delegate with agent_send; that answer also goes to the lead.' + (teams ? '' : ' Do not use send_message.'),
        ...(teams && self?.session !== true ? [WORKER_TEAM_NOTICE] : []),
        ...(self?.session === true && (self.worktrees?.length ?? 0) > 0 ? [`Worktrees you were given: ${self.worktrees!.join(', ')} (you may work in others under your workspace).`] : []),
      ]
    : [
        '# Agent Scheduler',
        'The user talks to a lead; every user message is handed to a fresh fork of the lead.',
        FORK_NOTICE,
        LEAD_NOTICE,
        'Workers are long-lived agents, each a session of its own in this workspace that the user can also open and talk to directly. Use agent_list to see them, agent_create to make one (coarse: per repository or module; it may get a worktree, and can work in others), agent_send to delegate (requests to one worker queue up in order); both take the rosterVersion from agent_list and run one at a time per session. Every answer comes to the lead as "[reply to r-N from name, asked by ...]"; forks do not wait for them. Do not use send_message or the subagent tools for this.',
        ...(teams ? [ON_TEAM_NOTICE] : []),
      ]
  // A worker that absorbed others: where their history is, so it can recall what the handoff left out.
  for (const from of self?.mergedFrom ?? []) lines.push(`You absorbed ${from.name} (merge ${from.merge}); its history is session ${from.session}: use agent_recall({ name: "${from.name}", query }) to look details up.`)
  if (self?.area !== undefined && self.formerNames !== undefined && self.formerNames.length > 0) lines.push(`You are now worker "${self.name}" (formerly ${self.formerNames.map(n => `"${n}"`).join(', ')}) in area "${self.area}"; workers split from the same area share it, each with its own work.`)
  if (role !== undefined && role !== '') lines.push(`Role:\n${role}`)
  return lines.join('\n')
}
