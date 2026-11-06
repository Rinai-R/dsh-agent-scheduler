/**
 * The lead's inbox on the Agents page: answers, reports, conclusions and failures that wait for
 * the lead while it is busy. It sits under the page head, above the member sections. The user
 * orders, pins and holds them, or hands them to the lead now; every change is a `/agents inbox`
 * command the host records, so the order shown is the order the lead gets them in.
 * @module dsh-agent-scheduler/client/inbox
 */
import { useState, type DragEvent, type KeyboardEvent } from 'react'
import { mailPreview } from '../mail.js'
import type { MailDelivery, MailItem } from '../projection.js'
import { t, tn } from './i18n.js'

/** Rows shown before the rest fold under 「还有 N 条」. */
export const INBOX_ROWS = 4

/** How recent a hand-over still reads as 「lead 正在处理」 while the lead runs. */
const HANDLING_MS = 15 * 60_000

export type InboxAction = 'pin' | 'unpin' | 'hold' | 'release' | 'now' | 'move'

/**
 * The command for one change.
 * @param action - what to do.
 * @param id - an `m-N`, or `all` with `now`.
 * @param before - `move`: the message it goes before, or `end`.
 * @returns the command line.
 */
export function inboxLine(action: InboxAction, id: string, before?: string): string {
  return `/agents inbox ${action} ${id}${action === 'move' ? ` ${before ?? 'end'}` : ''}`
}

/**
 * Where a message goes when moved one place up or down. It stays among the pinned or the
 * unpinned ones: pinned messages always come first.
 * @param items - the inbox in delivery order.
 * @param id - the message.
 * @param dir - -1 up, 1 down.
 * @returns the message it then stands before (`end`: last), or undefined when it cannot move.
 */
export function moveTarget(items: readonly MailItem[], id: string, dir: -1 | 1): string | undefined {
  const item = items.find(m => m.id === id)
  if (item === undefined) return undefined
  const group = items.filter(m => (m.pinned === true) === (item.pinned === true))
  const at = group.indexOf(item)
  if (dir === -1) return at > 0 ? group[at - 1]!.id : undefined
  if (at + 1 >= group.length) return undefined
  return group[at + 2]?.id ?? 'end'
}

/**
 * Where a dragged message goes when dropped on another: after it when dragged down, before it
 * when dragged up. Only among messages of the same group (pinned or not).
 * @returns the `before` argument of the move, or undefined for no move.
 */
export function dropTarget(items: readonly MailItem[], dragged: string, onto: string): string | undefined {
  if (dragged === onto) return undefined
  const a = items.find(m => m.id === dragged)
  const b = items.find(m => m.id === onto)
  if (a === undefined || b === undefined || (a.pinned === true) !== (b.pinned === true)) return undefined
  const group = items.filter(m => (m.pinned === true) === (a.pinned === true))
  const from = group.indexOf(a)
  const to = group.indexOf(b)
  if (to < from) return b.id
  return group[to + 1]?.id ?? 'end'
}

const KIND_KEY = { reply: 'inbox.kind.reply', report: 'inbox.kind.report', conclusion: 'inbox.kind.conclusion', failure: 'inbox.kind.failure', merged: 'inbox.kind.merged' } as const

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What the inbox section needs from the Agents page. */
export interface InboxProps {
  readonly items: readonly MailItem[]
  readonly delivered?: MailDelivery | undefined
  /** Whether the lead is running a turn now. */
  readonly leadRunning: boolean
  /** Requests still owed by members: `r-5 ibx-a`, oldest first. */
  readonly owed: readonly string[]
  readonly nameOf: (id: string) => string
  /** Run one `/agents inbox` line in the main Session; resolves to an error message or null. */
  readonly run: (line: string) => Promise<string | null>
  /** Open a member's chat (and read its report), as its roster row does. */
  readonly open: (memberId: string) => void
  /** Now (ms), for "recently handed over". */
  readonly now?: number
}

/**
 * The inbox section. Renders one quiet line when nothing waits.
 * @param props - see {@link InboxProps}.
 * @returns the section.
 */
