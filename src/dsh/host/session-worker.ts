/**
 * Workers as top-level Sessions (design §2, option B) through DSH's session controller, which
 * dsh-web-app mounts in every desktop and web composition (`asar:dsh-web-app/cordis.patch.yml:117`).
 * Spike-verified (design §1, `spike/out*.jsonl`):
 * - `create({ cwd, agentPreset })` makes a Session with no `parentSession`;
 * - `rename` titles it; `selectModel` sets its model (a subagent Session answers `session/agent-busy`);
 * - `resolveAgent` brings back a cold one;
 * - `workspaceRegistry.resolveByPath(cwd).attachSession(id)` puts it under that Workspace;
 * - `fork({ sessionId })` of a subagent Session yields a top-level copy with its history.
 *
 * Its header cwd is the router's workspace: `workspace-write` takes the session's immutable cwd as
 * its write root (`asar:dsh-sandbox-policy/README.md:75`), so the worker can write anywhere in that
 * workspace and nowhere outside it. That is the known trade-off of option B: no per-worker isolation.
 * @module dsh-agent-scheduler/dsh/host/session-worker
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, SessionEvent, UserMessage } from '../types.js'
import { features } from '../compat.js'
import { completedRounds, type Round } from '../../rounds.js'
import type { QueueAgent, QueueHost, QueueMessage } from '../../queue.js'
import { markRouter, OWNER_RECORD, pendingOf, removePending } from './agent.js'
import { appendRecord, eventsOf, recordOf, SessionId } from './session.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the controller and registry are untyped across this bundle boundary */
type Controller = {
  create(request: { sessionId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: unknown }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
}
type Registry = { resolveByPath(path: string): Promise<{ id: string; path?: string; record?: { path: string }; attachSession(id: string): Promise<void> } | undefined> }

/** The source a message the queue delivers carries; `queueId` survives in the target's log (spike `relay`). */
export const QUEUE_SOURCE = 'agent-message'

export interface OwnerRecord { readonly version: 1; readonly router: string; readonly name: string; readonly role: string; readonly worktrees?: readonly string[] }

/** What the scheduler does with top-level worker Sessions. */
export interface SessionWorkerPort {
  readonly available: boolean
  /** Why not, when not. */
  readonly missing: string | undefined
  /**
   * Create a worker Session in `cwd` (the router's workspace), title it, attach it under that workspace, record its owner.
   * @returns its id, and what did not work (non-fatal).
   */
  create(spec: { cwd: string; preset?: string | undefined; model?: { provider: string; model: string; reasoningEffort?: string | undefined } | undefined; title: string; owner: OwnerRecord }): Promise<{ id: string; warnings: string[] }>
  /** A top-level copy of a (subagent) Session, with its history; then as for create. */
  fork(source: string, spec: { cwd: string; title: string; owner: OwnerRecord }): Promise<{ id: string; warnings: string[] }>
  resolve(id: string): Promise<Agent | undefined>
  rename(id: string, title: string): Promise<void>
  selectModel(id: string, model: { provider: string; model: string; reasoningEffort?: string | undefined }): Promise<void>
}

const errorText = (e: unknown): string => e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e)

/**
 * @param ctx - a context with optional `sessionController` and `workspaceRegistry`.
 * @returns the port.
 */
export function sessionWorkerPort(ctx: Context): SessionWorkerPort {
  // Optional services: the rule row's own inject list stays what every DSH has; these come when
  // the composition mounts them (dsh-web-app does, in desktop and web) and go when it unmounts them.
  let controllerNow: Controller | undefined
  let registryNow: Registry | undefined
  const inject = (ctx as any).inject
  if (typeof inject === 'function') {
    ctx.inject(['sessionController'] as never, (scoped: any) => { controllerNow = scoped.sessionController; scoped.effect(() => () => { controllerNow = undefined }, 'agent-scheduler: session controller') })
    ctx.inject(['workspaceRegistry'] as never, (scoped: any) => { registryNow = scoped.workspaceRegistry; scoped.effect(() => () => { registryNow = undefined }, 'agent-scheduler: workspace registry') })
  }
  const get = (name: string): any => (ctx as any).get?.(name)
  const controller = (): Controller | undefined => controllerNow ?? get('sessionController')
  const registry = (): Registry | undefined => registryNow ?? get('workspaceRegistry')
  const resolve = async (id: string): Promise<Agent | undefined> => {
    const c = controller()
    if (c === undefined) return undefined
    const r = await c.resolveAgent(id)
    if ('agent' in r) return r.agent
    const code = (r.error as { code?: unknown } | undefined)?.code
    if (code === 'session/not-found') return undefined
    throw r.error instanceof Error ? r.error : new Error(errorText(r.error))
  }
  const finish = async (id: string, spec: { cwd: string; title: string; owner: OwnerRecord; model?: { provider: string; model: string; reasoningEffort?: string | undefined } | undefined }): Promise<string[]> => {
    const warnings: string[] = []
    const c = controller()!
    try { await c.rename({ sessionId: id, title: spec.title }) } catch (e) { warnings.push(`title: ${errorText(e)}`) }
    if (spec.model !== undefined) {
      try { await c.selectModel({ sessionId: id, provider: spec.model.provider, model: spec.model.model, ...(spec.model.reasoningEffort === undefined ? {} : { reasoningEffort: spec.model.reasoningEffort }) }) } catch (e) { warnings.push(`model: ${errorText(e)}`) }
    }
    if (features.record('workspaceRegistry', typeof registry()?.resolveByPath === 'function', 'workspaceRegistry.resolveByPath')) {
      try {
        const ws = await registry()!.resolveByPath(spec.cwd)
        if (ws === undefined) warnings.push(`no workspace is registered at ${spec.cwd}: the worker is listed under 未分组`)
        else await ws.attachSession(id)
      } catch (e) { warnings.push(`workspace: ${errorText(e)}`) }
    }
    const agent = await resolve(id)
    if (agent !== undefined) { appendRecord(agent.session, OWNER_RECORD, spec.owner); markRouter(agent, spec.owner.router) }
    return warnings
  }
  const has = (): boolean => features.record('sessionController', typeof controller()?.create === 'function' && typeof controller()?.resolveAgent === 'function', 'sessionController.create')
  return {
    get available() { return has() },
    get missing() { return has() ? undefined : 'this DSH has no session controller (dsh-web-app), so it cannot create top-level worker sessions' },
    async create(spec) {
      const c = controller()
      if (c === undefined) throw new Error('this DSH cannot create sessions')
      const made = await c.create({ cwd: spec.cwd, ...(spec.preset === undefined ? {} : { agentPreset: spec.preset }) })
      return { id: made.sessionId, warnings: await finish(made.sessionId, spec) }
    },
    async fork(source, spec) {
      const c = controller()
      if (c === undefined) throw new Error('this DSH cannot fork sessions')
      const made = await c.fork({ sessionId: source })
      return { id: made.sessionId, warnings: await finish(made.sessionId, spec) }
    },
    resolve,
    async rename(id, title) { await controller()?.rename({ sessionId: id, title }) },
    async selectModel(id, model) { await controller()?.selectModel({ sessionId: id, provider: model.provider, model: model.model, ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) }) },
  }
}

