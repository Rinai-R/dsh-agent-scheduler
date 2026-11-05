/**
 * One model menu for every place this plugin picks a model: the Agents page's 「分身模型」 and
 * 「Worker 模型」 (what later forks / workers start with) and a fork's or worker's own chat
 * composer. It follows the runtime composer selector (dsh-client-ui-model-selection): a root list
 * with 「模型 ›」 and 「推理等级 ›」 cells that drill into a searchable, provider-grouped model list
 * or the model's reasoning levels; same menu material, sticky headings, check marks, sizes and
 * theme tokens. That selector cannot be mounted here (it binds to one Session's own selection
 * and hides itself for subagents), so this is a copy of its look and behavior.
 * @module dsh-agent-scheduler/client/model-menu
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

/** Provider route, model id and optional effort. */
export interface ModelChoice { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
/** Reasoning levels a catalog model advertises. */
export interface CatalogReasoning { readonly defaultEffort?: string; readonly efforts: readonly { readonly id: string; readonly name: string }[] }
/** One catalog model. */
export interface CatalogModel { readonly id: string; readonly name: string; readonly reasoning?: CatalogReasoning }
/** One provider group of the Host model catalog (`remote.session.modelCatalog`). */
export interface CatalogGroup { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }

/** One selectable model row. `choice: null` is the pinned default row. */
export interface MenuRow { readonly key: string; readonly label: string; readonly choice: ModelChoice | null }
/** A titled run of rows. The pinned default row has no title. */
export interface MenuSection { readonly key: string; readonly title?: string | undefined; readonly rows: readonly MenuRow[] }
/** One row of the reasoning pane; `effort: undefined` is the provider's own default. */
export interface EffortRow { readonly key: string; readonly label: string; readonly effort: string | undefined }

/** The runtime's label for "let the provider decide" (its `effort.providerDefault`). */
export const PROVIDER_DEFAULT_EFFORT = 'Default'

/** Whether two choices are the same; `null` is the default. */
export const sameChoice = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean =>
  (a ?? null) === null ? (b ?? null) === null : b !== null && b !== undefined && a!.provider === b.provider && a!.model === b.model && (a!.reasoningEffort ?? null) === (b.reasoningEffort ?? null)

/** Whether two choices name the same model, whatever the effort. */
export const sameModel = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean =>
  (a ?? null) === null ? (b ?? null) === null : b !== null && b !== undefined && a!.provider === b.provider && a!.model === b.model

/**
 * Case-insensitive subsequence match, the runtime selector's search rule.
 * @param text - what is searched.
 * @param query - trimmed query.
 * @returns whether every query character appears in order.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  const hay = text.toLowerCase()
  let at = 0
  for (const ch of query.toLowerCase()) {
    const found = hay.indexOf(ch, at)
    if (found < 0) return false
    at = found + 1
  }
  return true
}

/**
 * The model pane: one row per model, as the runtime lists them (levels live in their own pane).
 * @param groups - catalog groups, in catalog order.
 * @param options - the pinned default row's label and the search query.
 * @returns sections: the default row first (always kept), then providers whose models match.
 */
export function menuSections(groups: readonly CatalogGroup[], options: { defaultLabel: string; query?: string }): MenuSection[] {
  const query = (options.query ?? '').trim()
  const sections: MenuSection[] = [{ key: 'default', rows: [{ key: 'default', label: options.defaultLabel, choice: null }] }]
  for (const group of groups) {
    const groupHit = query !== '' && fuzzyMatch(group.name, query)
    const rows: MenuRow[] = []
    for (const model of group.models) {
      if (query !== '' && !groupHit && !fuzzyMatch(model.name, query) && !fuzzyMatch(model.id, query)) continue
      rows.push({ key: `${group.id}\u0000${model.id}`, label: model.name, choice: { provider: group.id, model: model.id } })
    }
    if (rows.length > 0) sections.push({ key: group.id, title: group.name, rows })
  }
  return sections
}

/**
 * The catalog entry of a choice.
 * @param groups - catalog groups.
 * @param choice - the choice.
 * @returns its model, or undefined when the catalog does not list it.
 */
export function catalogModel(groups: readonly CatalogGroup[], choice: ModelChoice | null | undefined): CatalogModel | undefined {
  if (choice === null || choice === undefined) return undefined
  return groups.find(g => g.id === choice.provider)?.models.find(m => m.id === choice.model)
}

/**
 * The reasoning pane, as the runtime builds it: a 「Default」 row when the model names no default
 * level of its own, then its levels.
 * @param model - the catalog model.
 * @returns rows; empty when the model has no reasoning levels.
 */
export function effortRows(model: CatalogModel | undefined): EffortRow[] {
  const reasoning = model?.reasoning
  if (reasoning === undefined) return []
  return [
    ...(reasoning.defaultEffort === undefined ? [{ key: 'provider-default', label: PROVIDER_DEFAULT_EFFORT, effort: undefined }] : []),
    ...reasoning.efforts.map(level => ({ key: `effort:${level.id}`, label: level.name, effort: level.id })),
  ]
}

/**
 * The level a choice runs with: its own, else the model's default.
 * @param model - the catalog model.
 * @param choice - the choice.
 * @returns the effective level id, or undefined for the provider's default.
 */
export const effectiveEffort = (model: CatalogModel | undefined, choice: ModelChoice | null | undefined): string | undefined =>
  choice?.reasoningEffort ?? model?.reasoning?.defaultEffort

/**
 * What the trigger and the 「推理等级」 cell show for a choice, as the runtime does.
 * @param groups - catalog groups.
 * @param choice - the choice.
 * @returns the level name; undefined when there is nothing to show (no choice, no levels).
 */
export function effortLabel(groups: readonly CatalogGroup[], choice: ModelChoice | null | undefined): string | undefined {
  if (choice === null || choice === undefined) return undefined
  const model = catalogModel(groups, choice)
  if (model === undefined || model.reasoning === undefined) return choice.reasoningEffort
  const effort = effectiveEffort(model, choice)
  return effort === undefined ? PROVIDER_DEFAULT_EFFORT : model.reasoning.efforts.find(l => l.id === effort)?.name ?? effort
}

/**
 * Where a menu goes: below its trigger when it fits, else above; kept inside the viewport.
 * @param anchor - the trigger's rectangle.
 * @param size - the menu's measured size.
 * @param viewport - window size.
 * @returns fixed-position left/top and the height cap.
 */
export function placeMenu(anchor: { left: number; right: number; top: number; bottom: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, avoid?: { top: number }): { left: number; top: number; maxHeight: number } {
  const margin = 8
  const gap = 6
  // Inside a composer, the menu opens above the whole input box rather than over it.
  // (Fields are copied one by one: a DOMRect's are getters, which an object spread drops.)
  if (avoid !== undefined) anchor = { left: anchor.left, right: anchor.right, top: Math.min(anchor.top, avoid.top), bottom: Math.max(anchor.bottom, viewport.height) }
  const below = viewport.height - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin
  const downward = below >= Math.min(size.height, 240) || below >= above
  const maxHeight = Math.max(120, Math.min(360, downward ? below : above))
  const height = Math.min(size.height, maxHeight)
  const top = downward ? anchor.bottom + gap : anchor.top - gap - height
  // Right-align with the trigger when it would overflow on the right, as the runtime menu does.
  let left = anchor.left
  if (left + size.width > viewport.width - margin) left = anchor.right - size.width
  left = Math.max(margin, Math.min(left, viewport.width - margin - size.width))
  return { left, top: Math.max(margin, top), maxHeight }
}

const CHECK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" stroke="currentColor" /></svg>
)
const CHEVRON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
)
const CHEVRON_RIGHT = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
)
const CLEAR = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
)

