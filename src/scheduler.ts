/**
 * The scheduler for one preset scope. Rules, not model judgment, decide routing:
 * - a user message to the main Session never reaches the lead: it leaves the inbox on insertion
 *   and a new fork of the lead takes it;
 * - every piece of delegated work is a request; each completed round of the agent that took it
 *   answers the requests whose messages that round claimed, read from its log;
 * - there is one pipeline and it ends at the lead: a fork's conclusion, a worker's answer, and a
 *   failed request all report to the lead. Nobody is woken again just to relay a result, so a
 *   fork concludes after delegating instead of waiting for its workers;
 * - all children are direct children of the main Session, which sends on everyone's behalf.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Agent, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createDeveloperMessage, createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { FORK_FROM_PROVIDER, forgetForkSeed, forkSeed, registerForkSeed } from './forks-from.js'
import { Ledger, type Member, type Request } from './ledger.js'
import {
  appendAgent, appendForkState, appendInput, appendMode, appendRequest, appendRole, appendSettled, forkModelOf,
  type ForkModelSelection,
} from './records.js'
import { schedulingOn } from './projection.js'
import { completedRounds, cutByRestart } from './rounds.js'
import { fateOf, recoveryPolicy, RESTART_DETAIL, resumeText, traceChild, type ChildTrace } from './recovery.js'

/**
 * What a fork is for. It lives in the system-prompt section shared by the lead and its forks (so a
 * fork keeps the lead's cache prefix), not in the fork's first message: that message is the user's
 * bubble in the fork's chat and must show only what the user typed.
 */
export const FORK_NOTICE = [
  'If the newest message is the user\'s own words, you are a fork of the lead, created to route only that message, holding the lead\'s conversation so far.',
  'You are a router, not a worker. Work out what is being asked and which repository or area it belongs to, then hand it over, agent_list first:',
  '(1) a follow-up to work already given (rework, a question about it, review comments) goes by agent_send to the worker that did it;',
  '(2) a new task in an area a worker already owns, when that worker is running (state "running" in agent_list) or the task needs its own branch or worktree, goes to a new worker forked from the owner so it runs in parallel instead of queueing: agent_create with from: <owner>, name: <area>-<feature>, its own cwd (a new worktree), role and task;',
  '(3) a new area or repository with no worker yet: agent_create without from, with a role, its own cwd (one worker per directory or worktree) and the task.',
  'Do not do the work yourself: no edits, builds, tests or long investigations. Read only what you need to route well. Answer directly only what needs no work: a greeting, or a fact already in this conversation.',
  'Do not wait for workers: their answers go to the lead directly, not back to you.',
  'End your turn with a short conclusion of what was asked and what you handed to whom (or call report first): it goes to the lead automatically, and you are then archived.',
].join(' ')

/** What the lead is for: the user reads only the lead's own replies. */
export const LEAD_NOTICE = [
  'Otherwise you are the lead. The user\'s words never reach you directly; you receive forks\' conclusions as "The user said: ... Its conclusion: ...", workers\' answers as "[reply to r-N from name, asked by ...]", and failures as "[request r-N to name failed: ...]".',
  'The user does not read those messages or the forks\' work: only your replies. Tell the user the result in your own words, briefly, with anything they must decide. Never say you already answered them unless you did in a reply of your own.',
].join(' ')

/** Marker the runtime appends to a child's first message; we route results ourselves. */
const NATIVE_NOTICE = /^Your parent agent id is "/u

/** A child's log as stored: contiguous from seq 0, its first `inherited` events copied from a parent. */
export interface SessionLog {
  readonly events: readonly SessionEvent[]
  readonly inherited: number
}

