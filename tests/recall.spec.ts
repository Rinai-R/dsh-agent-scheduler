/** Recall of a merged (or any roster member's) session history: agent_recall (docs/merge-recall.md). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, until } from './support/scheduler.js'
import { historyLine } from '../src/merge.js'
import { snippetOf } from '../src/dsh/host/session-query.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema } from '../src/projection.js'
import { MERGE_RECORD } from '../src/records.js'
import { sectionFor } from '../src/tools.js'

afterEach(teardown)

const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal }) as never
const asked = (o: GenerateOptions) => body(o).includes('You are being merged into')
const HANDOFF = ['## Done', 'image fixed', '## In progress', 'none', '## Decisions', 'none', '## Open questions', 'none', '## Files changed', 'none', '## Branch / PR', 'none', '## Uncommitted changes', 'none'].join('\n')

/** hub split into hub-asr and hub-image; hub-image did work with a detail, then merged into hub-asr as hub. */
async function mergedPair() {
  const { ctx, lead } = await setup(async o => {
    if (o.sessionId === 'lead') return textResponse('LEAD')
    if (asked(o)) return textResponse(HANDOFF)
    if (body(o).includes('fix image')) return textResponse('Swapped the JPEG encoder for mozjpeg at quality 82; the old one leaked memory.')
    return textResponse('DONE')
  })
  const scheduler = install(ctx, { defaultOn: false })
  await scheduler.createWorker(lead, { name: 'hub', role: 'develops hub', task: 'warm up with the walrus drill' })
  await until(lead, '[reply to r-1 from hub]')
  await scheduler.split(lead, { owner: 'hub', ownerName: 'hub-asr', ownerRole: 'smoke-tests ASR', name: 'hub-image', role: 'fixes gpt_image', task: 'fix image' })
  await until(lead, '[reply to r-2 from hub-image]')
  const imageId = scheduler.ledgerOf(lead).find('hub-image')!.id
  await scheduler.merge(lead, { absorbed: 'hub-image', into: 'hub-asr', name: 'hub' })
  await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).merges[0]?.state).toBe('delivered') }, { timeout: 20_000 })
  return { ctx, lead, scheduler, imageId }
}

