/** Workers the user creates and names (`/agents new`), and renaming a worker (`/agents rename`). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, install, last, listThen, records, until, user } from './support/scheduler.js'
import { AGENT_RECORD } from '../src/records.js'
import { parseNewWorker, runAgentsCommand } from '../src/rule-plugin.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema } from '../src/projection.js'
import { commandFailure, needsRestartFor, newWorkerCommand, renameCommand } from '../src/client/index.js'

afterEach(teardown)

const agents = (scheduler: Parameters<typeof runAgentsCommand>[0], lead: unknown, rawInput: string) => runAgentsCommand(scheduler, { agent: lead, rawInput } as never)
const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
const systemOf = (o: GenerateOptions) => JSON.stringify(o.messages[0])

describe('/agents new', () => {
  it('creates a named worker with its role and directory, and no task', async () => {
    const { ctx, lead, adapter } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'sch-'))
    const result = await agents(scheduler, lead, `new billing --cwd ${dir} owns "billing" retries`)
    expect(result).toEqual({ kind: 'success', text: 'Created worker billing.' })
    expect(scheduler.ledgerOf(lead).find('billing')).toMatchObject({ kind: 'worker', state: 'started', role: 'owns "billing" retries', cwd: dir })
    expect(scheduler.ledgerOf(lead).requests.size).toBe(0)
    await vi.waitFor(() => { expect(adapter.requests.some(isWorker('billing'))).toBe(true) })
    expect(body(adapter.requests.find(isWorker('billing'))!)).toContain('No task yet')
  })

  it('refuses a malformed, reserved, or taken name, and a directory that does not exist', async () => {
    const { ctx, lead } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx)
    await agents(scheduler, lead, 'new docs writes docs')
    for (const [line, why] of [
      ['new Docs x', /lower-kebab-case/],
      ['new 9lives x', /lower-kebab-case/],
      ['new lead x', /reserved/],
      ['new user x', /reserved/],
      ['new fork-3 x', /reserved/],
      ['new docs again', /already taken/],
      [`new ops --cwd ${join(mkdtempSync(join(tmpdir(), 'sch-')), 'missing')} x`, /does not exist/],
      ['new ops', /Say what the worker is for/],
      ['new ops --cwd', /--cwd needs a value/],
      ['new ops --model nope x', /provider\/model/],
      ['', /Usage/],
    ] as const) {
      const result = await agents(scheduler, lead, line)
      expect(result.kind, line).toBe('error')
      expect(result.text, line).toMatch(why)
    }
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD).map(r => r.name)).toEqual(['docs'])
  })

  it('parses options before the role and keeps the role as typed', () => {
    expect(parseNewWorker('a --model p/m:high --cwd "/x y" do  the "thing"')).toEqual({ name: 'a', role: 'do  the "thing"', cwd: '/x y', model: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    expect(parseNewWorker('a fix --cwd handling')).toEqual({ name: 'a', role: 'fix --cwd handling' })
  })

  it('only runs in the main session', async () => {
    const { ctx, lead } = await setup(() => textResponse('ready'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'w', role: 'r' })
    const child = ctx.agents.get(SessionId(scheduler.ledgerOf(lead).find('w')!.id))!
    expect((await agents(scheduler, child, 'new x y')).kind).toBe('error')
  })
})

describe('/agents rename', () => {
  it('renames a worker: roster, agent_list, its prompt, and later replies use the new name; the old one still reaches it', async () => {
    let listed = ''
    let step = 0
    const { ctx, lead, adapter } = await setup(o => {
      if (isWorker('docs')(o)) return textResponse(last(o).includes('[request r-1 from lead]') ? 'DOCS ANSWER' : last(o).includes('[request r-2 from lead]') ? 'DOCS SECOND' : 'docs ready')
      if (o.sessionId === 'lead') {
        step += 1
        if (step === 1) return toolCallResponse('l1', 'agent_list', {})
        if (step === 2) { listed = body(o); return listThen(o, 's1', 'agent_send', { to: 'docs', message: 'first' }) }
        if (step === 3) return textResponse('LEAD SENT')
        // r-1 was answered since the first list: read the roster again for a current rosterVersion.
        if (step === 4) return toolCallResponse('l2', 'agent_list', {})
        if (step === 5) return listThen(o, 's2', 'agent_send', { to: 'site', message: 'second' })
        return textResponse('LEAD')
      }
      return textResponse('OTHER')
    })
    const scheduler = install(ctx)
    await agents(scheduler, lead, 'new docs writes docs')
    const id = scheduler.ledgerOf(lead).find('docs')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    expect(await agents(scheduler, lead, 'rename docs site')).toEqual({ kind: 'success', text: 'Renamed docs to site.' })
    const ledger = scheduler.ledgerOf(lead)
    expect(ledger.find('site')).toMatchObject({ id, name: 'site', formerNames: ['docs'] })
    expect(ledger.find('docs')?.id).toBe(id)
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD).at(-1)).toMatchObject({ action: 'renamed', id, name: 'site', previousName: 'docs' })
    expect(rosterView(ledger.state).members.find(m => m.id === id)).toMatchObject({ name: 'site', formerNames: ['docs'] })
    // The lead lists it under its new name and sends to it by the old one.
    lead.followup({ ...user('go'), source: { kind: 'goal' } as never })
    await until(lead, '[reply to r-1 from site]')
    expect(listed).toContain('\\"name\\":\\"site\\"')
    expect(listed).not.toContain('\\"name\\":\\"docs\\"')
    lead.followup({ ...user('again'), source: { kind: 'goal' } as never })
    await until(lead, '[reply to r-2 from site]')
    expect(ledger.requests.get('r-1')).toMatchObject({ to: id, state: 'answered' })
    // Its own prompt says its current name.
    expect(adapter.requests.filter(r => r.sessionId === id).some(r => systemOf(r).includes('Your name is \\"site\\"'))).toBe(true)
    // The old name can still archive it.
    await scheduler.archive(lead, 'docs')
    expect(ledger.find('site')?.state).toBe('archived')
  })

  it('the old name stays reserved; a fork, an archived worker, or an unknown name cannot be renamed', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'docs', role: 'r' })
    await scheduler.createWorker(lead, { name: 'ops', role: 'r' })
    await agents(scheduler, lead, 'rename docs site')
    expect((await agents(scheduler, lead, 'new docs again')).text).toMatch(/already taken/)
    expect((await agents(scheduler, lead, 'rename ops docs')).text).toMatch(/already taken/)
    expect((await agents(scheduler, lead, 'rename ops site')).text).toMatch(/already taken/)
    expect((await agents(scheduler, lead, 'rename ops lead')).text).toMatch(/reserved/)
    expect((await agents(scheduler, lead, 'rename ops Bad')).text).toMatch(/lower-kebab-case/)
    expect((await agents(scheduler, lead, 'rename nobody x')).text).toMatch(/no agent named/)
    expect((await agents(scheduler, lead, 'rename ops')).kind).toBe('error')
    // Taking back its own earlier name is allowed, and is not a reuse.
    expect((await agents(scheduler, lead, 'rename site docs')).kind).toBe('success')
    expect(scheduler.ledgerOf(lead).find('docs')).toMatchObject({ name: 'docs', formerNames: ['site'] })
    lead.followup(user('hi'))
    await until(lead, 'Its conclusion')
    expect((await agents(scheduler, lead, 'rename fork-1 helper')).text).toMatch(/is a fork/)
    await scheduler.archive(lead, 'ops')
    expect((await agents(scheduler, lead, 'rename ops ops2')).text).toMatch(/archived/)
  })

  it('a rename survives a restart of the main session', async () => {
    const { ctx } = await setup(() => textResponse('OK'))
    const opts = { provider: 'mock', model: 'lead-model' }
    const h1 = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('main'), agentOptions: opts } as never)
    const scheduler = install(ctx, { defaultOn: false })
    await scheduler.createWorker(h1.agent, { name: 'docs', role: 'r' })
    await scheduler.rename(h1.agent, 'docs', 'site')
    await h1.dispose()
    scheduler.forget('main')
    const h2 = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId('main'), agentOptions: opts } as never)
    expect(scheduler.ledgerOf(h2.agent).find('docs')).toMatchObject({ name: 'site', formerNames: ['docs'] })
  })

  it('a later record under the old name (a queued worker that starts) does not undo the rename', () => {
    const ev = (data: Record<string, unknown>, seq: number) => ({ type: AGENT_RECORD, ignorable: true, seq, time: seq, data: { version: 1, ...data } }) as never
    let s = applyRoster(EMPTY_ROSTER, ev({ action: 'queued', id: 'w1', name: 'docs', role: 'r' }, 1))
    s = applyRoster(s, ev({ action: 'renamed', id: 'w1', name: 'site', previousName: 'docs' }, 2))
    s = applyRoster(s, ev({ action: 'started', id: 'w1', name: 'docs' }, 3))
    expect(s.members[0]).toMatchObject({ name: 'site', state: 'started', formerNames: ['docs'] })
  })

  it('the projection parses formerNames and refuses a malformed one', () => {
    const member = { id: 'w1', name: 'site', kind: 'worker', state: 'started', text: 'r', formerNames: ['docs'] }
    const state = { enabled: null, role: null, forkModel: null, members: [member], requests: [] }
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(() => rosterViewSchema.parse({ enabled: true, role: null, forkModel: null, members: [member], openRequests: [] })).not.toThrow()
    expect(() => rosterSchema.parse({ ...state, members: [{ ...member, formerNames: 'docs' }] })).toThrow(/formerNames/)
    expect(() => rosterSchema.parse({ ...state, members: [{ ...member, formerNames: [1] }] })).toThrow(/formerNames/)
  })
})

describe('Agents page commands', () => {
  it('builds /agents new and rename lines the host parses back, and checks the input first', () => {
    const built = newWorkerCommand({ name: 'billing', role: ' owns\nretries ', cwd: '/tmp/a b' })
    expect(built).toEqual({ line: '/agents new billing --cwd "/tmp/a b" owns retries' })
    expect(parseNewWorker((built as { line: string }).line.slice('/agents new '.length))).toEqual({ name: 'billing', role: 'owns retries', cwd: '/tmp/a b' })
    expect(newWorkerCommand({ name: 'Bad', role: 'x' })).toHaveProperty('error')
    expect(newWorkerCommand({ name: 'ok', role: '  ' })).toHaveProperty('error')
    expect(parseNewWorker((newWorkerCommand({ name: 'ok', role: '--cwd trick' }) as { line: string }).line.slice('/agents new '.length))).toMatchObject({ name: 'ok' })
    expect(renameCommand('docs', ' site ')).toEqual({ line: '/agents rename docs site' })
    expect(renameCommand('docs', 'Site')).toHaveProperty('error')
    expect(needsRestartFor('Usage: /agents archive <name> | /agents archive done')).toBe(true)
    expect(needsRestartFor('"x" is already taken (names are never reused)')).toBe(false)
  })
})

describe('command results in the browser', () => {
  it('reads an error from the wrapped result the server sends, and from the older bare shape', () => {
    expect(commandFailure({ commandId: 'c', result: { kind: 'error', text: 'taken' } }, '/agents new x y')).toBe('taken')
    expect(commandFailure({ commandId: 'c', result: { kind: 'success', text: 'ok' } }, '/agents new x y')).toBeNull()
    expect(commandFailure({ kind: 'error', text: 'old' }, '/agents new x y')).toBe('old')
    expect(commandFailure({ kind: 'success' }, '/x')).toBeNull()
    expect(commandFailure(undefined, '/agents new x')).toBe('unknown command: /agents')
  })
})
