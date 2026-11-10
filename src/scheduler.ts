/**
 * The scheduler for one preset scope. Rules, not model judgment, decide routing:
 * - while scheduling is on, a user message to the main Session never reaches the lead: it leaves
 *   the inbox on insertion and a new fork of the lead takes it. Off, the user talks to the lead,
 *   and the lead keeps every worker tool: the switch decides only who takes user messages;
 * - every piece of delegated work is a request; each completed round of the agent that took it
 *   answers the requests whose messages that round claimed, read from its log;
 * - there is one pipeline and it ends at the lead: a fork's conclusion, a worker's answer, and a
 *   failed request all report to the lead. Nobody is woken again just to relay a result, so a
 *   fork concludes after delegating instead of waiting for its workers;
 * - all children are direct children of the main Session, which sends on everyone's behalf.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Agent, AgentOptions, PreStepDecision, Session, SessionEvent, UserMessage } from './dsh/types.js'
import {
  admitHidden, agentOptionsOf, cwdOf, pinSandboxMode, eventsOf, isCapacity, isContextOnly, isMainSession, isPending, isUserInput, lastEvent, liveLog, mainIdOf,
  isLive, pendingOf, relayMessage, turnEndOf, removePending, wakeForPending, replacePending, SessionId, settledSender, statusOf, steerLead, subagentPort, textOf, toLead, withoutReturnGuidance,
  type AccessPort, type AgentLookup, type HistoryPort, type RecallWindow, type SessionLog, type SubagentPort, type SubagentService, type TeamPort,
} from './dsh/host/index.js'
import { ForkSeedError, forkSeed } from './forks-from.js'
import { Ledger, type Member, type Request } from './ledger.js'
import {
  appendAgent, appendForkState, appendMemberAccess, appendInput, appendMail, appendMerge, appendMode, appendRequest, appendRole, appendSeen, appendSettled, appendTeam, workerModelOf,
  type ForkModelSelection, type MailKind,
} from './records.js'
import { mergePending, schedulingOn } from './projection.js'
import { completedRounds, cutByRestart } from './rounds.js'
import { unread } from './review.js'
import { applyMemberAccess, ceilingOf, rankOf, wideningReason } from './member-access.js'
import { applyMemberModel, appendMemberModel } from './member-model.js'
import { defaultSurvivor, gitFacts, handoffFromLog, handoffMessage, handoffRequest, mergedRole, unsettled } from './merge.js'
import type { MergeState } from './projection.js'
import { fateOf, recoveryPolicy, RESTART_DETAIL, resumeText, traceChild, type ChildTrace } from './recovery.js'

/**
 * What a fork is for. It lives in the system-prompt section shared by the lead and its forks (so a
 * fork keeps the lead's cache prefix), not in the fork's first message: that message is the user's
 * bubble in the fork's chat and must show only what the user typed.
 */
export const FORK_NOTICE = [
  'If the newest message is the user\'s own words, you are a fork of the lead, created to route only that message, holding the lead\'s conversation so far.',
  'You are a router, not a worker. Work out what is being asked and which repository or area it belongs to, then hand it over, agent_list first: agent_create, agent_split and agent_send take the rosterVersion it returns and are refused when the roster changed since (someone else just created or delegated); read the roster they return with the refusal and decide again, never by creating the same worker under another name. Workers start coarse and split only on a collision, like a hash trie that grows a branch only where two keys meet:',
  '(1) only a follow-up to one request already given (rework of its result, a question about it, review comments, or a change of direction for it) goes by agent_send to the worker that has it;',
  '(2) a new task in an area a worker already owns, even in the same files or feature: when that worker is idle and has no open requests, it goes by agent_send to that worker, no split; when that worker is running or already has open requests ("open" in agent_list), or the task needs its own branch, split the area so it runs in parallel instead of piling up: agent_split with owner: <owner>, ownerName and ownerRole rewritten to name only the work the owner already has (e.g. hub-asr, "smoke-tests ASR in hub"), and name and role written for the new task (e.g. hub-image, "fixes gpt_image in hub"), both concrete, never the area name again; task, and its own new worktree as cwd, never a directory another worker uses; agent_split and agent_create create that worktree themselves when you also pass repo (the repository\'s checkout) and branch (feat/<slug> or fix/<slug>, from base, default origin/main), e.g. cwd ~/project/worktrees/<repo>__<slug>; if the new task cannot start without the owner\'s uncommitted changes, still do not queue it: say in your conclusion that it depends on <owner>\'s uncommitted changes, which must be committed first, so the lead asks the user;',
  '(3) a new area or repository with no worker yet: agent_create without from, coarse: one worker for the whole repository or module, named after it (e.g. billing-service) with a role for the whole area ("develops the billing-service repository"), its own cwd (one worker per directory or worktree) and the task. agent_create with from: <owner> also forks a worker, but inside an area prefer agent_split, which renames both sides.',
  'You create at most one worker for your message: a second agent_create or agent_split is refused and names the worker it already went to.',
  'Never do the work yourself, however small, and even when the lead did similar work earlier in this conversation or the user says "continue" or "retry": no edits, builds, tests, commits, pushes, PRs, installs or long investigations. You do have a read-only shell (bash/pwsh) for triage — git log, git status, ls, cat, rg — because your Session is pinned to the read-only sandbox; anything that writes is refused at execution (file access denied under read-only mode). A fork is refused every tool except that shell, reading (read, glob, grep, web and session search) and agent_list, agent_send, agent_create, agent_split, agent_interrupt, agent_archive, role_set and report; a refused call means hand it over, not find another way. Read only what you need to route well. Answer directly only what needs no work: a greeting, or a fact already in this conversation.',
  'The runtime context may say you cannot start subagents and must carry out the work directly: that is about the subagent tools, not about agent_create or agent_send, which you always have; it does not apply to you. If a task cannot be handed over (agent_create or agent_send fails), do not do it yourself: say in your conclusion what could not be handed over and why, so the lead tells the user.',
  'Do not wait for workers: their answers go to the lead directly, not back to you.',
  'End your turn with a short conclusion of what was asked and what you handed to whom (or call report first): it goes to the lead automatically, and you are then archived.',
].join(' ')

/** How answers reach the lead: through its inbox, together, when it is free. */
export const INBOX_NOTICE = 'Answers that arrive while you are busy wait in your inbox (agent_list shows a summary of each) and reach you together in one message when you are free; the user may reorder or hold them, or hand one to you at once.'

/** What the lead is for: the user reads only the lead's own replies. */
export const LEAD_NOTICE = [
  'Otherwise you are the lead. The user\'s words never reach you directly; you receive forks\' conclusions as "The user said: ... Its conclusion: ...", workers\' answers as "[reply to r-N from name, asked by ...]", and failures as "[request r-N to name failed: ...]".',
  'When you create a worker yourself, pass for: the fork-N whose conclusion or the r-N whose reply you act on; each of those gets at most one worker, so a fork that already created one is not duplicated (the refusal names that worker: agent_send it instead).',
  'The user does not read those messages or the forks\' work: only your replies. Tell the user the result in your own words, briefly, with anything they must decide. Never say you already answered them unless you did in a reply of your own.',
  'The user\'s 调度 switch decides only whether their messages go to forks: when they turn it off they talk to you directly, you answer yourself, and you keep agent_list, agent_create, agent_send and the other worker tools.',
  INBOX_NOTICE,
].join(' ')

/**
 * What the lead is for while scheduling is off: the user talks to it directly, and it may still
 * create and use workers. Only in a Session that has members, so a plain chat stays plain.
 */
export const LEAD_OFF_NOTICE = [
  'Scheduling (handing each user message to a fork) is off: the user talks to you, the lead, directly, and you answer them yourself.',
  'You can still use workers, long-lived agents with their own sessions, for work that should run in parallel or in its own repository or worktree: agent_list shows them with the rosterVersion that agent_create, agent_split and agent_send require, and dispatches run one at a time per session; start coarse (one worker per repository or module) and agent_split a busy worker\'s area for a new task. While scheduling is off, for is optional on agent_create and agent_split (pass the r-N whose reply you act on when there is one; each fork-N or r-N still gets at most one worker).',
  'Answers come to you as messages of their own: "[reply to r-N from name, asked by ...]", "[report from name, not a request]", "[request r-N to name failed: ...]", and a fork created while scheduling was on still concludes as "The user said: ... Its conclusion: ...". Do not wait for them. The user reads only your replies: tell them results in your own words. Do not use send_message or the subagent tools for this.',
  INBOX_NOTICE,
].join(' ')

// Moved to the DSH adapter; re-exported for callers of this module.
export { admitHidden, HANDOFF_SOURCE, isCapacity, isMainSession, textOf, type SessionLog } from './dsh/host/index.js'

/** Services the scheduler uses, narrowed for tests. */
export interface SchedulerDeps {
  /** `ctx.subagents`; the scheduler drives it through the adapter's {@link SubagentPort}. */
  readonly subagents: SubagentService
  readonly agents: AgentLookup
  /** Read a Session's log whether or not it is resident. */
  readonly readLog: (id: SessionId) => Promise<SessionLog>
  /** Configured default model for workers; undefined inherits the runtime default. */
  readonly configuredWorkerModel?: ForkModelSelection | undefined
  /** Preset for new workers; undefined inherits the main Session's preset. */
  readonly workerPreset?: string | undefined
  readonly log?: (message: string, error?: unknown) => void
  /**
   * Whether a Session that never recorded a switch schedules. The plugin itself never sets it
   * (the preset that did is retired); tests of scheduling sessions do.
   */
  readonly defaultOn?: boolean | undefined
  /** Delay before retrying work refused at capacity; tests shorten it. */
  readonly retryMs?: number
  /**
   * Set a child Session's title (its chat header and session list), when the host offers it.
   * The right-pane tab label is the subagent's creation label, which the runtime cannot change.
   */
  readonly renameSession?: ((id: string, title: string) => void) | undefined
  /** Agent Teams, through its adapter (src/dsh/host/agent-team.ts); absent: no Teams here. */
  readonly team?: TeamPort | undefined
  /** Reads of one Session's history for `agent_recall`; absent: recall is unavailable. */
  readonly history?: HistoryPort | undefined
  /** The host's permission presets (access modes); absent: access switching is unavailable. */
  readonly access?: AccessPort | undefined
  /** Time budget of one recall scan; tests shorten it. */
  readonly recallTimeoutMs?: number
}

/** What `agent_recall` returns. */
export type RecallResult = {
  readonly name: string
  readonly session: string
  /** First seq of the Session's own events (earlier ones were inherited from a split). */
  readonly ownedFrom: number
  readonly hits?: ReadonlyArray<{ seq: number; type: string; time: string; snippet: string }>
  readonly total?: number
  readonly truncated?: boolean
  readonly window?: RecallWindow
  readonly next: string
}

type Outcome = 'done' | 'queued' | 'failed'

/** A child start or delivery refused for capacity, retried in order. */
interface Pending {
  readonly mainId: string
  /** The member the work starts or delivers to, so archiving it can drop the work. */
  readonly memberId: string
  readonly label: string
  readonly attempt: () => Promise<'done' | 'capacity' | 'failed'>
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const gone = (member: Member | undefined): boolean => member !== undefined && (member.state === 'archived' || member.state === 'failed')

/**
 * @param selection - a provider/model pair.
 * @returns agent options carrying it.
 */
export const selectionOptions = (selection: ForkModelSelection): AgentOptions => agentOptionsOf(selection)

/**
 * Optimistic check of a dispatch (agent_create, agent_send): the roster version the caller read
 * with agent_list. Checked inside the dispatch lock, so a caller never acts on a stale roster.
 */
export interface Dispatch {
  /** From agent_list (or the previous dispatch's result); a different current version refuses. */
  readonly rosterVersion?: string | undefined
}

/** A dispatch refused before anything was created or sent; carries the current roster. */
export class DispatchRefused extends Error {
  /**
   * @param reason - why, for the caller's model.
   * @param roster - the current roster summary.
   */
  constructor(reason: string, readonly roster: RosterSummary) {
    super(`${reason}\nNothing was created or sent. Current roster: ${JSON.stringify(roster)}`)
    this.name = 'DispatchRefused'
  }
}

/** What a refused (or any) dispatch shows of the roster: enough to decide again. */
export interface RosterSummary {
  readonly rosterVersion: string
  readonly workers: ReadonlyArray<{ name: string; state: string; open?: number; role: string; createdFor?: string; createdBy?: string; createdAt?: string }>
  /** The newest creations first: what someone else may have just done. */
  readonly recent: ReadonlyArray<{ name: string; for?: string; by: string; at?: string; request?: string }>
}

/** Arguments of a worker creation. */
export interface CreateWorker extends Dispatch {
  readonly name: string
  readonly role: string
  readonly cwd?: string | undefined
  readonly preset?: string | undefined
  readonly model?: ForkModelSelection | undefined
  /** Existing worker whose conversation this one continues. */
  readonly from?: string | undefined
  readonly task?: string | undefined
  /**
   * What the worker is created for: `fork-N` (that fork's user message) or `r-N` (a reply). Each
   * gets at most one worker. A fork always creates for its own message; others must name it.
   */
  readonly for?: string | undefined
  /** Create `cwd` as a new git worktree of this repository first (forks have no shell to do it). */
  readonly worktree?: { readonly repo: string; readonly branch: string; readonly base?: string | undefined } | undefined
  /** `user`: the user made it themselves (Agents page, `/agents fork`), recorded as such. */
  readonly via?: 'user' | undefined
}

/**
 * Create a new git worktree with a new branch.
 * @param repo - an existing checkout of the repository.
 * @param path - the new worktree directory; must not exist.
 * @param branch - the new branch.
 * @param base - what it starts from.
 * @throws with git's own message when git refuses.
 */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (!existsSync(repo)) throw new Error(`repo does not exist: ${repo}`)
  if (existsSync(path)) throw new Error(`cannot create the worktree: ${path} already exists`)
  if (!/^[\w][\w./-]*$/u.test(branch) || branch.includes('..')) throw new Error(`invalid branch name: ${branch}`)
  if (!/^[\w][\w./~^-]*$/u.test(base) || base.includes('..')) throw new Error(`invalid base: ${base}`)
  // Asynchronous: a fetch can take a while, and the host process serves every session meanwhile.
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000 })
  try {
    // Start from the remote's newest state; a repository without that remote still works from what it has.
    const remote = base.includes('/') ? base.slice(0, base.indexOf('/')) : undefined
    if (remote !== undefined) {
      try { await git('fetch', remote, '--prune', '--quiet') } catch { /* offline: use what is there */ }
    }
    await git('worktree', 'add', path, '-b', branch, base)
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    throw new Error(`git worktree add failed: ${(typeof stderr === 'string' && stderr.trim() !== '' ? stderr : messageOf(error)).trim()}`)
  }
}

