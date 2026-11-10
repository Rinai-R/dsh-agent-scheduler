/**
 * The focus deck: a left-sidebar panel listing the Sessions the user pinned, as live cards, plus
 * the unpinned Sessions with something waiting. It is the shell's own `sidebar.panellist` list
 * entry plus a `main` keyed panel body; the plugin config (`deck.enabled`) turns both off.
 * @module dsh-agent-scheduler/client/deck
 */
import { useSyncExternalStore } from 'react'
import { configSource, registerLiveSlot, SLOT } from '../dsh/client/ui.js'
import { t, useLocale } from './i18n.js'
import { cardOf, deckOf, readPins, togglePin, writePins, type DeckCard, type DeckSession, type DeckStatus } from './deck-model.js'

/** Panel id shared by the sidebar entry and the `main` panel. */
export const DECK_PANEL_ID = 'agent-scheduler-deck'
/** The host row's settings namespace (see src/client/recovery-config.tsx). */
const HOST_NS = 'dsh-agent-scheduler'

const CSS = `
.sch-deck{box-sizing:border-box;height:100%;overflow:auto;padding:20px 24px 32px;color:var(--dsw-alias-label-primary);font-size:13px}
.sch-deck h2{margin:0 0 2px;font-size:16px;font-weight:600;line-height:24px}
.sch-deck-lead{margin:0 0 16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
.sch-deck-section{margin:0 0 18px}
.sch-deck-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);letter-spacing:.02em;text-transform:uppercase}
.sch-deck-card{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;margin:0 0 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.sch-deck-card[data-lead=waiting]{border-color:var(--dsw-alias-state-warn-primary,#d9a441)}
.sch-deck-card[data-lead=running]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sch-deck-body{flex:1;min-width:0}
.sch-deck-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-deck-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:4px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:16px}
.sch-deck-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.sch-deck-state[data-lead=running]{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sch-deck-state[data-lead=waiting]{color:var(--dsw-alias-state-warn-primary,#d9a441)}
.sch-deck-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.sch-deck-act{border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:none;padding:4px 10px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-deck-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-deck-star{flex:none;border:0;background:none;padding:2px 4px;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;line-height:1}
.sch-deck-star[data-pinned=yes]{color:var(--dsw-alias-state-warn-primary,#d9a441)}
.sch-deck-star:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-deck-empty{padding:14px 16px;border:.5px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:12px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
.sch-deck-note{margin:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:18px}
`

/** The panel strip icon: a deck of cards. */
function DeckIcon(props: { size?: number; active?: boolean }) {
  const size = props.size ?? 18
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="8" rx="1.6" /><path d="M6 15.5h11.5" /><path d="M16 4.5v7" /></svg>
}

/** Stored pins, shared by the page and the icon strip (one store, so both re-render). */
function pinStore(storage: Storage | undefined) {
  let value = readPins(storage)
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toggle: (id: string) => { value = togglePin(value, id); writePins(storage, value); notify() },
  }
}

/**
 * Build the deck's page component.
 * @param ctx - the browser plugin context (closed over: sessions, uiSession, uiWorkspace).
 * @param openAgents - opens this plugin's Agents page for the Session the user just opened.
 * @returns the React component.
 */
