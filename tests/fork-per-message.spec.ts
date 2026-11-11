/** Phase 2 Q2: each user message goes to a fresh fork identical to its session (design phase 2 §2). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { gate, setup, stored, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, listThen, until, user } from './support/scheduler.js'
import { testController } from './support/session-controller.js'
import { MemoryQueueStore, MessageQueue } from '../src/queue.js'
import { queueHost } from '../src/dsh/host/index.js'

afterEach(teardown)

const isFork = (o: GenerateOptions) => o.sessionId !== 'router'
const toolsOf = (o: GenerateOptions) => (o.tools ?? []).map(t => t.name).sort()
const systemOf = (o: GenerateOptions) => JSON.stringify(o.messages[0])
const called = (o: GenerateOptions, tool: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${tool}"`))
const brief = { goal: 'fix the crash', userWords: 'fix the crash', findings: [], constraints: [], nonGoals: [], acceptance: ['a test passes'], openQuestions: [] }

/** A session with 调度 on and session workers, as the rule mounts it. */
async function session(respond: (o: GenerateOptions) => ReturnType<typeof textResponse> | ReturnType<typeof toolCallResponse> | Promise<ReturnType<typeof textResponse>>, opts: { on?: boolean; capacity?: number } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'q2-ws-'))
  const { ctx, adapter } = await setup(respond, opts.capacity)
  const lead = (await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('router'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'lead-model' } } as never)).agent
  const controller = testController(ctx, { workspace })
  const queue = new MessageQueue(new MemoryQueueStore(), queueHost(ctx, controller.port, async id => stored(ctx, SessionId(id))))
  const scheduler = install(ctx, { defaultOn: opts.on ?? true, sessionWorkers: controller.port, queue })
  return { ctx, lead, adapter, scheduler }
}

const leadModelTexts = (adapter: { requests: GenerateOptions[] }) => adapter.requests.filter(r => r.sessionId === 'router').map(body)

