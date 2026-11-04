/**
 * The scheduler for one preset scope. Rules, not model judgment, decide routing:
 * - a user message to the main Session never reaches the lead: it leaves the inbox on insertion
 *   and a new fork of the lead takes it;
 * - every piece of delegated work is a request; a round of the agent that took it answers the
 *   requests whose messages that round claimed (read from its log, not from what it says);
 * - an answer goes back to whoever asked; when that is gone, to the lead;
 * - a fork reports to the lead only when none of its own requests is open.
 * All children are direct children of the main Session, which sends on everyone's behalf.
 */
import { randomUUID } from 'node:crypto'
import type { Agent, AgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { completedPrefix, forgetForkSeed, registerForkSeed } from './forks-from.js'
import { Ledger, type Member } from './ledger.js'
import {
  appendAgent, appendForkState, appendInput, appendRequest, appendRole, forkModelOf,
  type ForkModelSelection,
} from './records.js'

/** First-message text for a fork. The system prompt explains the tools; this says what it is for. */
export const FORK_NOTICE = [
  'You are a fork of the lead, created to handle only the message above, holding the lead\'s conversation so far.',
  'Analyze, delegate to workers with agent_send or agent_create, or do the work yourself.',
  'Replies to your requests arrive as messages; while any is outstanding, end your turn and wait.',
  'When nothing is outstanding, end your turn with a self-contained conclusion (or call report first): it goes to the lead automatically.',
].join(' ')

/** Marker the runtime appends to a child's first message; we route results ourselves. */
const NATIVE_NOTICE = /^Your parent agent id is "/u

/** Services the scheduler uses, narrowed for tests. */
export interface SchedulerDeps {
  readonly subagents: Pick<SubagentRuntime, 'startActivation' | 'sendMessage' | 'interrupt' | 'drainChildren'>
  readonly agents: { get(id: SessionId): Agent | undefined }
  /** Read a Session's events whether or not it is resident. */
  readonly readEvents: (id: SessionId) => Promise<readonly SessionEvent[]>
  /** Configured model for forks; undefined means the lead's own model. */
  readonly configuredModel?: ForkModelSelection | undefined
  /** Configured default model for workers; undefined inherits the runtime default. */
  readonly configuredWorkerModel?: ForkModelSelection | undefined
  /** Preset for new workers; undefined inherits the main Session's preset. */
  readonly workerPreset?: string | undefined
  readonly log?: (message: string, error?: unknown) => void
  /** Delay before retrying work refused at capacity; tests shorten it. */
  readonly retryMs?: number
}

/** A child start or delivery refused for capacity, retried in order. */
interface Pending {
  readonly mainId: string
  readonly label: string
  readonly attempt: () => Promise<void>
}

export const isMainSession = (agent: Agent): boolean => agent.session.header.parentSession === undefined
const mainIdOf = (agent: Agent): string => agent.session.header.parentSession ?? agent.id
const isUserInput = (message: UserMessage): boolean => message.source.kind === 'user'
/** Context the runtime refreshes on every step; never a reason for the lead to speak. */
const isContextOnly = (message: UserMessage): boolean => (message.source as { form?: unknown }).form === 'snapshot'
/**
 * Whether a refusal is the runtime's capacity guard rather than a defect: the start path reports
 * `ACTIVATION_LIMIT_REACHED`, a cold-resume delivery reports `subagent/delivery-unavailable`.
 * @param error - whatever the runtime threw.
 * @returns true when waiting for a slot can help.
 */
export const isCapacity = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code
  if (code === 'ACTIVATION_LIMIT_REACHED' || code === 'subagent/delivery-unavailable') return true
  return /subagent limit reached|delivery-unavailable|temporarily unavailable/u.test(error instanceof Error ? error.message : String(error))
}

