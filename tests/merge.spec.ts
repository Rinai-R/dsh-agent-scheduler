/** Merging a worker into another, the reverse of agent_split (docs/worker-merge.md). */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, leadSaw, records, until } from './support/scheduler.js'
import { appendMerge, MERGE_RECORD } from '../src/records.js'
import { reviewOf } from '../src/review.js'
import { mailKindOf, type Scheduler } from '../src/scheduler.js'
import { defaultSurvivor, gitFacts, handoffFromLog, handoffSection, mergedRole, saysNone, unsettled } from '../src/merge.js'
import { parseMerge, runAgentsCommand } from '../src/rule-plugin.js'
import { mergeCommand, mergePartners } from '../src/client/index.js'

afterEach(teardown)

type Ctx = Awaited<ReturnType<typeof setup>>['ctx']
const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal }) as never
const HANDOFF = (uncommitted: string) => ['## Done', 'image fixed', '## In progress', 'none', '## Decisions', 'kept the old API', '## Open questions', 'none', '## Files changed', 'src/image.ts', '## Branch / PR', 'feat/image, PR #7 open', '## Uncommitted changes', uncommitted].join('\n')
const asked = (o: GenerateOptions) => body(o).includes('You are being merged into')

/** Two workers of area `hub`: hub split into hub-asr (owner) and hub-image. */
async function splitPair(respond: (o: GenerateOptions) => string | Promise<string> = () => 'DONE', opts: { imageCwd?: string } = {}) {
  const { ctx, lead, adapter } = await setup(async o => textResponse(o.sessionId === 'lead' ? 'LEAD' : await respond(o)))
  const scheduler = install(ctx, { defaultOn: false })
  await scheduler.createWorker(lead, { name: 'hub', role: 'develops hub', task: 'warm up' })
  await until(lead, '[reply to r-1 from hub]')
  await scheduler.split(lead, { owner: 'hub', ownerName: 'hub-asr', ownerRole: 'smoke-tests ASR in hub', name: 'hub-image', role: 'fixes gpt_image in hub', task: 'fix image', ...(opts.imageCwd === undefined ? {} : { cwd: opts.imageCwd }) })
  await until(lead, '[reply to r-2 from hub-image]')
  return { ctx, lead, adapter, scheduler }
}

const stateOf = (scheduler: Scheduler, lead: Agent, id = 'mg-1') => scheduler.ledgerOf(lead).merges.find(m => m.id === id)?.state
const survivorLog = async (ctx: Ctx, scheduler: Scheduler, lead: Agent, name: string) =>
  (await stored(ctx, SessionId(scheduler.ledgerOf(lead).find(name)!.id))).events.filter(e => e.type === 'user/message').map(e => JSON.stringify(e.data)).join('\n')

/**
 * The survivor's log once it holds `needle`: a delivered handoff is logged when the survivor's
 * next turn admits it, which can come a little after the merge records `delivered`.
 */
const survivorLogWith = async (ctx: Ctx, scheduler: Scheduler, lead: Agent, name: string, needle: string) => {
  await vi.waitFor(async () => { expect(await survivorLog(ctx, scheduler, lead, name)).toContain(needle) }, { timeout: 15_000 })
  return survivorLog(ctx, scheduler, lead, name)
}

