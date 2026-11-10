/**
 * The focus deck, in place in the left sidebar. One switch beside the brand wordmark swaps the
 * stock workspace tree for the deck; the centre keeps the conversation and the right pane keeps
 * worker chats.
 *
 * The deck is a curated list: the user imports Sessions into it (header import action, or 「加入指挥台」
 * in the stock row menu), and a Session created from the deck joins it automatically. Removing a
 * row only takes it out of the deck. Shell pins only draw the pin glyph.
 *
 * Slot facts this relies on (contract-tested, C14/C15):
 * - A `single` slot renders its first live entry in priority order, so an entry with
 *   `priority: -1` shadows the shipped one while registered; withdrawing it restores the shipped
 *   entry untouched. A single slot cannot render the entry it displaced.
 * - `sidebar.workspaces`: the deck body occupies it only in deck mode; 工作区 mode is the shell's
 *   own tree because the deck's entry is withdrawn.
 * - `sidebar.brand.name`: the shell's local-build fallback renders only with no occupant, so the
 *   deck occupies it only while another occupant (the official brand) is registered, and draws
 *   that occupant's own artwork (`BrandWordmark`, `includeMark: false`) plus the switch.
 * @module dsh-agent-scheduler/client/deck
 */
import { createElement, useState, useSyncExternalStore, type ReactNode } from 'react'
import { brandOccupied, configSource, mainViewSessionId, primitives, registerLiveSlot, registerSessionMenu, SLOT, startStockSession, stockText, watchSlot, type Primitives } from '../dsh/client/index.js'
import { t, useLocale } from './i18n.js'
import { addMembers, deckRows, importable, readMembers, removeMember, writeMembers, type DeckCard, type DeckSession, type DeckStatus, type DeckWorker } from './deck-model.js'

/** The host row's settings namespace (see src/client/recovery-config.tsx). */
const HOST_NS = 'dsh-agent-scheduler'
/** Which sidebar content the user chose. */
export type SidebarMode = 'workspace' | 'deck'
const MODE_KEY = 'dsh-agent-scheduler/deck/mode'
/** How long after 新会话 a newly opened Session is taken as the one the deck created. */
const NEW_SESSION_WINDOW_MS = 20_000

/*
 * Metrics copy the stock workspace browser (dsh-client-ui-workspace): section header 36px with the
 * label at row padding, 28px header icon buttons with 16px glyphs, 32px session rows with a 16px
 * leading slot, 14px title and 10px time. Colours and paddings are the shell's own variables.
 *
 * Class names never contain "brand": themes style `[class*='brand'] svg rect` (dsh-theme-endfield
 * fills those with its accent), which would paint our glyph solid. Rows carry `_sessionRow` and
 * `_selected` in their class names on purpose, so a theme that restyles the stock tree's rows by
 * those substrings restyles the deck's rows the same way.
 */
