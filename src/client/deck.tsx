/**
 * The focus deck, in place in the left sidebar. A small toggle beside the brand wordmark (and the
 * same toggle in the deck's own header) swaps the stock workspace tree for the deck; the centre
 * keeps the conversation and the right pane keeps worker chats.
 *
 * Slot facts this relies on (contract-tested, C14/C15):
 * - A `single` slot renders its first live entry in priority order, so an entry with
 *   `priority: -1` shadows the shipped one while registered; withdrawing it restores the shipped
 *   entry untouched. A single slot cannot render the entry it displaced.
 * - `sidebar.workspaces`: the deck body occupies it only in deck mode; 工作区 mode is the shell's
 *   own tree because the deck's entry is withdrawn.
 * - `sidebar.brand.name`: the shell's local-build fallback renders only with no occupant, so the
 *   deck occupies it only while another occupant (the official brand) is registered, and draws
 *   that occupant's own artwork (`BrandWordmark`, `includeMark: false`) plus the toggle.
 * @module dsh-agent-scheduler/client/deck
 */
import { createElement, useState, useSyncExternalStore, type ReactNode } from 'react'
import { brandOccupied, configSource, primitives, registerLiveSlot, SLOT, watchSlot } from '../dsh/client/index.js'
import { t, useLocale } from './i18n.js'
import { deckOf, readPins, togglePin, writePins, type DeckCard, type DeckSession, type DeckStatus, type DeckWorker } from './deck-model.js'

/** The host row's settings namespace (see src/client/recovery-config.tsx). */
const HOST_NS = 'dsh-agent-scheduler'
/** Which sidebar content the user chose. */
export type SidebarMode = 'workspace' | 'deck'
const MODE_KEY = 'dsh-agent-scheduler/deck/mode'

/*
 * Metrics copy the stock workspace browser (dsh-client-ui-workspace): section header 36px with the
 * label at row padding, 28px header icon buttons, 32px session rows with a 16px leading slot, 14px
 * title and 10px time. Colours and paddings are the shell's own variables.
 */
