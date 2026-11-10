/**
 * The focus deck, in-place in the left sidebar: a 工作区 | 指挥台 switch in the sidebar header
 * swaps the stock workspace tree for compact cards of the pinned Sessions. The deck never
 * replaces the centre conversation or the right pane, and 工作区 mode is the shell's own tree —
 * the deck's occupancy of `sidebar.workspaces` is withdrawn, so the stock registrant renders.
 *
 * Slot facts this relies on (contract-tested): a `single` slot renders its first live entry in
 * priority order, so a dynamic entry with `priority: -1` shadows the shipped tree while it is
 * registered; withdrawing it restores the shipped entry untouched. A single slot cannot render
 * the entry it displaced, which is why 工作区 mode withdraws instead of wrapping.
 * @module dsh-agent-scheduler/client/deck
 */
import { useSyncExternalStore } from 'react'
import { configSource, registerLiveSlot, SLOT } from '../dsh/client/ui.js'
import { t, useLocale } from './i18n.js'
import { cardOf, deckOf, readPins, togglePin, writePins, type DeckCard, type DeckSession, type DeckStatus } from './deck-model.js'
import { rowStateOf } from './row-state.js'

/** The host row's settings namespace (see src/client/recovery-config.tsx). */
const HOST_NS = 'dsh-agent-scheduler'
/** Which sidebar content the user chose. */
export type SidebarMode = 'workspace' | 'deck'
const MODE_KEY = 'dsh-agent-scheduler/deck/mode'
const PIN_KEY = 'dsh-agent-scheduler/deck/pinned'

const CSS = `
.sch-deck-switch{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.12));max-width:100%}
.sch-deck-switch button{border:0;background:none;padding:2px 7px;border-radius:6px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:16px;cursor:pointer;white-space:nowrap}
.sch-deck-switch button[data-active=yes]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.sch-deck-switch button:hover:not([data-active=yes]){color:var(--dsw-alias-label-primary)}
.sch-deck{box-sizing:border-box;height:100%;overflow:auto;padding:10px 8px 16px;color:var(--dsw-alias-label-primary);font-size:13px}
.sch-deck-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:2px 4px 8px}
.sch-deck-title{font-size:13px;font-weight:600;line-height:20px}
.sch-deck-switch-inline{display:inline-flex}
.sch-deck-section{margin:0 0 12px}
.sch-deck-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin:0 4px 4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-deck-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;border:0;background:none;padding:5px 6px;border-radius:8px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.sch-deck-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-deck-row[data-selected=yes]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.sch-deck-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,#888)}
.sch-deck-dot[data-state=running]{background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sch-deck-dot[data-state=waiting]{background:var(--dsw-alias-state-warn-primary,#d9a441)}
.sch-deck-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary,#e5484d)}
.sch-deck-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.sch-deck-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:17px}
.sch-deck-badges{display:flex;flex-wrap:wrap;gap:2px 7px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:15px;min-width:0}
.sch-deck-chev{flex:none;border:0;background:none;padding:0 2px;color:var(--dsw-alias-label-caption);cursor:pointer;border-radius:4px;line-height:1}
.sch-deck-chev:hover{color:var(--dsw-alias-label-primary)}
.sch-deck-star{flex:none;border:0;background:none;padding:0 3px;border-radius:4px;color:var(--dsw-alias-label-caption);cursor:pointer;font-size:12px;line-height:1}
.sch-deck-star[data-pinned=yes]{color:var(--dsw-alias-state-warn-primary,#d9a441)}
.sch-deck-star:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-deck-workers{margin:1px 0 2px 18px;padding:0 0 0 6px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));display:flex;flex-direction:column;gap:1px}
.sch-deck-worker{display:flex;align-items:center;gap:6px;border:0;background:none;padding:3px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;min-width:0}
.sch-deck-worker:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-deck-worker-name{flex:none;max-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.sch-deck-worker-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.sch-deck-empty{margin:0 4px;padding:10px 10px;border:.5px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:16px}
.sch-deck-note{margin:10px 4px 0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:16px}
`

/** Sidebar modes persisted in this browser profile; the choice survives reloads and restarts. */
export function createModeStore(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let value: SidebarMode = storage?.getItem(MODE_KEY) === 'workspace' ? 'workspace' : 'deck'
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
  }
}