const CSS = `
.sch-wm{display:inline-flex;align-items:center;gap:6px;min-width:0}
.sch-switch{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;-webkit-app-region:no-drag;letter-spacing:0}
.sch-switch svg{color:inherit}
.sch-switch[aria-pressed=true]{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.sch-switch:hover{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}}
.sch-switch:focus-visible,.sch-deck-icon:focus-visible,.sch-deck_sessionRow:focus-visible,.sch-deck-worker:focus-visible,.sch-deck-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.sch-deck{box-sizing:border-box;min-height:0;flex:1;display:flex;flex-direction:column;padding-right:var(--dsh-sidebar-inline-padding);color:var(--dsw-alias-label-primary);font-size:14px;position:relative}
.sch-deck[data-wide=no]{padding-right:0}
.sch-deck-header{height:36px;box-sizing:border-box;padding-left:var(--dsh-sidebar-row-padding);padding-right:1px;margin:2px -4px 4px 0;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);flex:none;display:flex;align-items:center;justify-content:flex-end;gap:4px;overflow:hidden}
.sch-deck-label{flex:none;white-space:nowrap;line-height:20px;position:relative;left:-1px;margin-right:auto}
.sch-deck-search{flex:1;min-width:0;display:flex;align-items:center;height:32px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:0 4px 0 8px;margin-left:calc(-1 * var(--dsh-sidebar-row-padding) + var(--dsh-sidebar-paint-inset) + 1px);color:var(--dsw-alias-label-caption)}
.sch-deck-search input,.sch-deck-pick-search input{flex:1;min-width:0;border:none;outline:none;background:none;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;margin-left:4px}
.sch-deck-search input::placeholder,.sch-deck-pick-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sch-deck-icon{border:none;background:none;padding:0;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer}
@media (hover:hover){.sch-deck-icon:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck[data-wide=no] .sch-deck-header{justify-content:flex-start;flex-direction:column;height:auto;gap:12px;margin:0 0 12px;padding:0}
.sch-deck[data-wide=no] .sch-deck-icon{width:36px;height:36px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary)}
.sch-deck-list{flex:1;min-height:0;overflow-y:auto;margin-left:-4px;padding-left:4px;padding-bottom:16px;scrollbar-gutter:stable}
.sch-deck-list>*+*{margin-top:2px}
.sch-deck_sessionRow{display:flex;align-items:center;gap:0;height:32px;width:100%;box-sizing:border-box;margin:0;border:none;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;border-radius:var(--dsw-radius-md);background:padding-box;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;user-select:none}
@media (hover:hover){.sch-deck_sessionRow:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck_sessionRow.sch-deck_selected{background-color:var(--dsw-alias-interactive-bg-hover)}
.sch-deck-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption)}
.sch-deck-chev{display:none;border:none;background:none;padding:0;width:16px;height:20px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-xs)}
.sch-deck-chev svg{transition:transform .15s var(--ds-ease-in-out)}
.sch-deck-chev[aria-expanded=true] svg{transform:rotate(90deg)}
.sch-deck_sessionRow[data-has-workers=yes]:hover .sch-deck-pin,.sch-deck_sessionRow[data-expanded=yes] .sch-deck-pin{display:none}
.sch-deck_sessionRow[data-has-workers=yes]:hover .sch-deck-chev,.sch-deck_sessionRow[data-expanded=yes] .sch-deck-chev{display:inline-flex}
.sch-deck-title{flex:1;min-width:0;margin:0 6px 0 var(--dsh-sidebar-label-gap);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.sch-deck-tail{flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;margin-inline-end:-1px}
.sch-deck-remove{display:none;border:none;background:none;padding:0;width:20px;height:20px;align-items:center;justify-content:center;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);cursor:pointer}
@media (hover:hover){.sch-deck_sessionRow:hover .sch-deck-remove{display:inline-flex}.sch-deck_sessionRow:hover .sch-deck-time{display:none}.sch-deck-remove:hover{color:var(--dsw-alias-label-primary)}}
.sch-deck-count{font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sch-deck-tag{font-size:10px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}
.sch-deck-dot{flex:none;width:6px;height:6px;border-radius:50%;box-sizing:border-box;border:1px solid var(--dsw-alias-label-caption);background:transparent}
.sch-deck-dot[data-state=running]{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary));background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary))}
.sch-deck-dot[data-state=waiting]{border-color:var(--dsw-alias-state-warn-primary);background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary) 50%,transparent 50%)}
.sch-deck-dot[data-state=done]{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary)}
.sch-deck-dot[data-state=failed]{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary)}
.sch-deck-workers{display:flex;flex-direction:column;gap:0}
.sch-deck-worker{display:flex;align-items:center;height:28px;width:100%;box-sizing:border-box;margin:0;border:none;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;border-radius:var(--dsw-radius-md);background:padding-box;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
@media (hover:hover){.sch-deck-worker:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sch-deck-glyph{width:16px;flex:none;text-align:center;color:var(--dsw-alias-label-caption);font-size:12px;line-height:20px;font-family:var(--ds-font-family-code)}
.sch-deck-wname{flex:1;min-width:0;margin:0 6px 0 var(--dsh-sidebar-label-gap);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.sch-deck-empty{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:64px;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.sch-deck-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.sch-deck-btn{display:inline-flex;align-items:center;gap:6px;height:30px;box-sizing:border-box;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
@media (hover:hover){.sch-deck-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck-btn[data-primary=yes]{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted)}
.sch-deck-btn:disabled{opacity:.45;cursor:default}
.sch-deck-nomatch{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px;line-height:20px}
.sch-deck-pick{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px;margin:0 0 8px}
.sch-deck-pick-search{display:flex;align-items:center;height:32px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:0 6px 0 8px;margin:0 calc(var(--dsh-sidebar-paint-inset) + 1px);color:var(--dsw-alias-label-caption)}
.sch-deck-pick-list{flex:1;min-height:0;overflow-y:auto;margin-left:-4px;padding-left:4px}
.sch-deck-pick-row{display:flex;align-items:center;gap:8px;height:32px;box-sizing:border-box;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;border-radius:var(--dsw-radius-md);background-clip:padding-box;padding:0 8px 0 calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));cursor:pointer;color:var(--dsw-alias-label-primary)}
@media (hover:hover){.sch-deck-pick-row:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.sch-deck-pick-row input{margin:0;flex:none;accent-color:var(--dsw-alias-label-primary)}
.sch-deck-pick-row .sch-deck-title{margin:0}
.sch-deck-pick-foot{display:flex;justify-content:flex-end;gap:8px;padding:4px calc(var(--dsh-sidebar-paint-inset) + 1px) 0}
`