export function createDeckPage(ctx: any, openAgents: () => void) {
  const pins = pinStore(typeof localStorage === 'undefined' ? undefined : localStorage)
  const sessions = (() => { try { return ctx.get?.('sessions') } catch { return undefined } })()
  const uiSession = (() => { try { return ctx.get?.('uiSession') } catch { return undefined } })()
  const workspace = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  const open = (id: string) => { workspace?.openSession?.(id) }
  return function DeckPage() {
    useLocale()
    const pinned = useSyncExternalStore(pins.subscribe, pins.get, pins.get)
    const list: any = sessions === undefined ? undefined : useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
    const statuses = uiSession === undefined ? undefined : useSyncExternalStore(uiSession.sessionStatus.subscribe, uiSession.sessionStatus.getSnapshot, uiSession.sessionStatus.getSnapshot)
    const rows: DeckSession[] = list === undefined || list === null ? [] : (list.ids as string[]).map((id: string) => list.byId[id]).filter((row: unknown): row is DeckSession => row !== undefined && row !== null)
    const { pinned: cards, attention } = deckOf(rows, statuses as ReadonlyMap<string, DeckStatus> | undefined, pinned)
    const card = (c: DeckCard) => (
      <div key={c.id} className="sch-deck-card" data-deck-card={c.id} data-lead={c.lead}>
        <div className="sch-deck-body">
          <div className="sch-deck-title" title={c.title}>{c.title}</div>
          <div className="sch-deck-meta">
            <span className="sch-deck-state" data-lead={c.lead}>{t(c.lead === 'running' ? 'deck.state.running' : c.lead === 'waiting' ? 'deck.state.waiting' : 'deck.state.idle')}</span>
            {c.runningWorkers === 0 ? null : <span data-deck-workers={c.runningWorkers}>{t('deck.meta.workers', { count: c.runningWorkers })}</span>}
            {c.inbox === 0 ? null : <span data-deck-inbox={c.inbox}>{t('deck.meta.inbox', { count: c.inbox })}</span>}
            {c.approvals === 0 ? null : <span data-deck-approvals={c.approvals}>{t('deck.meta.approvals', { count: c.approvals })}</span>}
            <span>{ago(c.lastActivity)}</span>
          </div>
          <div className="sch-deck-actions">
            <button type="button" className="sch-deck-act" data-deck-open={c.id} onClick={() => { open(c.id) }}>{t('deck.action.open')}</button>
            <button type="button" className="sch-deck-act" data-deck-agents={c.id} onClick={() => { open(c.id); openAgents() }}>{t('deck.action.agents')}</button>
          </div>
        </div>
        <button type="button" className="sch-deck-star" data-deck-star={c.id} data-pinned={c.pinned ? 'yes' : 'no'} aria-label={t(c.pinned ? 'deck.action.unpin' : 'deck.action.pin', { title: c.title })} title={t(c.pinned ? 'deck.action.unpin' : 'deck.action.pin', { title: c.title })} onClick={() => { pins.toggle(c.id) }}>{c.pinned ? '★' : '☆'}</button>
      </div>
    )
    return (
      <div className="sch-deck" data-scheduler-deck="">
        <style>{CSS}</style>
        <h2>{t('deck.title')}</h2>
        <p className="sch-deck-lead">{t('deck.lead')}{sessions === undefined ? ` ${t('deck.unavailable')}` : ''}</p>
        <section className="sch-deck-section" data-deck-section="pinned">
          <div className="sch-deck-head"><span>{t('deck.pinned')}</span><span>{cards.length}</span></div>
          {cards.length === 0 ? <div className="sch-deck-empty">{t('deck.pinnedEmpty')}</div> : cards.map(card)}
        </section>
        <section className="sch-deck-section" data-deck-section="attention">
          <div className="sch-deck-head"><span>{t('deck.attention')}</span><span>{attention.length}</span></div>
          {attention.length === 0 ? <div className="sch-deck-empty">{t('deck.empty')}</div> : attention.map(card)}
        </section>
        <p className="sch-deck-note">{t('deck.note')}</p>
      </div>
    )
  }
}

/** Relative time of the last activity, in the user's language. */
function ago(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return t('deck.ago.now')
  if (minutes < 60) return t('deck.ago.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  return hours < 24 ? t('deck.ago.hours', { count: hours }) : t('deck.ago.days', { count: Math.round(hours / 24) })
}

/**
 * Register the sidebar entry and the panel body while `deck.enabled` is on.
 * @param ctx - the browser plugin context.
 * @param openAgents - opens the Agents page for the Session to open first.
 * @returns nothing; the registration is disposed with the plugin.
 */
export function registerDeck(ctx: any, openAgents: () => void): void {
  const source = configSource<{ deck?: { enabled?: boolean } }>(ctx, HOST_NS)
  const Page = createDeckPage(ctx, openAgents)
  let dispose: (() => void) | undefined
  let shown: boolean | undefined
  const apply = (enabled: boolean) => {
    if (enabled === shown) return
    shown = enabled
    dispose?.()
    dispose = undefined
    if (!enabled) return
    const a = registerLiveSlot(ctx, SLOT.panelList, { id: DECK_PANEL_ID, order: 5, label: () => t('deck.panel') }, DeckIcon)
    const b = registerLiveSlot(ctx, SLOT.mainPanel, { key: DECK_PANEL_ID }, Page)
    dispose = () => { a(); b() }
  }
  const enabledOf = (snapshot: { status: string; value?: { deck?: { enabled?: boolean } } } | undefined): boolean =>
    snapshot === undefined || snapshot.status !== 'ready' ? true : snapshot.value?.deck?.enabled !== false
  apply(enabledOf(source?.get()))
  source?.subscribe(() => { apply(enabledOf(source.get())) })
}