export const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

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
  /** `report` calls not yet consumed by a settled round, per Session. */
  private readonly reports = new Map<string, string>()
  private readonly queue: Pending[] = []
  private draining: ReturnType<typeof setTimeout> | undefined
  /** One drain at a time: several idle/disposed events can arrive while a retry is in flight. */
  private drainRun: Promise<void> | undefined

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

  // ------------------------------------------------------------------ input rule

  /**
   * React to one inserted message. On the main Session a user message is handed to a fork.
   * On a child, the runtime's own result instructions are removed: results are routed here.
   * @param agent - the agent whose inbox changed.
   * @param message - the inserted message.
   * @returns whether the scheduler took or rewrote the message.
   */
  onInserted(agent: Agent, message: UserMessage): boolean {
    if (!isMainSession(agent)) return this.stripNativeNotice(agent, message)
    if (!isUserInput(message) || !agent.inbox.remove(message.id)) return false
    this.handOff(agent, message)
    return true
  }

  private stripNativeNotice(agent: Agent, message: UserMessage): boolean {
    const kept = message.content.filter(block => !(block.type === 'text' && NATIVE_NOTICE.test(block.text)))
    if (kept.length === message.content.length) return false
    return agent.inbox.replace(message.id, { ...message, content: kept })
  }

  private handOff(main: Agent, message: UserMessage): void {
    const forkId = SessionId(`session-${randomUUID()}`)
    const text = textOf(message.content)
    const name = this.ledgerOf(main).nextForkName()
    this.record(main, s => appendInput(s, { messageId: message.id, forkId, text, name }))
    const agentOptions = forkAgentOptions(main, this.deps.configuredModel)
    const start = async () => {
      await this.deps.subagents.startActivation({
        provider: 'fork', label: `${name}: ${text.slice(0, 50)}`, childId: forkId, signal: new AbortController().signal, delivery: 'parent',
        request: { parent: main, prompt: [...message.content, { type: 'text', text: FORK_NOTICE }], ...(agentOptions === undefined ? {} : { agentOptions }) },
      })
      if (this.ledgerOf(main).members.get(forkId)?.state === 'queued') this.record(main, s => appendForkState(s, { forkId, state: 'started' }))
    }
    this.run(main, name, start, () => { this.record(main, s => appendForkState(s, { forkId, state: 'queued' })) }, (error) => {
      this.record(main, s => appendForkState(s, { forkId, state: 'failed', detail: messageOf(error) }))
    })
  }

  // ------------------------------------------------------------------ capacity queue

  /**
   * Run one start or delivery; on capacity refusal mark it queued and retry in order.
   * @param main - the main agent.
   * @param label - what is waiting, for logs.
   * @param attempt - the operation.
   * @param onQueued - called once when it first waits.
   * @param onFailed - called on a non-capacity failure.
   */
  private run(main: Agent, label: string, attempt: () => Promise<void>, onQueued: () => void, onFailed: (error: unknown) => void): void {
    const guarded = async () => {
      try {
        await attempt()
      } catch (error) {
        if (isCapacity(error)) throw error
        this.deps.log?.(`${label} failed`, error)
        onFailed(error)
      }
    }
    if (this.queue.some(p => p.mainId === main.id)) {
      onQueued()
      this.queue.push({ mainId: main.id, label, attempt: guarded })
      this.schedule()
      return
    }
    guarded().catch(() => {
      onQueued()
      this.queue.push({ mainId: main.id, label, attempt: guarded })
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.draining !== undefined || this.drainRun !== undefined || this.queue.length === 0) return
    this.draining = setTimeout(() => { void this.drain() }, this.deps.retryMs ?? 1500)
  }

  /** Retry queued work front to back; stop at the first one still refused. */
  drain(): Promise<void> {
    this.drainRun ??= (async () => {
      if (this.draining !== undefined) clearTimeout(this.draining)
      this.draining = undefined
      try {
        while (this.queue.length > 0) {
          const next = this.queue[0]!
          try {
            await next.attempt()
            this.queue.shift()
          } catch {
            break
          }
        }
      } finally {
        this.drainRun = undefined
      }
      this.schedule()
    })()
    return this.drainRun
  }

  /** @returns labels of queued work, oldest first. */
  queued(): string[] { return this.queue.map(p => p.label) }

  /** Stop retrying (scope disposal). */
  dispose(): void {
    if (this.draining !== undefined) clearTimeout(this.draining)
    this.queue.length = 0
  }

  // ------------------------------------------------------------------ requests

  /**
   * Create a worker as a direct child of the main Session. A task becomes its first request.
   * @param caller - the agent asking.
   * @param args - name, role, and options.
   * @returns the worker's name, id, and the request id when a task was given.
   */
  createWorker(caller: Agent, args: CreateWorker): { name: string; id: string; request?: string; queued: boolean } {
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    if (!/^[a-z][a-z0-9-]{0,39}$/u.test(args.name)) throw new Error('name must be lower-kebab-case, start with a letter, at most 40 characters')
    if (args.name === 'lead' || /^fork-\d+$/u.test(args.name)) throw new Error(`"${args.name}" is reserved`)
    if (ledger.find(args.name) !== undefined) throw new Error(`"${args.name}" is already taken (names are never reused)`)
    const source = args.from === undefined ? undefined : ledger.find(args.from)
    if (args.from !== undefined) {
      if (source === undefined) throw new Error(`no agent named "${args.from}"`)
      if (source.kind !== 'worker') throw new Error(`"${args.from}" is a fork, not a worker; only a worker can be inherited from`)
      if (source.state === 'archived' || source.state === 'failed') throw new Error(`"${args.from}" is ${source.state}`)
      if (args.preset !== undefined) throw new Error('a worker that continues another worker cannot change its preset')
    }
    const id = SessionId(`session-${randomUUID()}`)
    const selection = args.model ?? this.deps.configuredWorkerModel
    const preset = args.preset ?? this.deps.workerPreset
    const cwd = args.cwd ?? source?.cwd
    const model = selection === undefined ? undefined : `${selection.provider}/${selection.model}`
    this.record(main, s => appendAgent(s, { action: 'created', id, name: args.name, role: args.role, ...(cwd === undefined ? {} : { cwd }), ...(model === undefined ? {} : { model }), ...(source === undefined ? {} : { from: source.id }) }))
    const requestId = args.task === undefined ? undefined : ledger.nextRequestId()
    if (requestId !== undefined) {
      this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: args.task! }))
    }
    const first = [
      `You are worker "${args.name}" in an Agent Scheduler session.`,
      ...(source === undefined ? [] : [`You continue worker "${source.name}": its conversation so far is your context.`]),
      `Your role: ${args.role}`,
      requestId === undefined ? 'No task yet: acknowledge briefly and wait for requests.' : this.requestText(requestId, ledger.nameOf(caller.id), args.task!),
    ].join('\n\n')
    let queued = false
    const start = async () => {
      // The manager prepares the child after reserving its id: register the inherited
      // conversation for that id before starting, and drop it once the child exists.
      if (source !== undefined) {
        const live = this.deps.agents.get(SessionId(source.id))
        const events = live?.session.snapshotEvents() ?? await this.deps.readEvents(SessionId(source.id))
        registerForkSeed(id, completedPrefix(events))
      }
      const activation = await this.deps.subagents.startActivation({
        provider: source === undefined ? 'spawn' : 'fork-from', label: args.name, childId: id, signal: new AbortController().signal, delivery: 'parent',
        request: {
          parent: main, prompt: [{ type: 'text', text: first }],
          ...(cwd === undefined ? {} : { cwd }),
          ...(preset === undefined ? {} : { agentPreset: preset }),
          ...(selection === undefined ? {} : { agentOptions: selectionOptions(selection) }),
        },
      })
      forgetForkSeed(id)
      if (ledger.members.get(id)?.state === 'queued') this.record(main, s => appendAgent(s, { action: 'started', id, name: args.name }))
      if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'sent', id: requestId, from: caller.id, to: id, text: args.task!, messageId: activation.messageId }))
    }
    this.run(main, args.name, start, () => {
      queued = true
      this.record(main, s => appendAgent(s, { action: 'queued', id, name: args.name }))
    }, (error) => {
      forgetForkSeed(id)
      this.record(main, s => appendAgent(s, { action: 'failed', id, name: args.name, detail: messageOf(error) }))
      if (requestId !== undefined) this.record(main, s => appendRequest(s, { action: 'failed', id: requestId, detail: messageOf(error) }))
    })
    return { name: args.name, id, queued, ...(requestId === undefined ? {} : { request: requestId }) }
  }

  private requestText(id: string, from: string, text: string): string {
    return `[request ${id} from ${from}]\n${text}\n\nAnswer it, then end your turn: your final message (or your report) goes back to ${from} automatically.`
  }

  /**
   * Send a request to a worker or fork on the caller's behalf.
   * @param caller - the agent asking.
   * @param to - name of the target.
   * @param text - the request.
   * @returns the request id.
   */
  async send(caller: Agent, to: string, text: string): Promise<{ request: string; to: string }> {
    const main = this.mainOf(caller)
    const ledger = this.ledgerOf(main)
    const target = ledger.find(to)
    if (target === undefined) throw new Error(`no agent named "${to}"; use agent_list`)
    if (target.id === caller.id) throw new Error('cannot send a request to yourself')
    if (target.state === 'archived' || target.state === 'failed') throw new Error(`"${to}" is ${target.state}`)
    const id = ledger.nextRequestId()
    const from = ledger.nameOf(caller.id)
    this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text }))
    const deliver = async () => {
      const messageId = await this.deps.subagents.sendMessage(main, SessionId(target.id), [{ type: 'text', text: this.requestText(id, from, text) }], { signal: new AbortController().signal })
      this.record(main, s => appendRequest(s, { action: 'sent', id, from: caller.id, to: target.id, text, messageId }))
    }
    this.run(main, id, deliver, () => {}, (error) => { this.record(main, s => appendRequest(s, { action: 'failed', id, detail: messageOf(error) })) })
    return { request: id, to: target.name }
  }

  /**
   * Remember a caller's conclusion for its current round.
   * @param caller - the reporting agent.
   * @param summary - the conclusion.
   */
  report(caller: Agent, summary: string): void { this.reports.set(caller.id, summary) }

  /**
   * Stop a member's current round.
   * @param caller - the agent asking.
   * @param name - the member.
   */
  interrupt(caller: Agent, name: string): void {
    const main = this.mainOf(caller)
    const target = this.ledgerOf(main).find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
    this.deps.subagents.interrupt(SessionId(target.id), { kind: 'ancestor', agent: main })
  }

  /**
   * Archive a worker: release it and keep its name taken.
   * @param caller - the agent asking.
   * @param name - the worker.
   */
  async archive(caller: Agent, name: string): Promise<void> {
    const main = this.mainOf(caller)
    const target = this.ledgerOf(main).find(name)
    if (target === undefined) throw new Error(`no agent named "${name}"`)
    if (target.state === 'archived') return
    await this.deps.subagents.drainChildren(main, [SessionId(target.id)])
    this.record(main, s => target.kind === 'fork'
      ? appendForkState(s, { forkId: target.id, state: 'done', detail: 'archived' })
      : appendAgent(s, { action: 'archived', id: target.id, name: target.name }))
    if (target.kind === 'fork') target.state = 'archived'
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

  // ------------------------------------------------------------------ routing

  /**
   * Admit one main-Session step: late user input goes to a fork; each child's settled round
   * answers the requests it claimed, and only what is for the lead stays in the step.
   * @param main - the main agent.
   * @param messages - claimed messages.
   * @returns the rewritten messages when anything changed, otherwise undefined.
   */
  async admit(main: Agent, messages: readonly UserMessage[]): Promise<UserMessage[] | undefined> {
    if (!isMainSession(main)) return undefined
    let changed = false
    const kept: UserMessage[] = []
    for (const message of messages) {
      if (isUserInput(message)) {
        this.handOff(main, message)
        changed = true
        continue
      }
      const sender = message.source.kind === 'subagent-settled' ? message.source.senderSessionId : undefined
      const member = sender === undefined ? undefined : this.ledgerOf(main).members.get(sender)
      if (member === undefined) {
        kept.push(message)
        continue
      }
      changed = true
      const forLead = await this.settle(main, member, message)
      if (forLead !== undefined) kept.push(forLead)
    }
    return changed ? kept : undefined
  }

  /** Route one settled round; returns what the lead should see, if anything. */
  private async settle(main: Agent, member: Member, message: UserMessage): Promise<UserMessage | undefined> {
    const ledger = this.ledgerOf(main)
    const answer = this.reports.get(member.id) ?? textOf(message.content)
    this.reports.delete(member.id)
    const claimed = await this.claimedIds(member.id)
    const answered = ledger.openTo(member.id).filter(r => r.messageId !== undefined && claimed.has(r.messageId))
    const forLead: string[] = []
    for (const request of answered) {
      const requester = request.from === ledger.mainId ? undefined : ledger.members.get(request.from)
      const gone = requester !== undefined && (requester.state === 'archived' || requester.state === 'failed')
      if (requester === undefined || gone) {
        this.record(main, s => appendRequest(s, { action: 'answered', id: request.id, answer, deliveredTo: ledger.mainId }))
        forLead.push(`[reply to ${request.id} from ${member.name}${gone ? `; ${requester.name} is ${requester.state}, so it comes to you` : ''}]\n${answer}`)
        continue
      }
      this.record(main, s => appendRequest(s, { action: 'answered', id: request.id, answer, deliveredTo: requester.id }))
      const reply = `[reply to ${request.id} from ${member.name}]\n${answer}`
      this.run(main, `reply ${request.id}`, async () => {
        await this.deps.subagents.sendMessage(main, SessionId(requester.id), [{ type: 'text', text: reply }], { signal: new AbortController().signal })
      }, () => {}, (error) => { this.deps.log?.(`reply ${request.id} undeliverable`, error) })
    }
    if (member.kind === 'fork' && ledger.openFrom(member.id).length === 0 && member.state !== 'failed') {
      if (member.state !== 'done') this.record(main, s => appendForkState(s, { forkId: member.id, state: 'done' }))
      forLead.push(`The user said: ${member.text}\n${member.name} handled it. Its conclusion:\n${answer}`)
    }
    if (forLead.length === 0) return undefined
    return { ...message, content: [{ type: 'text', text: forLead.join('\n\n') }] }
  }

  /** Inbox ids of every message the Session has claimed. */
  private async claimedIds(id: string): Promise<Set<string>> {
    const live = this.deps.agents.get(SessionId(id))
    const events = live?.session.snapshotEvents() ?? await this.deps.readEvents(SessionId(id))
    const ids = new Set<string>()
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const messageId = (event.data as { id?: unknown }).id
      if (typeof messageId === 'string') ids.add(messageId)
    }
    return ids
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  if (step === 1 && main && messages.every(isContextOnly)) return { kind: 'reject' }
  const decision = await next()
  if (step === 1 && main && decision.kind === 'enter' && decision.messages.every(isContextOnly)) return { kind: 'reject' }
  return decision
}
