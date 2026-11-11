/**
 * Shared by both halves of the DSH adapter: which host features this DSH offers, and warnings
 * that are given once. Platform-neutral (no node or DOM APIs), so the browser bundle can use it.
 * @module dsh-agent-scheduler/dsh/compat
 */

/** A host feature the plugin probes for. Required ones gate scheduling; the rest degrade. */
export type Feature =
  // host, required
  | 'subagents' | 'agents' | 'tools' | 'tools.guard' | 'systemPrompt' | 'commands' | 'sessionQuery'
  // host, optional
  | 'sessionTitle' | 'modelSelection' | 'llm.resolve' | 'settings.locale' | 'agentTeams.workerLead' | 'sessionQuery.filterEvents'
  | 'storageDomain' | 'sessionController' | 'workspaceRegistry' 
  // client
  | 'conversation.events' | 'slots' | 'sidebar.tabs' | 'sidebar.layout' | 'sidebar.gestures' | 'tabs.keepMounted'
  | 'sessions.subagentAddress' | 'sessions.projections' | 'remote.commands' | 'remote.modelCatalog' | 'modelDirectories.catalog' | 'dom.stripTabs' | 'locale'

/** Thrown when the host answers in a shape this plugin does not know. */
export class DshContractError extends Error {
  override readonly name = 'DshContractError'
}

type Sink = (message: string, error?: unknown) => void
const defaultSink: Sink = (message, error) => {
  // eslint-disable-next-line no-console
  if (error === undefined) console.warn(`[dsh-agent-scheduler] ${message}`)
  // eslint-disable-next-line no-console
  else console.warn(`[dsh-agent-scheduler] ${message}`, error)
}
let sink: Sink = defaultSink
const warned = new Set<string>()

/**
 * Route warnings to a logger (the host's `ctx.logger`); the console is the default.
 * @param next - where warnings go.
 * @returns restores the previous sink.
 */
export function setWarnSink(next: Sink): () => void {
  const previous = sink
  sink = next
  return () => { if (sink === next) sink = previous }
}

/**
 * Warn about one incompatibility, once per key for the life of the process (or page).
 * @param key - what is incompatible, e.g. a feature name.
 * @param message - what the user or a bug report should read.
 * @param error - the host's error, if any.
 */
export function warnOnce(key: string, message: string, error?: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  try { sink(message, error) } catch { /* a broken logger must not break the caller */ }
}

/** Forget which warnings were given (tests). */
export function resetWarnings(): void { warned.clear() }

const state = new Map<Feature, { ok: boolean; why?: string }>()

/** What this DSH offers, as probed. */
export const features = {
  /**
   * Record a probe result; a missing feature also warns once.
   * @param feature - the feature.
   * @param ok - whether the host has it.
   * @param why - what was missing, for the warning.
   * @returns `ok`.
   */
  record(feature: Feature, ok: boolean, why?: string): boolean {
    state.set(feature, ok ? { ok } : { ok, ...(why === undefined ? {} : { why }) })
    if (!ok) warnOnce(`feature:${feature}`, `this DSH has no ${feature}${why === undefined ? '' : ` (${why})`}; the parts of the plugin that use it are off`)
    return ok
  },
  /**
   * @param feature - the feature.
   * @returns false only when it was probed and missing.
   */
  has(feature: Feature): boolean { return state.get(feature)?.ok !== false },
  /** @returns every probed feature and whether it is there. */
  report(): Record<string, boolean> { return Object.fromEntries([...state].map(([k, v]) => [k, v.ok])) },
  /** Forget every probe (tests). */
  reset(): void { state.clear() },
}

/**
 * Whether `value` has a function at `path` (`a.b.c`), for feature probes.
 * @param value - the object probed.
 * @param path - dot-separated property path.
 * @returns whether the last segment is a function.
 */
export function hasFunction(value: unknown, path: string): boolean {
  let at: unknown = value
  const parts = path.split('.')
  for (const [i, part] of parts.entries()) {
    if (at === null || at === undefined) return false
    at = (at as Record<string, unknown>)[part]
    if (i === parts.length - 1) return typeof at === 'function'
  }
  return false
}