/** Styles; the runtime's menu tokens (and measured sizes) with fallbacks for themes that lack one. */
export const MODEL_MENU_STYLE = `
.sch-mt{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;height:28px;border:0;outline:none;background:none;margin:0;padding:0 4px 0 8px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:400;line-height:20px;cursor:pointer}
.sch-mt[data-size=compact]{height:24px;padding:0 2px 0 6px;font-size:12px;line-height:18px}
.sch-mt:hover:not(:disabled),.sch-mt[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-mt:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.sch-mt:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.sch-mt-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-mt-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex-shrink:1000}
.sch-mt-chev{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}
.sch-mt[aria-expanded=true] .sch-mt-chev{transform:rotate(180deg)}
.sch-mm-menu{position:fixed;z-index:1100;isolation:isolate;display:flex;flex-direction:column;box-sizing:border-box;width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);padding:4px;border:0;border-radius:var(--dsw-radius-lg,16px);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.25)),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05));overflow:hidden;font-size:13px;line-height:20px}
.sch-mm-menu::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,Canvas)));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);pointer-events:none}
.sch-mm-cell{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;height:34px;border:0;outline:none;background:none;margin:0;padding:0 8px;border-radius:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.sch-mm-cell:hover,.sch-mm-menu[data-keyboard] .sch-mm-cell[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.sch-mm-cell-label{flex:none}
.sch-mm-cell-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sch-mm-cell[data-cell=effort] .sch-mm-cell-value{text-align:right}
.sch-mm-cell-chev{flex:none;display:inline-flex;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-primary))}
.sch-mm-search{position:relative;flex:none;margin:2px 0 3px}
.sch-mm-search input{box-sizing:border-box;width:100%;height:28px;border:0;outline:none;background:none;padding:5px 30px 5px 7px;border-radius:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-primary);font-size:12px}
.sch-mm-search input::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.sch-mm-search input:focus{background:none}
.sch-mm-clear{position:absolute;top:50%;right:4px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:50%;background:none;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sch-mm-clear:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-mm-list{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sch-mm-group{position:relative}
.sch-mm-group+.sch-mm-group{margin-top:3px}
.sch-mm-head{position:sticky;top:0;z-index:1;padding:4px 7px 2px;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;line-height:16px}
.sch-mm-head[data-stuck]{background:var(--dsw-alias-menu-group-header-fill,var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2,Canvas)))}
.sch-mm-item{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:34px;border:0;outline:none;background:none;margin:0;padding:5px 7px;border-radius:var(--dsw-radius-md,12px);color:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.sch-mm-item[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.sch-mm-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-mm-check{flex:0 0 14px;display:grid;place-items:center;color:var(--dsw-alias-label-primary)}
.sch-mm-empty{padding:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`