const CSS = `
.sch-brand{display:inline-flex;align-items:center;gap:6px;min-width:0}
.sch-brand-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;-webkit-app-region:no-drag;letter-spacing:0}
.sch-brand-toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.sch-brand-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sch-brand-toggle:focus-visible,.sch-deck-icon:focus-visible,.sch-deck-row:focus-visible,.sch-deck-worker:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.sch-deck{box-sizing:border-box;min-height:0;flex:1;display:flex;flex-direction:column;padding-right:var(--dsh-sidebar-inline-padding);color:var(--dsw-alias-label-primary);font-size:14px}
.sch-deck[data-wide=no]{padding-right:0}
.sch-deck-header{height:36px;box-sizing:border-box;padding-left:var(--dsh-sidebar-row-padding);padding-right:1px;margin:2px -4px 4px 0;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);flex:none;display:flex;align-items:center;justify-content:flex-end;gap:4px;overflow:hidden}
.sch-deck-label{flex:none;white-space:nowrap;line-height:20px;position:relative;left:-1px;margin-right:auto}
.sch-deck-search{flex:1;min-width:0;display:flex;align-items:center;height:32px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:0 4px 0 8px;margin-left:calc(-1 * var(--dsh-sidebar-row-padding) + var(--dsh-sidebar-paint-inset) + 1px);color:var(--dsw-alias-label-caption)}
.sch-deck-search input{flex:1;min-width:0;border:none;outline:none;background:none;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;margin-left:4px}
.sch-deck-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sch-deck-icon{border:none;background:none;padding:0;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.sch-deck-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck-icon[aria-pressed=true]{color:var(--dsw-alias-label-primary)}
.sch-deck[data-wide=no] .sch-deck-header{justify-content:flex-start;flex-direction:column;height:auto;gap:12px;margin:0 0 12px;padding:0}
.sch-deck[data-wide=no] .sch-deck-icon{width:36px;height:36px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary)}
.sch-deck-list{flex:1;min-height:0;overflow-y:auto;margin-left:-4px;padding-left:4px;padding-bottom:16px;scrollbar-gutter:stable}
.sch-deck-list>*+*{margin-top:2px}
.sch-deck-group{height:28px;display:flex;align-items:center;padding-left:var(--dsh-sidebar-row-padding);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;margin-top:8px}
.sch-deck-row{display:flex;align-items:center;gap:0;height:32px;width:100%;box-sizing:border-box;margin:0;border:none;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;border-radius:var(--dsw-radius-md);background:padding-box;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;user-select:none}
@media (hover:hover){.sch-deck-row:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck-row[data-selected=yes]{background-color:var(--dsw-alias-interactive-bg-hover)}
.sch-deck-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption)}
.sch-deck-chev{display:none;border:none;background:none;padding:0;width:16px;height:20px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-xs)}
.sch-deck-chev svg{transition:transform .15s var(--ds-ease-in-out)}
.sch-deck-chev[aria-expanded=true] svg{transform:rotate(90deg)}
.sch-deck-row[data-has-workers=yes]:hover .sch-deck-pin,.sch-deck-row[data-expanded=yes] .sch-deck-pin{display:none}
.sch-deck-row[data-has-workers=yes]:hover .sch-deck-chev,.sch-deck-row[data-expanded=yes] .sch-deck-chev{display:inline-flex}
.sch-deck-title{flex:1;min-width:0;margin:0 6px 0 var(--dsh-sidebar-label-gap);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.sch-deck-tail{flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;margin-inline-end:-1px}
.sch-deck-count{font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sch-deck-tag{font-size:10px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.sch-deck-dot{flex:none;width:6px;height:6px;border-radius:50%;box-sizing:border-box;border:1px solid var(--dsw-alias-label-caption);background:transparent}
.sch-deck-dot[data-state=running]{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary));background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary))}
.sch-deck-dot[data-state=waiting]{border-color:var(--dsw-alias-state-warn-primary);background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary) 50%,transparent 50%)}
.sch-deck-dot[data-state=done]{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary)}
.sch-deck-dot[data-state=failed]{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary)}
.sch-deck-workers{display:flex;flex-direction:column;gap:0;margin-top:0}
.sch-deck-worker{display:flex;align-items:center;height:28px;width:100%;box-sizing:border-box;margin:0;border:none;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;border-radius:var(--dsw-radius-md);background:padding-box;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
@media (hover:hover){.sch-deck-worker:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sch-deck-glyph{width:16px;flex:none;text-align:center;color:var(--dsw-alias-label-caption);font-size:12px;line-height:20px;font-family:var(--ds-font-family-code)}
.sch-deck-wname{flex:1;min-width:0;margin:0 6px 0 var(--dsh-sidebar-label-gap);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.sch-deck-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px;line-height:20px}
`

const svg = (size: number, children: ReactNode) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
/** The deck toggle glyph: a sidebar whose content is a stack of cards (falls back when primitives lack one). */
const DeckGlyph = ({ size = 16 }: { size?: number }) => svg(size, <><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.25" /><path d="M5.75 2.5v11" /><path d="M8 5.5h4M8 8h4M8 10.5h2.5" /></>)
const SearchGlyph = ({ size = 14 }: { size?: number }) => {
  const Icon = primitives()?.IconSearchOutlineRegular
  return Icon !== undefined ? createElement(Icon as never, { size }) : svg(size, <><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></>)
}
const ChevronGlyph = () => {
  const Icon = primitives()?.IconChevronRightOutlineRegular
  return Icon !== undefined ? createElement(Icon as never, { size: 12 }) : svg(12, <path d="m6 4 4 4-4 4" />)
}
const PinGlyph = () => {
  const Icon = primitives()?.IconPinFillRegular
  return Icon !== undefined ? createElement(Icon as never, { size: 14 }) : svg(14, <path d="M8 2.5 9.6 6l3.7.4-2.8 2.5.8 3.6L8 10.6l-3.3 1.9.8-3.6L2.7 6.4 6.4 6Z" />)
}

/** Sidebar modes persisted in this browser profile; the choice survives reloads and restarts. */
export function createModeStore(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let value: SidebarMode = storage?.getItem(MODE_KEY) === 'deck' ? 'deck' : 'workspace'
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: SidebarMode) => {
      if (next === value) return
      value = next
      try { storage?.setItem(MODE_KEY, next) } catch { /* private storage keeps the choice for this page */ }
      notify()
    },
    toggle() { this.set(value === 'deck' ? 'workspace' : 'deck') },
  }
}
export type ModeStore = ReturnType<typeof createModeStore>