describe('agent_merge', () => {
  it('asks the absorbed worker for its handoff, archives it, gives its names to the survivor, and hands the survivor the handoff', async () => {
    const { ctx, lead, scheduler } = await splitPair(o => asked(o) ? HANDOFF('none') : 'DONE')
    const imageId = scheduler.ledgerOf(lead).find('hub-image')!.id
    const asrId = scheduler.ledgerOf(lead).find('hub-asr')!.id
    const reportedBefore = scheduler.ledgerOf(lead).members.get(imageId)?.reportedAt
    // v2 removed the agent_merge tool; /agents merge still merges v1 workers.
    expect(ctx.tools.get('agent_merge', lead)).toBeUndefined()
    const version = scheduler.rosterVersion(scheduler.ledgerOf(lead))
    const tool = { execute: async (a: { worker: string; with: string; into?: string; rosterVersion?: string; name?: string }, _e: unknown) => scheduler.merge(lead, { absorbed: a.worker, into: a.with, ...(a.name === undefined ? {} : { name: a.name }), ...(a.rosterVersion === undefined ? {} : { rosterVersion: a.rosterVersion }) }) }
    // Within one area the survivor may take back the area's name from before the split.
    const out = await tool.execute({ worker: 'hub-image', with: 'hub-asr', into: 'hub-asr', name: 'hub', rosterVersion: version }, exec(lead)) as Record<string, unknown>
    expect(out).toMatchObject({ merge: 'mg-1', request: 'r-3', absorbed: 'hub-image', into: 'hub-asr', name: 'hub' })
    // While it runs, the absorbed worker takes no new work and neither side can be renamed.
    await expect(scheduler.send(lead, 'hub-image', 'more')).rejects.toThrow(/being merged into hub-asr/)
    await expect(scheduler.rename(lead, 'hub-asr', 'hub-x')).rejects.toThrow(/is in merge mg-1/)
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('delivered') }, { timeout: 20_000 })
    const ledger = scheduler.ledgerOf(lead)
    expect(ledger.members.get(imageId)).toMatchObject({ state: 'archived', mergedInto: asrId })
    // Its unread report went to the survivor with the handoff: no dot left on the archived row.
    expect(reportedBefore).toBeDefined()
    expect(reviewOf(ledger.members.get(imageId)!)).toBeUndefined()
    expect(ledger.members.get(asrId)).toMatchObject({ name: 'hub', area: 'hub', role: 'smoke-tests ASR in hub; also: fixes gpt_image in hub' })
    expect(ledger.members.get(asrId)!.formerNames).toEqual(expect.arrayContaining(['hub-asr', 'hub-image']))
    expect(ledger.members.get(asrId)!.formerNames).not.toContain('hub')
    // Every old name now finds the survivor; the split hint is gone.
    for (const name of ['hub', 'hub-asr', 'hub-image']) expect(ledger.find(name)?.id).toBe(asrId)
    expect(ledger.splitHint('hub')).toBeUndefined()
    // The handoff reached the survivor as a message, not a request; the lead got one merged note.
    const log = await survivorLogWith(ctx, scheduler, lead, 'hub', '[handoff mg-1 from hub-image, merged into you; not a request]')
    expect(log).toContain('kept the old API')
    await until(lead, '[merged mg-1: hub-image into hub (formerly hub-asr)')
    expect(leadSaw(lead, 'reply to r-3')).toBe(0)
    expect(ledger.requests.get('r-3')).toMatchObject({ state: 'answered', kind: 'handoff', deliveredTo: asrId })
    // The handoff lit no review mark on the archived worker.
    expect(ledger.members.get(imageId)?.reportedAt).toBe(reportedBefore)
    // A request to an old name goes to the survivor.
    const sent = await scheduler.send(lead, 'hub-image', 'one more thing')
    expect(sent.to).toBe('hub')
    expect(ledger.requests.get(sent.request)?.to).toBe(asrId)
  })

  it('refuses while the absorbed worker runs or owes answers, from a worker, and for a taken name', async () => {
    const hold = gate()
    let held = false
    const { lead, scheduler, ctx } = await splitPair(async o => {
      if (body(o).includes('slow job') && !held) { held = true; await hold.promise }
      return 'DONE'
    })
    await scheduler.createWorker(lead, { name: 'docs', role: 'docs' })
    await scheduler.send(lead, 'hub-image', 'slow job')
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('hub-image')!.id))?.status).toBe('running') })
    await expect(scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })).rejects.toThrow(/is running; wait/)
    hold.open()
    await until(lead, 'DONE')
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).openTo(scheduler.ledgerOf(lead).find('hub-image')!.id)).toEqual([]) })
    await expect(scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr', name: 'docs' })).rejects.toThrow(/already taken/)
    await expect(scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-image' })).rejects.toThrow(/same worker/)
    // Outside one area the absorbed worker's name is not the survivor's to take.
    await expect(scheduler.merge(lead, { absorbed: 'docs', into: 'hub-asr', name: 'docs' })).rejects.toThrow(/already taken/)
    const worker = { id: scheduler.ledgerOf(lead).find('hub-asr')!.id, session: { header: { parentSession: lead.id } } } as never
    await expect(scheduler.merge(worker, { absorbed: 'hub-image', into: 'docs' })).rejects.toThrow(/only the lead/)
  })

  it('fails when uncommitted changes are left without being handed over, and merges once they are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-image-'))
    execFileSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, 'image.ts'), 'export {}\n')
    let attempt = 0
    const { ctx, lead, scheduler } = await splitPair(o => {
      if (!asked(o)) return 'DONE'
      attempt += 1
      return HANDOFF(attempt === 1 ? 'none' : 'image.ts: new file, not committed yet; yours to finish')
    }, { imageCwd: dir })
    await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('failed') }, { timeout: 20_000 })
    expect(scheduler.ledgerOf(lead).merges[0]!.detail).toMatch(/1 uncommitted change in .* that the handoff does not hand over/)
    await until(lead, '[merge mg-1 of hub-image into hub-asr failed')
    // Nothing changed on the roster.
    expect(scheduler.ledgerOf(lead).find('hub-image')).toMatchObject({ name: 'hub-image', state: 'started' })
    await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })
    await vi.waitFor(() => { expect(stateOf(scheduler, lead, 'mg-2')).toBe('delivered') }, { timeout: 20_000 })
    const log = await survivorLogWith(ctx, scheduler, lead, 'hub-asr', '[handoff mg-2 from')
    expect(log).toContain(`[checked by the scheduler in ${dir}]`)
    expect(log).toContain('?? image.ts')
  })

  it('never reads a failed git status as clean, and tells the survivor when the directory is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-image-'))
    execFileSync('git', ['init', '-q', dir])
    writeFileSync(join(dir, 'image.ts'), 'export {}\n')
    // A corrupt index: git knows it is a work tree, but `git status` fails.
    writeFileSync(join(dir, '.git', 'index'), 'not an index')
    const { ctx, lead, scheduler } = await splitPair(o => asked(o) ? HANDOFF('none') : 'DONE', { imageCwd: dir })
    await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('failed') }, { timeout: 20_000 })
    expect(scheduler.ledgerOf(lead).merges[0]!.detail).toMatch(/could not read git status in /)
    expect(scheduler.ledgerOf(lead).find('hub-image')).toMatchObject({ state: 'started' })
    // The worktree is removed: the merge goes on, and the survivor is told nothing could be checked.
    rmSync(dir, { recursive: true, force: true })
    await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })
    await vi.waitFor(() => { expect(stateOf(scheduler, lead, 'mg-2')).toBe('delivered') }, { timeout: 20_000 })
    const log = await survivorLogWith(ctx, scheduler, lead, 'hub-asr', '[handoff mg-2 from')
    expect(log).toContain(`found no directory at ${dir}`)
  })

  it('builds the handoff from the log of a worker that was archived', async () => {
    const { ctx, lead, scheduler } = await splitPair(o => body(o).includes('fix image') ? 'IMAGE FIXED: swapped the encoder' : 'DONE')
    await scheduler.archive(lead, 'hub-image')
    const started = await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr' })
    expect(started.request).toBeUndefined()
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('delivered') }, { timeout: 20_000 })
    expect(scheduler.ledgerOf(lead).merges[0]).toMatchObject({ source: 'log' })
    const log = await survivorLogWith(ctx, scheduler, lead, 'hub-asr', '[handoff mg-1 from')
    expect(log).toContain('could not write its own handoff')
    expect(log).toContain('IMAGE FIXED: swapped the encoder')
  })

  it('a merge cut off by a restart goes on from the step it recorded', async () => {
    const { ctx, lead, scheduler } = await splitPair()
    const ledger = scheduler.ledgerOf(lead)
    const [image, asr] = [ledger.find('hub-image')!, ledger.find('hub-asr')!]
    // As a log left behind: the handoff written and the code settled, the roster not changed yet.
    for (const record of [
      { action: 'requested' as const, id: 'mg-1', absorbed: image.id, survivor: asr.id, request: '', by: lead.id, name: 'hub' },
      { action: 'handoff' as const, id: 'mg-1', text: HANDOFF('none'), source: 'worker' as const },
      { action: 'settled' as const, id: 'mg-1' },
    ]) { appendMerge(lead.session, record); ledger.apply(lead.session.snapshotEvents().at(-1)!) }
    await scheduler.recover(lead)
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('delivered') }, { timeout: 20_000 })
    expect(ledger.find('hub')?.id).toBe(asr.id)
    // Recovering again does nothing more: one merged record, one handoff.
    await scheduler.recover(lead)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(records(lead.session.snapshotEvents(), MERGE_RECORD).filter(r => r.action === 'merged')).toHaveLength(1)
    expect((await survivorLogWith(ctx, scheduler, lead, 'hub', '[handoff mg-1 from')).split('[handoff mg-1 from').length - 1).toBe(1)
  })

  for (const [step, extra] of [['handoff', 0], ['merged', 0], ['merged', 1]] as const) {
    it(`a merge cut off at ${step}${extra === 1 ? ' after its handoff already reached the survivor' : ''} goes on once`, async () => {
      const { ctx, lead, scheduler } = await splitPair()
      const ledger = scheduler.ledgerOf(lead)
      const [image, asr] = [ledger.find('hub-image')!, ledger.find('hub-asr')!]
      const log: Parameters<typeof appendMerge>[1][] = [
        { action: 'requested', id: 'mg-1', absorbed: image.id, survivor: asr.id, request: '', by: lead.id, name: 'hub' },
        { action: 'handoff', id: 'mg-1', text: HANDOFF('none'), source: 'worker' },
      ]
      if (step === 'merged') log.push({ action: 'settled', id: 'mg-1' }, { action: 'merged', id: 'mg-1', name: 'hub', previousName: 'hub-asr', role: 'both', area: 'hub' })
      for (const record of log) { appendMerge(lead.session, record); ledger.apply(lead.session.snapshotEvents().at(-1)!) }
      if (extra === 1) {
        // DSH stopped after the handoff reached the survivor but before `delivered` was recorded.
        await scheduler.send(lead, 'hub-asr', '[handoff mg-1 from hub-image, merged into you; not a request] (already sent)')
        await survivorLogWith(ctx, scheduler, lead, 'hub-asr', '[handoff mg-1 from')
      }
      await scheduler.recover(lead)
      await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('delivered') }, { timeout: 20_000 })
      await scheduler.recover(lead)
      await new Promise(resolve => setTimeout(resolve, 300))
      const events = lead.session.snapshotEvents()
      expect(records(events, MERGE_RECORD).filter(r => r.action === 'merged')).toHaveLength(1)
      expect(records(events, MERGE_RECORD).filter(r => r.action === 'delivered')).toHaveLength(1)
      expect(ledger.find('hub-image')?.id).toBe(asr.id)
      const survivorText = await survivorLogWith(ctx, scheduler, lead, ledger.members.get(asr.id)!.name, '[handoff mg-1 from')
      expect(survivorText.split('[handoff mg-1 from').length - 1).toBe(1)
    })
  }

  it('/agents merge runs the same merge, picking the survivor when none is named', async () => {
    const { lead, scheduler } = await splitPair(o => asked(o) ? HANDOFF('none') : 'DONE')
    const run = (line: string) => runAgentsCommand(scheduler, { agent: lead, rawInput: line } as never)
    expect((await run('merge hub-image')).kind).toBe('error')
    // hub-asr is the area's original owner: it stays.
    const out = await run('merge hub-image hub-asr --name hub')
    expect(out).toMatchObject({ kind: 'success' })
    expect(out.text).toMatch(/hub-image/)
    await vi.waitFor(() => { expect(stateOf(scheduler, lead)).toBe('delivered') }, { timeout: 20_000 })
    expect(scheduler.ledgerOf(lead).find('hub')?.formerNames).toEqual(expect.arrayContaining(['hub-asr', 'hub-image']))
  })
})