/**
 * Refuse a worker name that is malformed, reserved, or held. Names are never reused: an archived
 * worker keeps its name, and so does a renamed one for every name it had.
 * @param ledger - the main Session's roster.
 * @param name - the proposed name.
 * @param opts - `failedFree`: a worker that failed to start never ran, so creating anew may take its name.
 * @throws when the name cannot be used.
 */
export function checkWorkerName(ledger: Ledger, name: string, opts: { failedFree: boolean }): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(name)) throw new Error('name must be lower-kebab-case, start with a letter, at most 40 characters')
  if (name === 'lead' || name === 'user' || /^fork-\d+$/u.test(name)) throw new Error(`"${name}" is reserved`)
  const reserved = ledger.merges.find(m => mergePending(m) && m.name === name)
  if (reserved !== undefined) throw new Error(`"${name}" is reserved by merge ${reserved.id}`)
  const holder = ledger.find(name)
  if (holder === undefined) return
  if (opts.failedFree && holder.kind === 'worker' && holder.state === 'failed' && holder.name === name) return
  throw new Error(`"${name}" is already taken (names are never reused)`)
}

/** Arguments of an area split (see {@link Scheduler.split}). */
export interface SplitWorker extends Dispatch {
  /** The worker that owns the area now. */
  readonly owner: string
  /** Its new, narrower name for the work it keeps. */
  readonly ownerName: string
  /** Its new role: the work it keeps. */
  readonly ownerRole: string
  /** The new worker, forked from the owner. */
  readonly name: string
  readonly role: string
  /** A new worktree of its own; required when the owner has a directory. */
  readonly cwd?: string | undefined
  /** Create `cwd` as a new git worktree first, as for agent_create. */
  readonly worktree?: CreateWorker['worktree']
  readonly model?: ForkModelSelection | undefined
  /** Its first request. */
  readonly task: string
  /** As for {@link CreateWorker.via}. */
  readonly via?: 'user' | undefined
  /** As for agent_create: what the new worker is for (the lead names a fork-N or r-N). */
  readonly for?: string | undefined
}

/** Arguments of a merge (see {@link Scheduler.merge}). */
export interface MergeWorkers extends Dispatch {
  /** The worker merged away: it writes a handoff and is archived. */
  readonly absorbed: string
  /** The worker that stays and takes over its work. */
  readonly into: string
  /** The survivor's new name. */
  readonly name?: string | undefined
  /** The survivor's new role; by default its own widened by the absorbed one's. */
  readonly role?: string | undefined
  /** As for agent_create: the fork-N or r-N the lead acts on. */
  readonly for?: string | undefined
}

/** What starting a merge returns. */
export type MergeStarted = {
  readonly merge: string
  readonly request?: string
  readonly absorbed: string
  readonly into: string
  readonly name: string
  readonly note: string
  readonly rosterVersion: string
}

/** A checked worker creation, ready to record and start. */
interface WorkerPlan {
  readonly id: string
  readonly source: Member | undefined
  readonly seed: SessionEvent[] | undefined
  readonly selection: ForkModelSelection | undefined
  readonly preset: string | undefined
  readonly cwd: string | undefined
  /** What it is created for (`fork-N` / `r-N`), recorded on `created`. */
  readonly key: string | undefined
  /** Area the new worker shares with the worker it was split from. */
  readonly area?: string | undefined
}

type Created = { name: string; id: string; request?: string; queued: boolean; rosterVersion: string }

/** Scheduler state and rules for every main Session in one preset scope. */
export class Scheduler {
  private readonly ledgers = new Map<string, Ledger>()
  private readonly queue: Pending[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private draining = false
  /** Settlement of one member at a time, so two triggers never attribute the same round twice. */
  private readonly settling = new Map<string, Promise<unknown>>()
  /**
   * Deliveries whose message id is not recorded yet, per member. The child can claim the message
   * and finish its round before `startActivation`/`sendMessage` returns the id; a settlement in
   * that window must not attribute the round without it. A child that settles before the runtime
   * announced it gets no settlement notice at all, so every delivery settles its member once
   * itself after the id is recorded.
   */
  private readonly inflight = new Map<string, number>()
  /** Members this scheduler itself stopped (interrupt, archive): their cut rounds settle at once. */
  private readonly stopping = new Set<string>()
  /** Per member, the last round a restart cut off that `recover` has dealt with. */
  private readonly recoveredThrough = new Map<string, number>()
  /**
   * The dispatch lock, per main Session: the tail of a promise chain. agent_create and agent_send
   * of the lead, its forks and its workers run one at a time, each reading the roster, checking,
   * creating or delivering, and recording inside it, so none decides on a roster another changed.
   */
  private readonly dispatching = new Map<string, Promise<void>>()
  /** Released main agents already warned about, so a burst of skipped records logs once. */
  private readonly released = new WeakSet<Agent>()

  /** @param deps - services and policy. */
  /** The runtime's subagent service, through the adapter. */
  private readonly port: SubagentPort

  /** @param deps - services and policy. */
  constructor(private readonly deps: SchedulerDeps) {
    this.port = subagentPort(deps.subagents)
  }

  /** A resident agent by Session id. */
  private live(id: string): Agent | undefined { return this.deps.agents.get(id as never) }

  /**
   * The ledger of the main Session an agent belongs to.
   * @param agent - the main agent or one of its children.
   * @returns the ledger, folded from the main log on first use.
   */
  ledgerOf(agent: Agent): Ledger {
    const mainId = mainIdOf(agent)
    let ledger = this.ledgers.get(mainId)
    if (ledger === undefined) {
      const main = this.live(mainId) ?? (isMainSession(agent) ? agent : undefined)
      ledger = Ledger.from(mainId, main === undefined ? [] : eventsOf(main.session))
      // A released main Session's fold is not cached: a reopened one folds its own log.
      if (main === undefined || this.writable(main)) this.ledgers.set(mainId, ledger)
    }
    return ledger
  }

  /**
   * Whether this Session hands user messages to forks now.
   * @param agent - the main agent or one of its children.
   * @returns the switch.
   */
  isOn(agent: Agent): boolean {
    const state = this.ledgerOf(agent).state
    return state.enabled ?? (this.deps.defaultOn === true || schedulingOn(state))
  }

  /**
   * Turn scheduling on or off for a main Session. Forks and workers already there keep running
   * and still answer to the lead; only later user messages are routed differently.
   * @param main - the main agent.
   * @param on - the new switch.
   * @returns whether the switch changed.
   */
  setMode(main: Agent, on: boolean): boolean {
    if (!isMainSession(main)) throw new Error('scheduling is switched in the main session')
    if (this.ledgerOf(main).state.enabled === on) return false
    this.record(main, s => appendMode(s, on))
    return true
  }

  /**
   * Whether an agent may use the scheduling tools: the main Session (the lead) always, whether or
   * not scheduling is on, since the switch only decides who takes user messages; and its forks
   * and workers. Children of ordinary subagent tools are not members and are left alone.
   * @param agent - any agent of this preset.
   * @returns membership.
   */
  takesPart(agent: Agent): boolean {
    return isMainSession(agent) || this.ledgerOf(agent).members.has(agent.id)
  }

  /**
   * The roster name of an agent that is one of this preset's forks; forks only route, and the
   * fork guard refuses them every working tool. A fork stays a fork when scheduling is switched
   * off and after it is archived (speaking to it in its chat wakes it as the same router).
   * @param agent - any agent of this preset.
   * @returns the fork's name, or undefined for the lead, workers, and ordinary subagents.
   */
  forkNameOf(agent: Agent): string | undefined {
    if (isMainSession(agent)) return undefined
    // Never fold (and cache) an empty ledger for a main Session that is not resident.
    const mainId = mainIdOf(agent)
    // A subagent of a worker has the worker, not a main Session, as its parent: nothing to fold.
    const parent = this.live(mainId)
    if (!this.ledgers.has(mainId) && (parent === undefined || !isMainSession(parent))) return undefined
    const member = this.ledgerOf(agent).members.get(agent.id)
    return member?.kind === 'fork' ? member.name : undefined
  }

  /**
   * Whether an agent is a live worker of a resident main Session (not a fork, not archived or
   * failed): such a worker leads its own Agent Team.
   * @param agent - any agent.
   * @returns membership as a worker.
   */
  isWorker(agent: Agent): boolean {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return false
    const parent = this.live(parentId)
    if (parent === undefined || !isMainSession(parent)) return false
    const member = this.ledgerOf(parent).members.get(agent.id)
    return member?.kind === 'worker' && member.state === 'started'
  }

  /**
   * Refuse a scheduling tool for an agent that does not take part.
   * @param agent - the calling agent.
   */
  assertTakesPart(agent: Agent): void {
    if (this.takesPart(agent)) return
    throw new Error('This agent is not part of scheduling.')
  }

  /**
   * Run `work` holding the main Session's dispatch lock; callers queue in arrival order, and the
   * lock is released whether `work` returns or throws.
   * @param mainId - the main Session.
   * @param work - the critical section.
   * @returns what `work` returns.
   */
  async exclusive<T>(mainId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.dispatching.get(mainId) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>(done => { release = done })
    const tail = previous.then(() => mine)
    this.dispatching.set(mainId, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.dispatching.get(mainId) === tail) this.dispatching.delete(mainId)
    }
  }

  /**
   * The roster version: changes whenever a worker is added or changes state, or a request is
   * sent, answered or failed. Forks and settlement marks leave it alone: they do not change
   * where work should go, and every user message would otherwise invalidate every reader.
   * @param ledger - the main Session's ledger.
   * @returns an opaque version string.
   */
  rosterVersion(ledger: Ledger): string {
    const workers = ledger.state.members.filter(m => m.kind === 'worker')
    const digest = createHash('sha1')
      .update(JSON.stringify([workers.map(m => [m.id, m.state]), ledger.state.requests.map(r => [r.id, r.state])]))
      .digest('hex').slice(0, 8)
    return `${workers.length}.${ledger.state.requests.length}.${digest}`
  }

  /**
   * The roster as a refused dispatch shows it.
   * @param ledger - the main Session's ledger.
   * @returns version, workers, and the newest creations.
   */
  rosterSummary(ledger: Ledger): RosterSummary {
    const workers = ledger.state.members.filter(m => m.kind === 'worker')
    const state = (m: Member) => m.state === 'started' ? (statusOf(this.deps.agents, m.id) ?? 'idle') : m.state
    return {
      rosterVersion: this.rosterVersion(ledger),
      workers: workers.map(m => {
        const open = ledger.openTo(m.id).length
        return {
          name: m.name, state: state(m), role: (m.role ?? m.text).slice(0, 120), ...(open > 0 ? { open } : {}),
          ...(m.createdFor === undefined ? {} : { createdFor: m.createdFor }),
          ...(m.createdBy === undefined ? {} : { createdBy: ledger.nameOf(m.createdBy) }),
          ...(m.createdAt === undefined ? {} : { createdAt: m.createdAt }),
        }
      }),
      recent: workers.filter(m => m.state !== 'failed').slice(-3).reverse().map(m => {
        const request = ledger.state.requests.find(r => r.to === m.id)?.id
        return {
          name: m.name, by: m.createdBy === undefined ? 'unknown' : ledger.nameOf(m.createdBy),
          ...(m.createdFor === undefined ? {} : { for: m.createdFor }),
          ...(m.createdAt === undefined ? {} : { at: m.createdAt }),
          ...(request === undefined ? {} : { request }),
        }
      }),
    }
  }

  /** Refuse a dispatch made on a roster that has changed since the caller read it. */
  private checkVersion(ledger: Ledger, dispatch: Dispatch): void {
    if (dispatch.rosterVersion === undefined || dispatch.rosterVersion === this.rosterVersion(ledger)) return
    throw new DispatchRefused(`The roster changed since you read it (your rosterVersion ${dispatch.rosterVersion}): someone else created a worker or delegated meanwhile. Read the roster below; delegate to a worker that already has this work instead of creating it again, then retry with the current rosterVersion if something is still needed.`, this.rosterSummary(ledger))
  }

  /**
   * What a creation is for: a fork creates for its own message; anyone else names the fork-N or
   * r-N it acts on. Undefined when a non-fork caller named nothing (tests and internal calls).
   */
  private creationKey(ledger: Ledger, caller: Agent, named: string | undefined): string | undefined {
    const self = ledger.members.get(caller.id)
    if (self?.kind === 'fork') return self.name
    if (named === undefined) return undefined
    if (/^fork-\d+$/u.test(named) ? ledger.find(named)?.kind !== 'fork' : !/^r-\d+$/u.test(named) || !ledger.requests.has(named)) {
      throw new Error(`for must name the fork-N whose conclusion or the r-N whose reply you act on; "${named}" is neither`)
    }
    return named
  }

  /** Refuse a second creation for the same message or reply, naming where it went. */
  private checkOnce(ledger: Ledger, key: string): void {
    const earlier = ledger.state.members.find(m => m.kind === 'worker' && m.createdFor === key && m.state !== 'failed')
    if (earlier === undefined) return
    const request = ledger.state.requests.find(r => r.to === earlier.id)?.id
    throw new DispatchRefused(`${key} was already dispatched${earlier.createdAt === undefined ? '' : ` at ${earlier.createdAt}`} to ${earlier.name}${request === undefined ? '' : ` (${request})`}${earlier.createdBy === undefined ? '' : ` by ${ledger.nameOf(earlier.createdBy)}`}. Each message or reply gets one worker: use agent_send to ${earlier.name} for anything more about it, or say in your conclusion what else is needed.`, this.rosterSummary(ledger))
  }

  /**
   * Forget a main Session (it was disposed); the log stays authoritative. Work still waiting for
   * a slot is dropped with it: its parent is gone, and `recover` fails what was queued when the
   * Session is opened again.
   */
  forget(mainId: string): void {
    this.ledgers.delete(mainId)
    for (let i = this.queue.length - 1; i >= 0; i -= 1) if (this.queue[i]!.mainId === mainId) this.queue.splice(i, 1)
  }

  /**
   * Whether the main Session still takes records (see {@link isLive}); warns once when it does not.
   * Every write to the main Session goes through here, so work that resumes after an await
   * (a drain, a log read, a delivery, a queued retry) never appends to a released Session.
   * @param main - the main agent, as captured before the await.
   * @returns false when it was released: the caller skips the write and returns quietly.
   */
  private writable(main: Agent): boolean {
    if (isLive(main, this.deps.agents)) return true
    if (!this.released.has(main)) {
      this.released.add(main)
      this.deps.log?.(`main session ${main.id} was released; scheduler records for it are skipped and settled from the logs when it is opened again`)
    }
    return false
  }

  private mainOf(agent: Agent): Agent {
    const main = isMainSession(agent) ? agent : this.live(mainIdOf(agent))
    if (main === undefined) throw new Error('the main session is not running')
    return main
  }