const svg = (size: number, children: ReactNode) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
/** A primitives icon by name, else a path-only fallback (never `<rect>`, see the CSS note). */
const icon = (name: keyof Primitives, size: number, fallback: ReactNode) => {
  const Icon = primitives()?.[name]
  return Icon !== undefined ? createElement(Icon as never, { size }) : svg(size, fallback)
}
/** 工作区 mode → open the deck: a grid of tiles. */
const DeckGlyph = ({ size = 16 }: { size?: number }) => icon('IconAppsAddOutlineRegular', size, <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM11.5 9.5v4M9.5 11.5h4" />)
/** Deck mode → back to the workspace tree. */
const TreeGlyph = ({ size = 16 }: { size?: number }) => icon('IconWorkspaceTreeOutlineRegular', size, <path d="M3 3h4M3 3v10M3 8h4M3 13h4M9 3h4M9 8h4M9 13h4" />)
const SearchGlyph = ({ size = 16 }: { size?: number }) => icon('IconSearchOutlineRegular', size, <path d="M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5ZM10.25 10.25l3 3" />)
const ImportGlyph = ({ size = 16 }: { size?: number }) => icon('IconPlusOutlineRegular', size, <path d="M8 3v10M3 8h10" />)
const NewGlyph = ({ size = 16 }: { size?: number }) => icon('IconNewChatOutlineRegular', size, <path d="M13 8.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V5a1.5 1.5 0 0 1 1.5-1.5H8M10.5 2.5l3 3-5 5h-3v-3z" />)
const ChevronGlyph = () => icon('IconChevronRightOutlineRegular', 12, <path d="m6 4 4 4-4 4" />)
const PinGlyph = () => icon('IconPinFillRegular', 14, <path d="M8 2.5 9.6 6l3.7.4-2.8 2.5.8 3.6L8 10.6l-3.3 1.9.8-3.6L2.7 6.4 6.4 6Z" />)
const CloseGlyph = ({ size = 14 }: { size?: number }) => icon('IconCloseOutlineRegular', size, <path d="m4 4 8 8M12 4l-8 8" />)

/** A tiny observable value (React reads it through useSyncExternalStore). */
function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { if (Object.is(next, value)) return; value = next; for (const listener of [...listeners]) listener() },
  }
}

/** Sidebar modes persisted in this browser profile; the choice survives reloads and restarts. */
export function createModeStore(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  const store = observable<SidebarMode>(storage?.getItem(MODE_KEY) === 'deck' ? 'deck' : 'workspace')
  const set = (next: SidebarMode) => {
    if (next === store.getSnapshot()) return
    try { storage?.setItem(MODE_KEY, next) } catch { /* private storage keeps the choice for this page */ }
    store.set(next)
  }
  return { get: store.getSnapshot, subscribe: store.subscribe, set, toggle: () => { set(store.getSnapshot() === 'deck' ? 'workspace' : 'deck') } }
}
export type ModeStore = ReturnType<typeof createModeStore>

