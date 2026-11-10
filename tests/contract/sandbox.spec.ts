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
})