/** Services the scheduler uses, narrowed for tests. */
export interface SchedulerDeps {
  readonly subagents: Pick<SubagentRuntime, 'startActivation' | 'sendMessage' | 'interrupt' | 'drainChildren'>
  readonly agents: { get(id: SessionId): Agent | undefined }
  /** Read a Session's log whether or not it is resident. */
  readonly readLog: (id: SessionId) => Promise<SessionLog>
  /** Configured model for forks; undefined means the lead's own model. */
  readonly configuredModel?: ForkModelSelection | undefined
  /** Configured default model for workers; undefined inherits the runtime default. */
  readonly configuredWorkerModel?: ForkModelSelection | undefined
  /** Preset for new workers; undefined inherits the main Session's preset. */
  readonly workerPreset?: string | undefined
  readonly log?: (message: string, error?: unknown) => void
  /**
   * Whether a Session that never recorded a switch schedules. True only for Sessions of the
   * retired `scheduler` preset, which scheduled from their first message.
   */
  readonly defaultOn?: boolean | undefined
  /** Delay before retrying work refused at capacity; tests shorten it. */
  readonly retryMs?: number
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

export const isMainSession = (agent: Agent): boolean => agent.session.header.parentSession === undefined
const mainIdOf = (agent: Agent): string => agent.session.header.parentSession ?? agent.id
const isUserInput = (message: UserMessage): boolean => message.source.kind === 'user'

/** Source of the empty node that hides a handed-off message from the lead's model input. */
export const HANDOFF_SOURCE = 'agent-scheduler-handoff'

/**
 * Log a handed-off user message as received, then hide it from the lead's model input.
 *
 * The browser composer releases a sent draft (text and attachments) only once the Session log
 * holds a `user/message` carrying the prompt's request id; an inbox removal is recorded as a
 * cancellation, and a draft with attachments is then restored as unsent. Logging the message
 * gives the composer its receipt and the chat the user's own bubble, images included. The
 * replacement that follows shadows that one surface node, inside a step with an empty developer message
 * which yields no model message, so the lead never reads the words a fork is handling. Outside
 * a step the shadow is a one-line note instead (the format allows developer messages only
 * inside steps).
 * @param session - the main Session.
 * @param message - the user message being handed to a fork.
 * @param note - the line the lead reads in its place when no step is open.
 * @returns false when the log has no system prompt yet and nothing could be logged.
 */
export function admitHidden(session: Session, message: UserMessage, note: string): boolean {
  // A log's first surface node must be the system prompt, which only the lead's first step
  // writes; before it, a user message cannot be logged at all.
  const head = session.surface.nodes[0]
  if (head === undefined || session.eventAt(head)?.type !== 'system/message') return false
  const logged = session.append('user/message', message, { surfaceOp: 'append' })
  const replace = { surfaceOp: { op: 'replace', startSeq: logged.seq, endSeq: logged.seq }, sourceEventSeqs: [logged.seq] } as never
  const open = openStep(session.snapshotEvents())
  if (open !== undefined) {
    // Inside a step the node may sit between a tool call and its result, where no user message
    // may stand; an empty developer message of that step yields no model message at all.
    session.append('developer/message', {
      ...open,
      message: createDeveloperMessage({ source: { kind: HANDOFF_SOURCE } as never, content: [] }),
    } as never, replace)
    return true
  }
  // Outside a step a developer message is not allowed; a one-line note in its place is.
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: HANDOFF_SOURCE } as never }), replace)
  return true
}

/** The turn and step of a step still open at the end of the log, if any. */
function openStep(events: readonly SessionEvent[]): { turn: number; step: number } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'step/end' || event.type === 'turn/end') return undefined
    if (event.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
  }
  return undefined
}
/** Context the runtime refreshes on every step; never a reason for the lead to speak. */
const isContextOnly = (message: UserMessage): boolean => (message.source as { form?: unknown }).form === 'snapshot'

/**
 * Whether a refusal is the runtime's residency limit, the one failure that waiting cures.
 * Persistence, draining, and authority failures are real and are not retried.
 * @param error - whatever the runtime threw.
 * @returns true for `ACTIVATION_LIMIT_REACHED`.
 */
export const isCapacity = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'ACTIVATION_LIMIT_REACHED'
  || /subagent limit reached/u.test(error instanceof Error ? error.message : String(error))

export const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const gone = (member: Member | undefined): boolean => member !== undefined && (member.state === 'archived' || member.state === 'failed')

/**
 * Resolve the model a new fork uses: Session override, then plugin config, then the lead's.
 * @param agent - the lead.
 * @param configured - plugin configuration.
 * @returns options for the fork, or undefined to inherit the lead's and keep its cache prefix.
 */
export function forkAgentOptions(agent: Agent, configured: ForkModelSelection | undefined): AgentOptions | undefined {
  const selection = forkModelOf(agent.session.snapshotEvents()) ?? configured
  return selection === undefined ? undefined : selectionOptions(selection)
}

/**
 * @param selection - a provider/model pair.
 * @returns agent options carrying it.
 */
