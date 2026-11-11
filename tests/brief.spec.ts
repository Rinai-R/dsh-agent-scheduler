/** The structured brief of a hand-off (design phase 2 §4, Q1). */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BRIEF_HEADINGS, BriefInvalid, parseBrief, renderBrief, withSenderRef } from '../src/brief.js'
import { senderRange } from '../src/scheduler.js'
import { applyRoster, EMPTY_ROSTER } from '../src/projection.js'
import { MemoryQueueStore } from '../src/queue.js'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, until } from './support/scheduler.js'
import { testController } from './support/session-controller.js'
import { MessageQueue } from '../src/queue.js'
import { queueHost } from '../src/dsh/host/index.js'
import { afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(teardown)

const good = () => ({
  goal: 'Fix the retry crash', userWords: '重试会崩，修一下',
  findings: [{ text: 'null deref on an empty body', refs: [{ kind: 'file', path: 'src/retry.ts', line: 42 }, { kind: 'commit', sha: 'abc123' }, { kind: 'session', id: 'session-x', seqFrom: 3, seqTo: 9 }] }],
  constraints: ['no API change'], nonGoals: ['refactor the client'], acceptance: ['a test reproduces and passes'], openQuestions: ['keep the old retry count?'],
})

describe('parseBrief', () => {
  it('accepts a full brief, and empty lists where they may be empty', () => {
    expect(parseBrief(good()).findings[0]!.refs).toHaveLength(3)
    expect(parseBrief({ ...good(), findings: [], constraints: [], nonGoals: [], openQuestions: [] }).acceptance).toEqual(['a test reproduces and passes'])
  })

  it('names every wrong field with what to give, all at once', () => {
    let error: unknown
    try {
      parseBrief({ goal: ' ', findings: [{ text: 'x', refs: [{ kind: 'file' }, { kind: 'session', id: 's', seqFrom: 5, seqTo: 2 }, { kind: 'tweet' }] }], constraints: 'no', acceptance: [], openQuestions: [''] })
    } catch (e) { error = e }
    expect(error).toBeInstanceOf(BriefInvalid)
    const problems = (error as BriefInvalid).problems
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^goal is missing or empty/u),
      expect.stringMatching(/^userWords is missing or empty/u),
      expect.stringMatching(/findings\[0\]\.refs\[0\]: a file ref needs path/u),
      expect.stringMatching(/findings\[0\]\.refs\[1\]: seqTo is before seqFrom/u),
      expect.stringMatching(/findings\[0\]\.refs\[2\]: kind is one of file, commit, pr, session, im, url/u),
      expect.stringMatching(/^constraints is missing/u),
      expect.stringMatching(/^nonGoals is missing/u),
      expect.stringMatching(/^acceptance is empty: give at least one item/u),
      expect.stringMatching(/^openQuestions\[0\] must be a non-empty string/u),
    ]))
    expect((error as Error).message).toMatch(/nothing was sent/u)
  })

  it('does not check userWords against what the user said (any non-empty text)', () => {
    expect(parseBrief({ ...good(), userWords: 'paraphrased, not a quote' }).userWords).toBe('paraphrased, not a quote')
  })
})

describe('renderBrief', () => {
  it('renders the fixed sections in the fixed order with English headings, refs inline, then the note', () => {
    const text = renderBrief(parseBrief({ ...good(), nonGoals: [] }), 'start with the parser')
    const at = BRIEF_HEADINGS.map(h => text.indexOf(`## ${h}\n`))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain('> 重试会崩，修一下')
    expect(text).toContain('[src/retry.ts:42; commit abc123; session session-x seq 3-9]')
    expect(text).toMatch(/## Non-goals\n- \(none\)/u)
    expect(text.endsWith('## Note\nstart with the parser')).toBe(true)
  })

  it('attaches the sender session and seq range as a session ref', () => {
    const b = withSenderRef(parseBrief(good()), { id: 'session-fork', seqFrom: 10, seqTo: 20 })
    expect(b.findings.at(-1)!.refs).toEqual([{ kind: 'session', id: 'session-fork', seqFrom: 10, seqTo: 20 }])
  })
})

/** A router with session workers (as tests/session-workers.spec.ts). */
async function router(respond: (body: string) => string) {
  const workspace = mkdtempSync(join(tmpdir(), 'brief-ws-'))
  const { ctx } = await setup(async o => textResponse(respond(body(o))))
  const lead = (await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('router'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'lead-model' } } as never)).agent
  const controller = testController(ctx, { workspace })
  const store = new MemoryQueueStore()
  const queue = new MessageQueue(store, queueHost(ctx, controller.port, async id => stored(ctx, SessionId(id))))
  const scheduler = install(ctx, { defaultOn: false, sessionWorkers: controller.port, queue })
  return { ctx, lead, store, scheduler }
}
const exec = (agent: Agent) => ({ agent, callId: `c-${Math.random()}` }) as never
const version = (scheduler: { rosterVersion(l: unknown): string; ledgerOf(a: Agent): unknown }, lead: Agent) => scheduler.rosterVersion(scheduler.ledgerOf(lead))

