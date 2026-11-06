/** A worker's team on the Agents page, rendered as a plain function (hooks stubbed). */
import { describe, expect, it, vi } from 'vitest'
import type { TeamView } from '../src/projection.js'
import { applyRoster, EMPTY_ROSTER, rosterView, rosterViewSchema } from '../src/projection.js'
import { TEAM_RECORD } from '../src/records.js'

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (init: unknown) => [init === false ? true : init, () => undefined] }))
const { TeamBlock, teamSummary } = await import('../src/client/team.js')

function texts(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(texts).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) return texts((node as { props: { children?: unknown } }).props.children)
  return ''
}
const team: TeamView = {
  members: [{ id: 'c1', name: 'helper', description: 'computes', status: 'running' }, { id: 'c2', name: 'docs', description: 'writes', status: 'inactive' }],
  tasks: [
    { id: 'task-1', subject: 'compute', status: 'in_progress', owner: 'helper', blockedBy: [] },
    { id: 'task-2', subject: 'write up', status: 'pending', blockedBy: ['task-1'] },
    { id: 'task-3', subject: 'old', status: 'deleted', blockedBy: [] },
  ],
}

describe('team view', () => {
  it('sums up members and tasks, and shows who works on what', () => {
    expect(teamSummary(team)).toMatch(/2.*0\/2/u)
    const text = texts(TeamBlock({ team, owner: 'w1', open: () => undefined }))
    expect(text).toContain('helper')
    expect(text).toContain('task-1 · compute')
    expect(text).toContain('write up')
    expect(text).not.toContain('old')
  })

  it('the roster folds the copy the host writes, and the view carries it', () => {
    const ev = { seq: 1, type: TEAM_RECORD, ignorable: true, time: 1, data: { version: 1, owner: 'w1', ...team } } as never
    const state = applyRoster(EMPTY_ROSTER, ev)
    expect(state.teams?.w1?.members).toHaveLength(2)
    // The same copy again changes nothing.
    expect(applyRoster(state, { ...(ev as object), seq: 2 } as never)).toBe(state)
    expect(rosterViewSchema.parse(JSON.parse(JSON.stringify(rosterView(state)))).teams?.w1?.tasks).toHaveLength(3)
  })
})