  /**
   * Append through the ledger, so the fold and the log never disagree. Nothing is written to a
   * main Session that was released meanwhile (see {@link writable}).
   * @returns whether the record was written.
   */
  private record(main: Agent, append: (session: Session) => unknown): boolean {
    if (!this.writable(main)) return false
    append(main.session)
    this.ledgerOf(main).apply(lastEvent(main.session))
    return true
  }

  private async logOf(id: string): Promise<SessionLog> {
    const live = this.live(id)
    if (live !== undefined) return liveLog(live)
    return this.deps.readLog(SessionId(id))
  }

  // ------------------------------------------------------------------ input rule

  /**
   * React to one inserted message. On the main Session a user message is handed to a fork.
   * On a child, the runtime's own result instructions are removed: results are routed here.
   * @param agent - the agent whose inbox changed.
   * @param message - the inserted message.
   * @returns whether the scheduler took or rewrote the message.
   */
  onInserted(agent: Agent, message: UserMessage): boolean {
    if (!isMainSession(agent)) return this.ledgerOf(agent).members.has(agent.id) && this.stripNativeNotice(agent, message)
    if (!isUserInput(message) || !this.isOn(agent) || !isPending(agent, message.id)) return false
    this.handOff(agent, message)
    return true
  }

  private stripNativeNotice(agent: Agent, message: UserMessage): boolean {
    const kept = withoutReturnGuidance(message)
    return kept !== undefined && replacePending(agent, kept)
  }

  private handOff(main: Agent, message: UserMessage): void {
    // A Session that schedules by default records it once, so the client's switch shows it.
    if (this.ledgerOf(main).state.enabled === null) this.record(main, s => appendMode(s, true))
    const forkId = `session-${randomUUID()}`
    const text = textOf(message.content)
    const name = this.ledgerOf(main).nextForkName()
    // Admit before removing: the composer keeps a draft with attachments until it sees the
    // message logged; a removal alone reads to it as a canceled send and restores the draft.
    const logged = admitHidden(main.session, message, `[A user message was handed to ${name}; its conclusion will come to you.]`)
    removePending(main, message.id)
    this.record(main, s => appendInput(s, { messageId: message.id, forkId, text, name, ...(logged ? { logged: true as const } : {}) }))
    // A fork always runs on the lead's model: it replays the lead's history, which then hits the
    // lead's prompt cache. There is no per-fork model (any `/fork model` record is history only).
    void this.run(main, forkId, name, async () => {
      await this.port.startFork(main, { childId: forkId, label: `${name}: ${text.slice(0, 50)}`, prompt: message.content })
      if (this.ledgerOf(main).members.get(forkId)?.state === 'queued') this.record(main, s => appendForkState(s, { forkId, state: 'started' }))
    }, {
      queued: () => { this.record(main, s => appendForkState(s, { forkId, state: 'queued' })) },
      failed: error => { this.record(main, s => appendForkState(s, { forkId, state: 'failed', detail: messageOf(error) })) },
    })
  }

  // ------------------------------------------------------------------ capacity queue

  /**
   * Run one start or delivery. Refused for capacity, it waits in a FIFO queue (per main Session,
   * behind anything already waiting there) and is retried when a slot may have freed.
   * @param main - the main agent.
   * @param label - what is waiting, for `agent_list` and logs.
   * @param attempt - the operation.
   * @param hooks - `queued` once when it first waits; `failed` on a real failure.
   * @returns the outcome of the first attempt.
   */
  private async run(main: Agent, memberId: string, label: string, attempt: () => Promise<void>, hooks: { queued?: () => void; failed: (error: unknown) => void }): Promise<Outcome> {
    const once = async (): Promise<'done' | 'capacity' | 'failed'> => {
      // A retry that comes after the main Session was released has no parent to start under.
      if (!this.writable(main)) return 'failed'
      try {
        await attempt()
        return 'done'
      } catch (error) {
        if (isCapacity(error)) return 'capacity'
        this.deps.log?.(`${label} failed`, error)
        hooks.failed(error)
        return 'failed'
      }
    }
    const wait = (): Outcome => {
      hooks.queued?.()
      this.queue.push({ mainId: main.id, memberId, label, attempt: once })
      this.arm()
      return 'queued'
    }
    if (this.queue.some(p => p.mainId === main.id)) return wait()
    const first = await once()
    return first === 'capacity' ? wait() : first
  }

  private arm(): void {
    if (this.timer !== undefined || this.draining || this.queue.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, this.deps.retryMs ?? 1500)
  }