/**
 * The owner a worker Session recorded.
 * @param agent - any agent.
 * @returns its router and name, or undefined.
 */
export function ownerOf(agent: Agent): OwnerRecord | undefined {
  if (agent.session.header.parentSession !== undefined) return undefined
  const events = eventsOf(agent.session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const record = recordOf(events[i]!)
    if (record?.type === OWNER_RECORD) return record.data as OwnerRecord
  }
  return undefined
}

/** The queue id a delivered message carries. */
export const queueIdOfMessage = (message: UserMessage): string | undefined => {
  const q = (message.source as { queueId?: unknown }).queueId
  return typeof q === 'string' ? q : undefined
}

/**
 * The queue's way into Sessions: followup (or steer) plus flush, the dsh-schedule pattern
 * (`asar:dsh-schedule/lib/index.js:1382-1400`), and its restart wake (`:1348-1375`).
 * @param ctx - with `sessions` (flush).
 * @param sessions - resolves a worker Session (cold ones are activated).
 * @param readLog - a cold Session's stored log.
 * @returns the host.
 */
export function queueHost(ctx: Context, sessions: Pick<SessionWorkerPort, 'resolve'>, readLog: (id: string) => Promise<{ events: readonly SessionEvent[] }>): QueueHost {
  const agents = new Map<string, Agent>()
  const flush = async (agent: Agent): Promise<boolean> => {
    // Optional: the rule row does not inject `sessions`; read it the way optional services are read.
    let s: any
    try { s = (ctx as any).get?.('sessions') } catch { s = undefined }
    return typeof s?.flush === 'function' ? Boolean(await s.flush(agent.session)) : true
  }
  const prepared = new Map<string, UserMessage>()
  return {
    async resolve(target): Promise<QueueAgent | undefined> {
      const agent = await sessions.resolve(target)
      if (agent === undefined) return undefined
      agents.set(target, agent)
      return { id: target, running: agent.status === 'running' }
    },
    prepare(m: QueueMessage): string {
      const message = createUserMessage({
        content: [{ type: 'text', text: m.text }],
        source: { kind: QUEUE_SOURCE, form: 'relay', senderSessionId: SessionId(m.producer.session ?? m.producer.id), queueId: m.qid, producer: `${m.producer.kind}:${m.producer.id}` } as never,
      })
      prepared.set(message.id, message)
      return message.id
    },
    async send(target, m, inboxMessageId) {
      const agent = agents.get(target.id) ?? await sessions.resolve(target.id)
      if (agent === undefined) throw new Error(`no session ${target.id}`)
      const message = prepared.get(inboxMessageId)
      if (message === undefined) throw new Error(`message ${inboxMessageId} was not prepared`)
      prepared.delete(inboxMessageId)
      if (m.mode === 'step') agent.steer(message)
      else agent.followup(message)
      return flush(agent)
    },
    find(target, qid, inboxMessageId) {
      const agent = agents.get(target.id)
      if (agent === undefined) return undefined
      const hit = (msg: UserMessage) => msg.id === inboxMessageId || queueIdOfMessage(msg) === qid
      if (pendingOf(agent).some(hit)) return 'inbox'
      const inLog = eventsOf(agent.session).some((e: SessionEvent) => e.type === 'user/message' && hit(e.data as unknown as UserMessage))
      return inLog ? 'log' : undefined
    },
    wake(target, inboxMessageId) {
      const agent = agents.get(target.id)
      if (agent === undefined || agent.status !== 'idle') return
      const message = pendingOf(agent).find(msg => msg.id === inboxMessageId)
      if (message === undefined) return
      removePending(agent, message.id)
      agent.followup(message)
    },
    async rounds(target, fromSeq): Promise<readonly Round[]> {
      const live = agents.get(target)
      const events = live !== undefined ? eventsOf(live.session) : (await readLog(target)).events
      return completedRounds(events, fromSeq)
    },
  }
}