describe('agent_send / agent_create with a brief', () => {
  it('refuses new work without a brief or with a bad one, recording nothing (no request id, no queue entry)', async () => {
    const { ctx, lead, store, scheduler } = await router(() => 'OK')
    const made = await scheduler.createWorker(lead, { name: 'hub', role: 'r' })
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(made.id))?.status).toBe('idle') })
    const requests = () => scheduler.ledgerOf(lead).state.requests.length
    const queued = () => store.messages().length
    const before = { r: requests(), q: queued() }
    const send = ctx.tools.get('agent_send', lead)!
    await expect(send.execute({ to: 'hub', message: 'do it', rosterVersion: version(scheduler, lead) }, exec(lead))).rejects.toThrow(/needs a brief.*followUp: "r-N"/su)
    await expect(send.execute({ to: 'hub', brief: { ...good(), acceptance: [] }, rosterVersion: version(scheduler, lead) }, exec(lead))).rejects.toThrow(/acceptance is empty/u)
    await expect(ctx.tools.get('agent_create', lead)!.execute({ name: 'other', role: 'r', task: 'x', rosterVersion: version(scheduler, lead) }, exec(lead))).rejects.toThrow(/needs a brief/u)
    expect({ r: requests(), q: queued() }).toEqual(before)
    expect(scheduler.ledgerOf(lead).find('other')).toBeUndefined()
  })

  it('stores the brief with the queued message, renders it for the worker, and attaches the sender\'s session range', async () => {
    const seen: string[] = []
    const { ctx, lead, store, scheduler } = await router(b => { if (b.includes('## Goal')) seen.push(b); return 'DONE' })
    const out = await ctx.tools.get('agent_create', lead)!.execute({ name: 'hub', role: 'r', brief: good(), task: 'start with the parser', rosterVersion: version(scheduler, lead) }, exec(lead)) as { request: string }
    await until(lead, `[reply to ${out.request} from hub]`)
    const m = store.messages().find(x => x.request === out.request)!
    expect(m.brief?.goal).toBe('Fix the retry crash')
    expect(m.brief?.findings.at(-1)!.refs[0]).toMatchObject({ kind: 'session', id: 'router' })
    const rendered = seen.join('\n')
    expect(rendered).toMatch(/## Goal\\nFix the retry crash/u)
    expect(rendered).toMatch(/session router seq \d+-\d+/u)
    expect(rendered).toContain('## Note\\nstart with the parser')
  })

  it('a follow-up to an earlier request goes without a brief; one to a request that is not yours is refused', async () => {
    const { ctx, lead, scheduler } = await router(b => b.includes('[follow-up to r-1]') ? 'REWORKED' : 'FIRST')
    const send = ctx.tools.get('agent_send', lead)!
    await ctx.tools.get('agent_create', lead)!.execute({ name: 'hub', role: 'r', brief: good(), rosterVersion: version(scheduler, lead) }, exec(lead))
    await until(lead, '[reply to r-1 from hub]')
    await expect(send.execute({ to: 'hub', followUp: 'r-9', message: 'again', rosterVersion: version(scheduler, lead) }, exec(lead))).rejects.toThrow(/not a request this session sent/u)
    await expect(send.execute({ to: 'hub', followUp: 'r-1', brief: good(), rosterVersion: version(scheduler, lead) }, exec(lead))).rejects.toThrow(/either brief .* or followUp/u)
    const out = await send.execute({ to: 'hub', followUp: 'r-1', message: 'use the other parser', rosterVersion: version(scheduler, lead) }, exec(lead)) as { request: string }
    await until(lead, `[reply to ${out.request} from hub]`)
  })

  it('the worker can agent_recall the sender session a brief points at, also when the sender is a fork of another session', async () => {
    const { ctx, lead, scheduler } = await router(() => 'OK')
    const out = await ctx.tools.get('agent_create', lead)!.execute({ name: 'hub', role: 'r', brief: { ...good(), findings: [{ text: 'explored in a fork', refs: [{ kind: 'session', id: 'session-fork-of-elsewhere', seqFrom: 1, seqTo: 4 }] }] }, rosterVersion: version(scheduler, lead) }, exec(lead)) as { request: string; id: string }
    await until(lead, `[reply to ${out.request} from hub]`)
    const worker = ctx.agents.get(SessionId(out.id))!
    // The worker's own roster does not list the router or that fork; the brief makes them recall targets.
    expect(scheduler.recallTargets(worker, 'session-fork-of-elsewhere')).toEqual([{ name: 'brief sender', session: 'session-fork-of-elsewhere', state: 'briefed' }])
    expect(scheduler.recallTargets(worker, 'router')).toEqual([{ name: 'brief sender', session: 'router', state: 'briefed' }])
    expect(scheduler.recallTargets(worker, 'session-unrelated')).toEqual([])
  })

  it('senderRange is the turn the caller is in', async () => {
    const { lead } = await router(() => 'OK')
    const r = senderRange(lead)
    expect(r.id).toBe('router')
    expect(r.seqTo).toBeGreaterThanOrEqual(r.seqFrom)
  })

  it('old queued records without a brief still fold and still validate', async () => {
    const { validateQueueMessage } = await import('../src/dsh/host/queue-store.js').then(m => ({ validateQueueMessage: (m as Record<string, unknown>).QUEUE_DOMAIN }))
    const spec = validateQueueMessage as { tables: { messages: { valueSchema: { parse(v: unknown): unknown } } } }
    const old = { qid: 'q-1', target: 'W', seq: 1, producer: { kind: 'router', id: 'R', session: 'R' }, dedupeKey: 'r-1', text: '[request r-1 from lead]\nplain', mode: 'turn', state: 'answered', attempts: 1, createdAt: new Date().toISOString(), request: 'r-1' }
    expect(() => spec.tables.messages.valueSchema.parse(old)).not.toThrow()
    expect(() => spec.tables.messages.valueSchema.parse({ ...old, brief: 'nope' })).toThrow(/brief is an object/u)
    const state = [{ seq: 1, type: 'plugin:dsh-agent-scheduler/request', ignorable: true, time: 1, data: { version: 1, action: 'sent', id: 'r-1', from: 'R', to: 'W', text: 'plain old request' } }].reduce(applyRoster as never, EMPTY_ROSTER) as unknown as { requests: Array<{ text: string }> }
    expect(state.requests[0]!.text).toBe('plain old request')
  })
})

void (null as unknown as Context)
