/**
 * Runtime wording the plugin reads or answers (T1-T4 in docs/dsh-adapter.md). None of it is
 * exported, so it is read from the shipped code, and the strip is checked on a real child.
 */
import { describe, expect, it } from 'vitest'
import { CAPACITY_CODE, DELEGATION_DEPTH_HINT, RELAY_PREFIX, RETURN_GUIDANCE, unwrapRelayed, withoutReturnGuidance } from '../../src/dsh/host/index.js'
import { FORK_NOTICE } from '../../src/scheduler.js'
import { forkRefusal } from '../../src/fork-guard.js'
import { fetched, installed, probesAvailable } from './probe.js'

describe('runtime wording', () => {
  it('T1: the return guidance appended to a continuable child\'s task still starts as the plugin strips it', () => {
    // dsh-subagent appends it (when the send_message tool is present) as
    // `Your parent agent id is ${JSON.stringify(parentId)}. Before you finish, send your result …`.
    const code = installed('dsh-subagent')
    expect(code).toMatch(/Your parent agent id is \$\{encodedParentId\}/u)
    expect(code).toMatch(/encodedParentId = JSON\.stringify\(/u)
    const guidance = `Your parent agent id is ${JSON.stringify('session-parent')}. Before you finish, send your result to that agent with send_message(...).`
    expect(RETURN_GUIDANCE.test(guidance)).toBe(true)
    const message = { id: 'm1', content: [{ type: 'text', text: 'task' }, { type: 'text', text: guidance }], source: { kind: 'user' } } as never
    expect(withoutReturnGuidance(message)?.content).toEqual([{ type: 'text', text: 'task' }])
  })

  it('T2: a message relayed into a child is prefixed as the plugin unwraps it', () => {
    const code = installed('dsh-subagent')
    expect(code).toMatch(/`Agent \$\{[^}]+\} sent a message: `/u)
    expect(unwrapRelayed('Agent session-1 sent a message: [request r-1 from lead]')).toBe('[request r-1 from lead]')
    expect(RELAY_PREFIX.test('Agent x sent a message: y')).toBe(true)
  })

  it('T4/H6: the residency limit carries the code the scheduler waits on', () => {
    expect(installed('dsh-subagent')).toContain(`'${CAPACITY_CODE}'`)
  })

  it.runIf(probesAvailable())('T3: the delegation-depth context still tells children what FORK_NOTICE answers', () => {
    expect(fetched('dsh-tool-subagent')).toContain(DELEGATION_DEPTH_HINT)
    expect(FORK_NOTICE).toContain(DELEGATION_DEPTH_HINT)
    expect(forkRefusal('fork-1', 'bash')).toContain(DELEGATION_DEPTH_HINT)
  })
})