/**
 * The deck's membership: imported Session ids in this browser profile's storage (the same store
 * the earlier pin list used). It is a view preference of this user in this browser, not Session
 * data: a main-Session log record cannot hold one list across Sessions, and this DSH has no
 * global plugin storage.
 */
export function createMemberStore(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  const store = observable<readonly string[]>(readMembers(storage))
  const commit = (next: readonly string[]) => { writeMembers(storage, next); store.set(next) }
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    add: (ids: readonly string[]) => { if (ids.length > 0) commit(addMembers(store.getSnapshot(), ids)) },
    remove: (id: string) => { commit(removeMember(store.getSnapshot(), id)) },
    has: (id: string) => store.getSnapshot().includes(id),
  }
}
export type MemberStore = ReturnType<typeof createMemberStore>

/** The switch's label for the mode it switches to. */
const switchLabel = (mode: SidebarMode) => t(mode === 'deck' ? 'deck.toWorkspace' : 'deck.toDeck')

/** Compact relative time, as the stock rows print it (「2分钟」, 「1天」). */
export function shortAgo(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return t('deck.short.now')
  if (minutes < 60) return t('deck.short.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? t('deck.short.hours', { count: hours }) : t('deck.short.days', { count: Math.floor(hours / 24) })
}

/** Filter by title, case-insensitively. */
export const matching = <T extends { title?: string | undefined; displayTitle?: string | undefined }>(items: readonly T[], query: string): T[] => {
  const q = query.trim().toLocaleLowerCase()
  return q === '' ? [...items] : items.filter(item => (item.displayTitle ?? item.title ?? '').toLocaleLowerCase().includes(q))
}

/**
 * After 新会话 from the deck, add the Session the shell opens to the deck: the first main-view
 * Session that differs from the one open when the button was pressed, within a short window.
 * @param sessions - the shell's session list store.
 * @param members - the deck membership.
 * @param now - the clock (tests).
 * @returns `expect()` to call right before asking the shell, and a disposer.
 */
export function createNewSessionWatcher(sessions: { subscribe(listener: () => void): () => void; getSnapshot(): unknown } | undefined, members: MemberStore, now: () => number = Date.now) {
  let pending: { before: string | undefined; until: number } | undefined
  const check = () => {
    if (pending === undefined || sessions === undefined) return
    if (now() > pending.until) { pending = undefined; return }
    const current = mainViewSessionId(sessions.getSnapshot() as never)
    if (current === undefined || current === pending.before) return
    pending = undefined
    members.add([current])
  }
  const off = sessions?.subscribe(check)
  return {
    expect: () => { pending = { before: sessions === undefined ? undefined : mainViewSessionId(sessions.getSnapshot() as never), until: now() + NEW_SESSION_WINDOW_MS } },
    check,
    dispose: () => { off?.() },
  }
}

/**
 * Build the deck's sidebar components.
 * @param ctx - the browser plugin context (sessions, uiSession, uiWorkspace, workspaces, locale).
 * @param openWorker - opens a worker's chat in the right pane (same path as the Agents page).
 * @param modes - the mode store.
 * @param members - the membership store.
 * @returns the brand-row name, the body, and the stores.
 */
export function createDeckViews(
  ctx: any,
  openWorker: (parent: string, child: string) => void,
  modes: ModeStore = createModeStore(typeof localStorage === 'undefined' ? undefined : localStorage),
  members: MemberStore = createMemberStore(typeof localStorage === 'undefined' ? undefined : localStorage),
) {
  const sessions = (() => { try { return ctx.get?.('sessions') } catch { return undefined } })()
  const uiSession = (() => { try { return ctx.get?.('uiSession') } catch { return undefined } })()
  const workspace = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  const workspaces = (() => { try { return ctx.get?.('workspaces') } catch { return undefined } })()
  const watcher = createNewSessionWatcher(sessions?.list, members)
  const open = (id: string) => { workspace?.openSession?.(id) }
  /** 新会话 from the deck: the shell's own action, then the opened Session joins the deck. */
  const newSession = () => { watcher.expect(); if (!startStockSession(ctx)) return; watcher.check() }
  const emptyWorkspaces = { pinnedSessionIds: [] as string[], archivedSessionIds: [] as string[] }
  const readWorkspaces = () => (workspaces?.list?.getSnapshot?.() ?? emptyWorkspaces) as { pinnedSessionIds?: string[]; archivedSessionIds?: string[] }
  const subscribeWorkspaces = (listener: () => void) => (workspaces?.list?.subscribe?.(listener) ?? (() => undefined)) as () => void

  /** The brand row's name seat: the official wordmark, then the one switch. */
  function BrandName() {
    useLocale()
    const mode = useSyncExternalStore(modes.subscribe, modes.get, modes.get)
    const Wordmark = primitives()?.BrandWordmark
    const label = switchLabel(mode)
    const stop = (event: { stopPropagation(): void; preventDefault(): void }) => { event.stopPropagation(); event.preventDefault() }
    return (
      <span className="sch-wm" data-scheduler-brand="">
        <style>{CSS}</style>
        {Wordmark === undefined ? null : createElement(Wordmark as never, { includeMark: false })}
        {/* The brand row is itself a button (new session): a span keeps the markup valid, every
            event stops here, and the row's own handler already ignores clicks inside
            [data-copy-version] (its local-build badge), so the row never opens a new session. */}
        <span
          className="sch-switch" role="button" tabIndex={0} data-deck-toggle="brand" data-copy-version="" data-mode={mode}
          aria-label={label} title={label} aria-pressed={mode === 'deck'}
          onPointerDown={event => { event.stopPropagation() }}
          onClick={event => { stop(event); modes.toggle() }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { stop(event); modes.toggle() } }}
        >{mode === 'deck' ? <TreeGlyph size={16} /> : <DeckGlyph size={16} />}</span>
      </span>
    )
  }

  function ImportPicker(props: { rows: readonly DeckSession[]; taken: readonly string[]; archived: readonly string[]; onDone: () => void }) {
    const [query, setQuery] = useState('')
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
    const candidates = matching(importable(props.rows, props.taken, { archived: props.archived }), query)
    const flip = (id: string) => { setChosen(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
    const untitled = stockText(ctx, 'session.untitled', t('deck.untitled'))
    return (
      <div className="sch-deck-pick" data-deck-picker="" role="dialog" aria-label={t('deck.importTitle')}>
        <label className="sch-deck-pick-search">
          <SearchGlyph size={11} />
          <input autoFocus value={query} placeholder={stockText(ctx, 'search.placeholder', t('deck.searchPlaceholder'))} aria-label={t('deck.search')} onChange={event => { setQuery(event.currentTarget.value) }} onKeyDown={event => { if (event.key === 'Escape') props.onDone() }} />
        </label>
        <div className="sch-deck-pick-list">
          {candidates.length === 0 ? <div className="sch-deck-nomatch">{t('deck.importNone')}</div> : candidates.map(session => {
            const title = session.displayTitle ?? session.title ?? untitled
            return (
              <label key={session.id} className="sch-deck-pick-row" data-deck-pick={session.id} title={title}>
                <input type="checkbox" checked={chosen.has(session.id)} onChange={() => { flip(session.id) }} />
                <span className="sch-deck-title">{title}</span>
                <span className="sch-deck-tail">{shortAgo(session.updatedAt ?? 0)}</span>
              </label>
            )
          })}
        </div>
        <div className="sch-deck-pick-foot">
          <button type="button" className="sch-deck-btn" data-deck-pick-cancel="" onClick={props.onDone}>{t('deck.cancel')}</button>
          <button type="button" className="sch-deck-btn" data-primary="yes" data-deck-pick-confirm="" disabled={chosen.size === 0} onClick={() => { members.add([...chosen]); props.onDone() }}>{chosen.size === 0 ? t('deck.import') : t('deck.importCount', { count: chosen.size })}</button>
        </div>
      </div>
    )
  }

  function DeckBody(props: { wide?: boolean; expandSidebar?: () => void }) {
    useLocale()
    const wide = props.wide !== false
    const ids = useSyncExternalStore(members.subscribe, members.getSnapshot, members.getSnapshot)
    const shell = useSyncExternalStore(subscribeWorkspaces, readWorkspaces, readWorkspaces)
    const list: any = sessions === undefined ? undefined : useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
    const statuses = uiSession === undefined ? undefined : useSyncExternalStore(uiSession.sessionStatus.subscribe, uiSession.sessionStatus.getSnapshot, uiSession.sessionStatus.getSnapshot)
    const [query, setQuery] = useState('')
    const [searching, setSearching] = useState(false)
    const [picking, setPicking] = useState(false)
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
    const rows: DeckSession[] = list === undefined || list === null ? [] : (list.ids as string[]).map((id: string) => list.byId[id]).filter((row: unknown): row is DeckSession => row !== undefined && row !== null)
    const current = mainViewSessionId(list)
    // A draft reads 「新会话」 like the stock tree (its summary title is the workspace name).
    const draftTitle = stockText(ctx, 'session.new', t('deck.newSession'))
    const all = deckRows(rows, statuses as ReadonlyMap<string, DeckStatus> | undefined, ids, { pinned: shell.pinnedSessionIds, archived: shell.archivedSessionIds })
      .map(card => card.blank ? { ...card, title: draftTitle } : card)
    const cards = matching(all, query)
    const newLabel = stockText(ctx, 'actions.newSession', t('deck.newSession'))
    const importButton = (size: number) => (
      <button type="button" className="sch-deck-icon" data-deck-import="" aria-label={t('deck.import')} title={t('deck.import')} onClick={() => { props.expandSidebar?.(); setPicking(true) }}><ImportGlyph size={size} /></button>
    )
    const newButton = (size: number) => (
      <button type="button" className="sch-deck-icon" data-deck-new="" aria-label={newLabel} title={newLabel} onClick={newSession}><NewGlyph size={size} /></button>
    )
    if (!wide) {
      // The rail: no switch here (it lives beside the brand, hidden on the rail). Search expands
      // the sidebar like the stock rail; the shell's own 新会话 button stays above.
      return (
        <div className="sch-deck" data-scheduler-deck="" data-wide="no">
          <style>{CSS}</style>
          <div className="sch-deck-header">
            <button type="button" className="sch-deck-icon" data-deck-search="" aria-label={t('deck.search')} title={t('deck.search')} onClick={() => { props.expandSidebar?.(); setSearching(true) }}><SearchGlyph size={18} /></button>
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
      const selected = card.id === current
      const tail = card.state === 'waiting'
        ? <>{t('deck.waitingYou')}{card.approvals > 0 ? <> · <span className="sch-deck-tag" data-deck-approvals={card.approvals}>{t('deck.pending', { count: card.approvals })}</span></> : null}</>
        : shortAgo(card.lastActivity)
      const removeLabel = t('deck.remove', { title: card.title })
      return (
        <div key={card.id} data-deck-card={card.id} data-lead={card.lead} data-state={card.state}>
          <div
            className={selected ? 'sch-deck_sessionRow sch-deck_selected' : 'sch-deck_sessionRow'} role="button" tabIndex={0} aria-current={selected ? 'page' : undefined}
            data-deck-open={card.id} data-selected={selected ? 'yes' : 'no'} data-has-workers={hasWorkers ? 'yes' : 'no'} data-expanded={open_ ? 'yes' : 'no'} title={card.title}
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
              <span className="sch-deck-time">{tail}</span>
              <button type="button" className="sch-deck-remove" data-deck-remove={card.id} aria-label={removeLabel} title={removeLabel} onClick={event => { event.stopPropagation(); members.remove(card.id) }}><CloseGlyph size={12} /></button>
            </span>
          </div>
          {open_ && hasWorkers ? (
            <div className="sch-deck-workers" data-deck-workers-of={card.id}>{card.workers.map((worker, i) => workerRow(card, worker, i === card.workers.length - 1))}</div>
          ) : null}
        </div>
      )
    }
    return (
      <div className="sch-deck" data-scheduler-deck="" data-wide="yes">
        <style>{CSS}</style>
        <div className="sch-deck-header">
          {searching ? (
            <label className="sch-deck-search" data-deck-search-open="">
              <SearchGlyph size={11} />
              <input autoFocus value={query} placeholder={stockText(ctx, 'search.placeholder', t('deck.searchPlaceholder'))} aria-label={t('deck.search')} onChange={event => { setQuery(event.currentTarget.value) }} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearching(false) } }} onBlur={() => { if (query === '') setSearching(false) }} />
            </label>
          ) : (
            <>
              <span className="sch-deck-label">{t('deck.title')}</span>
              <button type="button" className="sch-deck-icon" data-deck-search="" aria-label={t('deck.search')} title={t('deck.search')} onClick={() => { setSearching(true) }}><SearchGlyph size={14} /></button>
              {importButton(16)}
              {newButton(16)}
            </>
          )}
        </div>
        {picking ? (
          <ImportPicker rows={rows} taken={ids} archived={shell.archivedSessionIds ?? []} onDone={() => { setPicking(false) }} />
        ) : (
          <div className="sch-deck-list" data-deck-list="">
            {all.length === 0 ? (
              <div className="sch-deck-empty" data-deck-empty="">
                <span>{t('deck.emptyDeck')}</span>
                <span className="sch-deck-empty-actions">
                  <button type="button" className="sch-deck-btn" data-deck-empty-import="" onClick={() => { setPicking(true) }}><ImportGlyph size={14} />{t('deck.import')}</button>
                  <button type="button" className="sch-deck-btn" data-deck-empty-new="" onClick={newSession}><NewGlyph size={14} />{newLabel}</button>
                </span>
              </div>
            ) : null}
            <div data-deck-section="members">{cards.map(row)}</div>
            {all.length > 0 && query !== '' && cards.length === 0 ? <div className="sch-deck-nomatch">{t('deck.noMatch')}</div> : null}
          </div>
        )}
      </div>
    )
  }

  return { BrandName, DeckBody, modes, members, newSession, watcher }
}

