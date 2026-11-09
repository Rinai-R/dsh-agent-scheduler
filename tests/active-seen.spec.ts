/**
 * No review dots for the Session on screen: the mark is suppressed while its chat is the active
 * tab, and a report arriving there counts as read in the browser, so leaving does not light it up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewOf, unread, type ReviewFields } from '../src/review.js'
import { visibleChildren, type DockLayout } from '../src/client/layout.js'
import { autoSeenTargets, localSeen, type SeenCandidate } from '../src/client/active-seen.js'
import { applyRoster, EMPTY_ROSTER, rosterSchema } from '../src/projection.js'
import { reviewMarkOf, reviewSummary } from '../src/client/index.js'
import { SEEN_RECORD } from '../src/records.js'
import { ownFile } from './contract/probe.js'

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
    expect(autoSeenTargets(members, new Set())).toEqual([])
  })
})

describe('reads kept in the browser', () => {
  const memory = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } }

  it('a report seen on screen stays read after leaving, and the next report lights the row again', () => {
    const store = localSeen(memory())
    const w1 = { id: 'w1', reportedAt: 100 }
    store.mark('main', [w1])
    expect(reviewOf(store.apply('main', [w1])[0]!)).toBeUndefined()
    // A later report is unread again until it too is on screen.
    expect(reviewOf(store.apply('main', [{ id: 'w1', reportedAt: 200 }])[0]!)).toBe('reported')
    // Other main Sessions and members are untouched.
    expect(reviewOf(store.apply('other', [w1])[0]!)).toBe('reported')
    expect(reviewOf(store.apply('main', [{ id: 'w2', reportedAt: 100 }])[0]!)).toBe('reported')
  })

  it('persists across page loads, notifies once per change, and ignores repeats', () => {
    const storage = memory()
    const store = localSeen(storage)
    const calls: number[] = []
    store.subscribe(() => { calls.push(store.revision()) })
    store.mark('main', [{ id: 'w1', reportedAt: 100 }])
    store.mark('main', [{ id: 'w1', reportedAt: 100 }])
    store.mark('main', [{ id: 'w1', reportedAt: 100, seenAt: 150 }])
    expect(calls).toEqual([1])
    expect(JSON.parse(storage.data.get('dsh-agent-scheduler/seen/main')!)).toEqual({ w1: 100 })
    // A new page load reads it back.
    expect(reviewOf(localSeen(storage).apply('main', [{ id: 'w1', reportedAt: 100 }])[0]!)).toBeUndefined()
  })

  it('works without storage or with storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
    for (const store of [localSeen(), localSeen(broken)]) {
      store.mark('main', [{ id: 'w1', reportedAt: 100 }])
      expect(reviewOf(store.apply('main', [{ id: 'w1', reportedAt: 100 }])[0]!)).toBeUndefined()
    }
  })

  it('writes nothing to the session: the switch no longer runs a command for it', () => {
    const src = ownFile('src/client/index.tsx')
    const sw = src.slice(src.indexOf('export function createScheduleSwitch'), src.indexOf('export function createScheduleSwitch') + 6000)
    expect(sw).not.toMatch(/seenLine\(/u)
    expect(sw).not.toMatch(/deps\.run/u)
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
    // A collapsed column keeps docked chats mounted off screen: they are not in view; a float still is.
    expect([...visibleChildren({ ...two, expanded: false }, ['w1', 'w2'])]).toEqual([])
    expect([...visibleChildren({ ...floating, expanded: false }, ['w1'])]).toEqual(['w1'])
    // A member shown in two panes counts once.
    expect([...visibleChildren(layout([{ id: 'p1', tabs: ['w1'] }, { id: 'p2', tabs: ['w1'] }]), ['w1'])]).toEqual(['w1'])
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
