/** Capacity detection: only the runtime's slot guard is retried, not a real failure. */
import { describe, expect, it } from 'vitest'
import { isCapacity } from '../src/scheduler.js'

describe('capacity detection', () => {
  it('retries only the residency limit, never persistence or authority failures', () => {
    expect(isCapacity(Object.assign(new Error('subagent limit reached (active child limit: 8)'), { code: 'ACTIVATION_LIMIT_REACHED' }))).toBe(true)
    expect(isCapacity(new Error('subagent limit reached (active child limit: 1)'))).toBe(true)
    // The remote wrapper folds persistence and draining failures into this code; in process they are real errors.
    expect(isCapacity(Object.assign(new Error('subagent follow-up is temporarily unavailable'), { code: 'subagent/delivery-unavailable' }))).toBe(false)
    expect(isCapacity(Object.assign(new Error('persistence down'), { code: 'PERSISTENCE_UNAVAILABLE' }))).toBe(false)
    expect(isCapacity(new Error('subagent "x" already exists'))).toBe(false)
    expect(isCapacity('whatever')).toBe(false)
  })
})
