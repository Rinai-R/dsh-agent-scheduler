/**
 * Contract P1–P3: the permission-preset surface the access picker depends on (src/dsh/host/access.ts),
 * plus the delegation rule that makes a child read `custom` until it is given a preset.
 */
import { describe, expect, it } from 'vitest'
import { installed, probesAvailable } from './probe.js'

describe('permission presets (P1-P3)', () => {
  it('P1: the service still offers names, current, set and resolve', () => {
    const code = installed('dsh-permission-presets')
    expect(code).toMatch(/get names\(\)/u)
    expect(code).toMatch(/current\(session\)/u)
    expect(code).toMatch(/\bset\(session, name\)/u)
    expect(code).toMatch(/resolve\(name\)/u)
    // The write path stays: a preset records itself and each changed knob through its own setter.
    expect(code).toMatch(/permission\/preset/u)
    expect(code).toMatch(/setSandboxMode\(/u)
    expect(code).toMatch(/setApprovalPolicy\(/u)
  })

  it('P2: full-text of the service names the two internal setters the preset bundles', () => {
    const code = installed('dsh-permission-presets')
    expect(code).toContain('@deepseek-ai/dsh-sandbox-policy')
    expect(code).toContain('@deepseek-ai/dsh-user-approval')
  })

  it.skipIf(!probesAvailable())('P3: delegation still pins a child\'s approval policy to never (hence custom)', () => {
    const code = installed('dsh-subagent')
    const capture = /function captureDelegatedPolicyOverrides\(parent\)\s*\{[\s\S]*?\n\}/u.exec(code)?.[0] ?? ''
    expect(capture).toContain('approvalPolicy')
    expect(capture).toMatch(/never/u)
    // The delegation events land on the child log with source delegation.
    expect(code).toMatch(/source: "delegation"/u)
  })
})