  /** Retry queued work front to back; stop at the first one still refused. Re-entrant calls return at once. */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    try {
      while (this.queue.length > 0) {
        if (await this.queue[0]!.attempt() === 'capacity') break
        this.queue.shift()
      }
    } finally {
      this.draining = false
      this.arm()
    }
  }

  /**
   * React to an agent of this preset changing status. A child that went idle has completed a
   * round, so its requests are attributed now rather than when its settlement notice reaches the
   * lead: the runtime can steer that notice into a lead step that is already ending, and skips it
   * for a child that settled before being announced. Any idle agent may also have freed a slot.
   * @param agent - the agent.
   * @param status - its new status.
   */
  onStatus(agent: Agent, status: 'idle' | 'running'): void {
    this.syncTeamOf(agent)
    if (status !== 'idle') return
    if (this.queue.length > 0) void this.drain()
    // A lead that finished its turn takes what waited in its inbox, all in one message.
    // Only a Session this scheduler already folded can have an inbox (a restart refolds it in `recover`).
    // Not when DSH itself cut the turn (shutting down): the message would sit unread in a queue
    // nobody wakes; `recover` hands the inbox over when the Session is back.
    if (isMainSession(agent)) { if (this.ledgers.has(agent.id) && !cutByHost(agent)) this.deliverMail(agent); return }
    const main = this.live(mainIdOf(agent))
    if (main === undefined || !this.ledgerOf(main).members.has(agent.id)) return
    this.settleInBackground(main, agent.id)
  }

  // ------------------------------------------------------------------ Agent Teams

  /** Whether Agent Teams is mounted: the lead and workers lead Teams of their own. */
  teamsAvailable(): boolean { return this.deps.team?.available() === true }

  /**
   * Copy the Team an agent belongs to (as its Lead, or as a teammate of the lead or a worker) into
   * the main Session, when it changed: the Agents page draws it from there.
   * @param agent - any agent whose status or Team records changed.
   */
  syncTeamOf(agent: Agent): void {
    if (this.deps.team === undefined) return
    const parentId = agent.session.header.parentSession
    // The agent itself leads a Team, or its parent does (it is a teammate of the lead or a worker).
    for (const candidate of [agent, parentId === undefined ? undefined : this.live(parentId)]) {
      if (candidate === undefined) continue
      const main = isMainSession(candidate) ? candidate : this.isWorker(candidate) ? this.live(mainIdOf(candidate)) : undefined
      if (main === undefined || !this.ledgers.has(main.id)) continue
      this.syncTeam(main, candidate)
    }
  }

  /** Re-read one Team and record it when it changed. */
  syncTeam(main: Agent, owner: Agent): void {
    const snapshot = this.deps.team?.snapshot(owner)
    if (snapshot === undefined) return
    const known = this.ledgerOf(main).state.teams?.[owner.id]
    if (known === undefined && snapshot.members.length === 0 && snapshot.tasks.length === 0) return
    if (JSON.stringify(known) === JSON.stringify({ members: snapshot.members, tasks: snapshot.tasks })) return
    this.record(main, s => appendTeam(s, { owner: owner.id, members: snapshot.members, tasks: snapshot.tasks }))
  }

  /**
   * A Team record changed in some Session (Agent Teams appends to its Lead's log).
   * @param sessionId - the Session whose log changed.
   */
  onTeamRecord(sessionId: string): void {
    const agent = this.live(sessionId)
    if (agent === undefined) return
    queueMicrotask(() => { this.syncTeamOf(agent) })
  }

  /** Whether a teammate of the Team this worker leads is running or still being created. */
  private teamRunning(memberId: string): boolean {
    const agent = this.live(memberId)
    return agent !== undefined && this.deps.team?.busy(agent) === true
  }

  /** Whether a worker's teammates are still at work: its round's answer would be partial. */
  private teamBusy(memberId: string): boolean {
    const agent = this.live(memberId)
    if (agent === undefined || this.deps.team === undefined) return false
    if (this.deps.team.busy(agent)) return true
    // A teammate that already finished has its answer waiting in the worker's inbox: the worker
    // takes it in another round, and that round's summary is the answer, not this one's.
    const team = this.deps.team.snapshot(agent)
    return team !== undefined && team.members.length > 0 && pendingOf(agent).length > 0
  }

  /** Settle a member outside a lead step; what is for the lead is queued as its own message. */
  private settleInBackground(main: Agent, memberId: string): void {
    void this.settleOnce(main, memberId).then(
      texts => { for (const text of texts) this.toLead(main, text, memberId) },
      error => { this.deps.log?.(`settling ${memberId} failed`, error) },
    )
  }

  /**
   * @param mainId - restrict to one main Session.
   * @returns labels of queued work, oldest first.
   */
  queued(mainId?: string): string[] {
    // A worker waiting to start is labelled with the name it was created under; show its current one.
    return this.queue.filter(p => mainId === undefined || p.mainId === mainId).map(p => {
      const member = this.ledgers.get(p.mainId)?.members.get(p.memberId)
      return member?.formerNames?.includes(p.label) === true ? member.name : p.label
    })
  }

  /** Stop retrying (scope disposal). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.queue.length = 0
  }

  /**
   * Run a delivery to `memberId` and the record of its message id as one step a settlement waits for.
   * @param main - the main agent.
   * @param memberId - the receiving member.
   * @param deliver - delivers and records the id.
   */
  private async delivering(main: Agent, memberId: string, deliver: () => Promise<void>): Promise<void> {
    this.inflight.set(memberId, (this.inflight.get(memberId) ?? 0) + 1)
    try {
      await deliver()
    } finally {
      const left = (this.inflight.get(memberId) ?? 1) - 1
      if (left > 0) this.inflight.set(memberId, left)
      else {
        this.inflight.delete(memberId)
        this.settleInBackground(main, memberId)
      }
    }
  }

  // ------------------------------------------------------------------ requests

  /**
   * Create a worker as a direct child of the main Session. A task becomes its first request.
   * @param caller - the agent asking.
   * @param args - name, role, and options.
   * @returns the worker's name, id, the request id when a task was given, and whether it waits for a slot.
   * @throws when the arguments are invalid, the source cannot seed it, or the start failed.
   */
  async createWorker(caller: Agent, args: CreateWorker): Promise<{ name: string; id: string; request?: string; queued: boolean; rosterVersion: string }> {
    const main = this.mainOf(caller)
    return this.exclusive(main.id, () => this.createLocked(main, caller, args))
  }

  private async createLocked(main: Agent, caller: Agent, args: CreateWorker): Promise<Created> {
    const ledger = this.ledgerOf(main)
    this.checkVersion(ledger, args)
    const key = this.creationKey(ledger, caller, args.for)
    if (key !== undefined) this.checkOnce(ledger, key)
    const plan = await this.planWorker(main, args, key)
    const source = plan.source
    return this.launchWorker(main, caller, args, plan, source === undefined ? [] : [`You continue worker "${source.name}": its conversation so far is your context.`])
  }

  /**
   * Check a worker creation and gather what starting it needs; records nothing (it may create
   * the worktree it was asked for).
   * @param reserved - names another part of the same operation takes.
   * @param unseeded - a split may start the new worker fresh when the owner has no clean round.
   */
  private async planWorker(main: Agent, args: CreateWorker, key: string | undefined, reserved: readonly string[] = [], unseeded = false): Promise<WorkerPlan> {
    const ledger = this.ledgerOf(main)
    const checkName = (): void => {
      checkWorkerName(ledger, args.name, { failedFree: true })
      if (reserved.includes(args.name)) throw new Error('ownerName and name must differ')
    }
    checkName()
    const source = args.from === undefined ? undefined : this.lookup(ledger, args.from)
    let seed: SessionEvent[] | undefined
    if (source !== undefined) {
      if (source.kind !== 'worker') throw new Error(`"${args.from}" is a fork; only a worker can be continued`)
      if (gone(source)) throw new Error(`"${args.from}" is ${source.state}`)
      if (args.preset !== undefined) throw new Error('a worker that continues another worker keeps its preset')
      // A worker continued from one that has its own directory must get a new one (a new
      // worktree): without a cwd it would fall back to the session's directory, not a tree of its own.
      if (source.cwd !== undefined && args.cwd === undefined) throw new Error(`"${source.name}" works in ${source.cwd}; give "${args.name}" its own new worktree as cwd (git worktree add …), not a shared directory`)
      const events = (await this.logOf(source.id)).events
      try {
        seed = forkSeed(events, source.name)
      } catch (error) {
        // A split may start its worker fresh when the owner has no clean round to continue from
        // (it is still in its first round, or every round left a message it has not taken).
        if (!unseeded || !(error instanceof ForkSeedError) || error.code === 'NON_CONTIGUOUS_LOG') throw error
      }
      checkName()
    }
    // The explicit model, then (a fork of a worker) the model its owner runs on, then the Agents
    // page's 「Worker 模型」 (/worker model), then config.
    const ownerModel = source === undefined ? undefined : source.pickedModel ?? parseModelRoute(source.model)
    const selection = args.model ?? ownerModel ?? workerModelOf(eventsOf(main.session)) ?? this.deps.configuredWorkerModel
    const preset = args.preset ?? this.deps.workerPreset
    // One worker per directory: this is what keeps two writers out of the same tree. A worker
    // continued from another gets no default directory, since its source still works in its own.
    const base = cwdOf(main) ?? process.cwd()
    const expand = (p: string): string => p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
    const absolute = (p: string): string => { const e = expand(p); return isAbsolute(e) ? e : resolve(base, e) }
    const cwd = args.cwd === undefined ? undefined : absolute(args.cwd)
    if (args.worktree !== undefined) {
      if (cwd === undefined) throw new Error('repo and branch create a new worktree at cwd: give cwd too')
      const holder = ledger.state.members.find(m => m.kind === 'worker' && !gone(m) && m.cwd !== undefined && resolve(base, m.cwd) === cwd)
      if (holder !== undefined) throw new Error(`"${holder.name}" already works in ${cwd}; give each worker its own directory or worktree`)
      await addWorktree(absolute(args.worktree.repo), cwd, args.worktree.branch, args.worktree.base ?? 'origin/main')
    }
    if (cwd !== undefined) {
      // Checked before anything is recorded, so a bad directory costs no roster entry.
      if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}; create it (or the worktree) first`)
      if (!statSync(cwd).isDirectory()) throw new Error(`working directory is not a directory: ${cwd}`)
      const holder = ledger.state.members.find(m => m.kind === 'worker' && !gone(m) && m.cwd !== undefined && resolve(base, m.cwd) === cwd)
      if (holder !== undefined) throw new Error(`"${holder.name}" already works in ${cwd}; give each worker its own directory or worktree`)
    }
    return { id: `session-${randomUUID()}`, source, seed, selection, preset, cwd, key }
  }

  /** Record a planned worker and start it; its task becomes its first request. */
  private async launchWorker(main: Agent, caller: Agent, args: Pick<CreateWorker, 'name' | 'role' | 'task' | 'via'>, plan: WorkerPlan, intro: readonly string[]): Promise<Created> {
    const ledger = this.ledgerOf(main)
    const { id, source, seed, selection, preset, cwd, key, area } = plan
    const model = selection === undefined ? undefined : `${selection.provider}/${selection.model}`
    this.record(main, s => appendAgent(s, {
      action: 'created', id, name: args.name, role: args.role,
      ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }), ...(source === undefined || seed === undefined ? {} : { from: source.id }), ...(area === undefined ? {} : { area }),
      by: caller.id, ...(key === undefined ? {} : { for: key }), at: new Date().toISOString(), ...(args.via === 'user' ? { via: 'user' as const } : {}),
    }))
    const task = args.task
    const requestId = task === undefined ? undefined : ledger.nextRequestId()
    if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: task! }))
    const first = [
      `You are worker "${args.name}" in an Agent Scheduler session.`,
      ...intro,
      `Your role: ${args.role}`,
      requestId === undefined ? 'No task yet: acknowledge briefly and wait for requests.' : this.requestText(requestId, ledger.nameOf(caller.id), task!),
    ].join('\n\n')
    let failure = ''
    // The user may rename it while it waits for a slot: later records carry its current name.
    const nameNow = (): string => ledger.members.get(id)?.name ?? args.name
    const outcome = await this.run(main, id, args.name, () => this.delivering(main, id, async () => {
      const { messageId } = await this.port.startWorker(main, { childId: id, label: args.name, text: first, seed, cwd, preset, model: selection })
      if (ledger.members.get(id)?.state === 'queued') this.record(main, s => appendAgent(s, { action: 'started', id, name: nameNow() }))
      if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: task!, messageId }))
      // A worker split from another starts with that one's title; give it its own.
      if (area !== undefined) this.retitle(id, nameNow(), args.role)
    }), {
      queued: () => { this.record(main, s => appendAgent(s, { action: 'queued', id, name: nameNow() })) },
      failed: error => {
        failure = messageOf(error)
        this.record(main, s => appendAgent(s, { action: 'failed', id, name: nameNow(), detail: failure }))
        if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'failed', id: requestId, detail: failure }))
      },
    })
    if (outcome === 'failed') throw new Error(`could not start "${args.name}": ${failure}`)
    return { name: args.name, id, queued: outcome === 'queued', ...(requestId === undefined ? {} : { request: requestId }), rosterVersion: this.rosterVersion(ledger) }
  }

  /**
   * Split an area: the owner is renamed and narrowed to the work it has, and a new worker forked
   * from it takes a new task in parallel. Like a hash trie, a node holds a whole area until two
   * tasks collide in it; only then is it split, and both branches get a name and role of their own.
   * Runs inside the dispatch lock with the same rosterVersion and for rules as agent_create, and
   * checks everything before recording anything. The owner's rename reuses the `renamed` record
   * of `/agents rename`, with the narrower role and the area added. Once the owner is renamed, a
   * new worker that fails to start does not undo it (as for any worker whose start fails).
   * @param caller - the agent asking.
   * @param args - the owner, its new name and role, and the new worker as for {@link createWorker}.
   * @returns both workers' names, the area, the new worker's id and request, and whether it waits for a slot.
   */
  async split(caller: Agent, args: SplitWorker): Promise<Created & { area: string; owner: string; formerName: string; ownerNotified: boolean; seeded: boolean }> {
    const main = this.mainOf(caller)
    return this.exclusive(main.id, () => this.splitLocked(main, caller, args))
  }

  private async splitLocked(main: Agent, caller: Agent, args: SplitWorker): Promise<Created & { area: string; owner: string; formerName: string; ownerNotified: boolean; seeded: boolean }> {
    const ledger = this.ledgerOf(main)
    this.checkVersion(ledger, args)
    const owner = this.lookup(ledger, args.owner)
    this.refuseMerging(ledger, owner)
    if (owner.kind !== 'worker') throw new Error(`"${owner.name}" is a fork; only a worker owns an area`)
    if (gone(owner)) throw new Error(`"${owner.name}" is ${owner.state}`)
    if (args.ownerName === owner.name) throw new Error(`give "${owner.name}" a new, narrower name for the work it keeps (ownerName), not its current one`)
    if (args.ownerName === args.name) throw new Error('ownerName and name must differ')
    if (args.ownerRole.trim() === '' || args.role.trim() === '') throw new Error('ownerRole and role must say what each worker now does')
    checkWorkerName(ledger, args.ownerName, { failedFree: false })
    const key = this.creationKey(ledger, caller, args.for)
    if (key !== undefined) this.checkOnce(ledger, key)
    const area = owner.area ?? owner.name
    const formerName = owner.name
    const plan = await this.planWorker(main, { name: args.name, role: args.role, cwd: args.cwd, worktree: args.worktree, model: args.model, from: owner.id, task: args.task }, key, [args.ownerName], true)
    this.record(main, s => appendAgent(s, { action: 'renamed', id: owner.id, name: args.ownerName, previousName: formerName, role: args.ownerRole, area }))
    this.retitle(owner.id, args.ownerName, args.ownerRole)
    const intro = [plan.seed === undefined
      ? `Area "${area}" was split because a new task came while worker "${formerName}" was busy; it is now "${args.ownerName}" and keeps its current work (${args.ownerRole}). You are its sibling in the area, started fresh: do only your own task, do not redo or finish its work.`
      : `Area "${area}" was split because a new task came while "${formerName}" was busy. The conversation so far is "${formerName}"'s; it is now "${args.ownerName}" and keeps its current work (${args.ownerRole}). You are its sibling in the area: do only your own task, do not redo or finish its work.`]
    const result = await this.launchWorker(main, caller, { name: args.name, role: args.role, task: args.task, via: args.via }, { ...plan, area }, intro)
    // A running owner learns its new identity at its next step; an idle one is not woken for it:
    // its system prompt and its next request carry the identity (see requestText).
    let ownerNotified = false
    if (statusOf(this.deps.agents, owner.id) === 'running') {
      try {
        await this.port.send(main, owner.id, [
          '[note from the scheduler, not a request: you were renamed]',
          `You are now worker "${args.ownerName}" (formerly "${formerName}") in area "${area}".`,
          `Your role: ${args.ownerRole}`,
          `A new worker "${args.name}": ${args.role} was split off for a new task in this area; leave that to it and carry on with your current work.`,
        ].join('\n'))
        ownerNotified = true
      } catch (error) {
        this.deps.log?.(`telling ${args.ownerName} about the split failed`, error)
      }
    }
    return { ...result, area, owner: args.ownerName, formerName, ownerNotified, seeded: plan.seed !== undefined }
  }

  /**
   * The user forks a worker themselves (Agents page 「Fork…」, `/agents fork`): a new worker that
   * continues the owner's conversation, as its own session and row. With `ownerName` it is a split
   * (the owner is renamed and keeps its work, both share the area); without, the owner stays as it
   * is (`agent_create from`). Same dispatch lock, roster version and seed rule as those; the new
   * worker is recorded as made by the user.
   * @param caller - the main agent (the user's command).
   * @param args - the owner, the new worker, and optionally the owner's new name and role.
   * @returns the new worker, and whether the owner was renamed.
   */
  async forkWorker(caller: Agent, args: {
    owner: string; name: string; role?: string | undefined; task?: string | undefined; cwd?: string | undefined
    worktree?: CreateWorker['worktree']; ownerName?: string | undefined; ownerRole?: string | undefined; rosterVersion?: string | undefined
  }): Promise<{ name: string; id: string; request?: string | undefined; queued: boolean; owner: string; renamed: boolean }> {
    const main = this.mainOf(caller)
    if (!isMainSession(caller)) throw new Error('only the user forks a worker this way; agents use agent_split or agent_create with from')
    const ledger = this.ledgerOf(main)
    const owner = this.lookup(ledger, args.owner)
    if (owner.kind !== 'worker') throw new Error(`"${owner.name}" is a fork; only a worker can be forked`)
    const task = args.task === undefined || args.task.trim() === '' ? undefined : args.task.trim()
    // Without a role of its own the fork does what its owner does (the user narrows it later).
    const role = args.role === undefined || args.role.trim() === '' ? (owner.role ?? owner.text) : args.role.trim()
    const rename = args.ownerName !== undefined && args.ownerName.trim() !== '' && args.ownerName.trim() !== owner.name
    if (rename) {
      // A split needs a task (it is what the new worker splits off for).
      const done = await this.split(caller, {
        owner: owner.name, ownerName: args.ownerName!.trim(), ownerRole: args.ownerRole?.trim() || (owner.role ?? owner.text),
        name: args.name, role, cwd: args.cwd, worktree: args.worktree, task: task ?? `Take over: ${role}`, via: 'user',
        ...(args.rosterVersion === undefined ? {} : { rosterVersion: args.rosterVersion }),
      })
      return { name: done.name, id: done.id, request: done.request, queued: done.queued, owner: done.owner, renamed: true }
    }
    const made = await this.createWorker(caller, {
      name: args.name, role, from: owner.name, cwd: args.cwd, worktree: args.worktree, task, via: 'user',
      ...(args.rosterVersion === undefined ? {} : { rosterVersion: args.rosterVersion }),
    })
    return { name: made.name, id: made.id, request: made.request, queued: made.queued, owner: owner.name, renamed: false }
  }

  /** Find a member by name or id, or say what became of a name a split shared out. */
  private lookup(ledger: Ledger, key: string): Member {
    const hint = ledger.splitHint(key)
    if (hint !== undefined) throw new Error(hint)
    const member = ledger.find(key)
    if (member === undefined) throw new Error(`no agent named "${key}"; use agent_list`)
    return member
  }

  /** Session title of a worker's own chat, when the host can set it. */
  private retitle(id: string, name: string, role: string): void {
    if (this.deps.renameSession === undefined) return
    const short = role.trim().replace(/\s+/gu, ' ')
    try {
      this.deps.renameSession(id, (short === '' ? name : `${name} · ${short}`).slice(0, 60))
    } catch (error) {
      this.deps.log?.(`renaming the session of ${name} failed`, error)
    }
  }

  /**
   * Give a worker a new name. Its old name stays reserved and still finds it (see Ledger.find),
   * so requests, replies and roles keep pointing at the same worker.
   * @param caller - the agent asking (the user's command runs as the main agent).
   * @param name - current name, an old name, or Session id of the worker.
   * @param next - the new name.
   * @returns the old and new name.
   * @throws when there is no such worker, it is archived, or the new name is invalid or taken.
   */
  /**
   * Switch a worker's model (the lead's `agent_model`, or the user's `/agent-model`). Forks and
   * failed members are refused; the choice is recorded in the main Session and applied now.
   * @returns the member's name and the recorded selection.
   */
  setMemberModel(caller: Agent, args: { name: string; selection: { provider: string; model: string; reasoningEffort?: string } | null; by: 'user' | 'lead' }): { name: string; selection: { provider: string; model: string; reasoningEffort?: string } | null } {
    // Only the lead (or the user's command in the main Session) switches a worker: never a worker
    // or fork, whatever tools a profile shows them.
    if (!isMainSession(caller)) throw new Error('only the lead changes a worker\'s model')
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    const member = this.lookup(ledger, args.name)
    if (member.kind === 'fork') throw new Error(`"${member.name}" is a fork; forks always run on the lead's model`)
    if (member.state === 'failed') throw new Error(`"${member.name}" failed to start`)
    this.record(main, s => appendMemberModel(s, { agent: member.id, selection: args.selection }))
    const child = this.live(member.id)
    if (child !== undefined) applyMemberModel(child, args.selection)
    return { name: member.name, selection: args.selection }
  }

  /**
   * @returns the access modes the host offers, for the lead to name one in agent_access.
   */
  accessModes(): Array<{ name: string; sandbox: string; approval: string }> {
    const access = this.deps.access
    return access === undefined || !access.available ? [] : access.modes().map(m => ({ name: m.name, sandbox: m.sandbox, approval: m.approval }))
  }

  /**
   * The worker rows `agent_list` reports: the model in effect (its own choice over the one it
   * started with) and the access preset recorded for it.
   */
  effectiveModels(agent: Agent): Map<string, string | undefined> {
    const out = new Map<string, string | undefined>()
    for (const m of this.ledgerOf(this.mainOf(agent)).members.values()) {
      const picked = m.pickedModel === undefined ? undefined : `${m.pickedModel.provider}/${m.pickedModel.model}${m.pickedModel.reasoningEffort === undefined ? '' : `:${m.pickedModel.reasoningEffort}`}`
      out.set(m.id, picked ?? m.model)
    }
    return out
  }

  // ------------------------------------------------------------------ access modes

  /**
   * A member's access: what is recorded for it, and what its Session is on now.
   * @returns the view; `current` is `custom` when the host matches no preset.
   */
  memberAccessView(agent: Agent): { preset?: string | undefined; current: string; by?: 'user' | 'lead' | 'inherited' | undefined } {
    const access = this.deps.access
    const member = this.ledgerOf(this.mainOf(agent)).members.get(agent.id)
    const current = access?.available === true ? access.current(agent.session) : 'custom'
    return { preset: member?.accessPreset, current, by: member?.accessBy }
  }

  /**
   * Switch a worker's access mode. The user may choose any offered mode; the lead may narrow a
   * worker or match the user's own mode, never widen past it. Recorded in the main Session and
   * applied to the live worker, then re-applied whenever it is created again.
   * @param caller - the lead, or the user's command.
   * @param args - the member, the preset (null = the lead's current mode), and who chose it.
   * @returns the member's name and the preset now recorded.
   */
  setMemberAccess(caller: Agent, args: { name: string; preset: string | null; by: 'user' | 'lead' }): { name: string; preset: string } {
    if (!isMainSession(caller)) throw new Error('only the lead changes a worker\'s access mode')
    const main = this.mainOf(caller)
    const access = this.deps.access
    if (access === undefined || !access.available) throw new Error('this DeepSeek Harness has no permission presets')
    const ledger = this.ledgerOf(main)
    const member = this.lookup(ledger, args.name)
    if (member.kind === 'fork') throw new Error(`"${member.name}" is a fork; forks route on the lead's model and carry no access mode`)
    if (member.state === 'failed') throw new Error(`"${member.name}" failed to start`)
    const modes = access.modes()
    if (modes.length === 0) throw new Error('this DeepSeek Harness offers no access modes')
    const ceiling = ceilingOf(access, main)
    const preset = args.preset ?? ceiling?.name
    if (preset === undefined) throw new Error(`the user's own access mode is not one of the offered presets (${modes.map(m => m.name).join(', ')}); ask the user to pick one`)
    const target = modes.find(m => m.name === preset)
    if (target === undefined) throw new Error(`no access mode "${preset}" (available: ${modes.map(m => m.name).join(', ')})`)
    if (args.by === 'lead') {
      const why = wideningReason(target, ceiling)
      if (why !== undefined) throw new Error(why)
    }
    this.record(main, s => appendMemberAccess(s, { agent: member.id, preset, by: args.by }))
    const child = this.live(member.id)
    if (child !== undefined && member.state !== 'archived') applyMemberAccess(access, child, preset)
    return { name: member.name, preset }
  }

  /**
   * Keep a mode the lead chose within the user's current one. The lead may set a worker only as
   * wide as the user's own mode; when the user narrows their mode later, a worker the lead set
   * follows it down before its next step (and the narrowed mode is recorded, by the lead's
   * choice being clamped). Modes the user chose, or inherited at creation, are left alone.
   * @param agent - any agent; only workers whose recorded mode came from the lead are checked.
   */
  clampMemberAccess(agent: Agent): void {
    const access = this.deps.access
    if (access === undefined || !access.available || isMainSession(agent)) return
    const main = this.live(mainIdOf(agent))
    if (main === undefined) return
    const member = this.ledgerOf(main).members.get(agent.id)
    if (member?.kind !== 'worker' || member.accessBy !== 'lead' || member.accessPreset === undefined) return
    const modes = access.modes()
    const ceiling = ceilingOf(access, main)
    const target = modes.find(m => m.name === member.accessPreset)
    if (wideningReason(target, ceiling) === undefined) return
    // Past the user's mode now (or no longer comparable): fall back to the user's own mode, or
    // the narrowest offered when the user is on a custom combination.
    const narrowest = [...modes].sort((a, b) => (rankOf(a) ?? 99) - (rankOf(b) ?? 99))[0]
    const fallback = ceiling ?? narrowest
    if (fallback === undefined) return
    this.record(main, s => appendMemberAccess(s, { agent: agent.id, preset: fallback.name, by: 'lead' }))
    applyMemberAccess(access, agent, fallback.name)
  }

  /**
   * Pin a routing fork's own Session to the read-only sandbox, on every creation and before its
   * first step. DSH delegates only an explicit parent sandbox override and pins approval to
   * `never`, so with the deployment default (`workspace-write`) a fork allowed a shell could write
   * without any prompt; narrowing is always allowed, and a lead on `danger-full-access` still
   * produces a read-only fork. The event is durable, so a replay or a wake restores it.
   * @param agent - any created Agent; main Sessions, workers and non-members are left alone.
   */
  adoptForkSandbox(agent: Agent): void {
    this.pinForkSession(agent.id)
  }

  /** Sessions already pinned, so the created hook and the activation hook append only one mode. */
  private readonly pinnedSandbox = new WeakSet<object>()

  /**
   * Pin one fork Session to the read-only sandbox as soon as it exists (called from the
   * `agent/created` hook and from the subagent activation hook, whichever fires first).
   * @param childId - the child Session id.
   */
  pinForkSession(childId: string): void {
    const agent = this.live(SessionId(childId))
    if (agent === undefined || isMainSession(agent) || !this.isRoutingFork(agent)) return
    if (this.pinnedSandbox.has(agent.session)) return
    this.pinnedSandbox.add(agent.session)
    pinSandboxMode(agent.session, 'read-only')
  }

  /**
   * Whether this child Session is a routing fork. The Session's own descriptor names its provider
   * (`fork`), which is available before the main Session's fold has the member; the roster is the
   * fallback for a Session without a descriptor.
   */
  private isRoutingFork(agent: Agent): boolean {
    const descriptor = agent.session.snapshotEvents().find(e => e.type === 'subagent/descriptor')
    if (descriptor !== undefined) return (descriptor.data as { provider?: unknown } | null)?.provider === 'fork'
    const main = this.live(mainIdOf(agent))
    return main !== undefined && this.ledgerOf(main).members.get(agent.id)?.kind === 'fork'
  }

  /**
   * Give a just-created worker the access recorded for it, or (first creation) the lead's mode,
   * recorded as inherited so a later lead switch does not move it.
   * @param agent - the created Agent; main Sessions and forks are left alone.
   */
  adoptMemberAccess(agent: Agent): void {
    const access = this.deps.access
    if (access === undefined || !access.available || isMainSession(agent)) return
    const main = this.live(mainIdOf(agent))
    if (main === undefined) return
    const ledger = this.ledgerOf(main)
    const member = ledger.members.get(agent.id)
    if (member?.kind !== 'worker' || member.state === 'archived' || member.state === 'failed') return
    // A worker forked from another starts in its owner's mode, never wider than the user's own.
    const ceiling = ceilingOf(access, main)
    const ownerPreset = member.from === undefined ? undefined : ledger.members.get(member.from)?.accessPreset
    const ownerMode = ownerPreset === undefined ? undefined : access.modes().find(m => m.name === ownerPreset)
    const fromOwner = ownerMode !== undefined && wideningReason(ownerMode, ceiling) === undefined ? ownerMode.name : undefined
    const preset = member.accessPreset ?? fromOwner ?? ceiling?.name
    if (preset === undefined) return
    applyMemberAccess(access, agent, preset)
    if (member.accessPreset === undefined) this.record(main, s => appendMemberAccess(s, { agent: agent.id, preset, by: 'inherited' }))
  }

  async rename(caller: Agent, name: string, next: string): Promise<{ from: string; to: string }> {
    const main = this.mainOf(caller)
    // Inside the dispatch lock: a creation checking whether a name is free must not race it.
    return this.exclusive(main.id, async () => this.renameLocked(main, name, next))
  }

  private renameLocked(main: Agent, name: string, next: string): { from: string; to: string } {
    const ledger = this.ledgerOf(main)
    const target = ledger.find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
    if (target.kind !== 'worker') throw new Error(`"${target.name}" is a fork; only a worker can be renamed`)
    if (target.state === 'archived') throw new Error(`"${target.name}" is archived`)
    this.refuseMerging(ledger, target)
    if (next === target.name) return { from: target.name, to: next }
    // Taking back one of its own earlier names is no reuse: no one else can hold it.
    if (target.formerNames?.includes(next) !== true) checkWorkerName(ledger, next, { failedFree: false })
    this.record(main, s => appendAgent(s, { action: 'renamed', id: target.id, name: next, previousName: target.name }))
    return { from: target.name, to: next }
  }

  /**
   * A request as the worker's chat shows it: who asks and what. How to answer is in its system
   * prompt. A worker renamed in a split also gets who it is now, since its conversation still
   * says its old name and role.
   */
  private requestText(id: string, from: string, text: string, to?: Member): string {
    const identity = to?.area === undefined || to.formerNames === undefined || to.formerNames.length === 0
      ? ''
      : `[you are now worker "${to.name}" (formerly ${to.formerNames.map(n => `"${n}"`).join(', ')}) in area "${to.area}"; your role: ${(to.role ?? '').replace(/\s+/gu, ' ')}]\n`
    return `[request ${id} from ${from}]\n${identity}${text}`
  }

  /**
   * Send a request to a worker or fork on the caller's behalf.
   * @param caller - the agent asking.
   * @param to - name of the target.
   * @param text - the request.
   * @returns the request id, and whether delivery waits for a slot.
   * @throws when the target is unknown or gone, or delivery failed.
   */
  async send(caller: Agent, to: string, text: string, dispatch: Dispatch = {}): Promise<{ request: string; to: string; queued: boolean; busy: boolean; ahead: string[]; note: string; rosterVersion: string }> {
    const main = this.mainOf(caller)
    return this.exclusive(main.id, () => this.sendLocked(main, caller, to, text, dispatch))
  }

  private async sendLocked(main: Agent, caller: Agent, to: string, text: string, dispatch: Dispatch): Promise<{ request: string; to: string; queued: boolean; busy: boolean; ahead: string[]; note: string; rosterVersion: string }> {
    const ledger = this.ledgerOf(main)
    this.checkVersion(ledger, dispatch)
    const target = this.lookup(ledger, to)
    const merging = ledger.mergingOf(target.id)
    if (merging?.absorbed === target.id) throw new Error(`"${target.name}" is being merged into ${ledger.nameOf(merging.survivor)} (${merging.id}); send to ${ledger.nameOf(merging.survivor)} instead`)
    if (target.id === caller.id) throw new Error('cannot send a request to yourself')
    if (gone(target)) throw new Error(`"${to}" is ${target.state}`)
    // A running target takes the message at its next step boundary, inside the round it is in;
    // say so, since `queued` alone (waiting for a slot) reads as "it is being handled now".
    const busy = statusOf(this.deps.agents, target.id) === 'running'
    const id = ledger.nextRequestId()
    const from = ledger.nameOf(caller.id)
    this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text }))
    let failure = ''
    // A target still waiting to start is ahead in the queue, so this delivery waits behind it.
    const outcome = await this.run(main, target.id, id, () => this.delivering(main, target.id, async () => {
      const messageId = await this.port.send(main, target.id, this.requestText(id, from, text, ledger.members.get(target.id)))
      this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text, messageId }))
    }), {
      failed: error => {
        failure = messageOf(error)
        this.record(main, s => appendRequest(s, { action: 'failed', id, detail: failure }))
      },
    })
    if (outcome === 'failed') throw new Error(`request ${id} to "${target.name}" was not delivered: ${failure}`)
    const queued = outcome === 'queued'
    // Requests the target already had before this one: what this one waits behind.
    const ahead = ledger.openTo(target.id).filter(r => r.id !== id).map(r => r.id)
    const parallel = target.kind === 'worker' && (busy || ahead.length > 0)
      ? ` Only a follow-up to ${ahead.length > 0 ? ahead.join(', ') : 'its current work'} (rework, a question, review comments, a change of direction) belongs here. A new task, even in the same files, must run in parallel: agent_split with owner: ${target.name}, a narrower ownerName and ownerRole for what it is doing, and a new worker with its own new worktree as cwd.`
      : ''
    const note = (queued
      ? `${target.name} has not started yet (no free slot); ${id} is delivered when it starts.`
      : busy
        ? `${target.name} is busy${ahead.length > 0 ? ` with ${ahead.join(', ')}` : ''}; it reads ${id} after its current step and answers it when its current round ends, together with what it is doing now.`
        : `${target.name} was idle and starts on ${id} now.`) + parallel
    return { request: id, to: target.name, queued, busy, ahead, note, rosterVersion: this.rosterVersion(ledger) }
  }

  /**
   * Stop a member's current round.
   * @param caller - the agent asking.
   * @param name - the member.
   */
  interrupt(caller: Agent, name: string): void {
    const main = this.mainOf(caller)
    const target = this.lookup(this.ledgerOf(main), name)
    this.stopping.add(target.id)
    this.port.interrupt(main, target.id)
  }

  /**
   * Archive a fork or worker: release it and keep its name taken. Rounds it completed still
   * answer their requests; requests it will now never answer fail, and that failure goes to the lead.
   * @param caller - the agent asking.
   * @param name - the member.
   */
  async archive(caller: Agent, name: string): Promise<void> {
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    const target = this.lookup(ledger, name)
    if (target.state === 'archived') return
    // Work still waiting for a slot is dropped: a start would create it again, a delivery would
    // reach an agent that is no longer listening. Their requests fail below.
    const dropped = this.queue.filter(p => p.memberId === target.id)
    for (const pending of dropped) this.queue.splice(this.queue.indexOf(pending), 1)
    // Queued or failed to start: the runtime holds no session for it, so there is nothing to
    // drain or settle (draining an unknown session throws "session ... not found").
    const neverStarted = target.state === 'queued' || target.state === 'failed'
    this.stopping.add(target.id)
    const forLead: string[] = []
    if (!neverStarted) {
      try {
        await this.port.drain(main, [target.id])
      } catch (error) {
        // Released meanwhile, the runtime refuses to drain for it; the next open settles the member.
        if (!this.writable(main)) return
        throw error
      }
      // Rounds it completed still answer; the one it was cut off in fails its requests.
      forLead.push(...await this.settleOnce(main, target.id))
    }
    if (!this.writable(main)) return
    // A concluded fork may have retired itself while this archive waited.
    if (ledger.members.get(target.id)?.state !== 'archived') {
      this.record(main, s => target.kind === 'fork'
        ? appendForkState(s, { forkId: target.id, state: 'archived' })
        : appendAgent(s, { action: 'archived', id: target.id, name: target.name }))
    }
    for (const request of ledger.openTo(target.id)) {
      this.fail(main, request, target, `${target.name} was archived before answering`, forLead)
    }
    for (const text of forLead) this.toLead(main, text, target.id)
  }

  /**
   * Archive every fork that has concluded and owes nothing: clears the roster of finished work.
   * A fork with requests still addressed to it, or one still running, is kept.
   * @param main - the main agent.
   * @returns names archived.
   */
  async archiveConcluded(main: Agent): Promise<string[]> {
    const ledger = this.ledgerOf(main)
    const done = ledger.state.members.filter(m => m.kind === 'fork' && m.state === 'done' && ledger.openTo(m.id).length === 0 && statusOf(this.deps.agents, m.id) !== 'running')
    for (const fork of done) await this.archive(main, fork.id)
    return done.map(m => m.name)
  }

  /**
   * Mark a member's latest report as read: the user opened its chat. Recorded only when there is
   * an unread report, so opening a chat again writes nothing.
   * @param caller - the agent asking.
   * @param name - the member, by name or Session id, or `all` for every member with an unread report.
   * @returns whether a report was marked read.
   */
  markSeen(caller: Agent, name: string): boolean {
    const main = this.mainOf(caller)
    if (name === 'all') {
      // A log from before review marks existed has every past report unread: one click reads them.
      const marked = this.ledgerOf(main).state.members.filter(m => unread(m))
      for (const m of marked) this.record(main, s => appendSeen(s, { agent: m.id }))
      return marked.length > 0
    }
    const target = this.ledgerOf(main).find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
    if (!unread(target)) return false
    this.record(main, s => appendSeen(s, { agent: target.id }))
    return true
  }

  /**
   * Set the lead's role (or a worker's).
   * @param caller - the agent asking.
   * @param text - the role.
   * @param name - a worker, or undefined for the lead.
   */
  setRole(caller: Agent, text: string, name?: string): void {
    const main = this.mainOf(caller)
    const target = name === undefined ? undefined : this.ledgerOf(main).find(name)
    if (name !== undefined && target?.kind !== 'worker') throw new Error(`no worker named "${name}"`)
    this.record(main, s => appendRole(s, { text, ...(target === undefined ? {} : { agent: target.id }) }))
  }

  /**
   * The role an agent runs under: workers their own, the lead and forks the lead's.
   * @param agent - the agent being assembled.
   * @returns role text, or undefined.
   */
  roleFor(agent: Agent): string | undefined {
    const ledger = this.ledgerOf(agent)
    const member = ledger.members.get(agent.id)
    return member?.kind === 'worker' ? member.role : ledger.role
  }

  // ------------------------------------------------------------------ recall

  /**
   * The Sessions of this main Session's roster a name or id can mean, for recall: the lead, any
   * member by current or former name (archived and merged ones included). Unlike
   * {@link Ledger.find}, a merged worker's name means that worker itself, not the one it went into.
   * @returns matching Sessions, each with the name it is known by now.
   */
  recallTargets(caller: Agent, key: string): Array<{ name: string; session: string; state: string }> {
    const ledger = this.ledgerOf(this.mainOf(caller))
    if (key === 'lead' || key === ledger.mainId) return [{ name: 'lead', session: ledger.mainId, state: 'lead' }]
    const members = ledger.state.members
    const view = (m: Member) => ({ name: m.name, session: m.id, state: m.mergedInto !== undefined ? 'merged' : m.state })
    const byId = members.find(m => m.id === key)
    if (byId !== undefined) return [view(byId)]
    const current = members.filter(m => m.name === key)
    return (current.length > 0 ? current : members.filter(m => m.formerNames?.includes(key) === true)).map(view)
  }

  /**
   * Look a detail up in the history of a Session in this roster (docs/merge-recall.md): events
   * of its own log holding every word of `query`, newest first; or, with `around`, one event in
   * full and its neighbours.
   * @param caller - the lead, a fork or a worker.
   * @param args - `name` or `session`, and `query` or `around`.
   * @returns hits with seq numbers, or the window.
   */
  async recall(caller: Agent, args: { name?: string | undefined; session?: string | undefined; query?: string | undefined; limit?: number | undefined; around?: number | undefined; includeInherited?: boolean | undefined }): Promise<RecallResult> {
    const history = this.deps.history
    if (history === undefined || !history.available) throw new Error('recall is not available on this DeepSeek Harness (its session query has no filterEvents/readEvent); use session_event_read with a session id from agent_list')
    this.assertTakesPart(caller)
    const key = args.session ?? args.name
    if (key === undefined || key === '') throw new Error('give name (current, former or merged-away) or session')
    const targets = this.recallTargets(caller, key)
    if (targets.length === 0) throw new Error(`"${key}" is not in this session's roster (the lead, its forks and workers, archived and merged ones included); recall reads only those`)
    if (targets.length > 1) throw new Error(`"${key}" names ${targets.length} sessions: ${targets.map(t => `${t.name} (${t.state}) → session ${t.session}`).join('; ')}. Pass session to pick one`)
    const target = targets[0]!
    const ownedFrom = await history.ownedFrom(target.session)
    if (args.around !== undefined) {
      const window = await history.window(target.session, args.around, 3)
      return { name: target.name, session: target.session, ownedFrom, window, next: 'Read around another seq with around, or search again with query.' }
    }
    const terms = (args.query ?? '').split(/\s+/u).filter(t => t !== '').slice(0, 8)
    if (terms.length === 0) throw new Error('give query (words that must all appear in one event) or around (a seq)')
    const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 10)), 50)
    const budget = this.deps.recallTimeoutMs ?? 10_000
    const signal = AbortSignal.timeout(budget)
    let found: Awaited<ReturnType<HistoryPort['find']>>
    try {
      found = await history.find(target.session, terms, { fromSeq: args.includeInherited === true ? 0 : ownedFrom, limit, signal })
    } catch (error) {
      if (signal.aborted) throw new Error(`recall in ${target.name}'s history took over ${Math.round(budget / 1000)} s; use rarer words`)
      throw error
    }
    return {
      name: target.name, session: target.session, ownedFrom,
      hits: found.hits.map(h => ({ ...h, time: new Date(h.time).toISOString() })),
      total: found.total, truncated: found.total > found.hits.length,
      next: found.hits.length === 0 ? 'Nothing holds all those words; try fewer or other words.' : 'Read one in full with agent_recall({ session, around: seq }) or session_event_read.',
    }
  }

  // ------------------------------------------------------------------ merge

  /** Refuse to rename, split or delegate around a worker a merge is under way for. */
  private refuseMerging(ledger: Ledger, member: Member): void {
    const merging = ledger.mergingOf(member.id)
    if (merging === undefined) return
    throw new Error(`"${member.name}" is in merge ${merging.id} (${ledger.nameOf(merging.absorbed)} into ${ledger.nameOf(merging.survivor)}); wait until it is done`)
  }

  /** Whether a member has work in hand: running, owing answers, or waiting for a slot. */
  private busy(ledger: Ledger, member: Member): boolean {
    return statusOf(this.deps.agents, member.id) === 'running' || ledger.openTo(member.id).length > 0 || this.queue.some(p => p.memberId === member.id)
  }

  /**
   * Which of two workers stays when a merge names none (see `defaultSurvivor` in merge.ts).
   * @param caller - the agent asking.
   * @returns the absorbed and the surviving worker's names.
   */
  pickSurvivor(caller: Agent, a: string, b: string): { absorbed: string; into: string } {
    const ledger = this.ledgerOf(this.mainOf(caller))
    const [x, y] = [this.lookup(ledger, a), this.lookup(ledger, b)]
    const [absorbed, survivor] = defaultSurvivor(x, y, m => this.busy(ledger, m))
    return { absorbed: absorbed.name, into: survivor.name }
  }

  /**
   * Merge a worker into another, the reverse of a split. Checked and recorded in the dispatch
   * lock; the absorbed worker is then asked for its handoff, and the rest runs when it answers
   * ({@link advanceMerge}). See docs/worker-merge.md.
   * @param caller - the lead, a fork, or the user's command (the main agent).
   * @param args - who goes into whom, and the survivor's new name and role.
   * @returns the merge, its handoff request, and the roster version.
   */
  async merge(caller: Agent, args: MergeWorkers): Promise<MergeStarted> {
    const main = this.mainOf(caller)
    return this.exclusive(main.id, () => this.mergeLocked(main, caller, args))
  }

  private async mergeLocked(main: Agent, caller: Agent, args: MergeWorkers): Promise<MergeStarted> {
    const ledger = this.ledgerOf(main)
    if (ledger.members.get(caller.id)?.kind === 'worker') throw new Error('only the lead (or a fork) merges workers')
    this.checkVersion(ledger, args)
    const absorbed = this.lookup(ledger, args.absorbed)
    const survivor = this.lookup(ledger, args.into)
    if (absorbed.kind !== 'worker' || survivor.kind !== 'worker') throw new Error('only workers merge; forks are archived instead')
    if (absorbed.id === survivor.id) throw new Error(`"${args.absorbed}" and "${args.into}" are the same worker`)
    if (absorbed.mergedInto !== undefined) throw new Error(`"${absorbed.name}" was already merged into ${ledger.nameOf(absorbed.mergedInto)}`)
    if (gone(survivor) || survivor.state === 'queued') throw new Error(`"${survivor.name}" is ${survivor.state}; merge into a live worker`)
    this.refuseMerging(ledger, absorbed)
    this.refuseMerging(ledger, survivor)
    // Only a worker that ran can write its own handoff; a failed, archived or never-started one
    // gets one built from its log.
    const writes = absorbed.state === 'started'
    if (writes) {
      if (statusOf(this.deps.agents, absorbed.id) === 'running') throw new Error(`"${absorbed.name}" is running; wait until its round ends (or agent_interrupt it), then merge`)
      // Its teammates are its own children: archiving it would stop them with their work unfinished.
      if (this.teamRunning(absorbed.id)) throw new Error(`"${absorbed.name}" leads a team whose teammates are still working; wait until they have answered (or interrupt them), then merge`)
      const open = ledger.openTo(absorbed.id).map(r => r.id)
      if (open.length > 0) throw new Error(`"${absorbed.name}" still owes ${open.join(', ')}; wait for those answers (or interrupt or archive it), then merge`)
      if (this.queue.some(p => p.memberId === absorbed.id)) throw new Error(`"${absorbed.name}" has a delivery waiting for a slot; merge once it ran`)
    }
    const name = args.name === undefined || args.name === '' ? survivor.name : args.name
    if (name !== survivor.name) {
      // Its own earlier names come back freely; the absorbed worker's only within one area (undoing a split).
      const sameArea = absorbed.area !== undefined && absorbed.area === survivor.area
      const theirs = sameArea ? [absorbed.name, ...(absorbed.formerNames ?? [])] : []
      if (!(survivor.formerNames ?? []).includes(name) && !theirs.includes(name)) checkWorkerName(ledger, name, { failedFree: false })
    }
    const role = args.role === undefined || args.role.trim() === '' ? undefined : args.role.trim()
    const id = ledger.nextMergeId()
    const requestId = writes ? ledger.nextRequestId() : ''
    this.record(main, s => appendMerge(s, {
      action: 'requested', id, absorbed: absorbed.id, survivor: survivor.id, request: requestId, by: caller.id,
      ...(name === survivor.name ? {} : { name }), ...(role === undefined ? {} : { role }), ...(args.for === undefined ? {} : { for: args.for }),
    }))
    if (writes) {
      const text = handoffRequest(name)
      this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: absorbed.id, text, kind: 'handoff' }))
      const from = ledger.nameOf(caller.id)
      let failure = ''
      const outcome = await this.run(main, absorbed.id, requestId, () => this.delivering(main, absorbed.id, async () => {
        const messageId = await this.port.send(main, absorbed.id, this.requestText(requestId, from, text, absorbed))
        this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: absorbed.id, text, kind: 'handoff', messageId }))
      }), {
        failed: error => {
          failure = messageOf(error)
          const request = ledger.requests.get(requestId)
          if (request !== undefined) this.fail(main, request, absorbed, `the handoff request was not delivered: ${failure}`, [])
        },
      })
      if (outcome === 'failed') this.deps.log?.(`asking ${absorbed.name} for its handoff failed: ${failure}`)
    } else {
      void this.advanceMerge(main, id)
    }
    const into = name === survivor.name ? survivor.name : `${survivor.name} (to be renamed ${name})`
    const note = writes
      ? `${absorbed.name} writes its handoff now (${requestId}); once it answers, its code is checked, it is archived, its names reach ${name}, and ${into} gets the handoff. The outcome comes to you as "[merged ${id}: …]" or "[merge ${id} … failed: …]".`
      : `${absorbed.name} is ${absorbed.state}: its handoff is built from its log, then it is merged into ${into}. The outcome comes to you as "[merged ${id}: …]".`
    return { merge: id, ...(writes ? { request: requestId } : {}), absorbed: absorbed.name, into: survivor.name, name, note, rosterVersion: this.rosterVersion(ledger) }
  }

  private readonly advancing = new Map<string, Promise<void>>()

  /**
   * Take a merge as far as it can go now, one step at a time, each recorded before the next, so
   * a restart goes on from the last one. Steps of one merge run one at a time.
   * @param main - the main agent.
   * @param id - the merge.
   */
  advanceMerge(main: Agent, id: string): Promise<void> {
    const previous = this.advancing.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.stepMerge(main, id)).catch((error: unknown) => { this.deps.log?.(`merge ${id} failed to advance`, error) })
    this.advancing.set(id, next)
    void next.finally(() => { if (this.advancing.get(id) === next) this.advancing.delete(id) })
    return next
  }

  private async stepMerge(main: Agent, id: string): Promise<void> {
    for (let guard = 0; guard < 8; guard += 1) {
      if (!this.writable(main)) return
      const ledger = this.ledgerOf(main)
      const merge = ledger.merges.find(m => m.id === id)
      if (merge === undefined) return
      const absorbed = ledger.members.get(merge.absorbed)
      if (absorbed === undefined) { this.failMerge(main, merge, 'the absorbed worker is not in the roster'); return }
      switch (merge.state) {
        case 'requested': {
          const request = merge.request === '' ? undefined : ledger.requests.get(merge.request)
          // Still with its worker: the round that answers it moves the merge on.
          if (request?.state === 'sent') return
          if (request?.state === 'answered' && (request.answer ?? '').trim() !== '') {
            this.record(main, s => appendMerge(s, { action: 'handoff', id, text: request.answer!, source: 'worker' }))
            continue
          }
          let log: SessionLog | undefined
          try {
            if (absorbed.state !== 'queued') log = await this.logOf(absorbed.id)
          } catch (error) {
            this.deps.log?.(`reading ${absorbed.name} for its handoff failed`, error)
          }
          if (!this.writable(main)) return
          const text = handoffFromLog(absorbed, ledger.state.requests.filter(r => r.to === absorbed.id), log?.events, log?.inherited)
          this.record(main, s => appendMerge(s, { action: 'handoff', id, text, source: 'log' }))
          continue
        }
        case 'handoff': {
          let facts: Awaited<ReturnType<typeof gitFacts>>
          try {
            facts = await gitFacts(absorbed.cwd)
          } catch (error) {
            if (!this.writable(main)) return
            this.failMerge(main, merge, error instanceof Error ? error.message : String(error))
            return
          }
          if (!this.writable(main)) return
          const why = unsettled(facts, merge.handoff ?? '', merge.source ?? 'worker')
          if (why !== undefined) { this.failMerge(main, merge, why); return }
          this.record(main, s => appendMerge(s, { action: 'settled', id, ...(facts === undefined ? {} : { facts }) }))
          continue
        }
        case 'settled':
          await this.exclusive(main.id, () => this.finishMerge(main, id))
          continue
        case 'merged':
          await this.deliverHandoff(main, merge)
          return
        default:
          return
      }
    }
  }

  /** The roster part of a merge, in the dispatch lock: archive the absorbed worker, rename the survivor. */
  private async finishMerge(main: Agent, id: string): Promise<void> {
    const ledger = this.ledgerOf(main)
    const merge = ledger.merges.find(m => m.id === id)
    if (merge?.state !== 'settled') return
    const absorbed = ledger.members.get(merge.absorbed)!
    const survivor = ledger.members.get(merge.survivor)
    if (survivor === undefined || gone(survivor)) { this.failMerge(main, merge, `${survivor?.name ?? 'the survivor'} is ${survivor?.state ?? 'gone'}`); return }
    if (absorbed.state === 'started') {
      this.stopping.add(absorbed.id)
      try {
        await this.port.drain(main, [absorbed.id])
      } catch (error) {
        if (!this.writable(main)) return
        this.deps.log?.(`releasing ${absorbed.name} for merge ${id} failed`, error)
      }
      if (!this.writable(main)) return
    }
    const name = merge.name ?? survivor.name
    const role = merge.role ?? mergedRole(survivor, absorbed)
    const area = survivor.area ?? absorbed.area
    // Where the absorbed worker's own history is, for recall: its events after what it inherited.
    const span = await this.ownSpan(absorbed.id)
    if (!this.writable(main)) return
    this.record(main, s => appendMerge(s, { action: 'merged', id, name, previousName: survivor.name, role, ...(area === undefined ? {} : { area }), session: absorbed.id, ...span }))
    // Its last report went to the survivor in the handoff: nothing of it is left to review (#9).
    const archived = ledger.members.get(absorbed.id)
    if (archived !== undefined && unread(archived)) this.record(main, s => appendSeen(s, { agent: absorbed.id }))
    this.retitle(survivor.id, name, role)
    const renamed = name === survivor.name ? '' : ` (formerly ${survivor.name})`
    this.toLead(main, `[merged ${id}: ${absorbed.name} into ${name}${renamed}; its handoff went to ${name}]\n${name} now also answers to ${[absorbed.name, ...(absorbed.formerNames ?? [])].join(', ')}. Role: ${role}`, survivor.id)
  }

  /** The part of a member's log it wrote itself, and how many rounds it ran; nothing when unreadable. */
  private async ownSpan(memberId: string): Promise<{ seqFrom?: number; seqTo?: number; rounds?: number }> {
    try {
      const log = await this.logOf(memberId)
      const last = log.events.at(-1)?.seq
      if (last === undefined) return {}
      return { seqFrom: log.inherited, seqTo: Number(last), rounds: completedRounds(log.events, log.inherited).length }
    } catch (error) {
      this.deps.log?.(`reading ${memberId} for its history span failed`, error)
      return {}
    }
  }

  /** Give the survivor the handoff, once: a message already in its session is not sent again. */
  private async deliverHandoff(main: Agent, merge: MergeState): Promise<void> {
    const ledger = this.ledgerOf(main)
    const survivor = ledger.members.get(merge.survivor)
    const absorbed = ledger.members.get(merge.absorbed)
    if (survivor === undefined || absorbed === undefined) return
    const marker = `[handoff ${merge.id} from `
    try {
      const log = await this.logOf(survivor.id)
      if (log.events.some(e => e.type === 'user/message' && JSON.stringify(e.data).includes(marker))) {
        if (this.writable(main)) this.record(main, s => appendMerge(s, { action: 'delivered', id: merge.id }))
        return
      }
    } catch {
      // No log to read: deliver.
    }
    if (!this.writable(main)) return
    const text = handoffMessage({
      id: merge.id, absorbed: absorbed.name, name: survivor.name, formerNames: survivor.formerNames ?? [], role: survivor.role ?? survivor.text,
      area: survivor.area, handoff: merge.handoff ?? '', facts: merge.facts,
      history: survivor.mergedFrom?.find(f => f.merge === merge.id),
    })
    let failure = ''
    const outcome = await this.run(main, survivor.id, `handoff ${merge.id}`, async () => {
      const messageId = await this.port.send(main, survivor.id, text)
      this.record(main, s => appendMerge(s, { action: 'delivered', id: merge.id, messageId }))
    }, { failed: error => { failure = messageOf(error) } })
    // The roster part is done; a handoff that could not be delivered is sent again after a restart.
    if (outcome === 'failed') this.deps.log?.(`delivering the handoff of ${merge.id} to ${survivor.name} failed: ${failure}`)
  }

  /** End a merge that cannot go on; the roster is left as it was. */
  private failMerge(main: Agent, merge: MergeState, detail: string): void {
    const ledger = this.ledgerOf(main)
    if (!this.record(main, s => appendMerge(s, { action: 'failed', id: merge.id, detail }))) return
    this.toLead(main, `[merge ${merge.id} of ${ledger.nameOf(merge.absorbed)} into ${ledger.nameOf(merge.survivor)} failed: ${detail}]\nBoth workers stay as they were.`, merge.absorbed)
  }

  // ------------------------------------------------------------------ restart recovery

  /**
   * Settle what a DSH restart cut off, once the main Session is back. Read from logs only: open
   * requests and member states from this Session's plugin records, how each child's rounds ended
   * from the child's own log. Members resident in this process are alive and left alone.
   * - a queued fork or worker lost its place in the in-memory queue: it fails, with its requests;
   * - a fork whose last round was cut (or that never ran a round) fails, and the lead is told;
   * - a request whose round was cut, or that still waits in a sleeping child's inbox, fails and
   *   the lead is told (`fail`), or with `resume` its worker gets one note in its own session to
   *   check its state and finish it, up to `maxResumes` times. A note carries its request and
   *   attempt on its first line, so a note already delivered before another restart is found in
   *   the child's log and not sent twice;
   * - a request that never reached its child fails.
   * Failed records close a request, so a later restart finds nothing to do for it again.
   * @param main - the main agent, just resumed.
   */
  async recover(main: Agent): Promise<void> {
    if (!isMainSession(main)) return
    const ledger = this.ledgerOf(main)
    const policy = recoveryPolicy()
    // Only what was open when the Session came back; anything sent since is this process's work.
    const openAtResume = new Set(ledger.state.requests.filter(r => r.state === 'sent').map(r => r.id))
    for (const member of [...ledger.state.members]) {
      // Only a fork still routing, something still queued, or someone owing an answer can be cut off.
      const routing = member.kind === 'fork' && member.state === 'started'
      if (!routing && member.state !== 'queued' && ledger.openTo(member.id).length === 0) continue
      if (this.live(member.id) !== undefined) continue
      const previous = this.settling.get(member.id) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => this.recoverMember(main, member.id, policy, openAtResume))
      this.settling.set(member.id, next)
      try {
        await next
      } catch (error) {
        this.deps.log?.(`recovering ${member.name} failed`, error)
      } finally {
        if (this.settling.get(member.id) === next) this.settling.delete(member.id)
      }
      // Rounds that completed before the restart still answer through the ordinary settlement.
      if (!this.writable(main)) return
      const after = ledger.members.get(member.id)
      if (after !== undefined && after.state !== 'failed' && (ledger.openTo(member.id).length > 0 || (after.kind === 'fork' && after.state === 'started'))) this.settleInBackground(main, member.id)
    }
    // A merge a restart caught halfway goes on from the step it recorded.
    for (const merge of ledger.merges) if (merge.state !== 'failed' && merge.state !== 'delivered') void this.advanceMerge(main, merge.id)
    // What waited in the inbox when DSH stopped is still there: a free lead takes it now.
    this.deliverMail(main)
  }

  private async recoverMember(main: Agent, memberId: string, policy: ReturnType<typeof recoveryPolicy>, openAtResume: ReadonlySet<string>): Promise<void> {
    const ledger = this.ledgerOf(main)
    const member = ledger.members.get(memberId)
    if (member === undefined) return
    const forLead: string[] = []
    if (member.state === 'queued') {
      const detail = 'it was waiting for a free slot when DSH restarted and never started'
      this.record(main, s => member.kind === 'fork'
        ? appendForkState(s, { forkId: memberId, state: 'failed', detail })
        : appendAgent(s, { action: 'failed', id: memberId, name: member.name, detail }))
      if (member.kind === 'fork') forLead.push(`The user said: ${member.text}\n${member.name} never started: ${detail}. Nothing was done for it.`)
      for (const request of ledger.openTo(memberId).filter(r => openAtResume.has(r.id))) this.fail(main, request, member, `${RESTART_DETAIL} (${detail})`, forLead)
      for (const text of forLead) this.toLead(main, text, memberId)
      return
    }
    let log: SessionLog | undefined
    try {
      log = await this.logOf(memberId)
    } catch (error) {
      this.deps.log?.(`reading ${member.name} after a restart failed`, error)
    }
    if (!this.writable(main)) return
    const all = log === undefined ? [] : completedRounds(log.events, log.inherited)
    const unsettled = all.filter(r => r.endSeq > (member.settledThrough ?? -1))
    const trace: ChildTrace = log === undefined ? { pending: new Set(), taken: new Set(), requestMessages: new Map(), resumes: new Map() } : traceChild(log.events.slice(log.inherited))
    if (member.kind === 'fork' && member.state === 'started') {
      const last = all.at(-1)
      const concludes = unsettled.some(r => r.stopped === undefined)
      if (!concludes && (last === undefined || cutByRestart(last))) {
        this.record(main, s => appendForkState(s, { forkId: memberId, state: 'failed', detail: 'interrupted by a DSH restart' }))
        const open = ledger.openFrom(memberId).map(r => `${r.id} → ${ledger.nameOf(r.to)}`)
        forLead.push([
          `The user said: ${member.text}`,
          `${member.name} was interrupted by a DSH restart before concluding; it did not finish routing this message.`,
          ...(open.length === 0 ? [] : [`What it had delegated is still open and will be answered to you: ${open.join(', ')}`]),
        ].join('\n'))
      }
    }
    // Deliveries this process is making right now (sent after the resume) are not restart victims.
    const live = (id: string) => this.inflight.has(memberId) || this.queue.some(p => p.memberId === memberId && (p.label === id || p.label === member.name || member.formerNames?.includes(p.label) === true))
    for (const request of ledger.openTo(memberId)) {
      if (!openAtResume.has(request.id) || live(request.id)) continue
      // A request deferred for a worker's Team is answered by any later round that completed.
      const fate = log === undefined ? { kind: 'lost' as const }
        : request.deferred === true && unsettled.some(r => r.stopped === undefined) ? { kind: 'answered' as const }
        : fateOf(request, unsettled, trace)
      if (fate.kind === 'answered') continue
      if (fate.kind === 'lost') {
        this.fail(main, request, member, `${RESTART_DETAIL} (it never reached ${member.name})`, forLead)
        continue
      }
      const done = Math.max(0, ...(trace.resumes.get(request.id)?.keys() ?? []))
      // Only work the restart cut off is resumed; a round someone stopped stays stopped.
      const resumable = policy.onInterrupted === 'resume' && member.kind === 'worker' && member.state === 'started' && fate.byRestart
      if (!resumable || done >= policy.maxResumes) {
        const why = !fate.byRestart ? `${member.name}'s round ended before answering`
          : !resumable ? RESTART_DETAIL
          : `${RESTART_DETAIL} (resumed ${done} time${done === 1 ? '' : 's'}, the limit)`
        this.fail(main, request, member, why, forLead)
        continue
      }
      await this.resumeRequest(main, member, request, done + 1, policy.maxResumes, trace)
    }
    // Every request those cut rounds claimed is now failed or re-pointed at its resume note.
    const lastCut = unsettled.filter(r => r.stopped !== undefined).at(-1)
    if (lastCut !== undefined) this.recoveredThrough.set(memberId, lastCut.endSeq)
    for (const text of forLead) this.toLead(main, text, memberId)
  }

  /** Continue one request in its worker's own session; a note already delivered is reused. */
  private async resumeRequest(main: Agent, member: Member, request: Request, attempt: number, max: number, trace: ChildTrace): Promise<void> {
    const existing = trace.resumes.get(request.id)?.get(attempt)
    const repoint = (messageId: string) => {
      this.record(main, s => appendRequest(s, { action: 'sent', id: request.id, from: request.from, to: request.to, text: request.text, messageId }))
    }
    if (existing !== undefined) { repoint(existing); return }
    let failure = ''
    const outcome = await this.run(main, member.id, request.id, () => this.delivering(main, member.id, async () => {
      const messageId = await this.port.send(main, member.id, resumeText(request.id, attempt, max))
      repoint(messageId)
    }), {
      failed: error => {
        failure = messageOf(error)
        const forLead: string[] = []
        this.fail(main, request, member, `${RESTART_DETAIL} (resuming it failed: ${failure})`, forLead)
        for (const text of forLead) this.toLead(main, text, member.id)
      },
    })
    if (outcome === 'failed') this.deps.log?.(`resuming ${request.id} on ${member.name} failed: ${failure}`)
  }

  // ------------------------------------------------------------------ routing

  /**
   * Admit one main-Session step: late user input goes to a fork; a child's settlement notice
   * becomes the answers of its completed rounds, and only what is for the lead stays.
   * @param main - the main agent.
   * @param messages - claimed messages.
   * @returns the rewritten messages when anything changed, otherwise undefined.
   */
  async admit(main: Agent, messages: readonly UserMessage[]): Promise<UserMessage[] | undefined> {
    if (!isMainSession(main)) return undefined
    let changed = false
    const kept: UserMessage[] = []
    for (const message of messages) {
      if (isUserInput(message) && this.isOn(main)) {
        this.handOff(main, message)
        changed = true
        continue
      }
      const settled = settledSender(message)
      const member = settled === undefined ? undefined : this.ledgerOf(main).members.get(settled)
      if (settled === undefined || member === undefined) {
        kept.push(message)
        continue
      }
      changed = true
      // What the settlement has for the lead waits in its inbox like any other answer: the lead
      // takes it when this turn is over, after anything the user queued, or when the user says so.
      for (const text of await this.settleOnce(main, member.id)) this.toLead(main, text, member.id)
    }
    return changed ? kept : undefined
  }

  /** Settle one member, after any settlement of it already in progress. */
  private settleOnce(main: Agent, memberId: string): Promise<string[]> {
    const previous = this.settling.get(memberId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.settle(main, memberId))
    this.settling.set(memberId, next)
    void next.finally(() => { if (this.settling.get(memberId) === next) this.settling.delete(memberId) }).catch(() => undefined)
    return next
  }

  /**
   * Attribute every round the member completed since the last settlement.
   * @returns texts for the lead.
   */
  private async settle(main: Agent, memberId: string): Promise<string[]> {
    const forLead: string[] = []
    const ledger = this.ledgerOf(main)
    if (!ledger.members.has(memberId)) return forLead
    // The delivery settles this member itself once its message id is recorded.
    if (this.inflight.has(memberId)) return forLead
    const log = await this.logOf(memberId)
    // Released while the log was read: the next open settles these rounds.
    if (!this.writable(main)) return forLead
    const member = ledger.members.get(memberId)!
    const all = completedRounds(log.events, Math.max(log.inherited, (member.settledThrough ?? -1) + 1))
    // A round the host's shutdown cut off (not this scheduler's own interrupt or archive) is left
    // unsettled, with everything after it: the main Session is going away too, so a failure told
    // now could be lost, and `recover` settles it by the configured policy when it comes back.
    const handled = this.recoveredThrough.get(memberId) ?? -1
    const cut = all.findIndex(r => cutByRestart(r) && r.endSeq > handled && !this.stopping.has(memberId))
    const rounds = cut < 0 ? all : all.slice(0, cut)
    if (all.some(r => r.stopped !== undefined)) this.stopping.delete(memberId)
    if (rounds.length === 0) return forLead
    // A worker that leads a Team and ended its round while teammates still work has not answered
    // yet: their answers wake it again, and that round's closing answers the request (src/dsh/host/agent-team.ts).
    const waiting = member.kind === 'worker' && this.teamBusy(memberId)
    for (const [index, round] of rounds.entries()) {
      let answered = 0
      const last = index === rounds.length - 1
      for (const request of ledger.openTo(memberId)) {
        const taken = request.messageId !== undefined && round.claimed.has(request.messageId)
        if (!taken && request.deferred !== true) continue
        if (round.stopped === undefined && last && waiting) {
          if (request.deferred !== true) this.record(main, s => appendRequest(s, { action: 'sent', id: request.id, from: request.from, to: request.to, text: request.text, deferred: true }))
          answered += 1
          continue
        }
        answered += 1
        if (round.stopped !== undefined) {
          // Its message is consumed, so no later round will take it again: it fails now.
          this.fail(main, request, member, `${member.name}'s round ended (${round.stopped}) before answering`, forLead)
          continue
        }
        const merge = ledger.mergeOfRequest(request.id)
        if (merge !== undefined) {
          // A handoff goes on to the merge, not to the lead.
          this.record(main, s => appendRequest(s, { action: 'answered', id: request.id, answer: round.answer, deliveredTo: merge.survivor }))
          void this.advanceMerge(main, merge.id)
          continue
        }
        this.record(main, s => appendRequest(s, { action: 'answered', id: request.id, answer: round.answer, deliveredTo: ledger.mainId }))
        forLead.push(`${this.headerOf(ledger, request, `reply to ${request.id} from ${member.name}`)}\n${round.answer}`)
      }
      // A worker round that answered no request (the user spoke to it directly) reaches nobody,
      // unless it called report: that is an explicit message for the lead. The settled mark
      // below covers this round, so the report is delivered once.
      if (member.kind === 'worker' && answered === 0 && round.stopped === undefined && round.report !== undefined) {
        forLead.push(`[report from ${member.name}, not a request]\n${round.report}`)
      }
    }
    this.record(main, s => appendSettled(s, { agent: memberId, through: rounds.at(-1)!.endSeq }))
    const now = ledger.members.get(memberId)!
    // A fork concludes after every completed round; what it delegated is answered to the lead later.
    // An archived fork reports again only when someone spoke to it directly after it concluded.
    if (now.kind === 'fork' && rounds.at(-1)!.stopped === undefined && (now.state === 'started' || now.state === 'done' || now.state === 'archived')) {
      if (now.state !== 'done' && now.state !== 'archived') this.record(main, s => appendForkState(s, { forkId: memberId, state: 'done' }))
      if (now.state !== 'archived') setTimeout(() => { void this.retire(main, memberId) }, 0)
      const open = ledger.openFrom(memberId).map(r => `${r.id} → ${ledger.nameOf(r.to)}`)
      forLead.push([
        `The user said: ${now.text}`,
        `${now.name} handled it. Its conclusion:`,
        rounds.at(-1)!.answer,
        ...(open.length === 0 ? [] : [`Delegated, answers will come to you: ${open.join(', ')}`]),
      ].join('\n'))
    }
    return forLead
  }

  /**
   * Archive a fork that concluded: it has routed its one message and holds no slot any more.
   * Its chat stays open in the sidebar; speaking to it there wakes it, and it reports again.
   * @param main - the main agent.
   * @param forkId - the fork.
   */
  private async retire(main: Agent, forkId: string): Promise<void> {
    const ledger = this.ledgerOf(main)
    const fork = ledger.members.get(forkId)
    if (!this.writable(main) || fork?.kind !== 'fork' || fork.state !== 'done') return
    try {
      await this.port.drain(main, [forkId])
    } catch (error) {
      this.deps.log?.(`releasing ${fork.name} failed`, error)
    }
    // The main Session may have been released while the fork drained (DSH shutting down): then
    // the fork stays `done`, and archiveConcluded or the next retire archives it after a reopen.
    if (!this.writable(main) || ledger.members.get(forkId)?.state !== 'done') return
    this.record(main, s => appendForkState(s, { forkId, state: 'archived' }))
  }

  /**
   * The bracketed header of a line for the lead, naming who asked when it was not the lead.
   * @returns e.g. `[reply to r-3 from billing, asked by fork-2 for "check retries"]`.
   */
  private headerOf(ledger: Ledger, request: Request, what: string): string {
    if (request.from === ledger.mainId) return `[${what}]`
    const asker = ledger.members.get(request.from)
    if (asker === undefined) return `[${what}]`
    const purpose = asker.kind === 'fork' ? ` for "${asker.text.replace(/\s+/gu, ' ').slice(0, 60)}"` : ''
    return `[${what}, asked by ${asker.name}${purpose}]`
  }

  /** Record a request as failed and tell the lead. */
  private fail(main: Agent, request: Request, by: Member, detail: string, forLead: string[]): void {
    const ledger = this.ledgerOf(main)
    const merge = ledger.mergeOfRequest(request.id)
    if (merge !== undefined) {
      // A handoff its worker could not write: the merge builds one from its log instead.
      this.record(main, s => appendRequest(s, { action: 'failed', id: request.id, detail, deliveredTo: merge.survivor }))
      void this.advanceMerge(main, merge.id)
      return
    }
    this.record(main, s => appendRequest(s, { action: 'failed', id: request.id, detail, deliveredTo: ledger.mainId }))
    forLead.push(this.headerOf(ledger, request, `request ${request.id} to ${by.name} failed: ${detail}`))
  }

  /**
   * Give the lead a message: it waits in the lead's inbox (a plugin record), never in the
   * runtime's queue, and reaches the lead when it is free ({@link deliverMail}).
   */
  private toLead(main: Agent, text: string, sender: string): void {
    // A released lead gets it from `recover` instead.
    if (!this.writable(main)) return
    const ledger = this.ledgerOf(main)
    const id = ledger.nextMailId()
    const { kind, request } = mailKindOf(text)
    this.record(main, s => appendMail(s, { action: 'queued', id, from: sender, kind, ...(request === undefined ? {} : { request }), text }))
    this.scheduleDelivery(main)
  }

  private readonly deliveryDue = new WeakSet<Agent>()

  /** Deliver once after the current burst of messages (one settlement can bring several). */
  private scheduleDelivery(main: Agent): void {
    if (this.deliveryDue.has(main)) return
    this.deliveryDue.add(main)
    queueMicrotask(() => { this.deliveryDue.delete(main); this.deliverMail(main) })
  }

  /** Whether the lead is working, or about to: running, or something already waits in its runtime queue. */
  private leadBusy(main: Agent): boolean {
    return statusOf(this.deps.agents, main.id) === 'running' || pendingOf(main).length > 0
  }

  /**
   * Hand the lead its inbox in one message. Without `now`, only when the lead is free (so what
   * the user queued for it goes first) and only what is not held. With `now` (the user's 「交给
   * lead」), at once: into the running turn's next step, or a new turn when it is idle.
   * @param main - the main agent.
   * @param now - `all` (everything not held) or the ids to hand over now.
   * @returns the ids handed over.
   */
  deliverMail(main: Agent, now?: 'all' | readonly string[]): string[] {
    if (!isMainSession(main) || !this.writable(main)) return []
    const busy = this.leadBusy(main)
    if (now === undefined && busy) return []
    const mail = this.ledgerOf(main).mail
    const items = now === undefined || now === 'all' ? mail.filter(m => m.held !== true) : mail.filter(m => now.includes(m.id))
    if (items.length === 0) return []
    const ids = items.map(m => m.id)
    const via = busy ? 'steer' : 'followup'
    this.record(main, s => appendMail(s, { action: 'delivered', ids, via }))
    const deliver = via === 'steer' ? steerLead : toLead
    deliver(main, items.map(m => m.text).join('\n\n'), items[0]!.from)
    return ids
  }

  /**
   * Put what waits in the lead's inbox into a step that would otherwise hold nothing to answer
   * (the lead was woken by a runtime notice the scheduler emptied). Nothing the user queued may
   * be waiting: that goes first.
   * @returns whether a message was added.
   */
  takeMail(main: Agent, messages: UserMessage[]): boolean {
    // Right after DSH cut the lead's turn (shutting down), a late runtime notice can still wake it:
    // that turn is being torn down too, so the inbox waits for `recover` (or the next free lead).
    if (!isMainSession(main) || !this.writable(main) || pendingOf(main).some(isUserInput) || cutByHost(main)) return false
    const items = this.ledgerOf(main).mail.filter(m => m.held !== true)
    if (items.length === 0) return false
    this.record(main, s => appendMail(s, { action: 'delivered', ids: items.map(m => m.id), via: 'followup' }))
    messages.push(relayMessage(items.map(m => m.text).join('\n\n'), items[0]!.from))
    return true
  }

  /**
   * The user arranges the lead's inbox (`/agents inbox`).
   * @param caller - the main agent (the user's command).
   * @param action - pin, unpin, hold, release, move (before another message, or last), or now.
   * @param id - an `m-N`, or `all` with `now`.
   * @param before - `move`: the message it goes before; undefined puts it last.
   * @returns the ids handed to the lead (`now`), else the id arranged.
   */
  arrangeMail(caller: Agent, action: 'pin' | 'unpin' | 'hold' | 'release' | 'move' | 'now', id: string, before?: string): string[] {
    const main = this.mainOf(caller)
    if (!isMainSession(caller)) throw new Error('the inbox belongs to the main session')
    const mail = this.ledgerOf(main).mail
    if (action === 'now' && id === 'all') return this.deliverMail(main, 'all')
    if (!mail.some(m => m.id === id)) throw new Error(`no message ${id} in the lead's inbox (it may have been handed over already)`)
    if (action === 'now') return this.deliverMail(main, [id])
    if (action === 'move') {
      if (before !== undefined && (before === id || !mail.some(m => m.id === before))) throw new Error(`no message ${before} in the lead's inbox`)
      this.record(main, s => appendMail(s, { action: 'moved', id, before: before ?? null }))
      return [id]
    }
    const record = ({ pin: 'pinned', unpin: 'unpinned', hold: 'held', release: 'released' } as const)[action]
    this.record(main, s => appendMail(s, { action: record, id }))
    // A release can leave a free lead something to take.
    if (action === 'release') this.deliverMail(main)
    return [id]
  }
}

