/**
 * No review dots for the Session on screen: the mark is suppressed while its chat is the active
 * tab, and a report arriving there is recorded as seen (debounced), so leaving does not light it up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewOf, unread, type ReviewFields } from '../src/review.js'
import { visibleChildren, type DockLayout } from '../src/client/layout.js'
import { autoSeenTargets, seenScheduler, type SeenCandidate } from '../src/client/active-seen.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema } from '../src/projection.js'
import { reviewMarkOf, reviewSummary } from '../src/client/index.js'
import { SEEN_RECORD } from '../src/records.js'

const reported = (extra: Partial<ReviewFields> = {}): ReviewFields => ({ reportedAt: 100, ...extra })

describe('the Session on screen carries no dot', () => {
  it('suppresses every mark — report, failure and waiting prompt — and keeps them once it is not shown', () => {
    expect(reviewOf(reported(), false, true)).toBeUndefined()
    expect(reviewOf({ reportedAt: 100, reportFailed: true }, false, true)).toBeUndefined()
    expect(reviewOf(reported(), true, true)).toBeUndefined()
    // Off screen, exactly as before.
    expect(reviewOf(reported())).toBe('reported')
    expect(reviewOf({ reportedAt: 100, reportFailed: true })).toBe('failed')
    expect(reviewOf(reported(), true)).toBe('approval')
    // Seen stays seen on screen and off it.
    expect(reviewOf(reported({ seenAt: 200 }), false, true)).toBeUndefined()
    expect(reviewOf(reported({ seenAt: 200 }))).toBeUndefined()
  })

  it('an answer arriving after the user left marks the row again', () => {
    const member: ReviewFields = { reportedAt: 100, seenAt: 150 }
    const visible = new Set(['w1'])
    expect(unread(member)).toBe(false)
    expect(reviewOf(member, false, visible.has('w1'))).toBeUndefined()
    // Left the chat; a later report clears the seen mark in the fold (reported() drops seenAt).
    visible.delete('w1')
    const later = { reportedAt: 300 }
    expect(reviewOf(later, false, visible.has('w1'))).toBe('reported')
  })

  it('collects the visible unread members a seen record is due for, and skips a waiting prompt', () => {
    const members: SeenCandidate[] = [
      { id: 'w1', reportedAt: 100 },
      { id: 'w2', reportedAt: 100, seenAt: 200 },
      { id: 'w3', reportedAt: 100, reportFailed: true },
      { id: 'w4' },
    ]
    expect(autoSeenTargets(members, new Set(['w1', 'w2', 'w3', 'w4']))).toEqual(['w1', 'w3'])
    expect(autoSeenTargets(members, new Set(['w1', 'w3']), new Set(['w1']))).toEqual(['w3'])
    expect(autoSeenTargets(members, new Set())).toEqual([])
  })
})

describe('the seen write is debounced', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('writes once after the reports go quiet, not once per report', () => {
    const mark = vi.fn()
    const writes: string[][] = []
    const scheduler = seenScheduler(mark, 1000, ids => { writes.push([...ids]) })
    // A streaming round reporting three times.
    scheduler.note(['w1'])
    vi.advanceTimersByTime(400)
    scheduler.note(['w1'])
    vi.advanceTimersByTime(400)
    scheduler.note(['w1'])
    expect(mark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(mark).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(writes).toEqual([['w1']])
    expect(mark).toHaveBeenCalledTimes(1)
    expect(mark).toHaveBeenCalledWith('w1')
    // Nothing left to flush.
    vi.advanceTimersByTime(5000)
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('writes each member once per quiet period, flush writes what is pending, dispose drops it', () => {
    const mark = vi.fn()
    const scheduler = seenScheduler(mark, 1000)
    scheduler.note(['w1', 'w2'])
    scheduler.note(['w2', 'w3'])
    vi.advanceTimersByTime(1000)
    expect(mark.mock.calls.map(c => c[0]).sort()).toEqual(['w1', 'w2', 'w3'])
    mark.mockClear()
    scheduler.note(['w4'])
    scheduler.flush()
    expect(mark).toHaveBeenCalledWith('w4')
    mark.mockClear()
    scheduler.note(['w5'])
    scheduler.dispose()
    vi.advanceTimersByTime(5000)
    expect(mark).not.toHaveBeenCalled()
  })
})

describe('what is on screen', () => {
  const layout = (panes: Array<{ id: string; tabs: string[]; active?: string; host?: 'dock' | 'float' }>): DockLayout => {
    const tabs: Record<string, { id: string; kind: string; contentId: string }> = {}
    const nodes: Record<string, unknown> = {}
    for (const pane of panes) {
      for (const tab of pane.tabs) tabs[tab] = { id: tab, kind: 'subagentchat', contentId: `dsh-resource://subagentchat/session/${tab}?parent=lead&mode=continuable` }
      nodes[pane.id] = { kind: 'pane', id: pane.id, host: pane.host ?? 'dock', tabs: pane.tabs, activeTabId: pane.active ?? pane.tabs[0] }
    }
    nodes.root = { kind: 'split', id: 'root', axis: 'row', children: panes.map(p => p.id), sizes: panes.map(() => 1) }
    return { rootId: 'root', nodes: nodes as never, tabs }
  }

  it('finds the active chat of every docked or floating pane, and nothing for an inactive tab', () => {
    const one = layout([{ id: 'p1', tabs: ['w1'] }])
    expect([...visibleChildren(one, ['w1', 'w2'])]).toEqual(['w1'])
    // Two panes: the chat on the right is active, the roster and an old tab are not.
    const two = layout([{ id: 'p1', tabs: ['agents', 'w1'], active: 'agents' }, { id: 'p2', tabs: ['w1', 'w2'], active: 'w2' }])
    expect([...visibleChildren(two, ['w1', 'w2'])]).toEqual(['w2'])
    // A floating chat counts.
    const floating = layout([{ id: 'p1', tabs: ['agents'], active: 'agents' }, { id: 'p2', tabs: ['w1'], host: 'float' }])
    expect([...visibleChildren(floating, ['w1'])]).toEqual(['w1'])
    // A tab of something else is nobody's chat.
    expect([...visibleChildren(layout([{ id: 'p1', tabs: ['agents'] }]), ['w1'])]).toEqual([])
  })
})

describe('the Agents page and the composer badge agree', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind: 'worker' as const, state: 'started', text: id, ...extra })
  const rows = [row('w1', { reportedAt: 100 }), row('w2', { reportedAt: 100, reportFailed: true }), row('w3')]
  const statuses = new Map()

  it('hides the row mark and drops it from the badge counts while its chat is shown', () => {
    expect(reviewMarkOf(rows[0]!, statuses)).toBe('reported')
    expect(reviewMarkOf(rows[0]!, statuses, new Set(['w1']))).toBeUndefined()
    expect(reviewMarkOf(rows[1]!, statuses, new Set(['w1']))).toBe('failed')
    expect(reviewSummary(rows, statuses).n).toBe(2)
    expect(reviewSummary(rows, statuses, false, new Set(['w1']))).toEqual({ n: 1, tone: 'failed' })
    expect(reviewSummary(rows, statuses, true, new Set(['w1', 'w2']))).toEqual({ n: 0, tone: undefined })
    // Nothing visible: exactly today's behaviour.
    expect(reviewSummary(rows, statuses, false, new Set())).toEqual({ n: 2, tone: 'failed' })
  })
})

describe('the seen record itself', () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, ignorable: true, time: 100 + seq, data: { version: 1, ...data } }) as never
  const agent = (seq: number, id: string, name: string) => ev(seq, 'plugin:dsh-agent-scheduler/agent', { action: 'created', id, name, role: name })
  const request = (seq: number, id: string, action: 'sent' | 'answered', to: string) => ev(seq, 'plugin:dsh-agent-scheduler/request', { action, id, from: 'lead', to, ...(action === 'sent' ? { text: 'do it' } : { answer: 'ok' }) })

  it('one seen record per report: a repeated or stale write neither duplicates nor reorders', () => {
    // This is the client-side guard: auto-seen is only due while the member is unread, and the host
    // records a seen only for an unread member (scheduler.markSeen). The fold agrees.
    const base = [agent(1, 'w1', 'w1'), request(2, 'r-1', 'sent', 'w1'), request(3, 'r-1', 'answered', 'w1')].reduce(applyRoster, EMPTY_ROSTER)
    const seen = ev(4, SEEN_RECORD, { agent: 'w1' })
    const once = applyRoster(base, seen)
    expect(once.members[0]).toMatchObject({ reportedAt: 103, seenAt: 104 })
    // A second write for the same report changes nothing.
    expect(applyRoster(once, { ...(seen as object), seq: 5, time: 300 } as never)).toBe(once)
    // A later report clears the seen mark; a write then is a new state, not an old one revived.
    const again = applyRoster(applyRoster(applyRoster(once, request(6, 'r-2', 'sent', 'w1')), request(7, 'r-2', 'answered', 'w1')), { ...(seen as object), seq: 8, time: 400 } as never)
    expect(again.members[0]?.seenAt).toBe(400)
    expect(rosterSchema.parse(JSON.parse(JSON.stringify(again)))).toBeTruthy()
    // The seen write never reorders members.
    expect(again.members.map(m => m.id)).toEqual(['w1'])
  })
})
