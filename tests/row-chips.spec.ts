/** A quiet agent row: one meta line at most, the card owns the highlight, and the meta rules. */
import { afterEach, describe, expect, it } from 'vitest'
import { hasMeta, rowMeta } from '../src/client/row-meta.js'
import { setLanguage, LANGS } from '../src/i18n/index.js'
import { ownFile } from './contract/probe.js'

afterEach(() => { setLanguage('zh') })

const worker = (over: Partial<{ kind: 'worker' | 'fork'; state: string; accessPreset?: string }> = {}) => ({ kind: 'worker' as const, state: 'idle', ...over })

describe('the meta line only says what differs from the default', () => {
  it('a plain worker on the lead\'s access mode shows nothing at all', () => {
    expect(rowMeta({ member: worker({ accessPreset: 'workspace-write' }), accessDefault: 'workspace-write' })).toEqual({})
    expect(hasMeta(rowMeta({ member: worker() }))).toBe(false)
    expect(hasMeta(rowMeta({ member: worker({ accessPreset: 'read-only' }) }))).toBe(true)
  })

  it('adds the team count and a non-default access mode, localized', () => {
    setLanguage('zh')
    expect(rowMeta({ member: worker(), teamMembers: 3 })).toEqual({ team: '团队 3' })
    expect(rowMeta({ member: worker({ accessPreset: 'read-only' }), accessDefault: 'workspace-write' })).toEqual({ access: '仅可查看' })
    expect(rowMeta({ member: worker({ accessPreset: 'danger-full-access' }), teamMembers: 1, accessDefault: 'workspace-write' })).toEqual({ team: '团队 1', access: '完全权限' })
    setLanguage('en')
    expect(rowMeta({ member: worker({ accessPreset: 'danger-full-access' }), teamMembers: 2, accessDefault: 'workspace-write' })).toEqual({ team: 'Team 2', access: 'Full access' })
  })

  it('keeps archived and fork rows quiet', () => {
    expect(rowMeta({ member: worker({ state: 'archived', accessPreset: 'read-only' }), accessDefault: 'workspace-write' })).toEqual({})
    expect(rowMeta({ member: { kind: 'fork', state: 'done', accessPreset: 'read-only' }, accessDefault: 'workspace-write' })).toEqual({})
  })

  it('every dictionary has the team badge', () => {
    const zh = ownFile('src/i18n/zh.ts')
    expect(zh).toContain("'row.teamBadge'")
    for (const lang of LANGS) {
      setLanguage(lang)
      expect(rowMeta({ member: worker(), teamMembers: 1 }).team, lang).toBeTruthy()
    }
  })
})

describe('the row card owns the highlight and the meta line', () => {
  const css = ownFile('src/client/index.tsx')
  const team = ownFile('src/client/team.tsx')

  it('puts the selected and hover background on the whole card, not the inner button', () => {
    expect(css).toMatch(/\.sch-roster-item\{[^}]*margin:1px 8px[^}]*border-radius:10px/u)
    expect(css).toMatch(/\.sch-roster-item\[data-selected=yes\]\{background:/u)
    expect(css).toMatch(/\.sch-roster-item:hover\{background:/u)
    // The row is a full-width grid inside the card; no inset margin of its own.
    expect(css).toMatch(/\.sch-roster-row\{[^}]*margin:0[^}]*padding:8px 10px[^}]*border-radius:10px/u)
    expect(css).not.toMatch(/\.sch-roster-row\[data-selected=yes\]/u)
    expect(css).not.toMatch(/\.sch-roster-row:hover\{background/u)
    // The old inset width rule is gone, and the item carries the selection attribute.
    expect(css).not.toContain('width:calc(100% - 16px)')
    expect(css).toContain("data-selected={member.id === selected ? 'yes' : 'no'}")
  })

  it('draws at most one muted meta line under the row, holding the team toggle and the access note', () => {
    expect(css).toMatch(/\.sch-roster-meta\{[^}]*display:flex[^}]*margin:0 12px 6px 27px/u)
    expect(css).toContain('className="sch-roster-meta"')
    expect(css).toContain('data-scheduler-team-toggle')
    expect(css).toContain('data-scheduler-row-access')
    // No second always-visible line: the old standalone block and its styles are gone.
    expect(css).not.toContain('className="sch-roster-access"')
    expect(css).not.toMatch(/\.sch-roster-access\{/u)
    // The team toggle moved into the meta line, and the per-row access picker is gone.
    expect(team).toContain('.sch-roster-team-toggle{border:0')
    expect(team).not.toContain('.sch-roster-item[data-team]')
    expect(css).not.toContain('data-scheduler-row-access={member.name}>\n            <AccessPicker')
  })

  it('keeps the row actions on the row line, not centred in the taller card', () => {
    expect(css).toMatch(/\.sch-roster-archive,\.sch-roster-rename\{[^}]*top:26px/u)
    expect(css).toMatch(/\.sch-roster-merge\{[^}]*top:26px/u)
    expect(ownFile('src/client/fork.tsx')).toMatch(/\.sch-roster-fork\{[^}]*top:26px/u)
  })

  it('keeps the team list expandable from the meta line and the access in the chat', () => {
    expect(css).toContain("onClick={() => { setTeamsOpen(")
    expect(css).toContain('{hasTeam && teamsOpen.has(member.id) ? <TeamBlock')
    // The working access control still lives in the worker's own chat footer.
    expect(css).toContain("registerSlot(ctx, 'inputLeft', { id: 'agent-scheduler-access'")
    expect(css).toContain('createMemberAccessPicker')
  })
})
