/**
 * The user forks a worker (`/agents fork`, the Agents page's 「Fork…」, 「Fork this worker」 in its
 * chat): a new worker of its own. Regression for the report that a "forked worker" landed in the
 * main conversation: the only fork there was DSH's own 「branch into a new conversation」, which
 * makes a detached top-level Session. These pin that the scheduler's fork is a child of the main
 * Session with its own row, chat address and seed, and that nothing of it enters the lead's chat.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setup, stored, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { body, install, until } from './support/scheduler.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema } from '../src/projection.js'
import { parseFork, runAgentsCommand } from '../src/rule-plugin.js'

afterEach(teardown)

const isWorker = (name: string) => (o: GenerateOptions) => body(o).includes(`You are worker \\"${name}\\"`)
const userText = (events: readonly { type: string; data: unknown }[]) => events.filter(e => e.type === 'user/message' || e.type === 'assistant/message').map(e => JSON.stringify(e.data)).join('\n')

async function withHub() {
  const { ctx, lead, adapter } = await setup(o => {
    if (o.sessionId === 'lead') return textResponse('LEAD')
    if (isWorker('hub-image')(o)) return textResponse('IMAGE ANSWER')
    if (isWorker('hub')(o)) return textResponse('HUB SECRET DETAIL: the cache key is per-tenant')
    return textResponse('OTHER')
  })
  const scheduler = install(ctx, { defaultOn: false })
  const dir = mkdtempSync(join(tmpdir(), 'hub-'))
  await scheduler.createWorker(lead, { name: 'hub', role: 'develops hub', cwd: dir, task: 'warm up' })
  await until(lead, '[reply to r-1 from hub]')
  await lead.whenIdle()
  const run = (line: string) => runAgentsCommand(scheduler, { agent: lead, rawInput: line } as never)
  return { ctx, lead, adapter, scheduler, dir, run }
}

describe('/agents fork', () => {
  it('makes a worker of its own: a child of the main Session, its own row and seed, nothing in the lead\'s chat', async () => {
    const { ctx, lead, scheduler, run } = await withHub()
    const leadBefore = userText(lead.session.snapshotEvents())
    const cwd = mkdtempSync(join(tmpdir(), 'hub-image-'))
    const out = await run(`fork hub hub-image --role fixes gpt_image --task fix image --cwd ${cwd}`)
    expect(out).toMatchObject({ kind: 'success' })
    expect((out as { text: string }).text).toMatch(/hub-image/u)
    const ledger = scheduler.ledgerOf(lead)
    const forked = ledger.find('hub-image')!
    const hub = ledger.find('hub')!
    // Its own row: a worker, made by the user, continuing hub, in its own directory. hub is unchanged.
    expect(forked).toMatchObject({ kind: 'worker', role: 'fixes gpt_image', from: hub.id, cwd, createdVia: 'user' })
    expect(hub.name).toBe('hub')
    await until(lead, '[reply to r-2 from hub-image]')
    // Its own Session, a direct child of the main Session, seeded with hub's conversation.
    const own = await stored(ctx, SessionId(forked.id))
    const handle = await ctx.sessionPersistence.open(SessionId(forked.id), 'read')
    try {
      expect(handle.header.parentSession).toBe(lead.id)
      expect(handle.header.isSeeded).toBe(true)
    } finally { await handle.close() }
    expect(own.inherited).toBeGreaterThan(0)
    expect(userText(own.events.slice(0, own.inherited))).toContain('HUB SECRET DETAIL')
    expect(userText(own.events.slice(own.inherited))).toContain('fix image')
    // The lead's catalog lists it as its child; its chat is addressed by (main, child).
    expect(lead.session.snapshotEvents().some(e => e.type === 'subagent/catalog' && (e.data as { childId: string }).childId === forked.id)).toBe(true)
    // Nothing of the fork's seed or its own conversation entered the lead's model-visible chat
    // except the reply it was asked for.
    const leadAfter = userText(lead.session.snapshotEvents()).slice(leadBefore.length)
    expect(leadAfter).not.toContain('HUB SECRET DETAIL')
    expect(leadAfter).not.toContain('You are worker')
    // The roster carries "made by the user" through a restart (schema round trip).
    const folded = lead.session.snapshotEvents().reduce(applyRoster, EMPTY_ROSTER)
    const reread = rosterSchema.parse(JSON.parse(JSON.stringify(folded)))
    expect(reread.members.find(m => m.id === forked.id)?.createdVia).toBe('user')
  })

  it('the fork runs on its owner\'s model, and in its owner\'s access mode unless that is wider than the user\'s', async () => {
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'W'))
    const MODES = [
      { name: 'read-only', sandbox: 'read-only', approval: 'ask' as const },
      { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' as const },
      { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' as const },
    ]
    let userMode = 'workspace-write'
    const applied: Array<{ session: object; name: string }> = []
    const access = { available: true, modes: () => MODES, current: () => userMode, set: (session: object, name: string) => { applied.push({ session, name }) } }
    const scheduler = install(ctx, { defaultOn: false, access })
    const dir = mkdtempSync(join(tmpdir(), 'hub-'))
    await scheduler.createWorker(lead, { name: 'hub', role: 'develops hub', cwd: dir, task: 'warm up', model: { provider: 'mock', model: 'owner-model' } })
    await until(lead, '[reply to r-1 from hub]')
    await lead.whenIdle()
    // The owner was narrowed to read-only by the user.
    scheduler.setMemberAccess(lead, { name: 'hub', preset: 'read-only', by: 'user' })
    const run = (line: string) => runAgentsCommand(scheduler, { agent: lead, rawInput: line } as never)
    expect(await run(`fork hub hub-a --cwd ${mkdtempSync(join(tmpdir(), 'hub-a-'))}`)).toMatchObject({ kind: 'success' })
    const a = scheduler.ledgerOf(lead).find('hub-a')!
    expect(a.model).toBe('mock/owner-model')
    // The created hook (not wired in this harness) adopts the access mode.
    const adopt = (id: string) => { scheduler.adoptMemberAccess({ id, session: { header: { parentSession: lead.id } } } as never) }
    adopt(a.id)
    expect(scheduler.ledgerOf(lead).find('hub-a')).toMatchObject({ accessPreset: 'read-only', accessBy: 'inherited' })
    // An owner on full access while the user is on workspace-write: the fork gets the user's mode.
    userMode = 'danger-full-access'
    scheduler.setMemberAccess(lead, { name: 'hub', preset: 'danger-full-access', by: 'user' })
    userMode = 'workspace-write'
    expect(await run(`fork hub hub-b --cwd ${mkdtempSync(join(tmpdir(), 'hub-b-'))}`)).toMatchObject({ kind: 'success' })
    adopt(scheduler.ledgerOf(lead).find('hub-b')!.id)
    expect(scheduler.ledgerOf(lead).find('hub-b')?.accessPreset).toBe('workspace-write')
  })

  it('with --owner-name it is a split: the owner is renamed and keeps its work, both share the area', async () => {
    const { lead, scheduler, run } = await withHub()
    const cwd = mkdtempSync(join(tmpdir(), 'hub-image-'))
    const out = await run(`fork hub hub-image --role fixes gpt_image --cwd ${cwd} --owner-name hub-asr --owner-role smoke-tests ASR`)
    expect(out).toMatchObject({ kind: 'success' })
    const ledger = scheduler.ledgerOf(lead)
    expect(ledger.find('hub-asr')).toMatchObject({ role: 'smoke-tests ASR', area: 'hub' })
    expect(ledger.find('hub-image')).toMatchObject({ area: 'hub', createdVia: 'user' })
    // The old name now says which way it went, as for agent_split.
    expect(ledger.splitHint('hub')).toMatch(/hub-asr.*hub-image|hub-image.*hub-asr/u)
  })

  it('refuses what agent_split / agent_create from refuse, with the reason', async () => {
    const { ctx, lead, scheduler, run } = await withHub()
    // The owner has a directory: the fork needs its own.
    expect(await run('fork hub hub-image')).toMatchObject({ kind: 'error', text: expect.stringMatching(/cwd/u) })
    // No such worker; a taken name.
    expect(await run('fork nobody x')).toMatchObject({ kind: 'error' })
    const cwd = mkdtempSync(join(tmpdir(), 'x-'))
    expect(await run(`fork hub hub --cwd ${cwd}`)).toMatchObject({ kind: 'error' })
    // An owner whose only round left a message it has not taken cannot seed cleanly.
    const fresh = await scheduler.createWorker(lead, { name: 'fresh', role: 'r' })
    expect(await run(`fork fresh fresh-2`)).toMatchObject({ kind: 'error', text: expect.stringMatching(/has not completed a round|leaves a message/u) })
    void ctx; void fresh
    // Usage.
    expect(await run('fork hub')).toMatchObject({ kind: 'error' })
    expect(await run('fork hub x --repo /tmp')).toMatchObject({ kind: 'error' })
    // Only the user (the main Session) forks this way.
    const hubAgent = { id: scheduler.ledgerOf(lead).find('hub')!.id, session: { header: { parentSession: lead.id } } }
    await expect(scheduler.forkWorker(hubAgent as never, { owner: 'hub', name: 'y' })).rejects.toThrow()
  })

  it('creates the worktree from the owner\'s current commit, and refuses an existing path or branch', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const repo = mkdtempSync(join(tmpdir(), 'owner-repo-'))
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'a'), '1')
    git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first')
    git(repo, 'branch', 'taken')
    // The owner has moved on: a commit origin/main (absent here) and the first commit do not have.
    writeFileSync(join(repo, 'a'), '2')
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'owner work')
    const ownerHead = git(repo, 'rev-parse', 'HEAD')
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'W'))
    const scheduler = install(ctx, { defaultOn: false })
    await scheduler.createWorker(lead, { name: 'owner', role: 'r', cwd: repo, task: 'warm up' })
    await until(lead, '[reply to r-1 from owner]')
    await lead.whenIdle()
    const run = (line: string) => runAgentsCommand(scheduler, { agent: lead, rawInput: line } as never)
    // What the form submits: --base HEAD in the owner's checkout.
    const wt = join(tmpdir(), `fork-wt-${Date.now()}`)
    expect(await run(`fork owner owner-2 --cwd ${wt} --repo ${repo} --branch feat/owner-2 --base HEAD`)).toMatchObject({ kind: 'success' })
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(ownerHead)
    // An existing path, or a branch that exists, is refused with git's reason.
    expect(await run(`fork owner owner-3 --cwd ${wt} --repo ${repo} --branch feat/owner-3 --base HEAD`)).toMatchObject({ kind: 'error' })
    expect(await run(`fork owner owner-4 --cwd ${wt}-b --repo ${repo} --branch taken --base HEAD`)).toMatchObject({ kind: 'error' })
    expect(scheduler.ledgerOf(lead).find('owner-3')).toBeUndefined()
    expect(scheduler.ledgerOf(lead).find('owner-4')).toBeUndefined()
  })

  it('parses flags whose values have spaces', () => {
    expect(parseFork('hub hub-image --role fixes the image path --task make it fast --cwd /w/x --repo /w/hub --branch feat/x --owner-name hub-asr --owner-role ASR only')).toEqual({
      owner: 'hub', name: 'hub-image', role: 'fixes the image path', task: 'make it fast', cwd: '/w/x', worktree: { repo: '/w/hub', branch: 'feat/x' }, ownerName: 'hub-asr', ownerRole: 'ASR only',
    })
    expect(typeof parseFork('hub')).toBe('string')
    expect(typeof parseFork('hub x --what y')).toBe('string')
    expect(typeof parseFork('hub x --role')).toBe('string')
  })
})

describe('fork after a restart', () => {
  it('a forked worker comes back as a worker of the main Session, made by the user', async () => {
    const { ctx, lead, scheduler, run } = await withHub()
    const cwd = mkdtempSync(join(tmpdir(), 'hub-image-'))
    await run(`fork hub hub-image --cwd ${cwd} --task fix image`)
    await until(lead, '[reply to r-2 from hub-image]')
    await lead.whenIdle()
    const forkedId = scheduler.ledgerOf(lead).find('hub-image')!.id
    // What a restart rebuilds: the roster from the stored log alone.
    await vi.waitFor(async () => {
      const log = await stored(ctx, SessionId(lead.id))
      const folded = rosterSchema.parse(JSON.parse(JSON.stringify(log.events.reduce(applyRoster, EMPTY_ROSTER))))
      expect(folded.members.find(m => m.id === forkedId)).toMatchObject({ kind: 'worker', name: 'hub-image', createdVia: 'user' })
    }, { timeout: 5000 })
    scheduler.forget(lead.id)
    expect(scheduler.ledgerOf(lead).find('hub-image')).toMatchObject({ createdVia: 'user' })
    // The fork's own Session is released (as on shutdown) and comes back cold on the next request,
    // as itself: the seed is not consulted again.
    const child = ctx.agents.get(SessionId(forkedId))
    if (child !== undefined) { await child.whenIdle(); child.cancel({ kind: 'disposed' }) }
    await vi.waitFor(() => { expect(ctx.agents.get(SessionId(forkedId))).toBeUndefined() })
    await scheduler.send(lead, 'hub-image', 'one more')
    await until(lead, '[reply to r-3 from hub-image]')
    const own = await stored(ctx, SessionId(forkedId))
    expect(userText(own.events.slice(own.inherited))).toContain('one more')
  })
})
