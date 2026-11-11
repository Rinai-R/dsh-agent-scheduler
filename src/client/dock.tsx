/**
 * The session dock and the inbox card (design phase 2 §3): what replaced the Agents page and the
 * deck. Both sit in `conversation.input.dock`, the per-Session list above the composer where DSH's
 * own Todo dock sits, and both show only when there is something to show.
 *
 * The dock, top to bottom: a summary line with the 调度 switch (collapsible to just that line,
 * remembered); the inbox count; `← parent` and its other workers when another session created this
 * one; this session's workers (dot, name, current request, unread and queued counts; click opens
 * the worker, hover offers a quick message, rename, archive and, for old subagent workers,
 * convert); a footer with 新建 worker and 全部标为已读. Every action is a command of this session,
 * the same as typing it.
 *
 * Class names are `sch-dock-*` only (the endfield theme restyles any class containing "brand"),
 * and colours come from the host theme's variables.
 * @module dsh-agent-scheduler/client/dock
 */
import { memo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { reviewOf } from '../review.js'
import { mailPreview } from '../mail.js'
import type { MailItem } from '../projection.js'
import { rowStateOf, type RowState } from './row-state.js'
import { t, tn, useLocale } from './i18n.js'
import type { Face, Statuses, UseSessionStatus } from '../dsh/client/index.js'

/** The roster fields the dock reads (the host's `agentScheduler` projection view). */
export interface DockMember {
  readonly id: string
  readonly name: string
  readonly kind: 'fork' | 'worker'
  readonly state: string
  readonly text: string
  readonly role?: string | undefined
  readonly session?: true | undefined
  readonly reportedAt?: number | undefined
  readonly reportFailed?: true | undefined
  readonly seenAt?: number | undefined
}
export interface DockRoster {
  readonly enabled: boolean
  readonly members: readonly DockMember[]
  readonly openRequests: readonly { readonly id: string; readonly from: string; readonly to: string; readonly text: string }[]
  readonly inbox?: readonly MailItem[] | undefined
  readonly owner?: { readonly router: string; readonly name: string; readonly role?: string | undefined } | undefined
}

export type DockDot = 'running' | 'waiting' | 'idle' | 'failed' | 'queued'

export interface DockRow {
  readonly id: string
  readonly name: string
  readonly dot: DockDot
  /** The request it works on (or the oldest one it has), one line. */
  readonly request?: string | undefined
  readonly unread: number
  /** Requests waiting behind the current one. */
  readonly queued: number
  /** A top-level session worker (opens in the centre); false: an old subagent worker. */
  readonly session: boolean
}

export interface DockModel {
  readonly visible: boolean
  readonly on: boolean
  readonly inbox: number
  readonly unread: number
  readonly parent?: { readonly id: string; readonly name: string } | undefined
  /** Me among my parent's workers, with my siblings (mine marked). */
  readonly siblings: readonly { readonly id: string; readonly name: string; readonly dot: DockDot; readonly me: boolean }[]
  readonly workers: readonly DockRow[]
}

const flat = (text: string, max = 80): string => {
  const one = text.replace(/\s+/gu, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Strip the scheduler's framing from a request text for the one-line row. */
const requestLine = (text: string): string => flat(text.replace(/^\[request r-\d+ from [^\]]*\]\s*/u, '').replace(/^## Goal\s*/u, '').split('\n## ')[0] ?? '')

const dotOf = (state: RowState): DockDot =>
  state === 'running' || state === 'waiting' || state === 'failed' || state === 'queued' ? state : 'idle'

const live = (m: DockMember) => m.kind === 'worker' && m.state !== 'archived'

/**
 * What the dock shows for one session.
 * @param roster - the session's roster view.
 * @param statuses - live Session statuses (running / waiting for you).
 * @param parentRoster - the creator's roster view, when this session is a worker and it is loaded.
 * @param self - this session's id.
 */
export function dockModel(roster: DockRoster | undefined, statuses: Statuses | undefined, parentRoster: DockRoster | undefined, self: string): DockModel {
  const members = roster?.members ?? []
  const workers: DockRow[] = members.filter(live).map(m => {
    const open = (roster?.openRequests ?? []).filter(r => r.to === m.id)
    const state = rowStateOf(m as never, statuses as never)
    return {
      id: m.id, name: m.name, dot: dotOf(state),
      ...(open[0] === undefined ? {} : { request: requestLine(open[0].text) }),
      unread: reviewOf(m as never) === undefined ? 0 : 1,
      queued: Math.max(0, open.length - 1),
      session: m.session === true,
    }
  })
  const owner = roster?.owner
  const siblings = owner === undefined || parentRoster === undefined ? [] : parentRoster.members.filter(live).map(m => ({
    id: m.id, name: m.name, dot: dotOf(rowStateOf(m as never, statuses as never)), me: m.id === self,
  }))
  const inbox = roster?.inbox?.length ?? 0
  const unread = workers.reduce((n, w) => n + w.unread, 0)
  return {
    visible: workers.length > 0 || owner !== undefined || inbox > 0,
    on: roster?.enabled === true,
    inbox, unread, workers, siblings,
    ...(owner === undefined ? {} : { parent: { id: owner.router, name: parentRoster === undefined ? owner.router.slice(0, 16) : t('dock.parent.session') } }),
  }
}

/** The summary line's text, e.g. 「3 个 worker · 1 个运行中 · 1 条未读」. */
export function dockSummary(model: DockModel): string {
  const parts = [tn('dock.workers', model.workers.length)]
  const running = model.workers.filter(w => w.dot === 'running').length
  const waiting = model.workers.filter(w => w.dot === 'waiting').length
  if (running > 0) parts.push(tn('dock.running', running))
  if (waiting > 0) parts.push(tn('dock.waiting', waiting))
  if (model.unread > 0) parts.push(tn('dock.unread', model.unread))
  if (model.inbox > 0) parts.push(tn('dock.inbox', model.inbox))
  return parts.join(' · ')
}

/** Where the collapsed state is kept: one choice for every session, like the Todo dock's. */
export interface DockStore {
  collapsed(): boolean
  set(collapsed: boolean): void
  subscribe(listener: () => void): () => void
}
const COLLAPSED_KEY = 'dsh-agent-scheduler:dock-collapsed'
/** @param storage - where to remember (tests pass a map; absent: nothing is remembered). */
export function dockStore(storage?: Pick<Storage, 'getItem' | 'setItem'>): DockStore {
  const listeners = new Set<() => void>()
  let value = (() => { try { return storage?.getItem(COLLAPSED_KEY) === '1' } catch { return false } })()
  return {
    collapsed: () => value,
    set(next) {
      value = next
      try { storage?.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* private mode: kept for this page only */ }
      for (const l of listeners) l()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
const browserStore = dockStore(typeof localStorage === 'undefined' ? undefined : localStorage)

const quote = (value: string): string => /\s|"/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value

export type InboxAction = 'pin' | 'unpin' | 'hold' | 'release' | 'now' | 'move'
/** The `/agents inbox` command for one change of the inbox (pin, hold, hand over now, reorder). */
export function inboxLine(action: InboxAction, id: string, before?: string): string {
  return `/agents inbox ${action} ${id}${action === 'move' ? ` ${before ?? 'end'}` : ''}`
}

/** The command lines the dock runs, one per action (all of them also work typed). */
export const dockLine = {
  toggle: (on: boolean) => on ? '/schedule on' : '/schedule off',
  send: (name: string, text: string) => `/agents send ${name} ${text.replace(/\s+/gu, ' ').trim()}`,
  convert: (name: string) => `/agents convert ${name}`,
  rename: (name: string, to: string) => `/agents rename ${name} ${to}`,
  archive: (name: string) => `/agents archive ${name}`,
  create: (name: string, role: string) => `/agents new ${name} ${role.replace(/\s+/gu, ' ').trim()}`,
  seenAll: () => '/agents seen all',
  seen: (member: string) => `/agents seen ${quote(member)}`,
  deliverNow: (mail: string) => inboxLine('now', mail),
} as const

export interface DockDeps {
  run(sessionId: string, line: string): Promise<string | null>
  /** The roster view of another session (the parent), subscribable. */
  projection(sessionId: string): Face
  /** Open a top-level session (a session worker, the parent) in the centre. */
  openSession(sessionId: string): void
  /** Open an old subagent worker's native chat. */
  openChild(parent: string, child: string): void
  /** Whether this session is an addressed subagent chat (no dock there). */
  isChild(sessionId: string): boolean
  store?: DockStore | undefined
}

interface SlotProps { sessionId?: string; useProjection?: (key: string) => unknown; useSessionStatus?: UseSessionStatus }

const NOTHING = { getSnapshot: () => undefined, subscribe: () => () => undefined }
const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/u

/** @returns the dock component for the `conversation.input.dock` slot. */
export function createSessionDock(deps: DockDeps) {
  const store = deps.store ?? browserStore
  return memo(function SessionDock(props: SlotProps) {
    useLocale()
    const roster = props.useProjection?.('agentScheduler') as DockRoster | undefined
    const statuses = props.useSessionStatus?.((value: Statuses) => value)
    const parentFace = roster?.owner === undefined ? NOTHING : deps.projection(roster.owner.router)
    const parentRoster = useSyncExternalStore(parentFace.subscribe, parentFace.getSnapshot, parentFace.getSnapshot) as DockRoster | undefined
    const collapsed = useSyncExternalStore(store.subscribe, store.collapsed, store.collapsed)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [draft, setDraft] = useState<{ row: string; kind: 'send' | 'rename'; text: string } | undefined>(undefined)
    const [creating, setCreating] = useState<{ name: string; role: string } | undefined>(undefined)
    const sessionId = props.sessionId
    if (sessionId === undefined || deps.isChild(sessionId)) return null
    const model = dockModel(roster, statuses, parentRoster, sessionId)
    if (!model.visible) return null
    const run = (line: string) => {
      setBusy(true)
      setError(null)
      deps.run(sessionId, line).then(failure => { setBusy(false); setError(failure) }, (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) })
    }
    const open = (row: DockRow) => { if (row.session) deps.openSession(row.id); else deps.openChild(sessionId, row.id) }
    const submitDraft = () => {
      if (draft === undefined || draft.text.trim() === '') return
      const row = model.workers.find(w => w.id === draft.row)
      if (row === undefined) return
      run(draft.kind === 'send' ? dockLine.send(row.name, draft.text) : dockLine.rename(row.name, draft.text.trim()))
      setDraft(undefined)
    }
    const onDraftKey = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') { event.preventDefault(); submitDraft() }
      if (event.key === 'Escape') setDraft(undefined)
    }
    const createOk = creating !== undefined && WORKER_NAME.test(creating.name) && creating.role.trim() !== ''
    return (
      <div className="sch-dock" data-scheduler-dock="" data-collapsed={collapsed ? 'yes' : 'no'}>
        <div className="sch-dock-head">
          <button type="button" className="sch-dock-fold" aria-expanded={!collapsed} aria-label={t(collapsed ? 'dock.expand' : 'dock.collapse')} title={t(collapsed ? 'dock.expand' : 'dock.collapse')} onClick={() => { store.set(!collapsed) }}>
            <span className="sch-dock-chev" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            <span className="sch-dock-summary">{dockSummary(model)}</span>
          </button>
          <button type="button" className="sch-dock-switch" role="switch" aria-checked={model.on} disabled={busy} data-on={model.on ? 'yes' : 'no'} title={t(model.on ? 'switch.off.title' : 'switch.on.title')} onClick={() => { run(dockLine.toggle(!model.on)) }}>
            <span className="sch-dock-knob" aria-hidden="true" />{t('switch.label')}
          </button>
        </div>
        {error === null ? null : <div className="sch-dock-error" role="status">{error}</div>}
        {collapsed ? null : (
          <div className="sch-dock-body">
            {model.inbox === 0 ? null : (
              <button type="button" className="sch-dock-inbox" onClick={() => { scrollToInbox() }}>{tn('dock.inbox.waiting', model.inbox)}</button>
            )}
            {model.parent === undefined ? null : (
              <div className="sch-dock-parent">
                <button type="button" className="sch-dock-up" title={t('dock.parent.title')} onClick={() => { deps.openSession(model.parent!.id) }}>← {roster?.owner?.name === undefined ? model.parent.name : t('dock.parent.of', { name: roster.owner.name })}</button>
                {model.siblings.filter(s => !s.me).map(s => (
                  <button type="button" key={s.id} className="sch-dock-sib" data-dot={s.dot} onClick={() => { deps.openSession(s.id) }}><span className="sch-dock-dot" data-dot={s.dot} />{s.name}</button>
                ))}
              </div>
            )}
            {model.workers.length === 0 ? null : (
              <ul className="sch-dock-rows">
                {model.workers.map(row => (
                  <li key={row.id} className="sch-dock-row" data-dot={row.dot} data-scheduler-dock-row={row.name}>
                    <button type="button" className="sch-dock-open" title={t(row.session ? 'dock.open.session' : 'dock.open.old')} onClick={() => { open(row) }}>
                      <span className="sch-dock-dot" data-dot={row.dot} title={t(`dock.dot.${row.dot}`)} />
                      <span className="sch-dock-name">{row.name}</span>
                      <span className="sch-dock-req">{row.request ?? t('dock.idle')}</span>
                      {row.unread === 0 ? null : <span className="sch-dock-unread" title={t('dock.unread.title')}>{row.unread}</span>}
                      {row.queued === 0 ? null : <span className="sch-dock-queued" title={tn('dock.queued.title', row.queued)}>+{row.queued}</span>}
                    </button>
                    <span className="sch-dock-acts">
                      <button type="button" title={t('dock.send')} aria-label={t('dock.send')} onClick={() => { setDraft({ row: row.id, kind: 'send', text: '' }) }}>✉</button>
                      <button type="button" title={t('dock.rename')} aria-label={t('dock.rename')} onClick={() => { setDraft({ row: row.id, kind: 'rename', text: row.name }) }}>✎</button>
                      {row.session ? null : <button type="button" title={t('dock.convert')} aria-label={t('dock.convert')} disabled={busy} onClick={() => { run(dockLine.convert(row.name)) }}>⇪</button>}
                      <button type="button" title={t('dock.archive')} aria-label={t('dock.archive')} disabled={busy} onClick={() => { run(dockLine.archive(row.name)) }}>🗄</button>
                    </span>
                    {draft?.row !== row.id ? null : (
                      <input className="sch-dock-input" autoFocus value={draft.text} placeholder={t(draft.kind === 'send' ? 'dock.send.placeholder' : 'dock.rename.placeholder')} onChange={e => { setDraft({ ...draft, text: e.currentTarget.value }) }} onKeyDown={onDraftKey} onBlur={() => { if (draft.text.trim() === '') setDraft(undefined) }} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {creating === undefined ? null : (
              <div className="sch-dock-new">
                <input className="sch-dock-input" autoFocus value={creating.name} placeholder={t('dock.new.name')} onChange={e => { setCreating({ ...creating, name: e.currentTarget.value }) }} />
                <input className="sch-dock-input" value={creating.role} placeholder={t('dock.new.role')} onChange={e => { setCreating({ ...creating, role: e.currentTarget.value }) }} onKeyDown={e => { if (e.key === 'Enter' && createOk) { run(dockLine.create(creating.name, creating.role)); setCreating(undefined) } if (e.key === 'Escape') setCreating(undefined) }} />
                <button type="button" disabled={!createOk || busy} onClick={() => { run(dockLine.create(creating.name, creating.role)); setCreating(undefined) }}>{t('dock.new.create')}</button>
              </div>
            )}
            <div className="sch-dock-foot">
              <button type="button" onClick={() => { setCreating({ name: '', role: '' }) }}>{t('dock.new')}</button>
              <button type="button" disabled={busy || model.unread === 0} onClick={() => { run(dockLine.seenAll()) }}>{t('dock.seenAll')}</button>
            </div>
          </div>
        )}
      </div>
    )
  })
}

const scrollToInbox = (): void => {
  if (typeof document === 'undefined') return
  document.querySelector('[data-scheduler-inbox-card]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

/** What the inbox card lists: waiting replies, and worker reports not read yet. */
export function inboxCardModel(roster: DockRoster | undefined): { waiting: readonly { id: string; worker: string; request?: string | undefined; preview: string }[]; unread: readonly { id: string; worker: string }[] } {
  const nameOf = (id: string) => roster?.members.find(m => m.id === id)?.name ?? id.slice(0, 12)
  const waiting = (roster?.inbox ?? []).map(m => ({ id: m.id, worker: nameOf(m.from), ...(m.request === undefined ? {} : { request: m.request }), preview: flat(mailPreview(m.text), 120) }))
  const unread = (roster?.members ?? []).filter(m => m.kind === 'worker' && reviewOf(m as never) !== undefined).map(m => ({ id: m.id, worker: m.name }))
  return { waiting, unread }
}

/** @returns the inbox card component for the `conversation.input.dock` slot (shown only while something waits). */
export function createInboxCard(deps: Pick<DockDeps, 'run' | 'isChild'>) {
  return memo(function InboxCard(props: SlotProps) {
    useLocale()
    const roster = props.useProjection?.('agentScheduler') as DockRoster | undefined
    const [busy, setBusy] = useState(false)
    const sessionId = props.sessionId
    if (sessionId === undefined || deps.isChild(sessionId)) return null
    const model = inboxCardModel(roster)
    if (model.waiting.length === 0 && model.unread.length === 0) return null
    const run = (line: string) => { setBusy(true); deps.run(sessionId, line).finally(() => { setBusy(false) }) }
    return (
      <div className="sch-dock sch-dock-card" data-scheduler-inbox-card="">
        <div className="sch-dock-head"><span className="sch-dock-summary">{t('dock.card.title')}</span></div>
        <ul className="sch-dock-rows">
          {model.waiting.map(m => (
            <li key={m.id} className="sch-dock-row" data-scheduler-inbox-item={m.id}>
              <span className="sch-dock-name">{m.worker}</span>
              {m.request === undefined ? null : <span className="sch-dock-rid">{m.request}</span>}
              <span className="sch-dock-req">{m.preview}</span>
              <span className="sch-dock-acts sch-dock-acts-on"><button type="button" disabled={busy} onClick={() => { run(dockLine.deliverNow(m.id)) }}>{t('dock.card.now')}</button></span>
            </li>
          ))}
          {model.unread.map(m => (
            <li key={m.id} className="sch-dock-row" data-scheduler-inbox-unread={m.worker}>
              <span className="sch-dock-name">{m.worker}</span>
              <span className="sch-dock-req">{t('dock.card.report')}</span>
              <span className="sch-dock-acts sch-dock-acts-on"><button type="button" disabled={busy} onClick={() => { run(dockLine.seen(m.id)) }}>{t('dock.card.read')}</button></span>
            </li>
          ))}
        </ul>
      </div>
    )
  })
}

/** Styles: the host theme's own variables only; class names never contain "brand". */
export const DOCK_STYLE = `
.sch-dock{margin:0 0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);font-size:var(--dsw-font-xxs-12, 12px);color:var(--dsw-alias-label-secondary);overflow:hidden}
.sch-dock-head{display:flex;align-items:center;gap:8px;padding:4px 8px}
.sch-dock-fold{flex:1;min-width:0;display:flex;align-items:center;gap:6px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:2px 0;text-align:left}
.sch-dock-chev{color:var(--dsw-alias-label-tertiary)}
.sch-dock-summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.sch-dock-switch{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;padding:1px 8px 1px 3px;cursor:pointer}
.sch-dock-knob{width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.sch-dock-switch[data-on=yes]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}
.sch-dock-switch[data-on=yes] .sch-dock-knob{background:var(--dsw-alias-state-business-primary)}
.sch-dock-error{padding:2px 10px;color:var(--dsw-alias-state-error-primary)}
.sch-dock-body{border-top:1px solid var(--dsw-alias-border-l1);padding:4px 4px 2px}
.sch-dock-inbox,.sch-dock-up,.sch-dock-sib,.sch-dock-foot button,.sch-dock-acts button,.sch-dock-new button{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border-radius:var(--dsw-radius-sm);padding:2px 6px}
.sch-dock-inbox{color:var(--dsw-alias-state-warn-primary)}
.sch-dock-inbox:hover,.sch-dock-up:hover,.sch-dock-sib:hover,.sch-dock-foot button:hover,.sch-dock-acts button:hover,.sch-dock-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-dock-parent{display:flex;flex-wrap:wrap;gap:2px;padding:2px 0}
.sch-dock-up{color:var(--dsw-alias-label-primary)}
.sch-dock-rows{list-style:none;margin:0;padding:0}
.sch-dock-row{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 2px}
.sch-dock-open{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:3px 4px;border-radius:var(--dsw-radius-sm);text-align:left}
.sch-dock-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.sch-dock-dot[data-dot=running]{background:var(--dsw-alias-state-business-primary)}
.sch-dock-dot[data-dot=waiting]{background:var(--dsw-alias-state-warn-primary)}
.sch-dock-dot[data-dot=failed]{background:var(--dsw-alias-state-error-primary)}
.sch-dock-name{flex:none;color:var(--dsw-alias-label-primary)}
.sch-dock-rid{flex:none;color:var(--dsw-alias-label-tertiary)}
.sch-dock-req{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary)}
.sch-dock-unread{flex:none;min-width:16px;padding:0 4px;border-radius:999px;text-align:center;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-layer-1)}
.sch-dock-queued{flex:none;color:var(--dsw-alias-label-tertiary)}
.sch-dock-acts{display:none;flex:none}
.sch-dock-row:hover .sch-dock-acts,.sch-dock-row:focus-within .sch-dock-acts,.sch-dock-acts-on{display:inline-flex}
.sch-dock-input{flex-basis:100%;margin:2px 4px 4px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}
.sch-dock-new{display:flex;gap:4px;align-items:center}
.sch-dock-new .sch-dock-input{flex:1;flex-basis:auto}
.sch-dock-foot{display:flex;gap:4px;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l1);margin-top:2px;padding-top:2px}
`
