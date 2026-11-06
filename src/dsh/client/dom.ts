/**
 * The sidebar's DOM as the plugin reads it, and the CSS that reaches into DSH's own markup. None
 * of it is API: every selector here is checked against the installed DSH bundles by
 * tests/contract/client-probe.spec.ts, so a renamed attribute fails there first.
 * @module dsh-agent-scheduler/dsh/client/dom
 */
import { features } from '../compat.js'

/** DSH's own attributes and roles the plugin reads. */
export const SEL = {
  /** One mounted Session of the right sidebar (dsh-client-ui-sidebar-right). */
  sidebarSession: '[data-sidebar-right-session]',
  /** A docked pane; its value is the pane id (dockkit, in dsh-web-frontend). */
  dockPane: '[data-dockkit-pane]',
  /** A pane's tab strip; its value is the pane id (dockkit). */
  stripTabs: '[data-dockkit-strip-tabs]',
  /** The active tab of a strip. */
  selectedTab: '[role=tab][aria-selected=true]',
  /** The composer box (dsh-client-ui-conversation), which a composer menu keeps clear. */
  composerCard: '[data-composer-card]',
} as const

/** Values of DSH's `data-chat-flow-kind` (dsh-client-ui-chat) the plugin's CSS names. */
export const CHAT_FLOW_KINDS = ['turn-process', 'turn-tail'] as const

/**
 * CSS for DSH's own chat markup (dsh-client-ui-chat): a wake whose only message was handed off
 * leaves a turn with no content, a process row and then a tail; both are hidden.
 */
export const HOST_CSS = `
[data-chat-flow-kind="turn-process"]:has(+ [data-chat-flow-kind="turn-tail"]),
[data-chat-flow-kind="turn-process"] + [data-chat-flow-kind="turn-tail"]{display:none}
`

/**
 * Add a stylesheet to the page.
 * @param doc - the document, if any.
 * @param id - a `data-plugin` value naming it.
 * @param css - the rules.
 * @returns removes it.
 */
export function injectStyle(doc: Document | undefined, id: string, css: string): () => void {
  if (doc === undefined) return () => undefined
  const style = doc.createElement('style')
  style.dataset.plugin = id
  style.textContent = css
  doc.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Keep the right sidebar's tab strip still when its active tab changes.
 *
 * The dock draws a pane's tab strip inside the host of the pane's active tab, so closing or
 * switching a tab mounts a brand-new strip under the next tab: its scroll offset starts at 0 and
 * the dock then reveals the active tab with `scroll-behavior: smooth`. With more tabs than fit,
 * every close slid the whole strip for ~100 ms. This carries each pane's scroll offset over to
 * the strip that replaces it, reveals the active tab instantly, and turns the smooth animation
 * off for these strips, all before the next paint.
 * @param doc - the page's document.
 * @returns undo.
 */
export function steadyTabStrips(doc: Document | undefined): () => void {
  const view = doc?.defaultView
  if (doc === undefined || view === undefined || view === null || typeof view.MutationObserver !== 'function') return () => undefined
  const SELECTOR = `${SEL.sidebarSession} ${SEL.stripTabs}`
  const style = doc.createElement('style')
  style.dataset.plugin = 'dsh-agent-scheduler/strip'
  style.textContent = `${SELECTOR}{scroll-behavior:auto!important}`
  doc.head.appendChild(style)
  const offsets = new Map<string, number>()
  const seen = new WeakSet<Element>()
  const remember = (event: globalThis.Event) => {
    const el = event.target
    if (!(el instanceof view.HTMLElement) || !el.matches(SELECTOR)) return
    const pane = el.dataset.dockkitStripTabs
    if (pane !== undefined) offsets.set(pane, el.scrollLeft)
  }
  const settle = () => {
    for (const el of doc.querySelectorAll<HTMLElement>(SELECTOR)) {
      const pane = el.dataset.dockkitStripTabs
      if (pane === undefined) continue
      if (seen.has(el)) { offsets.set(pane, el.scrollLeft); continue }
      seen.add(el)
      const before = offsets.get(pane)
      if (before !== undefined) el.scrollLeft = before
      const active = el.querySelector<HTMLElement>(SEL.selectedTab)
      if (active !== null) {
        const box = el.getBoundingClientRect()
        const tab = active.getBoundingClientRect()
        if (tab.left < box.left) el.scrollLeft += tab.left - box.left - 24
        else if (tab.right > box.right) el.scrollLeft += tab.right - box.right + 24
      }
      offsets.set(pane, el.scrollLeft)
    }
  }
  // A DSH whose dock no longer marks its strips: nothing to keep still, say so once.
  const probe = view.setTimeout(() => {
    if (doc.querySelector(SEL.dockPane) !== null && doc.querySelector(SEL.stripTabs) === null) features.record('dom.stripTabs', false, `no ${SEL.stripTabs} in the sidebar`)
  }, 5000)
  doc.addEventListener('scroll', remember, true)
  const observer = new view.MutationObserver(settle)
  observer.observe(doc.body, { childList: true, subtree: true })
  settle()
  return () => {
    view.clearTimeout(probe)
    observer.disconnect()
    doc.removeEventListener('scroll', remember, true)
    style.remove()
  }
}

/**
 * Where an agent's chat goes in the right column: a docked pane other than the one showing the
 * Agents page, so opening a second agent never covers the roster. The column allows two panes;
 * once both exist, `preferNewPane` no longer splits and would drop the chat into the active pane,
 * which is the roster's pane right after a row click.
 * @param doc - the document.
 * @param rosterPane - the Agents page's own pane id, when known.
 * @param rosterSelector - what marks the Agents page's body.
 * @returns placement options for `openResource`.
 */
export function chatPlacement(doc: Pick<Document, 'querySelectorAll'>, rosterPane?: string, rosterSelector = '[data-scheduler-roster]'): { paneId: string } | { preferNewPane: true } {
  const panes = [...doc.querySelectorAll<HTMLElement>(`${SEL.sidebarSession}:not([hidden]) ${SEL.dockPane}`)]
  const holding = rosterPane ?? panes.find(p => p.querySelector(rosterSelector) !== null)?.dataset.dockkitPane
  const other = panes.map(p => p.dataset.dockkitPane).find(id => id !== undefined && id !== '' && id !== holding)
  return other === undefined ? { preferNewPane: true } : { paneId: other }
}

