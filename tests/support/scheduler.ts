/** Mount the scheduler on a test composition the way the preset plugin does. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, vi } from 'vitest'
import { preStep, Scheduler, type SchedulerDeps } from '../../src/scheduler.js'
import { historyPort } from '../../src/dsh/host/session-query.js'
import { schedulerTools, sectionFor } from '../../src/tools.js'
import { inputOf } from '../../src/records.js'
import { restoreMemberModel } from '../../src/member-model.js'
import { stored, text } from './harness.js'
import { toolCallResponse } from './mock-adapter.js'

const installed = new WeakMap<Scheduler, Array<() => void>>()

/** Stop a scheduler from hearing the composition (what a restart does to the old process). */
export function uninstall(scheduler: Scheduler): void {
  for (const off of installed.get(scheduler) ?? []) off()
  scheduler.disconnectQueue()
}

export function install(ctx: Context, deps: Partial<SchedulerDeps> = {}, opts: { tools?: boolean } = {}): Scheduler {
  const scheduler = new Scheduler({
    subagents: ctx.subagents,
    agents: ctx.agents,
    readLog: async id => stored(ctx, id),
    retryMs: 50,
    history: historyPort(ctx),
    // Existing scenarios are scheduling sessions; tests of the switch pass `defaultOn: false`.
    defaultOn: true,
    ...deps,
  })
  const offs: Array<() => void> = []
  const on = (name: string, listener: (...args: never[]) => unknown) => { const off = (ctx.on as (n: string, l: unknown) => unknown)(name, listener); if (typeof off === 'function') offs.push(off as () => void) }
  on('agent/inbox/inserted', ({ agent, message }: { agent: Agent; message: never }) => { scheduler.onInserted(agent, message) })
  on('agent/pre-step', (payload: never, next: never) => preStep(scheduler, payload, next))
  on('agent/status', ({ agent, status }: { agent: Agent; status: 'idle' | 'running' }) => { scheduler.onStatus(agent, status) })
  // As the rule does: a resumed main Session settles what the restart cut off.
  on('agent/created', ({ agent, source }: { agent: Agent; source: string }) => {
    if (source === 'resume' && agent.session.header.parentSession === undefined) setTimeout(() => { void scheduler.recover(agent) }, 0)
    return undefined
  })
  on('agent/created', ({ agent }: { agent: Agent }) => { restoreMemberModel(scheduler, agent); return undefined })
  installed.set(scheduler, offs)
  ctx.on('agent/disposed', () => { if (scheduler.queued().length > 0) void scheduler.drain() })
  // A second scheduler on the same composition (a restart, an upgrade) listens but registers no tools again.
  if (opts.tools === false) return scheduler
  for (const tool of schedulerTools(scheduler, ctx.agents as never)) ctx.tools.register(tool)
  ctx.systemPrompt.section({ name: 'agent-scheduler', order: 900, text: c => c.agent === undefined ? '' : sectionFor(scheduler, c.agent) })
  return scheduler
}

export const user = (t: string) => createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } })
export const body = (o: GenerateOptions) => JSON.stringify(o.messages)
/** Text of the newest message of a request. */
export const last = (o: GenerateOptions) => JSON.stringify(o.messages.at(-1))
export const records = (events: readonly SessionEvent[], type: string) =>
  events.map(pluginRecordOf).filter(r => r?.type === type).map(r => r!.data as unknown as Record<string, unknown>)
export const forksOf = (lead: Agent) => lead.session.snapshotEvents().flatMap(e => inputOf(e)?.forkId ?? [])
export const leadSaw = (lead: Agent, needle: string) =>
  lead.session.snapshotEvents().filter(e => e.type === 'user/message' && text(e).includes(needle)).length

/**
 * Wait until the lead has seen `n` messages containing `needle` and is idle.
 *
 * A resumed round re-runs a whole turn after a simulated restart, which takes several seconds on
 * a two-core CI runner; 15 s was close enough to the real duration to fail intermittently there.
 */
export async function until(lead: Agent, needle: string, n = 1): Promise<void> {
  await vi.waitFor(async () => {
    await lead.whenIdle()
    expect(leadSaw(lead, needle)).toBeGreaterThanOrEqual(n)
  }, { timeout: 30_000 })
  await lead.whenIdle()
}

/** The rosterVersion of the newest agent_list (or dispatch) result a request carries. */
export function rosterVersionIn(o: GenerateOptions): string | undefined {
  return [...body(o).matchAll(/rosterVersion\\+":\\+"([0-9a-f.]+)/gu)].at(-1)?.[1]
}

/** As a model does: agent_list first, then `tool` with the rosterVersion it returned. */
export function listThen(o: GenerateOptions, id: string, tool: string, args: Record<string, unknown>) {
  const version = rosterVersionIn(o)
  return version === undefined ? toolCallResponse(`${id}-list`, 'agent_list', {}) : toolCallResponse(id, tool, { ...args, rosterVersion: version })
}
