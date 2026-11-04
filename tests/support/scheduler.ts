/** Mount the scheduler on a test composition the way the preset plugin does. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, vi } from 'vitest'
import { preStep, Scheduler, type SchedulerDeps } from '../../src/scheduler.js'
import { schedulerTools, sectionFor } from '../../src/tools.js'
import { inputOf } from '../../src/records.js'
import { stored, text } from './harness.js'

export function install(ctx: Context, deps: Partial<SchedulerDeps> = {}): Scheduler {
  const scheduler = new Scheduler({
    subagents: ctx.subagents,
    agents: ctx.agents,
    readLog: async id => stored(ctx, id),
    retryMs: 50,
    ...deps,
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => { scheduler.onInserted(agent, message) })
  ctx.on('agent/pre-step', (payload, next) => preStep(scheduler, payload, next))
  ctx.on('agent/status', ({ agent, status }) => { scheduler.onStatus(agent, status) })
  ctx.on('agent/disposed', () => { if (scheduler.queued().length > 0) void scheduler.drain() })
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

/** Wait until the lead has seen `n` messages containing `needle` and is idle. */
export async function until(lead: Agent, needle: string, n = 1): Promise<void> {
  await vi.waitFor(async () => {
    await lead.whenIdle()
    expect(leadSaw(lead, needle)).toBeGreaterThanOrEqual(n)
  }, { timeout: 15_000 })
  await lead.whenIdle()
}