/**
 * Apply {@link Scheduler.admit} as a pre-step decision. Handing a message off from an idle lead
 * still opens its turn, and on the Session's first turn the runtime then adds its context
 * snapshot, which alone would start a model call; a first step holding only context is rejected.
 * Later steps always proceed: the turn has tool results to answer.
 * @param scheduler - the scheduler.
 * @param payload - the proposing agent, claimed messages (rewritten in place), and step.
 * @param next - the rest of the waterfall.
 * @returns the decision.
 */
export async function preStep(
  scheduler: Scheduler,
  payload: { readonly agent: Agent; readonly messages: UserMessage[]; readonly step: number },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const { agent, messages, step } = payload
  // A worker the lead set never runs a step wider than the user's mode is now.
  if (!isMainSession(agent)) scheduler.clampMemberAccess(agent)
  // Nothing claimed at all: the scheduler took the turn's message before DSH claimed it (a hand-off).
  const claimedNothing = messages.length === 0
  const admitted = await scheduler.admit(agent, messages)
  if (admitted !== undefined) messages.splice(0, messages.length, ...admitted)
  const main = isMainSession(agent)
  // A turn opened only by a runtime notice the scheduler emptied takes the lead's inbox instead.
  if (step === 1 && main && admitted !== undefined && messages.every(isContextOnly)) scheduler.takeMail(agent, messages)
  // A first step the scheduler emptied (a hand-off, a settlement notice whose answers already went
  // to the inbox) must not run on context alone, whether or not scheduling is on: DSH appends its
  // time and runtime snapshots to it, and the lead would answer them as an empty user message.
  // Checked on both sides of next(): listener order decides where the runtime's context appears.
  const guarded = step === 1 && main && (scheduler.isOn(agent) || admitted !== undefined || claimedNothing)
  if (guarded && messages.every(isContextOnly) && !await takePending(scheduler, agent, messages)) return refuse(agent)
  const decision = await next()
  if (guarded && decision.kind === 'enter' && decision.messages.every(isContextOnly) && !await takePending(scheduler, agent, decision.messages)) return refuse(agent)
  return decision
}

