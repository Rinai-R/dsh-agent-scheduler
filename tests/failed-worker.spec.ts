/** A worker that failed to start: it archives cleanly and does not hold its name. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { install, records, until } from './support/scheduler.js'
import { AGENT_RECORD } from '../src/records.js'
import { runAgentsCommand } from '../src/rule-plugin.js'

afterEach(teardown)

/** Install with a runtime that refuses the next start the way it refuses a bad directory. */
async function failingOnce() {
  const env = await setup(() => textResponse('OK'))
  let refuse = true
  const drained: string[] = []
  const subagents = env.ctx.subagents
  const scheduler = install(env.ctx, {
    subagents: {
      startActivation: (async (...a: Parameters<typeof subagents.startActivation>) => {
        if (refuse) { refuse = false; throw new Error('working-directory: directory does not exist') }
        return subagents.startActivation(...a)
      }) as typeof subagents.startActivation,
      sendMessage: (...a: Parameters<typeof subagents.sendMessage>) => subagents.sendMessage(...a),
      interrupt: (...a: Parameters<typeof subagents.interrupt>) => subagents.interrupt(...a),
      drainChildren: (...a: Parameters<typeof subagents.drainChildren>) => { drained.push(...a[1].map(String)); return subagents.drainChildren(...a) },
    },
  })
  return { ...env, scheduler, drained }
}

describe('a worker that failed to start', () => {
  it('archives without touching the runtime, and its task stays failed', async () => {
    const { lead, scheduler, drained } = await failingOnce()
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r', task: 'look' })).rejects.toThrow(/could not start "research"/)
    expect(scheduler.ledgerOf(lead).find('research')).toMatchObject({ state: 'failed' })
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'failed' })
    // Before the fix: `session "session-…" not found` from draining a session that never existed.
    const result = await runAgentsCommand(scheduler, { agent: lead, rawInput: 'archive research' } as never)
    expect(result).toMatchObject({ kind: 'success' })
    expect(scheduler.ledgerOf(lead).find('research')).toMatchObject({ state: 'archived' })
    expect(drained).toEqual([])
    expect(scheduler.ledgerOf(lead).requests.get('r-1')).toMatchObject({ state: 'failed' })
  })

  it('frees its name: the same name can be created again and replaces the failed entry', async () => {
    const { lead, scheduler } = await failingOnce()
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r' })).rejects.toThrow(/could not start/)
    const failedId = scheduler.ledgerOf(lead).find('research')!.id
    const made = await scheduler.createWorker(lead, { name: 'research', role: 'r2', task: 'again' })
    expect(made.id).not.toBe(failedId)
    const ledger = scheduler.ledgerOf(lead)
    expect(ledger.state.members.filter(m => m.name === 'research')).toEqual([expect.objectContaining({ id: made.id, state: 'started', role: 'r2' })])
    expect(ledger.find('research')!.id).toBe(made.id)
    await until(lead, '[reply to r-1 from research')
    // The log keeps both creations; refolding from it gives the same single entry.
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD).filter(r => r.name === 'research').map(r => r.action)).toEqual(['created', 'failed', 'created'])
  })

  it('a directory that does not exist is refused before anything is recorded, so the name stays free', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx)
    const missing = join(mkdtempSync(join(tmpdir(), 'sch-')), 'not-yet')
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r', cwd: missing, task: 't' })).rejects.toThrow(/working directory does not exist/)
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD)).toEqual([])
    expect(scheduler.ledgerOf(lead).requests.size).toBe(0)
    const dir = mkdtempSync(join(tmpdir(), 'sch-'))
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r', cwd: dir })).resolves.toMatchObject({ name: 'research' })
  })

  it('an archived name is still never reused, including one archived after it failed', async () => {
    const { lead, scheduler } = await failingOnce()
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r' })).rejects.toThrow(/could not start/)
    await scheduler.archive(lead, 'research')
    await expect(scheduler.createWorker(lead, { name: 'research', role: 'r' })).rejects.toThrow(/already taken/)
    await scheduler.createWorker(lead, { name: 'docs', role: 'd' })
    await scheduler.archive(lead, 'docs')
    await expect(scheduler.createWorker(lead, { name: 'docs', role: 'd' })).rejects.toThrow(/already taken/)
  })
})
