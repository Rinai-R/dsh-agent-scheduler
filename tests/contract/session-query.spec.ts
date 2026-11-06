/**
 * Contract R1–R5: the session-query reads `agent_recall` relies on (src/dsh/host/session-query.ts),
 * against DSH's own provider as dsh-base mounts it (`dsh-session-query-sqlite`, `openAt: never`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setup, teardown } from '../support/harness.js'
import { textResponse } from '../support/mock-adapter.js'
import { until, user } from '../support/scheduler.js'
import { historyPort } from '../../src/dsh/host/session-query.js'
import { features, resetWarnings } from '../../src/dsh/compat.js'

afterEach(async () => { await teardown(); features.reset(); resetWarnings() })

const signal = () => AbortSignal.timeout(10_000)

describe('session query for recall (R1-R5)', () => {
  it('R1-R3: filterEvents ANDs literal, case-insensitive terms over one session, live or cold, from a seq on', async () => {
    const { ctx, lead } = await setup(o => textResponse(JSON.stringify(o.messages).includes('alpha:') ? 'The Encoder was swapped for ZSTD level 9' : 'other'), 8, { hostQuery: true })
    const port = historyPort(ctx)
    expect(port.available).toBe(true)
    lead.followup(user('alpha: what did you change?'))
    await until(lead, 'alpha')
    const live = await port.find(lead.id, ['encoder', 'zstd'], { fromSeq: 0, limit: 10, signal: signal() })
    expect(live.hits.length).toBeGreaterThan(0)
    expect(live.hits[0]!.snippet).toMatch(/Encoder was swapped for ZSTD/u)
    // Both words must be in one event.
    expect((await port.find(lead.id, ['encoder', 'nowhere'], { fromSeq: 0, limit: 10, signal: signal() })).hits).toEqual([])
    // A seq range cuts what is scanned.
    const last = (lead.session.snapshotEvents().at(-1)!.seq as number) + 1
    expect((await port.find(lead.id, ['encoder'], { fromSeq: last, limit: 10, signal: signal() })).hits).toEqual([])
    // The window around a hit has the event in full.
    const w = await port.window(lead.id, live.hits[0]!.seq, 2)
    expect(w.target.text).toMatch(/ZSTD level 9/u)
    expect(w.around.length).toBeGreaterThan(0)
    expect(await port.ownedFrom(lead.id)).toBe(0)
    // Cold: the same reads once a session is only on disk.
    const h = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('cold'), agentOptions: { provider: 'mock', model: 'lead-model' } } as never)
    h.agent.followup(user('alpha: and the cold one?'))
    await until(h.agent, 'alpha: and the cold one')
    await h.dispose()
    expect(ctx.agents.get(SessionId('cold'))).toBeUndefined()
    expect((await port.find('cold', ['ZSTD'], { fromSeq: 0, limit: 10, signal: signal() })).hits.length).toBeGreaterThan(0)
  })

  it('R4: an event a later compaction-style replacement shadows is still found', async () => {
    const { ctx, lead } = await setup(() => textResponse('kept answer'), 8, { hostQuery: true })
    lead.followup(user('the secret word is pelican'))
    await until(lead, 'pelican')
    const port = historyPort(ctx)
    const seq = (await port.find(lead.id, ['pelican'], { fromSeq: 0, limit: 1, signal: signal() })).hits[0]!.seq
    // Shadow it the way compaction does: replace its surface node.
    await lead.whenIdle()
    lead.session.append('user/message', { id: 'replacement', content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } } as never, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] } as never)
    expect((await port.find(lead.id, ['pelican'], { fromSeq: 0, limit: 5, signal: signal() })).hits.map(h => h.seq)).toContain(seq)
  })

  it('R5: the host provider keeps full-text search disabled (recall does not use it)', async () => {
    const { ctx } = await setup(() => textResponse('x'), 8, { hostQuery: true })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('lead'), query: 'x' } as never)).rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' })
  })

  it('degrades when filterEvents is missing', () => {
    const port = historyPort({ sessionQuery: { observeSession: () => undefined } } as never)
    expect(port.available).toBe(false)
  })
})
