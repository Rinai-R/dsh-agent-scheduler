/**
 * Contract S1–S2: the sandbox surface the fork's read-only pin relies on — the durable
 * `sandbox/mode` event and its canonical writer — plus the read-only mode's existence.
 */
import { describe, expect, it } from 'vitest'
import { installed } from './probe.js'

describe('sandbox policy (S1-S2)', () => {
  it('S1: keeps the sandbox/mode event and setSandboxMode as the write path', () => {
    const code = installed('dsh-sandbox-policy')
    expect(code).toMatch(/export \{[\s\S]*setSandboxMode[\s\S]*\}/u)
    expect(code).toMatch(/session\.append\("sandbox\/mode", \{ mode \}\)/u)
    // The mode vocabulary the pin writes is still there.
    expect(code).toMatch(/"read-only"/u)
  })

  it('S2: the resolved policy still folds the session\'s last sandbox/mode event', () => {
    const code = installed('dsh-sandbox-policy')
    expect(code).toMatch(/event\.type === "sandbox\/mode" \? event\.data\.mode : state/u)
  })

  it('S3: the read-only policy still tells the model it cannot modify files, and the sandbox still has no network policy', () => {
    const code = installed('dsh-sandbox-policy')
    expect(code).toMatch(/case "read-only": return "Current DSH file policy: read-only\. [^"]*cannot modify files/u)
    // The residual risk the guide documents: file effects only. If DSH ever adds a network
    // policy, this fails so the docs (and the fork guard's remote-write list) are revisited.
    const sandbox = installed('dsh-sandbox')
    expect(sandbox).not.toMatch(/networkPolicy|allowNetwork|network:\s*["']?(deny|none|off)/u)
  })

  it('S4: a tool guard still receives the call\'s parsed arguments (the fork remote-write check reads them)', async () => {
    const { setup, teardown } = await import('../support/harness.js')
    const { textResponse, toolCallResponse } = await import('../support/mock-adapter.js')
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    let calls = 0
    const { ctx, lead } = await setup(() => (calls++ === 0 ? toolCallResponse('c1', 'probe_tool', { command: 'git push origin' }) : textResponse('done')))
    try {
      ctx.tools.register(defineTool({ name: 'probe_tool', description: 'p', parameters: { command: { type: 'string' } }, output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] }, execute: async () => ({}) }) as never)
      const seen: unknown[] = []
      ctx.tools.guard((exec: { name: string; arguments?: unknown }) => { if (exec.name === 'probe_tool') seen.push(exec.arguments); return undefined })
      const { user, until } = await import('../support/scheduler.js')
      lead.followup(user('go'))
      await until(lead, 'go')
      await lead.whenIdle()
      expect(seen).toEqual([{ command: 'git push origin' }])
    } finally { await teardown() }
  })
})