export function InboxSection(props: InboxProps) {
  const { items } = props
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<string | undefined>(undefined)
  const act = (action: InboxAction, id: string, before?: string) => {
    setBusy(b => new Set([...b, id]))
    setFailure(null)
    const settle = (error: string | null) => {
      setBusy(b => { const next = new Set(b); next.delete(id); return next })
      setFailure(error)
    }
    props.run(inboxLine(action, id, before)).then(settle, (reason: unknown) => { settle(reason instanceof Error ? reason.message : String(reason)) })
  }
  if (items.length === 0) {
    const now = props.now ?? Date.now()
    const handling = props.leadRunning && props.delivered !== undefined && now - props.delivered.at < HANDLING_MS
    return (
      <section className="sch-inbox" data-scheduler-inbox="" data-empty="" aria-label={t('inbox.aria')}>
        <div className="sch-inbox-head">
          <span className="sch-inbox-title">{ICON_MAIL}{t('inbox.empty')}</span>
          {handling ? <span className="sch-inbox-status">{tn('inbox.handling', props.delivered!.count)}</span> : null}
        </div>
        {props.owed.length === 0 ? null : <div className="sch-inbox-owed">{tn('inbox.owed', props.owed.length, { list: props.owed.slice(0, 3).join('、') + (props.owed.length > 3 ? '…' : '') })}</div>}
      </section>
    )
  }
  const ready = items.filter(m => m.held !== true)
  const status = ready.length === 0 ? t('inbox.allHeld') : props.leadRunning ? t('inbox.busy') : t('inbox.idle')
  const shown = expanded ? items : items.slice(0, INBOX_ROWS)
  const onKey = (e: KeyboardEvent, item: MailItem) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const before = moveTarget(items, item.id, e.key === 'ArrowUp' ? -1 : 1)
    if (before !== undefined) act('move', item.id, before)
  }
  const drop = (e: DragEvent, onto: MailItem) => {
    e.preventDefault()
    const dragged = dragging ?? e.dataTransfer.getData('text/x-scheduler-mail')
    setDragging(undefined)
    if (dragged === '') return
    const before = dropTarget(items, dragged, onto.id)
    if (before !== undefined) act('move', dragged, before)
  }
  const button = (action: InboxAction, item: MailItem, label: string, icon: string, before?: string, disabled = false) => (
    <button type="button" className="sch-inbox-act" data-act={action} aria-label={`${label} ${item.id}`} title={label} disabled={disabled || busy.has(item.id)} onClick={e => { e.stopPropagation(); setMenu(undefined); act(action, item.id, before) }}>{icon}</button>
  )
  return (
    <section className="sch-inbox" data-scheduler-inbox="" data-count={items.length} aria-label={t('inbox.aria')}>
      <div className="sch-inbox-head">
        <span className="sch-inbox-title">{ICON_MAIL}{tn('inbox.title', items.length)}</span>
        <span className="sch-inbox-status">{status}</span>
        {ready.length === 0 ? null : (
          <button type="button" className="sch-inbox-all" title={t('inbox.all.title')} disabled={busy.has('all')} onClick={() => { act('now', 'all') }}>
            <span className="sch-inbox-wide">{t('inbox.all')}</span><span className="sch-inbox-narrow">{t('inbox.all.short')}</span>
          </button>
        )}
      </div>
      {failure === null ? null : <div className="sch-inbox-failure" role="status">{failure}</div>}
      <ol className="sch-inbox-list">
        {shown.map(item => {
          const name = props.nameOf(item.from)
          const up = moveTarget(items, item.id, -1)
          const down = moveTarget(items, item.id, 1)
          return (
            <li
              key={item.id}
              className="sch-inbox-item"
              data-mail={item.id}
              data-held={item.held === true ? '' : undefined}
              data-pinned={item.pinned === true ? '' : undefined}
              data-dragging={dragging === item.id ? '' : undefined}
              data-busy={busy.has(item.id) ? '' : undefined}
              draggable
              tabIndex={0}
              onKeyDown={e => { onKey(e, item) }}
              onDragStart={e => { setDragging(item.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-scheduler-mail', item.id) }}
              onDragEnd={() => { setDragging(undefined) }}
              onDragOver={e => { if (dragging !== undefined && dropTarget(items, dragging, item.id) !== undefined) e.preventDefault() }}
              onDrop={e => { drop(e, item) }}
            >
              <span className="sch-inbox-grip" aria-hidden="true">⠿</span>
              <button type="button" className="sch-inbox-body" title={`${t('inbox.open.title', { name })}\n\n${item.text}`} onClick={() => { props.open(item.from) }}>
                <span className="sch-inbox-who">
                  {item.pinned === true ? <span className="sch-inbox-pin" aria-label={t('inbox.pinned')}>📌</span> : null}
                  {item.held === true ? <span className="sch-inbox-pause" aria-label={t('inbox.held')}>⏸</span> : null}
                  <span className="sch-inbox-name">{name}</span>
                  <span className="sch-inbox-meta">
                    {' · '}{t(KIND_KEY[item.kind])}{item.request === undefined ? '' : ` ${item.request}`}
                    <span className="sch-inbox-wide">{' · '}{clock(item.at)}{item.held === true ? ` · ${t('inbox.held')}` : ''}</span>
                  </span>
                </span>
                {/* A merge is news, not something to answer: one line, the rest in the tooltip. */}
                {item.kind === 'merged' ? null : <span className="sch-inbox-text">{mailPreview(item.text, 200)}</span>}
              </button>
              <span className="sch-inbox-acts">
                {button(item.pinned === true ? 'unpin' : 'pin', item, t(item.pinned === true ? 'inbox.unpin' : 'inbox.pin'), '📌')}
                {button(item.held === true ? 'release' : 'hold', item, t(item.held === true ? 'inbox.release' : 'inbox.hold'), item.held === true ? '▶' : '⏸')}
                {button('now', item, t('inbox.now'), '⚡')}
              </span>
              <button type="button" className="sch-inbox-more" aria-label={t('inbox.menu', { id: item.id })} aria-expanded={menu === item.id} onClick={() => { setMenu(m => m === item.id ? undefined : item.id) }}>⋯</button>
              {menu !== item.id ? null : (
                <span className="sch-inbox-menu" role="group">
                  {button(item.pinned === true ? 'unpin' : 'pin', item, t(item.pinned === true ? 'inbox.unpin' : 'inbox.pin'), '📌')}
                  {button('move', item, t('inbox.up'), '↑', up, up === undefined)}
                  {button('move', item, t('inbox.down'), '↓', down, down === undefined)}
                  {button(item.held === true ? 'release' : 'hold', item, t(item.held === true ? 'inbox.release' : 'inbox.hold'), item.held === true ? '▶' : '⏸')}
                  {button('now', item, t('inbox.now'), '⚡')}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {items.length <= INBOX_ROWS ? null : (
        <button type="button" className="sch-inbox-fold" aria-expanded={expanded} onClick={() => { setExpanded(v => !v) }}>
          {expanded ? t('inbox.less') : tn('inbox.moreRows', items.length - INBOX_ROWS)}
        </button>
      )}
    </section>
  )
}

const ICON_MAIL = <span className="sch-inbox-icon" aria-hidden="true">✉</span>

/** Styles of the inbox section; the Agents page is a size container, so it narrows with its column. */
export const INBOX_STYLE = `
.sch-roster{container-type:inline-size;container-name:sch-roster}
.sch-inbox{margin:8px 12px 4px;padding:6px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent);font:var(--dsw-font-xxs-12)}
.sch-inbox[data-empty]{border-color:var(--dsw-alias-border-l1,transparent);background:none;padding:4px 8px}
.sch-inbox-head{display:flex;align-items:center;gap:6px;min-height:22px;padding:0 2px}
.sch-inbox-title{display:inline-flex;align-items:center;gap:5px;flex:none;color:var(--dsw-alias-state-warn-primary);font-weight:600}
.sch-inbox[data-empty] .sch-inbox-title{color:var(--dsw-alias-label-tertiary);font-weight:400}
.sch-inbox-status{min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.sch-inbox-owed{padding:2px 2px 2px 19px;color:var(--dsw-alias-label-tertiary);line-height:16px}
.sch-inbox-all{flex:none;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,transparent);background:none;padding:1px 7px;border-radius:7px;color:var(--dsw-alias-state-warn-primary);font:inherit;cursor:pointer}
.sch-inbox-all:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.sch-inbox-failure{margin:4px 2px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.sch-inbox-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}
.sch-inbox-item{position:relative;display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px;padding:4px 4px 4px 2px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l1,transparent);outline:none}
.sch-inbox-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.sch-inbox-item[data-held]{opacity:.55}
.sch-inbox-item[data-busy]{opacity:.6}
.sch-inbox-item[data-dragging]{opacity:.35}
.sch-inbox-grip{flex:none;width:12px;padding-top:1px;color:var(--dsw-alias-label-caption);cursor:grab;text-align:center}
.sch-inbox-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;border:0;background:none;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sch-inbox-who{display:flex;align-items:baseline;gap:3px;min-width:0;white-space:nowrap}
.sch-inbox-name{color:var(--dsw-alias-label-primary);font-weight:500;overflow:hidden;text-overflow:ellipsis}
.sch-inbox-meta{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}
.sch-inbox-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sch-inbox-body:hover .sch-inbox-name{text-decoration:underline}
.sch-inbox-acts{flex:none;display:inline-flex;gap:1px}
.sch-inbox-act,.sch-inbox-more{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:none;padding:0;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.sch-inbox-act:hover:not(:disabled),.sch-inbox-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sch-inbox-act:disabled{opacity:.35;cursor:default}
.sch-inbox-item[data-pinned] > .sch-inbox-acts [data-act=unpin]{color:var(--dsw-alias-state-warn-primary)}
.sch-inbox-more{display:none}
.sch-inbox-menu{flex-basis:100%;display:flex;justify-content:flex-end;gap:2px;padding:2px 0 0}
.sch-inbox-fold{display:block;width:100%;margin-top:3px;border:0;background:none;padding:3px 4px;border-radius:6px;color:var(--dsw-alias-state-warn-primary);font:inherit;text-align:left;cursor:pointer}
.sch-inbox-fold:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.sch-inbox-narrow{display:none}
@container sch-roster (max-width: 280px){
  .sch-inbox-wide,.sch-inbox-grip,.sch-inbox-acts{display:none}
  .sch-inbox-narrow{display:inline}
  .sch-inbox-more{display:inline-flex}
  .sch-inbox:not([data-empty]) .sch-inbox-status{display:none}
  .sch-inbox-all{margin-left:auto}
}
.sch-roster-mail{color:var(--dsw-alias-state-warn-primary);font-size:11px;margin-right:2px}
.sch-agents-mail{display:inline-flex;align-items:center;gap:2px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;font-weight:600;line-height:16px}
`
