/** The shared model menu: rows, search, placement. Rendering is covered by the GUI run. */
import { describe, expect, it } from 'vitest'
import { catalogModel, effectiveEffort, effortLabel, effortRows, fuzzyMatch, menuSections, placeMenu, sameChoice, sameModel } from '../src/client/model-menu.js'

const groups = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } }, { id: 'pro', name: 'DeepSeek-V4-Pro' }] },
  { id: 'glm-anthropic', name: 'GLM Gateway (Anthropic Messages)', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'glm-5', name: 'GLM-5' }] },
  { id: 'magpie', name: 'Magpie', models: [{ id: 'm1', name: 'Magpie One' }] },
]

describe('model menu', () => {
  it('pins the default row first, then one section per provider', () => {
    const sections = menuSections(groups, { defaultLabel: '同 lead（默认）' })
    expect(sections.map(s => s.title)).toEqual([undefined, 'DeepSeek', 'GLM Gateway (Anthropic Messages)', 'Magpie'])
    expect(sections[0]!.rows).toEqual([{ key: 'default', label: '同 lead（默认）', choice: null }])
    expect(sections[1]!.rows.map(r => r.choice)).toEqual([{ provider: 'deepseek-official', model: 'flash' }, { provider: 'deepseek-official', model: 'pro' }])
  })

  it('lists one row per model, as the runtime model pane does', () => {
    const rows = menuSections(groups, { defaultLabel: 'd' })[1]!.rows
    expect(rows.map(r => r.label)).toEqual(['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro'])
    expect(rows[0]!.choice).toEqual({ provider: 'deepseek-official', model: 'flash' })
  })

  it('the reasoning pane: the model levels, with 「Default」 first when the model has no default level', () => {
    const flash = catalogModel(groups, { provider: 'deepseek-official', model: 'flash' })
    expect(effortRows(flash).map(r => [r.label, r.effort])).toEqual([['Default', undefined], ['Off', 'off'], ['High', 'high']])
    const withDefault = { id: 'r', name: 'R', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    expect(effortRows(withDefault).map(r => r.effort)).toEqual(['low', 'high'])
    expect(effortRows(catalogModel(groups, { provider: 'deepseek-official', model: 'pro' }))).toEqual([])
    expect(effectiveEffort(withDefault, { provider: 'p', model: 'r' })).toBe('high')
    expect(effectiveEffort(withDefault, { provider: 'p', model: 'r', reasoningEffort: 'low' })).toBe('low')
  })

  it('shows the level next to the model the way the runtime trigger does', () => {
    expect(effortLabel(groups, null)).toBeUndefined()
    expect(effortLabel(groups, { provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' })).toBe('High')
    expect(effortLabel(groups, { provider: 'deepseek-official', model: 'flash' })).toBe('Default')
    // A model without levels shows none; one the catalog lost keeps the raw id.
    expect(effortLabel(groups, { provider: 'deepseek-official', model: 'pro' })).toBeUndefined()
    expect(effortLabel(groups, { provider: 'gone', model: 'x', reasoningEffort: 'max' })).toBe('max')
    expect(sameModel({ provider: 'a', model: 'b', reasoningEffort: 'high' }, { provider: 'a', model: 'b' })).toBe(true)
  })

  it('filters by model name, id or provider name, keeping the default row', () => {
    expect(fuzzyMatch('Claude Opus 5.5', 'opus')).toBe(true)
    expect(fuzzyMatch('Claude Opus 5.5', 'co5')).toBe(true)
    expect(fuzzyMatch('Claude Opus 5.5', 'zz')).toBe(false)
    const byModel = menuSections(groups, { defaultLabel: 'd', query: ' opus ' })
    expect(byModel.map(s => s.key)).toEqual(['default', 'glm-anthropic'])
    expect(byModel[1]!.rows.map(r => r.label)).toEqual(['Claude Opus 5.5'])
    // A provider name match keeps all of its models.
    expect(menuSections(groups, { defaultLabel: 'd', query: 'magpie' }).map(s => s.key)).toEqual(['default', 'magpie'])
    expect(menuSections(groups, { defaultLabel: 'd', query: 'glm-5' })[1]!.rows.map(r => r.label)).toEqual(['GLM-5'])
    expect(menuSections(groups, { defaultLabel: 'd', query: 'nothing at all' }).map(s => s.key)).toEqual(['default'])
  })

  it('compares choices including the effort', () => {
    expect(sameChoice(null, undefined)).toBe(true)
    expect(sameChoice(null, { provider: 'a', model: 'b' })).toBe(false)
    expect(sameChoice({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' })).toBe(true)
    expect(sameChoice({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', reasoningEffort: 'high' })).toBe(false)
  })

  it('opens below the trigger when it fits, else above; never leaves the window', () => {
    const viewport = { width: 1600, height: 1000 }
    // Agents page header: room below.
    expect(placeMenu({ left: 960, right: 1080, top: 100, bottom: 124 }, { width: 300, height: 360 }, viewport)).toEqual({ left: 960, top: 130, maxHeight: 360 })
    // Composer at the bottom: opens upward, capped by the space above.
    const up = placeMenu({ left: 1430, right: 1520, top: 930, bottom: 958 }, { width: 300, height: 360 }, viewport)
    expect(up.top + Math.min(360, up.maxHeight)).toBeLessThanOrEqual(930 - 6)
    // Right edge: right-aligned to the trigger, inside the window.
    expect(up.left).toBe(1520 - 300)
    expect(placeMenu({ left: 1590, right: 1600, top: 100, bottom: 124 }, { width: 300, height: 200 }, viewport).left).toBe(1600 - 8 - 300)
    // In a composer the menu stays above the whole input box, not just above the trigger.
    // A DOMRect-like anchor whose fields are getters, as getBoundingClientRect returns.
    const rect = Object.create({ get left() { return 1430 }, get right() { return 1520 }, get top() { return 930 }, get bottom() { return 958 } }) as { left: number; right: number; top: number; bottom: number }
    const clear = placeMenu(rect, { width: 300, height: 360 }, viewport, { top: 872 })
    expect(clear.left).toBe(1520 - 300)
    expect(clear.top + Math.min(360, clear.maxHeight)).toBeLessThanOrEqual(872 - 6)
    // Very short window: a usable minimum height.
    expect(placeMenu({ left: 10, right: 50, top: 60, bottom: 84 }, { width: 240, height: 500 }, { width: 800, height: 200 }).maxHeight).toBe(120)
  })

})
