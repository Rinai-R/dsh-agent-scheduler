/** The inbox section of the Agents page, rendered as a plain function (hooks stubbed). */
import { describe, expect, it, vi } from 'vitest'
import type { MailItem } from '../src/projection.js'

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (init: unknown) => [init, () => undefined] }))
const { INBOX_ROWS, InboxSection } = await import('../src/client/inbox.js')

/** Every element of a rendered tree, depth first. */
function nodes(node: unknown, out: Array<{ type: unknown; props: Record<string, unknown> }> = []): typeof out {
  if (Array.isArray(node)) { for (const n of node) nodes(n, out); return out }
  if (node === null || typeof node !== 'object' || !('props' in node)) return out
  const el = node as { type: unknown; props: Record<string, unknown> }
  out.push(el)
  nodes(el.props.children, out)
  return out
}
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: unknown } }).props.children)
  return ''
}

const item = (id: string, extra: Partial<MailItem> = {}): MailItem => ({ id, from: 's1', kind: 'reply', request: 'r-1', text: `[reply to r-1 from a]\nanswer ${id}`, at: 0, ...extra })
const base = { leadRunning: true, owed: [] as string[], nameOf: () => 'ibx-a', run: async () => null, open: () => undefined }

describe('lead inbox section', () => {
  it('shows each message with sender, request and its first line, in order, and folds past four', () => {
    const tree = InboxSection({ ...base, items: ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'].map(id => item(id, id === 'm-1' ? { pinned: true } : id === 'm-2' ? { held: true } : {})) })
    const all = nodes(tree)
    const rows = all.filter(n => n.props['data-mail'] !== undefined)
    expect(rows.map(r => r.props['data-mail'])).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    expect(rows).toHaveLength(INBOX_ROWS)
    expect(rows[1]!.props['data-held']).toBe('')
    const text = textOf(tree)
    expect(text).toContain('answer m-1')
    expect(text).toContain('ibx-a')
    expect(text).toContain('r-1')
    expect(text).not.toContain('[reply to')
    expect(all.find(n => n.props.className === 'sch-inbox-fold')).toBeDefined()
    // Every row can be pinned, held and handed over now.
    expect(all.filter(n => n.props['data-act'] === 'now')).toHaveLength(INBOX_ROWS)
  })

  it('says what the lead is doing when nothing waits', () => {
    const tree = InboxSection({ ...base, items: [], owed: ['r-5 ibx-a'], delivered: { count: 2, at: 1000, requests: ['r-3', 'r-4'] }, now: 2000 })
    const text = textOf(tree)
    expect(nodes(tree)[0]!.props['data-empty']).toBe('')
    expect(text).toContain('2')
    expect(text).toContain('r-5 ibx-a')
    // Long after the hand-over, or with the lead free, it does not claim the lead is on it.
    expect(textOf(InboxSection({ ...base, items: [], leadRunning: false, delivered: { count: 2, at: 1000, requests: [] }, now: 2000 }))).not.toMatch(/2/u)
  })
})
