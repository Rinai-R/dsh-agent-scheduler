/**
 * The Agents page must not bring the merged-from link back: a survivor row shows only its own
 * row (docs/merge-recall.md §7). The data stays (agent_list, agent_recall); the shortcut is gone.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  memo: (fn: unknown) => fn,
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useState: (init: unknown) => [init, () => undefined],
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}))
vi.mock('../src/client/i18n.js', async (original) => ({ ...await original<typeof import('../src/client/i18n.js')>(), useLocale: () => undefined }))

const { createAgentsPage } = await import('../src/client/index.js')

/** Every element of a rendered tree, depth first. */
function elements(node: unknown, out: Array<{ type: unknown; props: Record<string, unknown> }> = []): typeof out {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out }
  if (node === null || typeof node !== 'object' || !('props' in node)) return out
  const el = node as { type: unknown; props: Record<string, unknown> }
  out.push(el)
  elements(el.props.children, out)
  return out
}

function texts(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(texts).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) return texts((node as { props: { children?: unknown } }).props.children)
  return ''
}

/** A viewed roster: a survivor that absorbed `hub-image`, and one live worker. */
const roster = {
  enabled: false,
  role: null,
  forkModel: null,
  workerModel: null,
  members: [
    { id: 'B', name: 'hub', kind: 'worker', state: 'started', text: 'hub', role: 'hub', mergedFrom: [{ merge: 'mg-1', name: 'hub-image', session: 'session-A', at: 1 }] },
    { id: 'C', name: 'docs', kind: 'worker', state: 'started', text: 'docs', role: 'docs' },
    { id: 'A', name: 'hub-image', kind: 'worker', state: 'archived', text: 'hub-image', mergedInto: 'B' },
  ],
  openRequests: [],
  inbox: [],
}

describe('the merged-from link is gone', () => {
  it('renders the survivor row with nothing extra, and no merged-from element or text', () => {
    const AgentsPage = createAgentsPage({ chatAddress: () => 'dsh-resource://subagentchat/session/x' })
    const tree = (AgentsPage as unknown as (props: Record<string, unknown>) => unknown)({
      sessionId: 'lead',
      useProjection: () => roster,
      useSessionStatus: () => new Map(),
      useTabInfo: () => undefined,
    })
    const all = elements(tree)
    expect(all.some(el => el.props['data-scheduler-merged-from'] !== undefined)).toBe(false)
    expect(all.some(el => String(el.props.className ?? '').includes('merged'))).toBe(false)
    const text = texts(tree)
    expect(text).not.toContain('合并自')
    expect(text).not.toContain('merged from')
    expect(text).not.toContain('↶')
    // The survivor's own row is still drawn.
    expect(text).toContain('hub')
    expect(text).toContain('docs')
  })
})