/**
 * A rejected turn ends without draining the inbox, so anything that arrived while this step was
 * admitted (a reply queued for the lead, a settlement steered in) would wait for the next wake.
 * Take it into this step instead, through the same admission.
 * @returns whether the step now holds something besides context.
 */
/** A recorded `provider/model` route as a selection; undefined when absent or unreadable. */
function parseModelRoute(model: string | undefined): { provider: string; model: string } | undefined {
  const m = model === undefined ? null : /^([^/\s]+)\/(\S+)$/u.exec(model)
  return m === null ? undefined : { provider: m[1]!, model: m[2]! }
}

/**
 * Refuse a first step that carries only context. A refused turn ends without DSH's usual check for
 * more input, so anything sent from here until the driver is idle would wait with no driver: once
 * idle, the lead is woken for it.
 */
function refuse(agent: Agent): PreStepDecision {
  void agent.whenIdle().then(() => { wakeForPending(agent) }).catch(() => undefined)
  return { kind: 'reject' }
}

async function takePending(scheduler: Scheduler, agent: Agent, messages: UserMessage[]): Promise<boolean> {
  const pending = pendingOf(agent).filter(message => removePending(agent, message.id))
  if (pending.length === 0) return false
  messages.push(...(await scheduler.admit(agent, pending) ?? pending))
  return !messages.every(isContextOnly)
}

