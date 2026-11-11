/**
 * A test session controller: what dsh-web-app's `sessionController` does for the scheduler,
 * built on the test composition's AgentLoop (spike-verified behaviour, design §1):
 * `create({ cwd })` makes a top-level Session, `resolveAgent` brings back a cold one, `fork`
 * copies a Session's history into a new top-level one (a subagent's included), `selectModel`
 * refuses a subagent Session (`session/agent-busy`).
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionWorkerPort } from '../../src/dsh/host/index.js'
import { appendRecord, markRouter, OWNER_RECORD } from '../../src/dsh/host/index.js'
import { stored } from './harness.js'

export interface TestController {
  readonly port: SessionWorkerPort
  readonly created: string[]
  readonly titles: Map<string, string>
  readonly workspaces: Map<string, string>
  /** Sessions rolled back (archived) after a failed creation. */
  readonly archived: string[]
  /** Release a worker Session (as DSH does when unused, or on shutdown); it comes back cold. */
  release(id: string): Promise<void>
}

export function testController(ctx: Context, opts: { workspace?: string; failFork?: boolean } = {}): TestController {
  const created: string[] = []
  const titles = new Map<string, string>()
  const workspaces = new Map<string, string>()
  const archived: string[] = []
  const handles = new Map<string, { dispose(): Promise<void> }>()
  const agentOptions = { provider: 'mock', model: 'worker-model' }
  // One resume per Session at a time, as the controller's own `resumes` map does
  // (asar:dsh-api-session-controller/lib/index.js:192-200).
  const resuming = new Map<string, Promise<Agent | undefined>>()
  const resolve = async (id: string): Promise<Agent | undefined> => {
    const live = ctx.agents.get(SessionId(id))
    if (live !== undefined) return live
    let pending = resuming.get(id)
    if (pending === undefined) {
      pending = (async () => {
        try {
          const h = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId(id), agentOptions } as never)
          handles.set(id, h)
          return h.agent
        } catch {
          return undefined
        }
      })().finally(() => { resuming.delete(id) })
      resuming.set(id, pending)
    }
    return pending
  }
  const finish = async (id: string, spec: { cwd: string; title: string; owner: { router: string } }) => {
    titles.set(id, spec.title)
    if (opts.workspace !== undefined) workspaces.set(id, opts.workspace)
    const agent = await resolve(id)
    if (agent !== undefined) { appendRecord(agent.session, OWNER_RECORD, spec.owner); markRouter(agent, spec.owner.router) }
    return { id, warnings: [] as string[] }
  }
  const port: SessionWorkerPort = {
    available: true,
    missing: undefined,
    async create(spec) {
      const id = `session-${randomUUID()}`
      const h = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), meta: { cwd: spec.cwd }, agentOptions } as never)
      handles.set(id, h)
      created.push(id)
      return finish(id, spec)
    },
    async fork(source, spec) {
      if (opts.failFork === true) throw new Error('fork refused')
      const live = ctx.agents.get(SessionId(source))
      if (live !== undefined) await live.whenIdle()
      const log = await stored(ctx, SessionId(source))
      const id = `session-${randomUUID()}`
      const seed = log.events.filter(e => e.type !== 'session' as never).map((e, i) => ({ ...e, seq: i }))
      const h = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), meta: { cwd: spec.cwd, isSeeded: true }, seed, inheritedEventCount: seed.length, agentOptions } as never)
      handles.set(id, h)
      created.push(id)
      return finish(id, spec)
    },
    resolve,
    async rollBack(id) { archived.push(id); return true },
    async rename(id, title) { titles.set(id, title) },
    async selectModel(id) {
      const agent = await resolve(id)
      if (agent?.session.header.parentSession !== undefined) throw Object.assign(new Error(`session "${id}" is owned by subagent routing`), { code: 'session/agent-busy' })
    },
  }
  return {
    port, created, titles, workspaces, archived,
    async release(id) {
      const agent = ctx.agents.get(SessionId(id))
      if (agent !== undefined) await agent.whenIdle()
      await handles.get(id)?.dispose()
      handles.delete(id)
    },
  }
}