describe('agent_recall', () => {
  it('finds a detail in a merged worker\'s own history by its old name, and reads around it', async () => {
    const { ctx, lead, scheduler, imageId } = await mergedPair()
    const hub = scheduler.ledgerOf(lead).find('hub')!
    // The merge kept a pointer: the absorbed session, its own span, and how many rounds it ran.
    expect(hub.mergedFrom).toEqual([expect.objectContaining({ merge: 'mg-1', name: 'hub-image', session: imageId })])
    const from = hub.mergedFrom![0]!
    expect(from.seqFrom).toBeGreaterThan(0)
    expect(from.seqTo).toBeGreaterThan(from.seqFrom!)
    expect(from.rounds).toBeGreaterThanOrEqual(2)
    // The handoff carries it, and so does the survivor's prompt.
    await vi.waitFor(async () => {
      const log = (await stored(ctx, SessionId(hub.id))).events.map(e => JSON.stringify(e.data)).join('\n')
      expect(log).toContain(`[absorbed hub-image → session ${imageId}`)
    }, { timeout: 15_000 })
    const survivor = { id: hub.id, session: { header: { parentSession: lead.id } } } as never
    expect(sectionFor(scheduler, survivor)).toContain(`You absorbed hub-image (merge mg-1); its history is session ${imageId}`)
    // By the old name: the merged worker itself, not the survivor its name now finds.
    const tool = ctx.tools.get('agent_recall', lead)!
    const out = await tool.execute({ name: 'hub-image', query: 'mozjpeg quality' }, exec(lead)) as { session: string; hits: Array<{ seq: number; snippet: string }>; ownedFrom: number }
    expect(out.session).toBe(imageId)
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits[0]!.snippet).toMatch(/mozjpeg at quality 82/u)
    // What hub-image inherited from hub when it was split off is not searched by default.
    expect(out.ownedFrom).toBeGreaterThan(0)
    const inherited = await scheduler.recall(lead, { name: 'hub-image', query: 'walrus drill' })
    expect(inherited.hits).toEqual([])
    expect((await scheduler.recall(lead, { name: 'hub-image', query: 'walrus drill', includeInherited: true })).hits!.length).toBeGreaterThan(0)
    // Every word must be in one event.
    expect((await scheduler.recall(lead, { session: imageId, query: 'mozjpeg unicorn' })).hits).toEqual([])
    const around = await scheduler.recall(lead, { session: imageId, around: out.hits[0]!.seq })
    expect(around.window!.target.text).toMatch(/leaked memory/u)
    // A worker may recall too (a fork as well: it is on the fork list).
    expect((await scheduler.recall(survivor, { name: 'hub-image', query: 'mozjpeg' })).hits!.length).toBeGreaterThan(0)
  })

  it('agent_list shows session ids, the survivor\'s mergedFrom, and history', async () => {
    const { ctx, lead, imageId } = await mergedPair()
    const out = await ctx.tools.get('agent_list', lead)!.execute({}, exec(lead)) as { agents: Array<Record<string, unknown>>; history: Array<Record<string, unknown>> }
    const hub = out.agents.find(a => a.name === 'hub')!
    expect(typeof hub.session).toBe('string')
    expect(hub.mergedFrom).toEqual([{ name: 'hub-image', session: imageId }])
    expect(out.agents.some(a => a.name === 'hub-image')).toBe(false)
    expect(out.history).toEqual([expect.objectContaining({ name: 'hub-image', session: imageId, state: 'merged', mergedInto: 'hub' })])
  })

  it('refuses what is not in the roster, an ambiguous name, and a query without words', async () => {
    const { lead, scheduler } = await mergedPair()
    await scheduler.createWorker(lead, { name: 'docs', role: 'docs' })
    await expect(scheduler.recall(lead, { session: 'session-elsewhere', query: 'x' })).rejects.toThrow(/not in this session's roster/)
    await expect(scheduler.recall(lead, { name: 'nobody', query: 'x' })).rejects.toThrow(/not in this session's roster/)
    await expect(scheduler.recall(lead, { name: 'hub-image' })).rejects.toThrow(/give query/)
    await expect(scheduler.recall(lead, {})).rejects.toThrow(/give name/)
    // "hub" was the name of the area before the split: now the survivor's current name, one session.
    expect(scheduler.recallTargets(lead, 'hub')).toHaveLength(1)
    // A former name two members share lists both.
    const ledger = scheduler.ledgerOf(lead)
    const twin = { ...ledger.find('docs')!, formerNames: ['old'] }
    const asr = { ...ledger.find('hub')!, formerNames: [...(ledger.find('hub')!.formerNames ?? []), 'old'] }
    const fake = Object.create(scheduler) as typeof scheduler
    Object.defineProperty(fake, 'ledgerOf', { value: () => ({ ...ledger, mainId: ledger.mainId, state: { ...ledger.state, members: ledger.state.members.map(m => m.id === twin.id ? twin : m.id === asr.id ? asr : m) } }) })
    expect(fake.recallTargets(lead, 'old')).toHaveLength(2)
    // The lead itself is in scope.
    expect(scheduler.recallTargets(lead, 'lead')).toEqual([{ name: 'lead', session: lead.id, state: 'lead' }])
  })

  it('a slow scan is cut at the time budget', async () => {
    const { ctx, lead } = await setup(() => textResponse('x'))
    const scheduler = install(ctx, {
      defaultOn: false,
      recallTimeoutMs: 50,
      history: {
        available: true,
        ownedFrom: async () => 0,
        find: (_id, _t, opts) => new Promise((_resolve, reject) => { opts.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) }),
        window: async () => { throw new Error('unused') },
      },
    })
    await expect(scheduler.recall(lead, { name: 'lead', query: 'x' })).rejects.toThrow(/took over 0 s|took over/)
  })
})

describe('recall helpers', () => {
  it('cuts a snippet around the first term, in one line', () => {
    const text = `${'a '.repeat(200)}the Needle is here ${'b '.repeat(200)}`
    const s = snippetOf(text, 'needle')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toContain('the Needle is here')
    expect(s.length).toBeLessThan(330)
    expect(snippetOf('short\n text', undefined)).toBe('short text')
  })

  it('writes the pointer line, and folds mergedFrom (older merges without a span still fold)', () => {
    expect(historyLine({ merge: 'mg-1', name: 'a', session: 's-1', seqFrom: 4, seqTo: 90, rounds: 3, at: 0 })).toBe('[absorbed a → session s-1; its own events seq 4–90, 3 rounds; recall details with agent_recall({ name: "a", query: "…" })]')
    expect(historyLine({ merge: 'mg-1', name: 'a', session: 's-1', at: 0 })).toBe('[absorbed a → session s-1; recall details with agent_recall({ name: "a", query: "…" })]')
    const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, ignorable: true, time: 100 + seq, data: { version: 1, ...data } }) as never
    const agent = (seq: number, id: string, name: string) => ev(seq, 'plugin:dsh-agent-scheduler/agent', { action: 'created', id, name, role: name })
    const state = [
      agent(1, 'A', 'a'), agent(2, 'B', 'b'),
      ev(3, MERGE_RECORD, { action: 'requested', id: 'mg-1', absorbed: 'A', survivor: 'B', request: '' }),
      ev(4, MERGE_RECORD, { action: 'handoff', id: 'mg-1', text: 'h' }),
      ev(5, MERGE_RECORD, { action: 'settled', id: 'mg-1' }),
      ev(6, MERGE_RECORD, { action: 'merged', id: 'mg-1', name: 'b' }),
    ].reduce(applyRoster, EMPTY_ROSTER)
    expect(state.members.find(m => m.id === 'B')?.mergedFrom).toEqual([{ merge: 'mg-1', name: 'a', session: 'A', at: 106 }])
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(state)))).toBeTruthy()
  })
})