/**
 * Whether the main Session's latest turn was cut by DSH going away (not by the user's Stop).
 * @param main - the main agent, just idle.
 */
function cutByHost(main: Agent): boolean {
  const events = eventsOf(main.session)
  // A turn that never ran a step (a late runtime notice woke the lead and the scheduler emptied
  // it) says nothing about the lead being back: look past it to the last turn that did work.
  for (let i = events.length - 1; i >= Math.max(0, events.length - 200); i -= 1) {
    if (events[i]!.type !== 'turn/end' || !turnHasStep(events, i)) continue
    const end = turnEndOf(events[i]!)
    return end.kind === 'interrupted' || (end.kind === 'aborted' && (end.cause === 'disposed' || end.cause === 'parent'))
  }
  return false
}

/** Whether the turn that ends at `end` ran at least one step. */
function turnHasStep(events: readonly SessionEvent[], end: number): boolean {
  for (let i = end - 1; i >= 0; i -= 1) {
    const type = events[i]!.type
    if (type === 'step/start') return true
    if (type === 'turn/start' || type === 'turn/end') return false
  }
  return false
}

/**
 * What a message for the lead is, from the header the scheduler wrote on it.
 * @param text - the message.
 * @returns its kind, and the request it answers or fails.
 */
export function mailKindOf(text: string): { kind: MailKind; request?: string } {
  const reply = /^\[reply to (r-\d+)\b/u.exec(text)
  if (reply !== null) return { kind: 'reply', request: reply[1]! }
  if (/^\[merged mg-\d+\b/u.test(text)) return { kind: 'merged' }
  if (/^\[merge mg-\d+ .*? failed\b/u.test(text)) return { kind: 'failure' }
  const failed = /^\[request (r-\d+) to .*? failed\b/u.exec(text)
  if (failed !== null) return { kind: 'failure', request: failed[1]! }
  if (text.startsWith('The user said: ')) return { kind: 'conclusion' }
  return { kind: 'report' }
}