describe('one fork per message (Q2)', () => {
  it('a fork copies the session: same tools, prompt section and model; no read-only pin', async () => {
    const { lead, adapter, scheduler } = await session(o => textResponse(isFork(o) ? 'FORK REPLY' : 'LEAD'), { on: false })
    lead.followup(user('warm up'))
    await lead.whenIdle()
    scheduler.setMode(lead, true)
    lead.followup(user('hello there'))
    await until(lead, 'Its reply to the user')
    const own = adapter.requests.find(r => r.sessionId === 'router')!
    const fork = adapter.requests.find(isFork)!
    expect(fork.model).toBe(own.model)
    expect(toolsOf(fork)).toEqual(toolsOf(own))
    const section = (o: GenerateOptions) => /# Agent Scheduler[^"]*/u.exec(systemOf(o))?.[0]
    expect(section(fork)).toBe(section(own))
    // The fork replays the session's completed turns.
    expect(body(fork)).toContain('warm up')
    // Access: nothing tells the fork it is read-only or routing-only (the old pin and allowlist are gone).
    expect(JSON.stringify(adapter.requests.filter(isFork).map(systemOf))).not.toMatch(/read-only shell|only route/iu)
  })

  it('answers directly when no work is needed: the reply reaches the session, which passes it on', async () => {
    const { lead, adapter } = await session(o => textResponse(isFork(o) ? 'It is 3 pm.' : 'LEAD RELAYED'))
    lead.followup(user('what time is it?'))
    await until(lead, 'Its reply to the user')
    const relay = leadModelTexts(adapter).find(b => b.includes('Its reply to the user'))!
    expect(relay).toContain('The user said: what time is it?')
    expect(relay).toContain('It is 3 pm.')
    // The session never reads the user's words directly, only through the fork's reply.
    expect(adapter.requests.filter(r => r.sessionId === 'router')).toHaveLength(1)
  })

  it('the session relays the fork\'s reply verbatim: every line, untouched, in the text it is given and in its own reply', async () => {
    const reply = 'Line one: `code` stays.\n\n- a bullet with **bold**\n- 中文也一字不差\n\n> quoted line\n   indented line   '
    const { lead, adapter } = await session(o => {
      if (isFork(o)) return textResponse(reply)
      // A model that follows the prompt passes the reply on as it is.
      const relay = body(o)
      const at = relay.indexOf('Its reply to the user:')
      return textResponse(at < 0 ? 'LEAD' : JSON.parse(`"${relay.slice(at + 'Its reply to the user:'.length).replace(/^\\n/u, '').split('\\n\\nDelegated')[0]!.replace(/"\}.*$/su, '')}"`))
    })
    lead.followup(user('format this'))
    await until(lead, 'Its reply to the user')
    // What the session is given holds the fork's text byte for byte.
    const given = lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => JSON.stringify(e.data)).find(t => t.includes('Its reply to the user'))!
    expect(JSON.parse(given).content[0].text.endsWith(`Its reply to the user:\n${reply}`)).toBe(true)
    // And the prompt tells the session to pass it on as it is.
    expect(leadModelTexts(adapter).join('')).toMatch(/pass that reply on to the user as your own answer, as it is/u)
  })

  it('the fork\'s reply is the tail of what the session gets, after any delegation note (nothing to strip when copying it)', async () => {
    const { lead } = await session(o => {
      if (o.sessionId === 'router') return textResponse('LEAD')
      if (body(o).includes('## Goal')) return textResponse('WORKER DONE')
      if (called(o, 'agent_create')) return textResponse('Handed to hub.\nSecond line.')
      return listThen(o, 'c1', 'agent_create', { name: 'hub', role: 'develops hub', brief })
    })
    lead.followup(user('fix the crash in hub'))
    await until(lead, 'Its reply to the user')
    const given = lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => (e.data as unknown as { content: Array<{ text?: string }> }).content[0]?.text ?? '').find(t => t.includes('Its reply to the user'))!
    expect(given.indexOf('Delegated, answers will come to you: r-1')).toBeLessThan(given.indexOf('Its reply to the user'))
    expect(given.endsWith('Its reply to the user:\nHanded to hub.\nSecond line.')).toBe(true)
  })

  it('hands off with a brief, then replies with a short confirmation; the worker\'s answer comes later', async () => {
    const { lead } = await session(o => {
      if (o.sessionId === 'router') return textResponse('LEAD')
      if (body(o).includes('## Goal')) return textResponse('WORKER DONE')
      if (called(o, 'agent_create')) return textResponse('Handed to hub.')
      return listThen(o, 'c1', 'agent_create', { name: 'hub', role: 'develops hub', brief })
    })
    lead.followup(user('fix the crash in hub'))
    await until(lead, 'Handed to hub.')
    await until(lead, '[reply to r-1 from hub')
  })

  it('swallows a subagent-finished notice about a fork: no lead turn, nothing visible', async () => {
    const { lead, adapter } = await session(o => textResponse(isFork(o) ? 'FORK REPLY' : 'LEAD'))
    lead.followup(user('hi'))
    await until(lead, 'Its reply to the user')
    const before = adapter.requests.filter(r => r.sessionId === 'router').length
    const forkId = forksOf(lead)[0]!
    lead.followup(createUserMessage({ content: [{ type: 'text', text: 'Background subagent finished' }], source: { kind: 'subagent-settled', senderSessionId: forkId } as never }))
    await new Promise(r => setTimeout(r, 300))
    await lead.whenIdle()
    expect(adapter.requests.filter(r => r.sessionId === 'router')).toHaveLength(before)
    expect(leadModelTexts(adapter).some(b => b.includes('Background subagent finished'))).toBe(false)
  })

  it('a fork that fails gives a short error reply, never silence', async () => {
    const { lead, adapter } = await session(o => {
      if (isFork(o)) throw new Error('provider refused')
      return textResponse('Sorry, that message was not handled.')
    })
    lead.followup(user('do something'))
    await until(lead, 'before replying')
    const relay = leadModelTexts(adapter).find(b => b.includes('before replying'))!
    expect(relay).toContain('The user said: do something')
    expect(relay).toMatch(/ended \((error|aborted)[^)]*\) before replying/u)
  })

  it('two messages in quick succession get a fork each, running side by side, each replied to', async () => {
    const hold = gate()
    const { lead } = await session(async o => {
      if (o.sessionId === 'router') return textResponse('LEAD')
      if (body(o).includes('first message')) await hold.promise
      return textResponse(body(o).includes('first message') ? 'REPLY ONE' : 'REPLY TWO')
    }, { capacity: 4 })
    lead.followup(user('first message'))
    await vi.waitFor(() => { expect(forksOf(lead)).toHaveLength(1) })
    lead.followup(user('second message'))
    await vi.waitFor(() => { expect(forksOf(lead)).toHaveLength(2) })
    await until(lead, 'REPLY TWO')
    hold.open()
    await until(lead, 'REPLY ONE')
    expect(new Set(forksOf(lead)).size).toBe(2)
  })

  it('two forks of one session cannot each create a worker for the same request', async () => {
    let made = 0
    const { lead, scheduler } = await session(o => {
      if (o.sessionId === 'router') return textResponse('LEAD')
      if (body(o).includes('## Goal')) return textResponse('OK')
      if (called(o, 'agent_create')) return textResponse('done')
      made += 1
      return listThen(o, `c${made}`, 'agent_create', { name: 'hub', role: 'develops hub', brief })
    }, { capacity: 4 })
    lead.followup(user('fix hub, part one'))
    lead.followup(user('fix hub, part two'))
    // Both replies may reach the session together, in one inbox message.
    await until(lead, 'The user said: fix hub, part one')
    await until(lead, 'The user said: fix hub, part two')
    const hubs = scheduler.ledgerOf(lead).state.members.filter(m => m.kind === 'worker' && m.name === 'hub')
    expect(hubs).toHaveLength(1)
  })

  it('with the switch off the session handles the message itself; no fork', async () => {
    const { lead, adapter } = await session(o => textResponse(isFork(o) ? 'FORK' : 'SELF'), { on: false })
    lead.followup(user('just me'))
    await lead.whenIdle()
    expect(forksOf(lead)).toHaveLength(0)
    expect(adapter.requests.filter(isFork)).toHaveLength(0)
    expect(leadModelTexts(adapter).some(b => b.includes('just me'))).toBe(true)
  })
})