/** Pins: the shell's own workspace pins when that service exists, else the plugin's browser list. */
function pinStore(ctx: any, storage: Storage | undefined) {
  const workspaces = (() => { try { return ctx.get?.('workspaces') } catch { return undefined } })()
  if (workspaces?.list !== undefined && typeof workspaces.list.getSnapshot === 'function') {
    return {
      get: () => (workspaces.list.getSnapshot().pinnedSessionIds ?? []) as string[],
      subscribe: (listener: () => void) => workspaces.list.subscribe(listener) as () => void,
    }
  }
  let value = readPins(storage)
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toggle: (id: string) => { value = togglePin(value, id); writePins(storage, value); for (const listener of listeners) listener() },
  }
}

/** The toggle's label for the mode it switches to. */
const toggleLabel = (mode: SidebarMode) => t(mode === 'deck' ? 'deck.toWorkspace' : 'deck.toDeck')

/** Compact relative time, as the stock rows print it (「2分钟」, 「1天」). */
export function shortAgo(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return t('deck.short.now')
  if (minutes < 60) return t('deck.short.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? t('deck.short.hours', { count: hours }) : t('deck.short.days', { count: Math.floor(hours / 24) })
}

/** Filter cards by title, case-insensitively. */
export const matching = (cards: readonly DeckCard[], query: string): DeckCard[] => {
  const q = query.trim().toLocaleLowerCase()
  return q === '' ? [...cards] : cards.filter(card => card.title.toLocaleLowerCase().includes(q))
}

/**
 * Build the deck's sidebar components.
 * @param ctx - the browser plugin context (sessions, uiSession, uiWorkspace, workspaces).
 * @param openWorker - opens a worker's chat in the right pane (same path as the Agents page).
 * @returns the brand-row name, the body, and the mode store.
 */
export function createDeckViews(ctx: any, openWorker: (parent: string, child: string) => void, modes: ModeStore = createModeStore(typeof localStorage === 'undefined' ? undefined : localStorage)) {
  const pins = pinStore(ctx, typeof localStorage === 'undefined' ? undefined : localStorage)
  const sessions = (() => { try { return ctx.get?.('sessions') } catch { return undefined } })()
  const uiSession = (() => { try { return ctx.get?.('uiSession') } catch { return undefined } })()
  const workspace = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  const open = (id: string) => { workspace?.openSession?.(id) }

  /** The brand row's name seat: the official wordmark, then the toggle. */
  function BrandName() {
    useLocale()
    const mode = useSyncExternalStore(modes.subscribe, modes.get, modes.get)
    const Wordmark = primitives()?.BrandWordmark
    const label = toggleLabel(mode)
    const stop = (event: { stopPropagation(): void; preventDefault(): void }) => { event.stopPropagation(); event.preventDefault() }
    return (
      <span className="sch-brand" data-scheduler-brand="">
        <style>{CSS}</style>
        {Wordmark === undefined ? null : createElement(Wordmark as never, { includeMark: false })}
        {/* The brand row is itself a button (new session): a span keeps the markup valid, every
            event stops here, and the row's own handler already ignores clicks inside
            [data-copy-version] (its local-build badge), so the row never opens a new session. */}
        <span
          className="sch-brand-toggle" role="button" tabIndex={0} data-deck-toggle="brand" data-copy-version=""
          aria-label={label} title={label} aria-pressed={mode === 'deck'}
          onPointerDown={event => { event.stopPropagation() }}
          onClick={event => { stop(event); modes.toggle() }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { stop(event); modes.toggle() } }}
        ><DeckGlyph size={16} /></span>
      </span>
    )
  }

  function DeckBody(props: { wide?: boolean; expandSidebar?: () => void }) {
    useLocale()
    const wide = props.wide !== false
    const pinned = useSyncExternalStore(pins.subscribe, pins.get, pins.get)
    const list: any = sessions === undefined ? undefined : useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
    const statuses = uiSession === undefined ? undefined : useSyncExternalStore(uiSession.sessionStatus.subscribe, uiSession.sessionStatus.getSnapshot, uiSession.sessionStatus.getSnapshot)
    const [query, setQuery] = useState('')
    const [searching, setSearching] = useState(false)
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
    const rows: DeckSession[] = list === undefined || list === null ? [] : (list.ids as string[]).map((id: string) => list.byId[id]).filter((row: unknown): row is DeckSession => row !== undefined && row !== null)
    const deck = deckOf(rows, statuses as ReadonlyMap<string, DeckStatus> | undefined, pinned)
    const pinnedCards = matching(deck.pinned, query)
    const attention = matching(deck.attention, query)
    const label = toggleLabel('deck')
    const toggleButton = (
      <button type="button" className="sch-deck-icon" data-deck-toggle="header" aria-label={label} title={label} aria-pressed onClick={() => { modes.set('workspace') }}><DeckGlyph size={wide ? 14 : 18} /></button>
    )
    if (!wide) {
      return (
        <div className="sch-deck" data-scheduler-deck="" data-wide="no">
          <style>{CSS}</style>
          <div className="sch-deck-header">
            <button type="button" className="sch-deck-icon" data-deck-search="" aria-label={t('deck.search')} title={t('deck.search')} onClick={() => { props.expandSidebar?.(); setSearching(true) }}><SearchGlyph size={18} /></button>
            {toggleButton}
          </div>
        </div>
      )
    }
    const toggle = (id: string) => { setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
    const workerRow = (card: DeckCard, worker: DeckWorker, last: boolean) => (
      <button key={worker.id} type="button" className="sch-deck-worker" data-deck-worker={worker.id} data-state={worker.state} title={worker.text === '' ? worker.name : `${worker.name} — ${worker.text}`} onClick={() => { openWorker(card.id, worker.id) }}>
        <span className="sch-deck-glyph" aria-hidden="true">{last ? '└' : '├'}</span>
        <span className="sch-deck-wname">{worker.name}</span>
        <span className="sch-deck-tail"><span className="sch-deck-dot" data-state={worker.state} />{t(`state.${worker.state}`)}</span>
      </button>
    )
    const row = (card: DeckCard) => {
      const open_ = expanded.has(card.id)
      const hasWorkers = card.workers.length > 0
      const tail = card.state === 'waiting'
        ? <>{t('deck.waitingYou')}{card.approvals > 0 ? <> · <span className="sch-deck-tag" data-deck-approvals={card.approvals}>{t('deck.pending', { count: card.approvals })}</span></> : null}</>
        : shortAgo(card.lastActivity)
      return (
        <div key={card.id} data-deck-card={card.id} data-lead={card.lead} data-state={card.state}>
          <div
            className="sch-deck-row" role="button" tabIndex={0} data-deck-open={card.id} data-has-workers={hasWorkers ? 'yes' : 'no'} data-expanded={open_ ? 'yes' : 'no'} title={card.title}
            onClick={() => { open(card.id) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); open(card.id) } }}
          >
            <span className="sch-deck-slot">
              {card.pinned ? <span className="sch-deck-pin" data-deck-pinned="" aria-hidden="true"><PinGlyph /></span> : null}
              {hasWorkers ? (
                <button type="button" className="sch-deck-chev" data-deck-expand={card.id} aria-expanded={open_} aria-label={t(open_ ? 'deck.collapse' : 'deck.expand', { title: card.title })} onClick={event => { event.stopPropagation(); toggle(card.id) }}><ChevronGlyph /></button>
              ) : null}
            </span>
            <span className="sch-deck-title">{card.title}</span>
            <span className="sch-deck-tail">
              {card.runningWorkers > 0 ? <span className="sch-deck-count" data-deck-workers={card.runningWorkers}>{t('deck.workersBadge', { count: card.runningWorkers })}</span> : null}
              <span className="sch-deck-dot" data-state={card.state} />
              <span>{tail}</span>
            </span>
          </div>
          {open_ && hasWorkers ? (
            <div className="sch-deck-workers" data-deck-workers-of={card.id}>{card.workers.map((worker, i) => workerRow(card, worker, i === card.workers.length - 1))}</div>
          ) : null}
        </div>
      )
    }
    const empty = deck.pinned.length === 0 && deck.attention.length === 0
    return (
      <div className="sch-deck" data-scheduler-deck="" data-wide="yes">
        <style>{CSS}</style>
        <div className="sch-deck-header">
          {searching ? (
            <label className="sch-deck-search" data-deck-search-open="">
              <SearchGlyph size={11} />
              <input autoFocus value={query} placeholder={t('deck.searchPlaceholder')} aria-label={t('deck.search')} onChange={event => { setQuery(event.currentTarget.value) }} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearching(false) } }} onBlur={() => { if (query === '') setSearching(false) }} />
            </label>
          ) : (
            <>
              <span className="sch-deck-label">{t('deck.title')}</span>
              <button type="button" className="sch-deck-icon" data-deck-search="" aria-label={t('deck.search')} title={t('deck.search')} onClick={() => { setSearching(true) }}><SearchGlyph size={14} /></button>
            </>
          )}
          {toggleButton}
        </div>
        <div className="sch-deck-list" data-deck-list="">
          {empty ? <div className="sch-deck-empty">{t('deck.emptyAll')}</div> : null}
          <div data-deck-section="pinned">{pinnedCards.map(row)}</div>
          {attention.length === 0 ? null : (
            <div data-deck-section="attention">
              <div className="sch-deck-group">{t('deck.needsYou')}</div>
              {attention.map(row)}
            </div>
          )}
          {!empty && query !== '' && pinnedCards.length === 0 && attention.length === 0 ? <div className="sch-deck-empty">{t('deck.noMatch')}</div> : null}
        </div>
      </div>
    )
  }

  return { BrandName, DeckBody, modes }
}

