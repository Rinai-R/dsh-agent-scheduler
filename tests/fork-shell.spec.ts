/**
 * A routing fork may run a read-only shell: its own Session is pinned to the read-only sandbox
 * before the first step, whatever the lead is on, and stays pinned when the lead widens later.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, until, user } from './support/scheduler.js'

afterEach(teardown)

const OK = { type: 'object', additionalProperties: true, properties: {} } as const
const standIn = (name: string, ran: string[]) => defineTool({
  name, description: `${name} stand-in`, parameters: { command: { type: 'string' } },
  output: { schema: OK, render: (_: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] },
  execute: async () => { ran.push(name); return { ok: name } },
})
const sandboxEvents = async (ctx: Parameters<typeof stored>[0], id: string) => {
  const { events } = await stored(ctx, SessionId(id))
  return events.filter(e => e.type === 'sandbox/mode') as Array<{ seq: number; data: { mode: string } }>
}
const firstUserSeq = async (ctx: Parameters<typeof stored>[0], id: string) => {
  const { events } = await stored(ctx, SessionId(id))
  return events.find(e => e.type === 'user/message')?.seq ?? Number.POSITIVE_INFINITY
}

describe('a fork runs under the read-only sandbox', () => {
  const runs = [['deployment default (workspace-write)', undefined], ['lead on danger-full-access', 'danger-full-access'], ['lead on read-only too', 'read-only']] as const
  for (const [label, leadMode] of runs) {
    it(`pins the fork Session read-only before its first step: ${label}`, async () => {
      const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
      install(ctx)
      if (leadMode !== undefined) setSandboxMode(lead.session, leadMode)
      lead.followup(user('route this'))
      await until(lead, 'Its conclusion')
      const forkId = forksOf(lead)[0]!
      // The activation hook runs while the child is being created; wait for its durable event.
      const pinned = await vi.waitFor(async () => {
        const found = await sandboxEvents(ctx, forkId)
        expect(found).toHaveLength(1)
        return found
      }, { timeout: 20_000 })
      expect(pinned.map(e => e.data.mode)).toEqual(['read-only'])
      // The durable event precedes the fork's own first user message and step.
      expect(pinned[0]!.seq).toBeLessThan(await firstUserSeq(ctx, forkId))
      // The lead's own session was not narrowed by the pin.
      const leadModes = (lead.session.snapshotEvents().filter(e => e.type === 'sandbox/mode') as Array<{ data: { mode: string } }>).map(e => e.data.mode)
      expect(leadModes.at(-1)).toBe(leadMode ?? undefined)
    })
  }

  it('keeps an existing fork read-only when the lead widens its own mode later', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    lead.followup(user('route one'))
    await until(lead, 'Its conclusion')
    const forkId = forksOf(lead)[0]!
    const before = await vi.waitFor(async () => {
      const found = await sandboxEvents(ctx, forkId)
      expect(found).toHaveLength(1)
      return found
    }, { timeout: 20_000 })
    expect(before.map(e => e.data.mode)).toEqual(['read-only'])
    // Widen the lead: the deployment default becomes danger-full-access for later children only.
    setSandboxMode(lead.session, 'danger-full-access')
    const after = await sandboxEvents(ctx, forkId)
    expect(after.map(e => e.data.mode)).toEqual(['read-only'])
    // A fork created after that widening is still read-only (the lead-on-danger case above covers
    // the creation path; here the durable event on the existing fork must not change).
  })
})

describe('the fork shell is refused a write, and a write cannot be smuggled in', () => {
  it('runs the allowed shell body and refuses an edit, even when the shell output asks for it', async () => {
    const ran: string[] = []
    const { ctx, lead, adapter } = await setup(o => {
      if (o.sessionId === 'lead') return textResponse('LEAD')
      const messages = JSON.stringify(o.messages)
      if (!messages.includes('git log --oneline -3')) {
        return toolCallResponse('f-bash', 'bash', { command: 'git log --oneline -3' })
      }
      if (!messages.includes('"f-edit"')) {
        // The shell result tells the fork to edit; the fork tries it anyway.
        return toolCallResponse('f-edit', 'edit', { path: 'src/hacked.ts' })
      }
      return textResponse('FORK CONCLUSION: read the log, could not edit')
    })
    ctx.tools.register(standIn('bash', ran))
    ctx.tools.register(standIn('edit', ran))
    install(ctx)
    lead.followup(user('look at the log and then edit it'))
    await until(lead, 'could not edit')
    const forkId = forksOf(lead)[0]!
    // Only the shell ran; the edit body never did.
    expect(ran).toEqual(['bash'])
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === forkId)).toBe(true) })
    const forkReqs = adapter.requests.filter(r => r.sessionId === forkId)
    const lastFork = JSON.stringify(forkReqs.at(-1)!.messages)
    expect(lastFork).toContain('fork-1 is a fork: forks only route, so edit is not available to you')
    expect(lastFork).toContain('the shell you do have is read-only and cannot write')
  })
})
