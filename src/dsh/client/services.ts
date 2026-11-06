/**
 * The client services the plugin calls (dsh-api-session-controller, dsh-api-remotes,
 * dsh-client-ui-workspace) and the shapes they answer in. The browser half is handed an untyped
 * `ctx`; this module is where that `any` is turned into typed calls, and where a reshaped answer
 * is recognised instead of being misread.
 * @module dsh-agent-scheduler/dsh/client/services
 */
import { features, hasFunction, warnOnce } from '../compat.js'
import { SUBAGENT_CHAT_KIND } from './sidebar.js'

/** One Session's live status as the client root hook `useSessionStatus` reports it. */
export interface StatusRow { running?: boolean; pendingInteraction?: unknown; completionUnread?: boolean }
export type Statuses = Map<string, StatusRow>
export type UseSessionStatus = (selector: (value: Statuses) => Statuses) => Statuses

/** A subscribable read of one projection key, as the client session binding exposes it. */
export interface Face { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }
export const NO_FACE: Face = { getSnapshot: () => undefined, subscribe: () => () => undefined }

/** Resource-address prefix of a native subagent chat (dsh-client-ui-subagent). */
export const SUBAGENT_CHAT_ADDRESS = `dsh-resource://${SUBAGENT_CHAT_KIND}/session/`

/**
 * The failure text of a remote command's result, or null when it succeeded. The server answers
 * `{ commandId, result: { kind, text } }`; older servers answered `{ kind, text }` directly.
 * @param value - `result.value` of `remote.commands.execute`.
 * @param line - the command line, for the unknown-command message.
 * @returns the error text, or null.
 */
export function commandFailure(value: unknown, line: string): string | null {
  if (value === undefined || value === null) return `unknown command: ${line.split(' ')[0]}`
  const outer = value as { kind?: string; text?: string; result?: { kind?: string; text?: string } }
  const inner = outer.result !== undefined && typeof outer.result === 'object' ? outer.result : outer
  return inner.kind === 'error' ? (inner.text ?? 'failed') : null
}

/**
 * A provider-grouped model catalog entry, as `remote.session.modelCatalog()` lists it.
 * Kept structural: the menu reads only ids, names and reasoning efforts.
 */
export interface CatalogShape { readonly groups: readonly unknown[] }

/** The client services, typed. Every method degrades instead of throwing on a missing service. */
export interface ClientHost {
  /** Run one command line in a Session; null on success, otherwise what went wrong. */
  run(sessionId: string, line: string): Promise<string | null>
  /** Whether the Session's host half knows a command: it lags the browser half until a restart. */
  has(sessionId: string, name: string): Promise<boolean>
  /** The Host's provider-grouped model catalog, the one the composer's model menu lists. */
  catalog<G>(): Promise<readonly G[]>
  /** The parent of an addressed fork or worker chat; undefined for a main Session. */
  parentOf(sessionId: string): string | undefined
  /** Whether a Session is an addressed subagent (fork, worker, ordinary subagent). */
  isChild(sessionId: string): boolean
  /** One projection of an open Session, subscribable. */
  projection(sessionId: string, key: string): Face
  /** The sidebar resource address of a child's native chat. */
  chatAddress(parent: string, child: string): string
  /** Open a child's chat as a workspace view: the fallback when there is no right sidebar. */
  openSession(parent: string, child: string): void
}

type Result = { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string } }

/**
 * @param ctx - the browser plugin context.
 * @returns the typed services.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function clientHost(ctx: any): ClientHost {
  const commands = features.record('remote.commands', hasFunction(ctx, 'remote.commands.execute') && hasFunction(ctx, 'remote.commands.list'), 'remote.commands')
  const address = () => features.record('sessions.subagentAddress', hasFunction(ctx, 'sessions.subagentAddress'), 'sessions.subagentAddress')
  return {
    async run(sessionId, line) {
      if (!commands) return 'this DeepSeek Harness offers no command service'
      const result = await ctx.remote.commands.execute(sessionId, line, []) as Result
      if (!result.ok) return `${result.error.message} (${result.error.code})`
      return commandFailure(result.value, line)
    },
    async has(sessionId, name) {
      if (!commands) return false
      const result = await ctx.remote.commands.list(sessionId) as Result
      if (!result.ok) throw new Error(result.error.message)
      if (!Array.isArray(result.value)) {
        warnOnce('remote.commands.list', 'commands.list answered in a shape this plugin does not know')
        return false
      }
      return (result.value as readonly { name?: string }[]).some(command => command.name === name)
    },
    async catalog<G>() {
      if (!features.record('remote.modelCatalog', hasFunction(ctx, 'remote.session.modelCatalog'), 'remote.session.modelCatalog')) return []
      const result = await ctx.remote.session.modelCatalog() as Result
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const groups = (result.value as Partial<CatalogShape> | undefined)?.groups
      if (!Array.isArray(groups)) throw new Error('the model catalog came in a shape this plugin does not know')
      return groups as readonly G[]
    },
    parentOf(sessionId) {
      if (!address()) return undefined
      return (ctx.sessions.subagentAddress(sessionId) as { parentSessionId?: string } | undefined)?.parentSessionId
    },
    isChild(sessionId) {
      return address() && ctx.sessions.subagentAddress(sessionId) !== undefined
    },
    projection(sessionId, key) {
      const face = ctx.sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.(key) as Face | undefined
      if (face === undefined && !hasFunction(ctx, 'sessions.binding')) features.record('sessions.projections', false, 'sessions.binding')
      return face ?? NO_FACE
    },
    chatAddress(parent, child) {
      return subagentAddress(ctx, parent, child)
    },
    openSession(parent, child) {
      ctx.uiWorkspace?.openSession?.({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })
    },
  }
}

/**
 * Address of one child's native sidebar chat, preferring the controller's known mode.
 * @param ctx - client plugin context.
 * @param parent - main Session id, the fallback parent when the controller has no address.
 * @param child - fork or worker Session id.
 * @returns the resource address.
 */
export function subagentAddress(
  ctx: { sessions?: { subagentAddress?: (id: string) => { parentSessionId?: string; mode?: string } | undefined } },
  parent: string,
  child: string,
): string {
  const known = ctx.sessions?.subagentAddress?.(child)
  const query = new URLSearchParams({ parent: known?.parentSessionId ?? parent, mode: known?.mode ?? 'continuable' })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(child)}?${query}`
}