describe('merge helpers', () => {
  it('reads the handoff sections and decides whether the code is settled', () => {
    const handoff = HANDOFF('none')
    expect(handoffSection(handoff, 'Branch / PR')).toBe('feat/image, PR #7 open')
    expect(handoffSection(handoff, 'missing')).toBeUndefined()
    for (const none of ['none', 'None.', '无', '-', '', 'n/a']) expect(saysNone(none)).toBe(true)
    expect(saysNone('src/a.ts not committed')).toBe(false)
    const facts = { cwd: '/w', dirty: [' M a.ts'] }
    expect(unsettled(facts, handoff, 'worker')).toMatch(/uncommitted change/)
    expect(unsettled(facts, HANDOFF('a.ts is yours'), 'worker')).toBeUndefined()
    expect(unsettled(facts, handoff, 'log')).toBeUndefined()
    expect(unsettled({ cwd: '/w', dirty: [] }, handoff, 'worker')).toBeUndefined()
  })

  it('picks the side with work, then the area owner, then the older', () => {
    const w = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, name, ...extra })
    expect(defaultSurvivor(w('a'), w('b'), m => m.name === 'a').map(m => m.name)).toEqual(['b', 'a'])
    expect(defaultSurvivor(w('hub-image', { area: 'hub' }), w('hub-asr', { area: 'hub', formerNames: ['hub'] }), () => false).map(m => m.name)).toEqual(['hub-image', 'hub-asr'])
    expect(defaultSurvivor(w('a', { createdAt: '2026-01-02' }), w('b', { createdAt: '2026-01-01' }), () => false).map(m => m.name)).toEqual(['a', 'b'])
    expect(mergedRole({ role: 'x', text: 'x' }, { role: 'y', text: 'y' })).toBe('x; also: y')
    expect(mergedRole({ role: 'x and y', text: '' }, { role: 'y', text: 'y' })).toBe('x and y')
  })

  it('reads git facts of a checkout, and nothing of a plain directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-'))
    expect(await gitFacts(dir)).toBeUndefined()
    execFileSync('git', ['init', '-q', '-b', 'feat/x', dir])
    writeFileSync(join(dir, 'f.txt'), 'x')
    expect(await gitFacts(dir)).toMatchObject({ cwd: dir, branch: 'feat/x', dirty: ['?? f.txt'] })
    expect(await gitFacts(undefined)).toBeUndefined()
  })

  it('builds a handoff from what a worker answered', () => {
    const text = handoffFromLog({ id: 'w', name: 'w', kind: 'worker', state: 'archived', text: 'role' }, [
      { id: 'r-1', from: 'l', to: 'w', text: 'do a', state: 'answered', answer: 'did a' },
      { id: 'r-2', from: 'l', to: 'w', text: 'do b', state: 'failed' },
      { id: 'r-3', from: 'l', to: 'w', text: 'handoff', state: 'failed', kind: 'handoff' },
    ], undefined)
    expect(text).toContain('r-1: do a\n  answer: did a')
    expect(text).toContain('r-2 (failed): do b')
    expect(text).not.toContain('r-3')
  })

  it('parses /agents merge, builds the page\'s command, and lists partners', () => {
    expect(parseMerge('a into b --name c --role does both')).toEqual({ a: 'a', b: 'b', into: 'b', name: 'c', role: 'does both' })
    expect(parseMerge('a b')).toEqual({ a: 'a', b: 'b' })
    expect(typeof parseMerge('a into')).toBe('string')
    expect(typeof parseMerge('a b --name')).toBe('string')
    expect(mergeCommand('a', 'b', '')).toEqual({ line: '/agents merge a into b' })
    expect(mergeCommand('a', 'b', 'hub')).toEqual({ line: '/agents merge a into b --name hub' })
    expect(mergeCommand('a', 'b', 'Bad Name')).toHaveProperty('error')
    const rows = [
      { id: '1', kind: 'worker' as const, state: 'started' as const, area: 'hub' },
      { id: '2', kind: 'worker' as const, state: 'started' as const },
      { id: '3', kind: 'worker' as const, state: 'started' as const, area: 'hub' },
      { id: '4', kind: 'worker' as const, state: 'archived' as const },
      { id: '5', kind: 'fork' as const, state: 'started' as const },
    ]
    expect(mergePartners(rows, rows[0]!, []).map(r => r.id)).toEqual(['3', '2'])
    expect(mergePartners(rows, rows[0]!, [{ absorbed: '3', survivor: '9' }]).map(r => r.id)).toEqual(['2'])
    expect(mailKindOf('[merged mg-1: a into b; its handoff went to b]')).toEqual({ kind: 'merged' })
    expect(mailKindOf('[merge mg-2 of a into b failed: x]')).toEqual({ kind: 'failure' })
  })
})
