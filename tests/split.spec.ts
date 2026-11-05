/** Coarse workers that split only when a new task collides with a busy owner (agent_split). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, install, last, records, until } from './support/scheduler.js'
import { AGENT_RECORD, appendAgent, REQUEST_RECORD } from '../src/records.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema, rosterView, rosterViewSchema, type Roster } from '../src/projection.js'
import { FORK_NOTICE } from '../src/scheduler.js'
import { byArea, subline } from '../src/client/index.js'

afterEach(teardown)

const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
const rosterOf = (lead: Parameters<typeof until>[0]): Roster => lead.session.snapshotEvents().reduce(applyRoster, EMPTY_ROSTER)
const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal }) as never

describe('agent_split', () => {
  it('renames a busy owner, forks a new worker for the new task, and both share the area', async () => {
    const hold = gate()
    let ownerRounds = 0
    const renames: Array<[string, string]> = []
    const { ctx, lead, adapter } = await setup(async o => {
      if (o.sessionId === 'lead') return textResponse('LEAD')
      if (isWorker('hub-image')(o)) return textResponse('IMAGE DONE')
      if (isWorker('hub')(o)) {
        ownerRounds += 1
        // The first round answers at once (so a clean round exists to fork from); the second is held.
        if (ownerRounds === 1) return textResponse('hub ready')
        await hold.promise
        return textResponse('ASR DONE')
      }
      return textResponse('OTHER')
    })
    const scheduler = install(ctx, { renameSession: (id, title) => { renames.push([String(id), title]) } })
    const ownerDir = mkdtempSync(join(tmpdir(), 'hub-'))
    await scheduler.createWorker(lead, { name: 'hub', role: 'develops the hub repository', cwd: ownerDir })
    const hubId = scheduler.ledgerOf(lead).find('hub')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(hubId))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await lead.whenIdle()
    await scheduler.send(lead, 'hub', 'smoke test asr')
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(hubId))?.status).toBe('running') })

    const newDir = mkdtempSync(join(tmpdir(), 'hub-image-'))
    const split = ctx.tools.get('agent_split', lead)!
    const splitArgs = { owner: 'hub', ownerName: 'hub-asr', ownerRole: 'smoke-tests ASR in hub', name: 'hub-image', role: 'fixes gpt_image in hub', cwd: newDir, task: 'fix gpt_image' }
    // Like agent_create: the tool wants the rosterVersion from agent_list, and the lead says what it is for.
    await expect(split.execute(splitArgs, exec(lead))).rejects.toThrow(/rosterVersion is required/)
    const rosterVersion = scheduler.rosterVersion(scheduler.ledgerOf(lead))
    await expect(split.execute({ ...splitArgs, rosterVersion }, exec(lead))).rejects.toThrow(/The lead must say what the new worker is for/)
    await expect(split.execute({ ...splitArgs, rosterVersion: '0.0.stale', for: 'r-1' }, exec(lead))).rejects.toThrow(/The roster changed since you read it/)
    const out = await split.execute({ ...splitArgs, rosterVersion, for: 'r-1' }, exec(lead)) as Record<string, unknown>
    expect(out).toMatchObject({ area: 'hub', owner: 'hub-asr', formerName: 'hub', name: 'hub-image', request: 'r-2', queued: false, ownerNotified: true, seeded: true })

    const ledger = scheduler.ledgerOf(lead)
    const owner = ledger.find('hub-asr')!
    expect(owner).toMatchObject({ id: hubId, name: 'hub-asr', role: 'smoke-tests ASR in hub', text: 'smoke-tests ASR in hub', area: 'hub', formerNames: ['hub'], cwd: ownerDir, state: 'started' })
    const sibling = ledger.find('hub-image')!
    expect(sibling).toMatchObject({ role: 'fixes gpt_image in hub', area: 'hub', cwd: newDir, from: hubId, createdFor: 'r-1' })
    // The owner's rename is the same record /agents rename writes, with the narrower role and area.
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD).find(r => r.action === 'renamed')).toMatchObject({ id: hubId, name: 'hub-asr', previousName: 'hub', role: 'smoke-tests ASR in hub', area: 'hub' })
    expect(ledger.requests.get('r-2')).toMatchObject({ to: sibling.id, text: 'fix gpt_image' })
    // The old name now names two live workers: a request to it is refused with both halves.
    expect(ledger.splitHint('hub')).toMatch(/"hub" was split in area hub; it is now "hub-asr" .* and "hub-image"/)
    expect(renames).toContainEqual([hubId, 'hub-asr · smoke-tests ASR in hub'])
    await vi.waitFor(() => { expect(renames.some(([id]) => id === sibling.id)).toBe(true) })

    // The new worker continues hub's conversation, told what it is now.
    await vi.waitFor(() => { expect(adapter.requests.some(isWorker('hub-image'))).toBe(true) })
    const imageReq = adapter.requests.find(isWorker('hub-image'))!
    expect(body(imageReq)).toContain('hub ready')
    expect(body(imageReq)).toContain('[request r-2 from lead]')
    expect(body(imageReq)).toContain('Area \\"hub\\" was split')

    // The running owner got a note (not a request) with its new identity and its sibling.
    hold.open()
    await until(lead, '[reply to r-1 from hub-asr]')
    const ownerReqs = adapter.requests.filter(r => r.sessionId === hubId)
    expect(ownerReqs.some(r => body(r).includes('You are now worker \\"hub-asr\\" (formerly \\"hub\\") in area \\"hub\\"'))).toBe(true)
    expect(ownerReqs.some(r => body(r).includes('\\"hub-image\\": fixes gpt_image in hub'))).toBe(true)
    // Its system prompt carries the new role and identity.
    expect(JSON.stringify(ownerReqs.at(-1)!.messages[0])).toContain('smoke-tests ASR in hub')
    expect(records(lead.session.snapshotEvents(), REQUEST_RECORD).filter(r => r.action === 'sent' && r.to === hubId).map(r => r.id)).toEqual(['r-1', 'r-1'])

    // Later requests to the renamed owner carry its current identity.
    await scheduler.send(lead, 'hub-asr', 'rerun asr')
    await vi.waitFor(() => { expect(adapter.requests.some(r => r.sessionId === hubId && last(r).includes('rerun asr'))).toBe(true) })
    expect(last(adapter.requests.filter(r => r.sessionId === hubId && last(r).includes('rerun asr'))[0]!)).toContain('[you are now worker \\"hub-asr\\" (formerly \\"hub\\") in area \\"hub\\"; your role: smoke-tests ASR in hub]')

    // agent_list shows the area and the former names.
    const listed = await ctx.tools.get('agent_list', lead)!.execute({}, exec(lead)) as { agents: Array<Record<string, unknown>> }
    expect(listed.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hub-asr', area: 'hub', formerNames: ['hub'] }),
      expect.objectContaining({ name: 'hub-image', area: 'hub' }),
    ]))
    // Host ledger and client projection agree, and the state round-trips its validation.
    const state = rosterOf(lead)
    expect(ledger.state).toEqual(state)
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(rosterViewSchema.parse(rosterView(state))).toBe(rosterView(state))
  })

  it('a split while the owner is still in its first round starts the new worker fresh', async () => {
    const hold = gate()
    const { ctx, lead, adapter } = await setup(async o => {
      if (isWorker('api-docs')(o)) return textResponse('DOCS DONE')
      if (isWorker('api')(o)) { await hold.promise; return textResponse('API DONE') }
      return textResponse('LEAD')
    })
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'api', role: 'develops api', task: 'add pagination' })
    const apiId = scheduler.ledgerOf(lead).find('api')!.id
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(apiId))?.status).toBe('running') })
    const out = await scheduler.split(lead, { owner: 'api', ownerName: 'api-paging', ownerRole: 'adds pagination to api', name: 'api-docs', role: 'writes api docs', task: 'document endpoints' })
    expect(out).toMatchObject({ seeded: false, area: 'api' })
    expect(scheduler.ledgerOf(lead).find('api-docs')).toMatchObject({ area: 'api' })
    expect(scheduler.ledgerOf(lead).find('api-docs')!.from).toBeUndefined()
    await until(lead, '[reply to r-2 from api-docs]')
    expect(body(adapter.requests.find(isWorker('api-docs'))!)).toContain('started fresh')
    hold.open()
    await until(lead, '[reply to r-1 from api-paging]')
  })

  it('a second split of one area keeps the area, not the latest name', async () => {
    const { ctx, lead } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'web', role: 'web repo' })
    const id = scheduler.ledgerOf(lead).find('web')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await scheduler.split(lead, { owner: 'web', ownerName: 'web-login', ownerRole: 'login page', name: 'web-cart', role: 'cart', task: 'cart' })
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.filter(e => e.type === 'turn/end').length).toBeGreaterThanOrEqual(1) })
    await scheduler.split(lead, { owner: 'web-login', ownerName: 'web-login-form', ownerRole: 'login form', name: 'web-login-sso', role: 'sso', task: 'sso' })
    const ledger = scheduler.ledgerOf(lead)
    expect(ledger.find('web-login-form')).toMatchObject({ area: 'web', formerNames: ['web', 'web-login'] })
    expect(ledger.find('web-login-sso')).toMatchObject({ area: 'web' })
    expect(ledger.find('web-cart')).toMatchObject({ area: 'web' })
    // Every retired name stays taken.
    for (const name of ['web', 'web-login']) await expect(scheduler.createWorker(lead, { name, role: 'x' })).rejects.toThrow(/already taken/)
    // Records written before a split (no area) and /agents rename (no area) fold the same way.
    expect(ledger.find('web-login-form')!.role).toBe('login form')
  })

  it('refuses before recording anything when an argument is wrong', async () => {
    const { ctx, lead } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'svc-'))
    await scheduler.createWorker(lead, { name: 'svc', role: 'svc repo', cwd: dir })
    await scheduler.createWorker(lead, { name: 'other', role: 'other repo' })
    const id = scheduler.ledgerOf(lead).find('svc')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    const before = records(lead.session.snapshotEvents(), AGENT_RECORD).length
    const base = { owner: 'svc', ownerName: 'svc-a', ownerRole: 'a', name: 'svc-b', role: 'b', cwd: mkdtempSync(join(tmpdir(), 'svc-b-')), task: 't' }
    await expect(scheduler.split(lead, { ...base, owner: 'nobody' })).rejects.toThrow(/no agent named "nobody"/)
    await expect(scheduler.split(lead, { ...base, ownerName: 'svc' })).rejects.toThrow(/new, narrower name/)
    await expect(scheduler.split(lead, { ...base, ownerName: 'other' })).rejects.toThrow(/already taken/)
    await expect(scheduler.split(lead, { ...base, name: 'other' })).rejects.toThrow(/already taken/)
    await expect(scheduler.split(lead, { ...base, name: 'svc-a' })).rejects.toThrow(/must differ/)
    await expect(scheduler.split(lead, { ...base, ownerName: 'Bad' })).rejects.toThrow(/kebab/)
    await expect(scheduler.split(lead, { ...base, ownerRole: ' ' })).rejects.toThrow(/must say/)
    // The new worker needs a worktree of its own: none, or the owner's, is refused.
    await expect(scheduler.split(lead, { ...base, cwd: undefined })).rejects.toThrow(/its own new worktree/)
    await expect(scheduler.split(lead, { ...base, cwd: dir })).rejects.toThrow(/"svc" already works in/)
    await expect(scheduler.split(lead, { ...base, cwd: join(dir, 'missing') })).rejects.toThrow(/does not exist/)
    expect(records(lead.session.snapshotEvents(), AGENT_RECORD)).toHaveLength(before)
    expect(scheduler.ledgerOf(lead).find('svc')).toMatchObject({ name: 'svc' })
    expect(scheduler.ledgerOf(lead).find('svc')!.formerNames).toBeUndefined()
    await scheduler.archive(lead, 'other')
    await expect(scheduler.split(lead, { ...base, owner: 'other', cwd: undefined })).rejects.toThrow(/archived/)
  })

  it('a retired name cannot be reused, and sending to it names both halves', async () => {
    const { ctx, lead } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'pay', role: 'pay repo' })
    const id = scheduler.ledgerOf(lead).find('pay')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await scheduler.split(lead, { owner: 'pay', ownerName: 'pay-refund', ownerRole: 'refunds in pay', name: 'pay-invoice', role: 'invoices in pay', task: 'invoice' })
    await expect(scheduler.createWorker(lead, { name: 'pay', role: 'x' })).rejects.toThrow(/"pay" is already taken/)
    await expect(scheduler.split(lead, { owner: 'pay-refund', ownerName: 'pay', ownerRole: 'x', name: 'pay-x', role: 'y', task: 't' })).rejects.toThrow(/already taken/)
    const refused = scheduler.send(lead, 'pay', 'anything')
    await expect(refused).rejects.toThrow(/"pay" was split in area pay; it is now "pay-refund" \(refunds in pay\) and "pay-invoice" \(invoices in pay\)/)
    await expect(scheduler.archive(lead, 'pay')).rejects.toThrow(/was split/)
    // Once the other half is archived, the old name reaches the owner again, as after /agents rename.
    await scheduler.archive(lead, 'pay-invoice')
    expect(scheduler.ledgerOf(lead).splitHint('pay')).toBeUndefined()
    expect(scheduler.ledgerOf(lead).find('pay')?.name).toBe('pay-refund')
    // Nothing was recorded for the refused send.
    expect(records(lead.session.snapshotEvents(), REQUEST_RECORD).filter(r => r.text === 'anything')).toEqual([])
  })
})

describe('renamed records in the roster fold', () => {
  const ev = (seq: number, data: Record<string, unknown>) => ({ seq, type: 'plugin/record', data: { type: AGENT_RECORD, data: { version: 1, ...data } } }) as never

  it('renames in place, keeps state and settlement, and ignores unknown or fork targets', async () => {
    const { lead } = await setup(() => textResponse('x'))
    appendAgent(lead.session, { action: 'created', id: 's1', name: 'core', role: 'core repo', cwd: '/w/core' })
    appendAgent(lead.session, { action: 'queued', id: 's1', name: 'core' })
    const before = rosterOf(lead)
    appendAgent(lead.session, { action: 'renamed', id: 's1', name: 'core-db', previousName: 'core', role: 'db layer of core', area: 'core' })
    const after = rosterOf(lead)
    expect(after.members).toEqual([{ id: 's1', name: 'core-db', kind: 'worker', state: 'queued', text: 'db layer of core', role: 'db layer of core', cwd: '/w/core', area: 'core', formerNames: ['core'] }])
    // A later lifecycle record keeps area and former names.
    appendAgent(lead.session, { action: 'started', id: 's1', name: 'core-db' })
    expect(rosterOf(lead).members[0]).toMatchObject({ state: 'started', area: 'core', formerNames: ['core'] })
    // A rename of nobody leaves the state as it is (same reference).
    expect(applyRoster(before, ev(999, { action: 'renamed', id: 'nobody', name: 'x' }))).toBe(before)
  })

  it('old logs and saved states without area or former names still fold and parse', () => {
    const old: Roster = { enabled: true, role: null, forkModel: null, members: [{ id: 's1', name: 'core', kind: 'worker', state: 'started', text: 'core repo', role: 'core repo' }], requests: [] }
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual(old)
    expect(rosterViewSchema.parse(rosterView(old)).members[0]).not.toHaveProperty('area')
    const folded = applyRoster(old, ev(1, { action: 'started', id: 's1', name: 'core' }))
    expect(folded.members[0]).not.toHaveProperty('area')
    expect(folded.members[0]).not.toHaveProperty('formerNames')
    expect(() => rosterSchema.parse({ ...old, members: [{ ...old.members[0], area: 3 }] })).toThrow(/member area/)
    expect(() => rosterSchema.parse({ ...old, members: [{ ...old.members[0], formerNames: ['a', 1] }] })).toThrow(/member formerNames/)
  })
})

describe('Agents page', () => {
  it('keeps workers of one area together and prefixes the area', () => {
    const rows = [
      { id: '1', name: 'hub-asr', area: 'hub' }, { id: '2', name: 'billing' }, { id: '3', name: 'hub-image', area: 'hub' }, { id: '4', name: 'docs' },
    ]
    expect(byArea(rows).map(r => r.name)).toEqual(['hub-asr', 'hub-image', 'billing', 'docs'])
    expect(subline({ id: '1', name: 'hub-asr', kind: 'worker', state: 'started', text: 'asr', role: 'asr', area: 'hub', cwd: '/w/hub__asr/' })).toBe('hub · hub__asr · asr')
  })
})

describe('fork notice', () => {
  it('says: coarse first, send when free, split on a collision with both sides renamed', () => {
    for (const rule of [
      'Workers start coarse and split only on a collision',
      'when that worker is idle and has no open requests, it goes by agent_send to that worker, no split',
      'agent_split with owner: <owner>, ownerName and ownerRole rewritten',
      'both concrete, never the area name again',
      'one worker for the whole repository or module',
      'inside an area prefer agent_split, which renames both sides',
    ]) expect(FORK_NOTICE).toContain(rule)
  })
})

describe('one rename, two entry points', () => {
  it('/agents rename keeps a split worker\'s area and role; a split after a plain rename keeps every old name', async () => {
    const { ctx, lead } = await setup(() => textResponse('ok'))
    const scheduler = install(ctx)
    await scheduler.createWorker(lead, { name: 'app', role: 'app repo' })
    const id = scheduler.ledgerOf(lead).find('app')!.id
    await vi.waitFor(async () => { expect((await stored(ctx, SessionId(id))).events.some(e => e.type === 'turn/end')).toBe(true) })
    await scheduler.rename(lead, 'app', 'mobile')
    await scheduler.split(lead, { owner: 'mobile', ownerName: 'mobile-ios', ownerRole: 'ios app', name: 'mobile-android', role: 'android app', task: 't' })
    expect(scheduler.ledgerOf(lead).find('mobile-ios')).toMatchObject({ formerNames: ['app', 'mobile'], area: 'mobile', role: 'ios app' })
    await scheduler.rename(lead, 'mobile-ios', 'ios')
    expect(scheduler.ledgerOf(lead).find('ios')).toMatchObject({ formerNames: ['app', 'mobile', 'mobile-ios'], area: 'mobile', role: 'ios app' })
    // agent_split runs in the dispatch lock: two at once on the same owner, one wins.
    const both = await Promise.allSettled([
      scheduler.split(lead, { owner: 'ios', ownerName: 'ios-ui', ownerRole: 'ui', name: 'ios-net', role: 'net', task: 't' }),
      scheduler.split(lead, { owner: 'ios', ownerName: 'ios-ui', ownerRole: 'ui', name: 'ios-net', role: 'net', task: 't' }),
    ])
    expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})