/**
 * Register the deck: the brand-row switch (only beside an official wordmark), the body in the
 * browsing region only while 指挥台 is chosen, and 「加入指挥台」 in the stock session menu.
 * `deck.enabled` off registers nothing.
 * @param ctx - the browser plugin context.
 * @param openWorker - opens a worker's chat in the right pane.
 * @param modes - the mode store (tests).
 * @param members - the membership store (tests).
 * @returns the stores (tests and the GUI drive them).
 */
export function registerDeck(ctx: any, openWorker: (parent: string, child: string) => void, modes?: ModeStore, members?: MemberStore): { modes: ModeStore; members: MemberStore; newSession: () => void } {
  const source = configSource<{ deck?: { enabled?: boolean } }>(ctx, HOST_NS)
  const views = createDeckViews(ctx, openWorker, modes, members)
  let brandDispose: (() => void) | undefined
  let bodyDispose: (() => void) | undefined
  let menuDispose: (() => void) | undefined
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
      menuDispose?.(); menuDispose = undefined
      return
    }
    watchers = [views.modes.subscribe(syncBody), watchSlot(ctx, SLOT.brandName, syncBrand)]
    menuDispose = registerSessionMenu(ctx, 'agent-scheduler.deck', 150, [views.members], sessionId => [
      views.members.has(sessionId)
        ? { id: 'deck-remove', label: t('deck.menuRemove'), run: () => { views.members.remove(sessionId) } }
        : { id: 'deck-add', label: t('deck.menuAdd'), run: () => { views.members.add([sessionId]) } },
    ])
    syncBrand()
    syncBody()
  }
  const enabledOf = (snapshot: { status: string; value?: { deck?: { enabled?: boolean } } } | undefined): boolean =>
    snapshot === undefined || snapshot.status !== 'ready' ? true : snapshot.value?.deck?.enabled !== false
  apply(enabledOf(source?.get()))
  source?.subscribe(() => { apply(enabledOf(source.get())) })
  return { modes: views.modes, members: views.members, newSession: views.newSession }
}
