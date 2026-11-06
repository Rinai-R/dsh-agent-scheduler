/**
 * Host contract: every DSH service, export and behaviour the host adapter (src/dsh/host) relies
 * on, checked against the installed DSH runtime, not mocks. A failure names the dependency point
 * of docs/dsh-adapter.md it breaks; fix src/dsh/host, not the business modules.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as Agent from '@deepseek-ai/dsh-agent'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as SessionPkg from '@deepseek-ai/dsh-session'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Commands from '@deepseek-ai/dsh-commands'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { features, resetWarnings } from '../../src/dsh/compat.js'
import { isCapacity, isUserInput, missingRequired, relayMessage, settledSender, steerLead, subagentPort, toLead, turnEndOf } from '../../src/dsh/host/index.js'
import * as RulePlugin from '../../src/rule-plugin.js'
import { gate, setup, teardown } from '../support/harness.js'
import { textResponse } from '../support/mock-adapter.js'
import { installed } from './probe.js'

afterEach(async () => { await teardown(); features.reset(); resetWarnings() })

describe('host exports (H17, H18, H19, H20, H21, H9, H12)', () => {
  it('every value the adapter imports exists', () => {
    expect(typeof Agent.installModelSelection).toBe('function')
    expect(typeof Llm.createUserMessage).toBe('function')
    expect(typeof Llm.createDeveloperMessage).toBe('function')
    expect(typeof Llm.boundContextSummary).toBe('function')
    expect(typeof Llm.ReasoningEffortId).toBe('function')
    expect(typeof SessionPkg.appendPluginRecord).toBe('function')
    expect(typeof SessionPkg.pluginRecordOf).toBe('function')
    expect(typeof SessionPkg.SessionId).toBe('function')
    expect(typeof Subagent.finalAssistantOutput).toBe('function')
    expect(typeof Tools.defineTool).toBe('function')
    expect(typeof Commands.CommandDefinitionId).toBe('function')
  })
})

describe('host services (H1-H16, H22)', () => {
  it('a real composition offers everything scheduling requires, and the rule mounts on it', async () => {
    const { ctx } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    expect(missingRequired(ctx)).toEqual([])
    const errors: unknown[] = []
    ctx.on('internal/error' as never, ((error: unknown) => { errors.push(error) }) as never)
    await ctx.plugin(RulePlugin as never, {} as never)
    expect(errors).toEqual([])
    expect(Object.values(features.report()).every(Boolean)).toBe(true)
  })

  it('the projection registry reads schemas only through parse (H16)', () => {
    const code = installed('dsh-session-projection')
    expect(code).toMatch(/stateSchema\.parse\(/u)
    expect(code).toMatch(/viewSchema\.parse\(/u)
    expect(code).not.toMatch(/Schema\.(safeParse|parseAsync|_parse)\(/u)
  })
})

describe('subagents (H1, H2, H6, D1b, D2)', () => {
  it('a started child reports the id of its first message, and its settlement names it', async () => {
    const { ctx, lead } = await setup(() => textResponse('done'))
    const port = subagentPort(ctx.subagents)
    const settled: string[] = []
    ctx.on('agent/pre-step', async (payload, next) => {
      for (const m of payload.messages) { const s = settledSender(m); if (s !== undefined) settled.push(s) }
      return next()
    })
    const { messageId } = await port.startWorker(lead, { childId: 'session-contract-w', label: 'w', text: 'hello' })
    expect(typeof messageId).toBe('string')
    const child = ctx.agents.get('session-contract-w' as never)!
    await expect.poll(() => child.session.snapshotEvents().some(e => e.type === 'user/message' && String(e.data.id) === messageId)).toBe(true)
    await expect.poll(() => settled).toContain('session-contract-w')
  })

  it('the residency limit is refused with the code the scheduler waits on', async () => {
    const hold = gate()
    const { ctx, lead } = await setup(async () => { await hold.promise; return textResponse('x') }, 1)
    const port = subagentPort(ctx.subagents)
    await port.startWorker(lead, { childId: 'session-contract-a', label: 'a', text: 'a' })
    const refused = await port.startWorker(lead, { childId: 'session-contract-b', label: 'b', text: 'b' }).catch((e: unknown) => e)
    hold.open()
    expect(isCapacity(refused)).toBe(true)
    expect((refused as { code?: unknown }).code).toBe('ACTIVATION_LIMIT_REACHED')
  })

  it('a child stopped on the parent\'s authority ends its turn aborted, cause parent', async () => {
    const hold = gate()
    const { ctx, lead } = await setup(async () => { await hold.promise; return textResponse('x') })
    const port = subagentPort(ctx.subagents)
    await port.startWorker(lead, { childId: 'session-contract-i', label: 'i', text: 'work' })
    const child = ctx.agents.get('session-contract-i' as never)!
    await expect.poll(() => child.status).toBe('running')
    port.interrupt(lead, 'session-contract-i')
    hold.open()
    await expect.poll(() => child.session.snapshotEvents().some(e => e.type === 'turn/end')).toBe(true)
    const end = child.session.snapshotEvents().find(e => e.type === 'turn/end')!
    expect(turnEndOf(end)).toEqual({ kind: 'aborted', cause: 'parent' })
  })
})

describe('the lead inbox hand-over (H7b)', () => {
  it('followup queues a relay for the next turn and steer for the next step, and neither is a user message', async () => {
    const hold = gate()
    let held = false
    const { lead } = await setup(async () => { if (!held) { held = true; await hold.promise } return textResponse('X') })
    lead.followup(relayMessage('opening', 'w'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lead.status).toBe('running')
    toLead(lead, 'NEXT TURN', 'w')
    steerLead(lead, 'NEXT STEP', 'w')
    expect(lead.inbox.nextTurn.map(m => m.source.kind)).toEqual(['agent-message'])
    expect(lead.inbox.nextStep.map(m => m.source.kind)).toEqual(['agent-message'])
    // The scheduler hands its inbox over only as relays: never input a fork would take.
    expect([...lead.inbox.nextTurn, ...lead.inbox.nextStep].some(m => isUserInput(m))).toBe(false)
    hold.open()
    await lead.whenIdle()
    const said = lead.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => JSON.stringify(e.data))
    expect(said.some(t => t.includes('NEXT TURN'))).toBe(true)
    expect(said.some(t => t.includes('NEXT STEP'))).toBe(true)
  })
})
