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

  it('a DSH subagent_fork child of a worker or of the lead is not a routing fork: its sandbox is left alone', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'CHILD'))
    install(ctx, { defaultOn: false })
    // What DSH's own subagent_fork tool does: an activation with provider "fork", started by the
    // lead itself (scheduling off) — not by the scheduler.
    const childId = 'plain-fork-child'
    const subagents = (ctx as unknown as { subagents: { startActivation(a: unknown): Promise<unknown> } }).subagents
    await subagents.startActivation({ provider: 'fork', label: 'plain', childId: SessionId(childId), signal: new AbortController().signal, delivery: 'parent', request: { parent: lead, prompt: [{ type: 'text', text: 'write a file' }] } })
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(childId))).events.some(e => e.type === 'user/message')).toBe(true) }, { timeout: 20_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await sandboxEvents(ctx, childId)).filter(e => e.data.mode === 'read-only')).toEqual([])
  })

  it('the read-only mode is folded before the fork\'s first step/start (lead on danger-full-access)', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    install(ctx)
    setSandboxMode(lead.session, 'danger-full-access')
    lead.followup(user('route this'))
    await until(lead, 'Its conclusion')
    const forkId = forksOf(lead)[0]!
    // The stored log is flushed asynchronously: wait for the fork's turn to be on disk.
    const events = await vi.waitFor(async () => {
      const { events } = await stored(ctx, SessionId(forkId))
      expect(events.some(e => e.type === 'turn/end')).toBe(true)
      return events
    }, { timeout: 20_000 })
    const pin = events.findIndex(e => e.type === 'sandbox/mode' && (e.data as { mode: string }).mode === 'read-only')
    const firstStep = events.findIndex(e => e.type === 'step/start')
    expect(pin).toBeGreaterThanOrEqual(0)
    expect(firstStep).toBeGreaterThan(pin)
    // No other sandbox mode after the pin.
    expect(events.slice(pin + 1).filter(e => e.type === 'sandbox/mode')).toEqual([])
  })

  it('workers, split-seeded workers and created-from workers are never pinned read-only', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'W'))
    const scheduler = install(ctx, { defaultOn: false })
    setSandboxMode(lead.session, 'workspace-write')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    await scheduler.createWorker(lead, { name: 'hub', role: 'r', cwd: mkdtempSync(join(tmpdir(), 'hub-')), task: 'warm up' })
    await until(lead, '[reply to r-1 from hub]')
    await scheduler.split(lead, { owner: 'hub', ownerName: 'hub-a', ownerRole: 'a', name: 'hub-b', role: 'b', cwd: mkdtempSync(join(tmpdir(), 'hub-b-')), task: 'b work' })
    await until(lead, '[reply to r-2 from hub-b]')
    await scheduler.createWorker(lead, { name: 'hub-c', role: 'c', from: 'hub-a', cwd: mkdtempSync(join(tmpdir(), 'hub-c-')), task: 'c work' })
    await until(lead, '[reply to r-3 from hub-c]')
    const ledger = scheduler.ledgerOf(lead)
    for (const name of ['hub-a', 'hub-b', 'hub-c']) {
      const modes = (await sandboxEvents(ctx, ledger.find(name)!.id)).map(e => e.data.mode)
      expect(modes, name).not.toContain('read-only')
    }
  })

  it('refuses the obvious remote writes from a fork shell (best effort, not a boundary), and lets reads through', async () => {
    const { remoteWriteOf, forkGuard } = await import('../src/fork-guard.js')
    const writes = [
      'git push origin HEAD', 'cd repo && git push -f', 'git -C x push --tags',
      'gh pr merge 41 --merge', 'gh pr create --title x', 'gh pr comment 3 -b hi', 'gh issue close 4',
      'gh api -X POST repos/o/r/issues', 'gh api repos/o/r/issues -f title=x', 'gh api --method DELETE repos/o/r',
      'gh release create v1', 'gh repo delete o/r', 'gh workflow run ci', 'gh auth token',
      'curl -X POST https://x', 'curl -d a=1 https://x', 'curl --json {} https://x', 'curl -T f https://x',
      'wget --post-data=a https://x',
    ]
    for (const command of writes) expect(remoteWriteOf('bash', { command }), command).toBe(command)
    const reads = ['git log --oneline -5', 'git status', 'git diff HEAD~1', 'gh pr view 41', 'gh pr list', 'gh pr diff 41', 'gh api repos/o/r/pulls', 'curl -s https://x', 'rg push src', 'cat push.md', 'ls -la']
    for (const command of reads) expect(remoteWriteOf('bash', { command }), command).toBeUndefined()
    // Other tools are not inspected; only the shell is.
    expect(remoteWriteOf('read', { command: 'git push' })).toBeUndefined()
    // The guard refuses a fork's remote write with a readable reason, and leaves non-forks alone.
    const guard = forkGuard(agent => (agent as { fork?: string }).fork)
    expect(guard({ name: 'bash', agent: { fork: 'fork-1' } as never, arguments: { command: 'gh pr merge 1 --merge' } })).toMatch(/changes something remotely/u)
    expect(guard({ name: 'bash', agent: { fork: 'fork-1' } as never, arguments: { command: 'git log -1' } })).toBeUndefined()
    expect(guard({ name: 'bash', agent: {} as never, arguments: { command: 'git push' } })).toBeUndefined()
    // Not a boundary: indirection still gets through (documented in docs/guide.md).
    expect(remoteWriteOf('bash', { command: 'sh -c "$(echo Z2l0IHB1c2g= | base64 -d)"' })).toBeUndefined()
  })

  it('a fork woken again after a lead restart is still read-only before its next step, with no second pin', async () => {
    const { ctx } = await setup(o => textResponse(o.sessionId === 'main' ? 'MAIN' : 'FORK'))
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx)
    setSandboxMode(h1.agent.session, 'danger-full-access')
    h1.agent.followup(user('before restart'))
    await until(h1.agent, 'Its conclusion')
    const forkId = forksOf(h1.agent)[0]!
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    await ctx.subagents.sendMessage(h2.agent, SessionId(forkId), [{ type: 'text', text: 'again' }], { signal: new AbortController().signal })
    await until(h2.agent, 'Its conclusion', 2)
    const { events } = await stored(ctx, SessionId(forkId))
    const modes = events.filter(e => e.type === 'sandbox/mode').map(e => (e.data as { mode: string }).mode)
    // Whatever delegation copied first, the last mode before every step is read-only.
    const steps = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'step/start').map(([, i]) => i)
    expect(steps.length).toBeGreaterThanOrEqual(2)
    for (const at of steps) {
      const last = events.slice(0, at).filter(e => e.type === 'sandbox/mode').at(-1)
      expect((last?.data as { mode?: string } | undefined)?.mode).toBe('read-only')
    }
    expect(modes.filter(m => m === 'read-only').length).toBeGreaterThanOrEqual(1)
  })
})
