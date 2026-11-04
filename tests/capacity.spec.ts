/** Capacity detection: only the runtime's slot guard is retried, not a real failure. */
import { describe, expect, it } from 'vitest'
import { isCapacity } from '../src/scheduler.js'

describe('capacity detection', () => {
  it('recognizes the start and delivery guards by code and message', () => {
    expect(isCapacity(Object.assign(new Error('subagent limit reached (active child limit: 8)'), { code: 'ACTIVATION_LIMIT_REACHED' }))).toBe(true)
    expect(isCapacity(Object.assign(new Error('subagent follow-up is temporarily unavailable'), { code: 'subagent/delivery-unavailable' }))).toBe(true)
    expect(isCapacity(new Error('subagent "x" already exists'))).toBe(false)
    expect(isCapacity('whatever')).toBe(false)
  })
})