/**
 * Register the deck: the brand-row toggle (only beside an official wordmark), and the body in the
 * browsing region only while 指挥台 is chosen. `deck.enabled` off registers nothing.
 * @param ctx - the browser plugin context.
 * @param openWorker - opens a worker's chat in the right pane.
 * @returns the mode store (tests and the GUI drive it).
 */
export function registerDeck(ctx: any, openWorker: (parent: string, child: string) => void, modes?: ModeStore): { modes: ModeStore } {
  const source = configSource<{ deck?: { enabled?: boolean } }>(ctx, HOST_NS)
  const views = createDeckViews(ctx, openWorker, modes)
  let brandDispose: (() => void) | undefined
  let bodyDispose: (() => void) | undefined
  let watchers: Array<() => void> = []
  let enabled: boolean | undefined
  const syncBody = () => {
    const deck = views.modes.get() === 'deck'
    if (deck && bodyDispose === undefined) bodyDispose = registerLiveSlot(ctx, SLOT.workspaces, { priority: -1 }, views.DeckBody)
    if (!deck && bodyDispose !== undefined) { bodyDispose(); bodyDispose = undefined }
  }
  // Beside an official wordmark only: with no other occupant the shell draws its local-build
  // fallback (「本地构建」 + version badge, click to copy), which an occupant would replace.
  let syncing = false
  const syncBrand = () => {
    // Our own registration notifies the same slot; a registry that notifies synchronously would
    // re-enter before the disposer is stored.
    if (syncing) return
    syncing = true
    try {
      const show = enabled === true && primitives()?.BrandWordmark !== undefined && brandOccupied(ctx, views.BrandName)
      if (show && brandDispose === undefined) brandDispose = registerLiveSlot(ctx, SLOT.brandName, { priority: -1 }, views.BrandName)
      if (!show && brandDispose !== undefined) { const dispose = brandDispose; brandDispose = undefined; dispose() }
    } finally {
      syncing = false
    }
  }
  const apply = (on: boolean) => {
    if (on === enabled) return
    enabled = on
    if (!on) {
      for (const off of watchers) off()
      watchers = []
      const brand = brandDispose; brandDispose = undefined; brand?.()
      bodyDispose?.(); bodyDispose = undefined
      return
    }
    watchers = [views.modes.subscribe(syncBody), watchSlot(ctx, SLOT.brandName, syncBrand)]
    syncBrand()
    syncBody()
  }
  const enabledOf = (snapshot: { status: string; value?: { deck?: { enabled?: boolean } } } | undefined): boolean =>
    snapshot === undefined || snapshot.status !== 'ready' ? true : snapshot.value?.deck?.enabled !== false
  apply(enabledOf(source?.get()))
  source?.subscribe(() => { apply(enabledOf(source.get())) })
  return { modes: views.modes }
}
