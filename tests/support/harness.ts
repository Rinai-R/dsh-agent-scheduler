/**
 * P0 harness: a real Cordis composition (AgentLoop, JSONL persistence, SubagentService,
 * spawn + fork providers, a test SessionQuery) with a routing mock LLM.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { installForkFrom } from '../../src/forks-from.js'
import { RoutingMockAdapter } from './mock-adapter.js'
import { TestSessionQuery } from './test-session-query.js'

export const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

/** Dispose every composition and temp dir created by {@link setup}. */
export async function teardown(): Promise<void> {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** A responder that may block until released, so a test can hold a turn open. */
export type Respond = (options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>

/**
 * Build the composition and a root `lead` agent.
 * @param respond - answers every model request.
 * @param maxActiveSubagents - SubagentService residency cap.
 */
export async function setup(respond: Respond, maxActiveSubagents = 8) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-sched-p0-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService, { maxActiveSubagents, maxDepth: 1 })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  installForkFrom(ctx)
  const adapter = new RoutingMockAdapter(respond)
  ctx.llm.registerAdapter(['mock', 'mock-b'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'lead-model' })
  return { ctx, lead, adapter, storageRoot }
}

/** Read a stored log through a short-lived persistence handle. */
export async function stored(ctx: Context, id: SessionId): Promise<{ events: readonly SessionEvent[]; inherited: number }> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return { events: (await handle.read()).events, inherited: handle.inheritedEventCount }
  } finally {
    await handle.close()
  }
}

/** JSON text of one event's data, for substring checks. */
export const text = (e: SessionEvent): string => JSON.stringify(e.data)

/** A promise plus its resolver. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(r => { open = r })
  return { promise, open }
}