export function selectionOptions(selection: ForkModelSelection): AgentOptions {
  const { provider, model, reasoningEffort } = selection
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as NonNullable<AgentOptions['reasoningEffort']> }) }
}

/** Arguments of a worker creation. */
export interface CreateWorker {
  readonly name: string
  readonly role: string
  readonly cwd?: string | undefined
  readonly preset?: string | undefined
  readonly model?: ForkModelSelection | undefined
  /** Existing worker whose conversation this one continues. */
  readonly from?: string | undefined
  readonly task?: string | undefined
}

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

  /** @param deps - services and policy. */
  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * The ledger of the main Session an agent belongs to.
   * @param agent - the main agent or one of its children.
   * @returns the ledger, folded from the main log on first use.
   */
  ledgerOf(agent: Agent): Ledger {
    const mainId = mainIdOf(agent)
    let ledger = this.ledgers.get(mainId)
    if (ledger === undefined) {
      const main = this.deps.agents.get(SessionId(mainId)) ?? (isMainSession(agent) ? agent : undefined)
      ledger = Ledger.from(mainId, main?.session.snapshotEvents() ?? [])
      this.ledgers.set(mainId, ledger)
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
   * Whether an agent belongs to scheduling: the main Session while it is on, or one of its forks
   * and workers. Children of ordinary subagent tools are not members and are left alone.
   * @param agent - any agent of this preset.
   * @returns membership.
   */
  takesPart(agent: Agent): boolean {
    return isMainSession(agent) ? this.isOn(agent) : this.ledgerOf(agent).members.has(agent.id)
  }

  /**
   * Refuse a scheduling tool for an agent that does not take part.
   * @param agent - the calling agent.
   */
  assertTakesPart(agent: Agent): void {
    if (this.takesPart(agent)) return
    throw new Error(isMainSession(agent)
      ? 'Scheduling is off in this session. The user turns it on with the 调度 switch below the input or /schedule on; until then, work directly.'
      : 'This agent is not part of scheduling.')
  }

  /** Forget a main Session (it was disposed); the log stays authoritative. */
  forget(mainId: string): void { this.ledgers.delete(mainId) }

  private mainOf(agent: Agent): Agent {
    const main = isMainSession(agent) ? agent : this.deps.agents.get(SessionId(mainIdOf(agent)))
    if (main === undefined) throw new Error('the main session is not running')
    return main
  }

  /** Append through the ledger, so the fold and the log never disagree. */
  private record(main: Agent, append: (session: Session) => unknown): void {
    append(main.session)
    const events = main.session.snapshotEvents()
    this.ledgerOf(main).apply(events[events.length - 1]!)
  }

  private async logOf(id: string): Promise<SessionLog> {
    const live = this.deps.agents.get(SessionId(id))
    if (live !== undefined) return { events: live.session.snapshotEvents(), inherited: Number(live.session.inheritedEventCount) }
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
    if (!isUserInput(message) || !this.isOn(agent) || !agent.inbox.nextTurn.concat(agent.inbox.nextStep).some(m => m.id === message.id)) return false
    this.handOff(agent, message)
    return true
  }

  private stripNativeNotice(agent: Agent, message: UserMessage): boolean {
    const kept = message.content.filter(block => !(block.type === 'text' && NATIVE_NOTICE.test(block.text)))
    if (kept.length === message.content.length) return false
    return agent.inbox.replace(message.id, { ...message, content: kept })
  }

  private handOff(main: Agent, message: UserMessage): void {
    // A Session that schedules by default records it once, so the client's switch shows it.
    if (this.ledgerOf(main).state.enabled === null) this.record(main, s => appendMode(s, true))
    const forkId = SessionId(`session-${randomUUID()}`)
    const text = textOf(message.content)
    const name = this.ledgerOf(main).nextForkName()
    // Admit before removing: the composer keeps a draft with attachments until it sees the
    // message logged; a removal alone reads to it as a canceled send and restores the draft.
    const logged = admitHidden(main.session, message, `[A user message was handed to ${name}; its conclusion will come to you.]`)
    main.inbox.remove(message.id)
    this.record(main, s => appendInput(s, { messageId: message.id, forkId, text, name, ...(logged ? { logged: true as const } : {}) }))
    const agentOptions = forkAgentOptions(main, this.deps.configuredModel)
    void this.run(main, forkId, name, async () => {
      await this.deps.subagents.startActivation({
        provider: 'fork', label: `${name}: ${text.slice(0, 50)}`, childId: forkId, signal: new AbortController().signal, delivery: 'parent',
        request: { parent: main, prompt: [...message.content], ...(agentOptions === undefined ? {} : { agentOptions }) },
      })
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
    if (status !== 'idle') return
    if (this.queue.length > 0) void this.drain()
    if (isMainSession(agent)) return
    const main = this.deps.agents.get(SessionId(mainIdOf(agent)))
    if (main === undefined || !this.ledgerOf(main).members.has(agent.id)) return
    this.settleInBackground(main, agent.id)
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
  queued(mainId?: string): string[] { return this.queue.filter(p => mainId === undefined || p.mainId === mainId).map(p => p.label) }

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
  async createWorker(caller: Agent, args: CreateWorker): Promise<{ name: string; id: string; request?: string; queued: boolean }> {
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    const checkName = (): void => {
      if (!/^[a-z][a-z0-9-]{0,39}$/u.test(args.name)) throw new Error('name must be lower-kebab-case, start with a letter, at most 40 characters')
      if (args.name === 'lead' || /^fork-\d+$/u.test(args.name)) throw new Error(`"${args.name}" is reserved`)
      // A worker that failed to start never ran: its name is free again, and creating it anew
      // replaces that member in the roster (see applyRoster). Archived names are never reused.
      const holder = ledger.find(args.name)
      if (holder !== undefined && !(holder.kind === 'worker' && holder.state === 'failed')) throw new Error(`"${args.name}" is already taken (names are never reused)`)
    }
    checkName()
    const source = args.from === undefined ? undefined : ledger.find(args.from)
    let seed: SessionEvent[] | undefined
    if (args.from !== undefined) {
      if (source === undefined) throw new Error(`no agent named "${args.from}"`)
      if (source.kind !== 'worker') throw new Error(`"${args.from}" is a fork; only a worker can be continued`)
      if (gone(source)) throw new Error(`"${args.from}" is ${source.state}`)
      if (args.preset !== undefined) throw new Error('a worker that continues another worker keeps its preset')
      seed = forkSeed((await this.logOf(source.id)).events, source.name)
      checkName()
    }
    const id = SessionId(`session-${randomUUID()}`)
    const selection = args.model ?? this.deps.configuredWorkerModel
    const preset = args.preset ?? this.deps.workerPreset
    // One worker per directory: this is what keeps two writers out of the same tree. A worker
    // continued from another gets no default directory, since its source still works in its own.
    const base = main.session.header.cwd ?? process.cwd()
    const cwd = args.cwd === undefined ? undefined : isAbsolute(args.cwd) ? args.cwd : resolve(base, args.cwd)
    if (cwd !== undefined) {
      // Checked before anything is recorded, so a bad directory costs no roster entry.
      if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}; create it (or the worktree) first`)
      if (!statSync(cwd).isDirectory()) throw new Error(`working directory is not a directory: ${cwd}`)
      const holder = ledger.state.members.find(m => m.kind === 'worker' && !gone(m) && m.cwd !== undefined && resolve(base, m.cwd) === cwd)
      if (holder !== undefined) throw new Error(`"${holder.name}" already works in ${cwd}; give each worker its own directory or worktree`)
    }
    const model = selection === undefined ? undefined : `${selection.provider}/${selection.model}`
    this.record(main, s => appendAgent(s, {
      action: 'created', id, name: args.name, role: args.role,
      ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }), ...(source === undefined ? {} : { from: source.id }),
    }))
    const task = args.task
    const requestId = task === undefined ? undefined : ledger.nextRequestId()
    if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: task! }))
    const first = [
      `You are worker "${args.name}" in an Agent Scheduler session.`,
      ...(source === undefined ? [] : [`You continue worker "${source.name}": its conversation so far is your context.`]),
      `Your role: ${args.role}`,
      requestId === undefined ? 'No task yet: acknowledge briefly and wait for requests.' : this.requestText(requestId, ledger.nameOf(caller.id), task!),
    ].join('\n\n')
    let failure = ''
    const outcome = await this.run(main, id, args.name, () => this.delivering(main, id, async () => {
      if (seed !== undefined) registerForkSeed(id, seed)
      let messageId: string
      try {
        ;({ messageId } = await this.deps.subagents.startActivation({
          provider: seed === undefined ? 'spawn' : FORK_FROM_PROVIDER, label: args.name, childId: id, signal: new AbortController().signal, delivery: 'parent',
          request: {
            parent: main, prompt: [{ type: 'text', text: first }],
            ...(cwd === undefined ? {} : { cwd }),
            ...(preset === undefined ? {} : { agentPreset: preset }),
            ...(selection === undefined ? {} : { agentOptions: selectionOptions(selection) }),
          },
        }))
      } finally {
        forgetForkSeed(id)
      }
      if (ledger.members.get(id)?.state === 'queued') this.record(main, s => appendAgent(s, { action: 'started', id, name: args.name }))
      if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: task!, messageId }))
    }), {
      queued: () => { this.record(main, s => appendAgent(s, { action: 'queued', id, name: args.name })) },
      failed: error => {
        failure = messageOf(error)
        this.record(main, s => appendAgent(s, { action: 'failed', id, name: args.name, detail: failure }))
        if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'failed', id: requestId, detail: failure }))
      },
    })
    if (outcome === 'failed') throw new Error(`could not start "${args.name}": ${failure}`)
    return { name: args.name, id, queued: outcome === 'queued', ...(requestId === undefined ? {} : { request: requestId }) }
  }

  /** A request as the worker's chat shows it: who asks and what. How to answer is in its system prompt. */
  private requestText(id: string, from: string, text: string): string {
    return `[request ${id} from ${from}]\n${text}`
  }

  /**
   * Send a request to a worker or fork on the caller's behalf.
   * @param caller - the agent asking.
   * @param to - name of the target.
   * @param text - the request.
   * @returns the request id, and whether delivery waits for a slot.
   * @throws when the target is unknown or gone, or delivery failed.
   */
  async send(caller: Agent, to: string, text: string): Promise<{ request: string; to: string; queued: boolean; busy: boolean; note: string }> {
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    const target = ledger.find(to)
    if (target === undefined) throw new Error(`no agent named "${to}"; use agent_list`)
    if (target.id === caller.id) throw new Error('cannot send a request to yourself')
    if (gone(target)) throw new Error(`"${to}" is ${target.state}`)
    // A running target takes the message at its next step boundary, inside the round it is in;
    // say so, since `queued` alone (waiting for a slot) reads as "it is being handled now".
    const busy = this.deps.agents.get(SessionId(target.id))?.status === 'running'
    const id = ledger.nextRequestId()
    const from = ledger.nameOf(caller.id)
    this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text }))
    let failure = ''
    // A target still waiting to start is ahead in the queue, so this delivery waits behind it.
    const outcome = await this.run(main, target.id, id, () => this.delivering(main, target.id, async () => {
      const messageId = await this.deps.subagents.sendMessage(main, SessionId(target.id), [{ type: 'text', text: this.requestText(id, from, text) }], { signal: new AbortController().signal })
      this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text, messageId }))
    }), {
      failed: error => {
        failure = messageOf(error)
        this.record(main, s => appendRequest(s, { action: 'failed', id, detail: failure }))
      },
    })
    if (outcome === 'failed') throw new Error(`request ${id} to "${target.name}" was not delivered: ${failure}`)
    const queued = outcome === 'queued'
    const note = queued
      ? `${target.name} has not started yet (no free slot); ${id} is delivered when it starts.`
      : busy
        ? `${target.name} is busy; it reads ${id} after its current step and answers it when its current round ends, together with what it is doing now.`
        : `${target.name} was idle and starts on ${id} now.`
    return { request: id, to: target.name, queued, busy, note }
  }

  /**
   * Stop a member's current round.
   * @param caller - the agent asking.
   * @param name - the member.
   */
  interrupt(caller: Agent, name: string): void {
    const main = this.mainOf(caller)
    const target = this.ledgerOf(main).find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
    this.stopping.add(target.id)
    this.deps.subagents.interrupt(SessionId(target.id), { kind: 'ancestor', agent: main })
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
    const target = ledger.find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
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
      await this.deps.subagents.drainChildren(main, [SessionId(target.id)])
      // Rounds it completed still answer; the one it was cut off in fails its requests.
      forLead.push(...await this.settleOnce(main, target.id))
    }
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
    const done = ledger.state.members.filter(m => m.kind === 'fork' && m.state === 'done' && ledger.openTo(m.id).length === 0 && this.deps.agents.get(SessionId(m.id))?.status !== 'running')
    for (const fork of done) await this.archive(main, fork.id)
    return done.map(m => m.name)
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
      if (this.deps.agents.get(SessionId(member.id)) !== undefined) continue
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
      const after = ledger.members.get(member.id)
      if (after !== undefined && after.state !== 'failed' && (ledger.openTo(member.id).length > 0 || (after.kind === 'fork' && after.state === 'started'))) this.settleInBackground(main, member.id)
    }
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
    const live = (id: string) => this.inflight.has(memberId) || this.queue.some(p => p.memberId === memberId && (p.label === id || p.label === member.name))
    for (const request of ledger.openTo(memberId)) {
      if (!openAtResume.has(request.id) || live(request.id)) continue
      const fate = log === undefined ? { kind: 'lost' as const } : fateOf(request, unsettled, trace)
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
      const messageId = await this.deps.subagents.sendMessage(main, SessionId(member.id), [{ type: 'text', text: resumeText(request.id, attempt, max) }], { signal: new AbortController().signal })
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
      const settled = message.source.kind === 'subagent-settled' ? message.source : undefined
      const member = settled === undefined ? undefined : this.ledgerOf(main).members.get(settled.senderSessionId)
      if (settled === undefined || member === undefined) {
        kept.push(message)
        continue
      }
      changed = true
      const forLead = await this.settleOnce(main, member.id)
      if (forLead.length === 0) continue
      // The runtime's row label says the child "will do no further work"; ours names what arrived.
      const concluded = forLead.some(text => text.startsWith('The user said: '))
      const replies = forLead.filter(text => !text.startsWith('[report from ')).length
      const summary = boundContextSummary(concluded ? `${member.name} concluded`
        : replies === 0 ? `${member.name} reported`
        : `${member.name} answered ${replies === 1 ? 'a request' : `${replies} requests`}`)
      kept.push({ ...message, source: { ...settled, summary }, content: [{ type: 'text', text: forLead.join('\n\n') }] })
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
    for (const round of rounds) {
      let answered = 0
      for (const request of ledger.openTo(memberId)) {
        if (request.messageId === undefined || !round.claimed.has(request.messageId)) continue
        answered += 1
        if (round.stopped !== undefined) {
          // Its message is consumed, so no later round will take it again: it fails now.
          this.fail(main, request, member, `${member.name}'s round ended (${round.stopped}) before answering`, forLead)
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
    if (fork?.kind !== 'fork' || fork.state !== 'done') return
    try {
      await this.deps.subagents.drainChildren(main, [SessionId(forkId)])
    } catch (error) {
      this.deps.log?.(`releasing ${fork.name} failed`, error)
    }
    if (ledger.members.get(forkId)?.state !== 'done') return
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
    this.record(main, s => appendRequest(s, { action: 'failed', id: request.id, detail, deliveredTo: ledger.mainId }))
    forLead.push(this.headerOf(ledger, request, `request ${request.id} to ${by.name} failed: ${detail}`))
  }

  /** Give the lead a message outside a step it is admitting: queued for its next turn. */
  private toLead(main: Agent, text: string, sender: string): void {
    main.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId(sender) } }))
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
  const admitted = await scheduler.admit(agent, messages)
  if (admitted !== undefined) messages.splice(0, messages.length, ...admitted)
  const main = isMainSession(agent)
  // Checked on both sides of next(): listener order decides where the runtime's context appears.
  if (step === 1 && main && scheduler.isOn(agent) && messages.every(isContextOnly) && !await takePending(scheduler, agent, messages)) return { kind: 'reject' }
  const decision = await next()
  if (step === 1 && main && scheduler.isOn(agent) && decision.kind === 'enter' && decision.messages.every(isContextOnly) && !await takePending(scheduler, agent, decision.messages)) return { kind: 'reject' }
  return decision
}

/**
 * A rejected turn ends without draining the inbox, so anything that arrived while this step was
 * admitted (a reply queued for the lead, a settlement steered in) would wait for the next wake.
 * Take it into this step instead, through the same admission.
 * @returns whether the step now holds something besides context.
 */
async function takePending(scheduler: Scheduler, agent: Agent, messages: UserMessage[]): Promise<boolean> {
  const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => agent.inbox.remove(message.id))
  if (pending.length === 0) return false
  messages.push(...(await scheduler.admit(agent, pending) ?? pending))
  return !messages.every(isContextOnly)
}
