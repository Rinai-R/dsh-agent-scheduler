/**
 * Where the browser half plugs into DSH's UI: slot names and their registration shape, the
 * conversation-event engine, sidebar tab types, and the plugin page's settings form
 * (dsh-cordis-client-runner slots, dsh-client-ui-conversation, dsh-client-ui-sidebar-right,
 * dsh-client-ui-plugin-manager). Each registration probes its service and is skipped, with one
 * warning, on a DSH that does not offer it.
 * @module dsh-agent-scheduler/dsh/client/ui
 */
import { features, hasFunction } from '../compat.js'

/** The UI seats the plugin fills. */
export const SLOT = {
  /** A node of the chat flow, keyed by its view-node kind. */
  chatNode: 'conversation.chat.node',
  /** The body of a right-sidebar tab, keyed by its tab type id. */
  paneTab: 'sidebar.right.pane.tab',
  /** The composer's mode row, left of the input. */
  inputLeft: 'conversation.input.left',
  /** The composer's right controls. */
  inputRight: 'conversation.input.right',
  /** A bundle's configuration page on the Plugins page, keyed by package name. */
  bundleConfig: 'plugins.bundle.config',
} as const

/* eslint-disable @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */

/**
 * Fill one seat for as long as the plugin is mounted.
 * @param ctx - the browser plugin context (or a scoped one).
 * @param slot - which seat.
 * @param spec - the seat's registration fields besides `name` (`key`, or `id` / `order` / `inject`).
 * @param component - what it renders.
 * @returns whether the seat was filled.
 */
export function registerSlot(ctx: any, slot: keyof typeof SLOT, spec: Record<string, unknown>, component: unknown): boolean {
  if (!features.record('slots', hasFunction(ctx, 'slots.inject') && hasFunction(ctx, 'slots.register'), 'slots')) return false
  const name = SLOT[slot]
  ctx.slots.inject(name, () => ctx.slots.register({ name, ...spec }, component))
  return true
}

/**
 * Register a conversation-event definition: it folds Session events into chat view nodes
 * (`kind`, `match`, `start`, `update`, `buildViewNode`).
 * @param ctx - the browser plugin context.
 * @param definition - the definition.
 * @returns whether it was registered.
 */
export function registerChatEvent(ctx: any, definition: unknown): boolean {
  if (!features.record('conversation.events', hasFunction(ctx, 'uiConversation.events.register'), 'uiConversation.events')) return false
  ctx.uiConversation.events.register(definition)
  return true
}

/** A right-sidebar tab type. */
export interface TabType {
  readonly id: string
  readonly kind: string
  readonly title: () => string
  readonly keepMounted?: boolean
}

/**
 * Register a page-kind tab type as an extension.
 * @param ctx - the browser plugin context.
 * @param type - the type.
 * @returns whether it was registered.
 */
export function registerTabType(ctx: any, type: TabType): boolean {
  if (!features.record('sidebar.tabs', hasFunction(ctx, 'sidebarRightTabs.register'), 'sidebarRightTabs')) return false
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...type, priority: 'extension' }), `agent-scheduler: ${type.kind} tab type`)
  return true
}

/** A settings form of one Host settings namespace. */
export interface ConfigForm<T> {
  getSnapshot(): { status: string; value?: T; writable: boolean }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<boolean>
}

/**
 * Show a page on the Plugins page while the Host serves a settings namespace. Optional: a
 * deployment without the settings client simply has no page.
 * @param ctx - the browser plugin context.
 * @param namespace - the Host settings namespace (a host row id).
 * @param packageName - the bundle whose page this is.
 * @param render - the page, given its form.
 */
export function configPage<T>(ctx: any, namespace: string, packageName: string, render: (form: ConfigForm<T>, view: string | undefined) => unknown): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['configForms', 'slots'], (scoped: any) => {
    const form = scoped.configForms.get(namespace) as ConfigForm<T>
    scoped.effect(() => scoped.configForms.whileServed([namespace], () => scoped.slots.inject(SLOT.bundleConfig, () => scoped.slots.register({
      name: SLOT.bundleConfig,
      key: packageName,
    }, ({ view }: { view?: string }) => render(form, view)))), 'agent-scheduler: config page')
  })
}