type Pane = 'root' | 'model' | 'effort'

/**
 * A model trigger and its menu.
 * @param props - the current choice, the catalog, labels, and what picking does.
 * @returns the control.
 */
export function ModelMenu(props: {
  groups: readonly CatalogGroup[] | undefined
  /** The choice; null is the default (「同 lead」 / 「默认模型」). */
  current: ModelChoice | null
  /** Trigger text when the choice is the default or not in the catalog. */
  label: string
  /** The default row's label in the model pane, and the 「模型」 cell's value for it. */
  defaultLabel: string
  /** The 「模型」 cell's value and the trigger text for the default choice; defaults to `label`. */
  defaultValue?: string | undefined
  busy?: boolean | undefined
  size?: 'normal' | 'compact'
  ariaLabel: string
  title?: string | undefined
  onPick: (choice: ModelChoice | null) => void
  /** Rendered in the model pane when the catalog failed to load. */
  failure?: ReactNode
  /** Closest ancestor matching this selector is kept clear (the composer box). */
  avoid?: string | undefined
  /** Extra attribute for tests and styles. */
  testId?: string | undefined
}) {
  const groups = props.groups ?? []
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Root cells show the keyboard position only after a key moved it; the mouse uses :hover.
  const [keyboard, setKeyboard] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | undefined>(undefined)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const sections = useMemo(() => menuSections(groups, { defaultLabel: props.defaultLabel, query }), [groups, props.defaultLabel, query])
  const rows = useMemo(() => sections.flatMap(s => s.rows), [sections])
  const model = catalogModel(groups, props.current)
  const levels = useMemo(() => effortRows(model), [model])
  const effort = effectiveEffort(model, props.current)
  const level = effortLabel(groups, props.current)
  const defaultValue = props.defaultValue ?? props.label
  const modelValue = props.current === null ? defaultValue : model?.name ?? props.current.model
  // The root lists 「推理等级」 only for a model with levels, as the runtime does.
  const cells: Pane[] = levels.length > 0 ? ['model', 'effort'] : ['model']

  const close = (refocus = true) => {
    setOpen(false)
    setPane('root')
    setQuery('')
    setPlace(undefined)
    if (refocus) trigger.current?.focus()
  }
  const drill = (next: Pane) => {
    setQuery('')
    if (next === 'model') setActive(Math.max(0, menuSections(groups, { defaultLabel: props.defaultLabel }).flatMap(s => s.rows).findIndex(r => sameModel(r.choice, props.current))))
    else if (next === 'effort') setActive(Math.max(0, levels.findIndex(l => l.effort === effort)))
    else setActive(0)
    setPane(next)
  }
  const back = (from: Pane) => { setPane('root'); setQuery(''); setActive(Math.max(0, cells.indexOf(from))) }
  const openMenu = () => {
    setKeyboard(false)
    setQuery('')
    setActive(0)
    setPane('root')
    setOpen(true)
  }
  // Measure, then place inside the window: below the trigger, or above when it does not fit.
  // A pane change (or a new result count) drops the placement first, so the menu is measured
  // again hidden and at its natural height, then capped to fit (else a long model list would
  // inherit the short root pane's placement and run off the screen).
  useLayoutEffect(() => { if (open) setPlace(undefined) }, [pane, sections.length])
  useLayoutEffect(() => {
    if (!open || place !== undefined || trigger.current === null || menu.current === null) return
    const a = trigger.current.getBoundingClientRect()
    const m = menu.current.getBoundingClientRect()
    const box = props.avoid === undefined ? null : trigger.current.closest(props.avoid)
    setPlace(placeMenu(a, { width: m.width, height: m.height }, { width: window.innerWidth, height: window.innerHeight }, box === null ? undefined : { top: box.getBoundingClientRect().top }))
  })
  const placed = place !== undefined
  // Focus: the search in the model pane; otherwise the menu itself carries the keys.
  useEffect(() => {
    if (!open || !placed) return
    if (pane === 'model') search.current?.focus({ preventScroll: true })
    else menu.current?.focus({ preventScroll: true })
  }, [open, placed, pane])
  useEffect(() => {
    if (!open) return undefined
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (target !== null && (menu.current?.contains(target) === true || trigger.current?.contains(target) === true)) return
      close(false)
    }
    const away = () => { close(false) }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', away)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', away) }
  }, [open])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open, pane])
  // Headings are transparent at rest and take the menu fill only while pinned, as the runtime's.
  useEffect(() => {
    const viewport = list.current
    if (!open || !placed || pane !== 'model' || viewport === null) return undefined
    const mark = () => {
      const top = viewport.getBoundingClientRect().top
      for (const head of viewport.querySelectorAll<HTMLElement>('.sch-mm-head')) {
        const group = head.parentElement!.getBoundingClientRect()
        head.toggleAttribute('data-stuck', group.top < top - 0.5 && group.bottom > top)
      }
    }
    mark()
    viewport.addEventListener('scroll', mark, { passive: true })
    return () => { viewport.removeEventListener('scroll', mark) }
  }, [open, placed, pane, sections])

  const finish = (choice: ModelChoice | null) => {
    close()
    if (!sameChoice(choice, props.current)) props.onPick(choice)
  }
  // Picking a model keeps the level only when re-picking the same model, as the runtime does
  // (another model starts at its own default level).
  const pickModel = (row: MenuRow | undefined) => {
    if (row === undefined) return
    if (sameModel(row.choice, props.current)) { close(); return }
    finish(row.choice)
  }
  const pickEffort = (row: EffortRow | undefined) => {
    if (row === undefined || props.current === null) return
    if (row.effort === effort) { close(); return }
    const { reasoningEffort: _, ...base } = props.current
    finish(row.effort === undefined ? base : { ...base, reasoningEffort: row.effort })
  }
  const count = pane === 'root' ? cells.length : pane === 'model' ? rows.length : levels.length
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setKeyboard(true)
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => count === 0 ? 0 : (i + 1) % count) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => count === 0 ? 0 : (i - 1 + count) % count) }
    else if (event.key === 'Home' && pane !== 'model') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End' && pane !== 'model') { event.preventDefault(); setActive(Math.max(0, count - 1)) }
    else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      if (pane === 'root') drill(cells[active] ?? 'model')
      else if (pane === 'model') pickModel(rows[active])
      else pickEffort(levels[active])
    } else if (event.key === 'ArrowRight' && pane === 'root') { event.preventDefault(); drill(cells[active] ?? 'model') }
    else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey) || (event.key === 'ArrowLeft' && pane === 'effort')) {
      event.preventDefault()
      event.stopPropagation()
      if (pane !== 'root') back(pane)
      else close()
    }
  }

  const cellValue = (cell: Pane) => cell === 'model' ? modelValue : level
  let index = -1
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sch-mt"
        data-size={props.size ?? 'normal'}
        data-testid={props.testId}
        disabled={props.busy === true}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        title={props.title}
        onClick={() => { if (open) close(); else openMenu() }}
        onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openMenu() } }}
      >
        <span className="sch-mt-label">{props.current === null ? defaultValue : model?.name ?? props.label}</span>
        {level === undefined ? null : <span className="sch-mt-detail">{level}</span>}
        <span className="sch-mt-chev">{CHEVRON}</span>
      </button>
      {open ? (
        <div
          ref={menu}
          className="sch-mm-menu"
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={props.ariaLabel}
          data-menu-material=""
          data-pane={pane}
          {...(keyboard ? { 'data-keyboard': '' } : {})}
          tabIndex={-1}
          style={place === undefined ? { left: -9999, top: 0, visibility: 'hidden' } : { left: place.left, top: place.top, maxHeight: place.maxHeight }}
          onKeyDown={onKey}
        >
          {pane === 'root' ? cells.map((cell, i) => (
            <button
              key={cell}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="sch-mm-cell"
              data-cell={cell}
              {...(i === active ? { 'data-active': '' } : {})}
              onMouseMove={() => { setKeyboard(false); if (i !== active) setActive(i) }}
              onClick={() => { drill(cell) }}
            >
              <span className="sch-mm-cell-label">{cell === 'model' ? '模型' : '推理等级'}</span>
              <span className="sch-mm-cell-value">{cellValue(cell)}</span>
              <span className="sch-mm-cell-chev">{CHEVRON_RIGHT}</span>
            </button>
          )) : null}
          {pane === 'model' ? (
            <>
              <div className="sch-mm-search">
                <input
                  ref={search}
                  type="text"
                  role="searchbox"
                  value={query}
                  placeholder="搜索模型…"
                  aria-label="搜索模型…"
                  aria-activedescendant={rows[active] === undefined ? undefined : `sch-mm-row-${active}`}
                  onChange={(event) => { setQuery(event.currentTarget.value); setActive(0) }}
                />
                {query === '' ? null : <button type="button" className="sch-mm-clear" aria-label="清除搜索" onClick={() => { setQuery(''); setActive(0); search.current?.focus() }}>{CLEAR}</button>}
              </div>
              {props.failure}
              <div ref={list} className="sch-mm-list" role="menu" aria-label="模型">
                {sections.map(section => (
                  <section key={section.key} className="sch-mm-group" role="group" aria-label={section.title ?? props.defaultLabel}>
                    {section.title === undefined ? null : <div className="sch-mm-head">{section.title}</div>}
                    {section.rows.map(row => {
                      index += 1
                      const i = index
                      const checked = sameModel(row.choice, props.current)
                      return (
                        <button
                          key={row.key}
                          id={`sch-mm-row-${i}`}
                          type="button"
                          role="menuitemradio"
                          tabIndex={-1}
                          aria-checked={checked}
                          className="sch-mm-item"
                          title={row.label}
                          data-value={row.choice === null ? 'default' : `${row.choice.provider}/${row.choice.model}`}
                          {...(i === active ? { 'data-active': '' } : {})}
                          onMouseMove={() => { if (i !== active) setActive(i) }}
                          onClick={() => { pickModel(row) }}
                        >
                          <span className="sch-mm-name">{row.label}</span>
                          <span className="sch-mm-check">{checked ? CHECK : null}</span>
                        </button>
                      )
                    })}
                  </section>
                ))}
                {rows.length === 1 && query !== '' ? <div className="sch-mm-empty" role="status">没有匹配的模型。</div> : null}
              </div>
            </>
          ) : null}
          {pane === 'effort' ? (levels.length === 0
            ? <div className="sch-mm-empty">当前模型未提供推理等级。</div>
            : levels.map((row, i) => (
              <button
                key={row.key}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={row.effort === effort}
                className="sch-mm-item"
                data-value={row.effort ?? 'default'}
                {...(i === active ? { 'data-active': '' } : {})}
                onMouseMove={() => { if (i !== active) setActive(i) }}
                onClick={() => { pickEffort(row) }}
              >
                <span className="sch-mm-name">{row.label}</span>
                <span className="sch-mm-check">{row.effort === effort ? CHECK : null}</span>
              </button>
            ))) : null}
        </div>
      ) : null}
    </>
  )
}