/** Pins: the shell's own workspace pins when that service exists, else the plugin's browser list. */
function pinStore(ctx: any, storage: Storage | undefined) {
  const workspaces = (() => { try { return ctx.get?.('workspaces') } catch { return undefined } })()
  const uiWorkspace = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  if (workspaces?.list !== undefined && typeof workspaces.list.getSnapshot === 'function' && typeof uiWorkspace?.pinSession === 'function') {
    return {
      get: () => (workspaces.list.getSnapshot().pinnedSessionIds ?? []) as string[],
      subscribe: (listener: () => void) => workspaces.list.subscribe(listener) as () => void,
      toggle: (id: string) => {
        const pinned = (workspaces.list.getSnapshot().pinnedSessionIds ?? []).includes(id)
        void (pinned ? uiWorkspace.unpinSession(id) : uiWorkspace.pinSession(id)).catch?.(() => undefined)
      },
    }
  }
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
 * Build the deck's sidebar components.
 * @param ctx - the browser plugin context (sessions, uiSession, uiWorkspace, workspaces).
 * @param openWorker - opens a worker's chat in the right pane (same path as the Agents page).
 * @returns the switch and the body.
 */
export function createDeckViews(ctx: any, openWorker: (parent: string, child: string) => void) {
  const modes = createModeStore(typeof localStorage === 'undefined' ? undefined : localStorage)
  const pins = pinStore(ctx, typeof localStorage === 'undefined' ? undefined : localStorage)
  const sessions = (() => { try { return ctx.get?.('sessions') } catch { return undefined } })()
  const uiSession = (() => { try { return ctx.get?.('uiSession') } catch { return undefined } })()
  const workspace = (() => { try { return ctx.get?.('uiWorkspace') } catch { return undefined } })()
  const open = (id: string) => { workspace?.openSession?.(id); modes.set('workspace') }

  function ModeSwitch(props: { inline?: boolean }) {
    useLocale()
    const mode = useSyncExternalStore(modes.subscribe, modes.get, modes.get)
    return (
      <span className="sch-deck-switch" data-deck-switch="" data-inline={props.inline === true ? 'yes' : 'no'} role="tablist" aria-label={t('deck.switch')}>
        <button type="button" role="tab" data-deck-mode="workspace" data-active={mode === 'workspace' ? 'yes' : 'no'} aria-selected={mode === 'workspace'} onClick={() => { modes.set('workspace') }}>{t('deck.mode.workspace')}</button>
        <button type="button" role="tab" data-deck-mode="deck" data-active={mode === 'deck' ? 'yes' : 'no'} aria-selected={mode === 'deck'} onClick={() => { modes.set('deck') }}>{t('deck.mode.deck')}</button>
      </span>
    )
  }

  function DeckBody() {
    useLocale()
    const pinned = useSyncExternalStore(pins.subscribe, pins.get, pins.get)
    const list: any = sessions === undefined ? undefined : useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
    const statuses = uiSession === undefined ? undefined : useSyncExternalStore(uiSession.sessionStatus.subscribe, uiSession.sessionStatus.getSnapshot, uiSession.sessionStatus.getSnapshot)
    const rows: DeckSession[] = list === undefined || list === null ? [] : (list.ids as string[]).map((id: string) => list.byId[id]).filter((row: unknown): row is DeckSession => row !== undefined && row !== null)
    const { pinned: cards, attention } = deckOf(rows, statuses as ReadonlyMap<string, DeckStatus> | undefined, pinned)
    const [openId, setOpenId] = useExpanded()
    const card = (c: DeckCard) => {
      const roster = rosterOfCard(c.id, rows)
      const members = (roster?.members ?? []).filter(m => m.kind === 'worker')
      const expanded = openId === c.id
      return (
        <div key={c.id} data-deck-card={c.id} data-lead={c.lead}>
          <button type="button" className="sch-deck-row" data-deck-open={c.id} title={c.title} onClick={() => { open(c.id) }}>
            <span className="sch-deck-dot" data-state={c.lead === 'waiting' ? 'waiting' : c.lead === 'running' ? 'running' : 'idle'} />
            <span className="sch-deck-body">
              <span className="sch-deck-name">{c.title}</span>
              <span className="sch-deck-badges">
                {c.runningWorkers === 0 ? null : <span data-deck-workers={c.runningWorkers}>{t('deck.meta.workers', { count: c.runningWorkers })}</span>}
                {c.inbox === 0 ? null : <span data-deck-inbox={c.inbox}>{t('deck.meta.inbox', { count: c.inbox })}</span>}
                {c.approvals === 0 ? null : <span data-deck-approvals={c.approvals}>{t('deck.meta.approvals', { count: c.approvals })}</span>}
                <span>{ago(c.lastActivity)}</span>
              </span>
            </span>
            {members.length === 0 ? null : (
              <span className="sch-deck-chev" role="button" tabIndex={0} data-deck-expand={c.id} aria-expanded={expanded} aria-label={t(expanded ? 'deck.collapse' : 'deck.expand', { title: c.title })} onClick={event => { event.stopPropagation(); setOpenId(expanded ? undefined : c.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setOpenId(expanded ? undefined : c.id) } }}>{expanded ? '▾' : '▸'}</span>
            )}
            <span className="sch-deck-star" role="button" tabIndex={0} data-deck-star={c.id} data-pinned={c.pinned ? 'yes' : 'no'} aria-label={t(c.pinned ? 'deck.action.unpin' : 'deck.action.pin', { title: c.title })} onClick={event => { event.stopPropagation(); pins.toggle(c.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); pins.toggle(c.id) } }}>{c.pinned ? '★' : '☆'}</span>
          </button>
          {members.length === 0 || !expanded ? null : (
            <div className="sch-deck-workers" data-deck-workers-of={c.id}>
              {members.map(member => {
                const state = rowStateOf(member, statuses as never)
                return (
                  <button key={member.id} type="button" className="sch-deck-worker" data-deck-worker={member.id} data-state={state} title={member.text} onClick={() => { openWorker(c.id, member.id) }}>
                    <span className="sch-deck-dot" data-state={state} />
                    <span className="sch-deck-worker-name">{member.name}</span>
                    <span className="sch-deck-worker-text">{member.text}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )
    }
    return (
      <div className="sch-deck" data-scheduler-deck="" data-mode="deck">
        <style>{CSS}</style>
        <div className="sch-deck-head">
          <span className="sch-deck-title">{t('deck.title')}</span>
          <ModeSwitch inline />
        </div>
        <section className="sch-deck-section" data-deck-section="pinned">
          <div className="sch-deck-section-head"><span>{t('deck.pinned')}</span><span>{cards.length}</span></div>
          {cards.length === 0 ? <div className="sch-deck-empty">{t('deck.pinnedEmpty')}</div> : cards.map(card)}
        </section>
        <section className="sch-deck-section" data-deck-section="attention">
          <div className="sch-deck-section-head"><span>{t('deck.attention')}</span><span>{attention.length}</span></div>
          {attention.length === 0 ? <div className="sch-deck-empty">{t('deck.empty')}</div> : attention.map(card)}
        </section>
        <p className="sch-deck-note">{t('deck.note')}</p>
      </div>
    )
  }

  return { ModeSwitch, DeckBody, modes }
}

/** The roster view of one card's Session, from the summary rows. */
function rosterOfCard(id: string, rows: readonly DeckSession[]) {
  const row = rows.find(r => r.id === id)
  const value = row?.projectionValues?.agentScheduler
  return value === null || typeof value !== 'object' ? undefined : value as { members?: readonly { id: string; kind: string; state: string; name: string; text: string }[] }
}

/** Expansion state for the pinned rows. */
function useExpanded() {
  // A tiny external store keeps sibling rows in sync without a context provider.
  const store = expandedStore()
  const value = (useSyncExternalStore(store.subscribe, store.get, store.get) as string | null) ?? undefined
  return [value, (id: string | undefined) => { store.set(id ?? null) }] as const
}
let sharedExpanded: { get: () => string | null; subscribe: (listener: () => void) => () => void; set: (id: string | null) => void } | undefined
function expandedStore() {
  if (sharedExpanded !== undefined) return sharedExpanded
  let value: string | null = null
  const listeners = new Set<() => void>()
  sharedExpanded = {
    get: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (id: string | null) => { if (id === value) return; value = id; for (const listener of listeners) listener() },
  }
  return sharedExpanded
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
 * Register the sidebar mode: the 工作区 | 指挥台 switch in the header, and the deck body occupying
 * the browsing region only while 指挥台 is chosen (工作区 withdraws it, so the stock tree renders).
 * @param ctx - the browser plugin context.
 * @param openWorker - opens a worker's chat in the right pane.
 */
export function registerDeck(ctx: any, openWorker: (parent: string, child: string) => void): { modes: ReturnType<typeof createModeStore> } {
  const source = configSource<{ deck?: { enabled?: boolean } }>(ctx, HOST_NS)
  const views = createDeckViews(ctx, openWorker)
  let switchDispose: (() => void) | undefined
  let bodyDispose: (() => void) | undefined
  let modeDispose: (() => void) | undefined
  let enabled: boolean | undefined
  const syncBody = () => {
    const deck = views.modes.get() === 'deck'
    if (deck && bodyDispose === undefined) bodyDispose = registerLiveSlot(ctx, SLOT.workspaces, { priority: -1 }, views.DeckBody)
    if (!deck && bodyDispose !== undefined) { bodyDispose(); bodyDispose = undefined }
  }
  const apply = (on: boolean) => {
    if (on === enabled) return
    enabled = on
    if (!on) {
      switchDispose?.(); switchDispose = undefined
      bodyDispose?.(); bodyDispose = undefined
      modeDispose?.(); modeDispose = undefined
      return
    }
    switchDispose = registerLiveSlot(ctx, SLOT.brandName, { priority: -1 }, views.ModeSwitch)
    modeDispose = views.modes.subscribe(syncBody)
    syncBody()
  }
  const enabledOf = (snapshot: { status: string; value?: { deck?: { enabled?: boolean } } } | undefined): boolean =>
    snapshot === undefined || snapshot.status !== 'ready' ? true : snapshot.value?.deck?.enabled !== false
  apply(enabledOf(source?.get()))
  source?.subscribe(() => { apply(enabledOf(source.get())) })
  return { modes: views.modes }
}
