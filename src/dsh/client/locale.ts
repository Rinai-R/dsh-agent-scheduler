/**
 * DSH's language in the browser: the `locale` service of `@deepseek-ai/dsh-client-locale`
 * (`ctx.locale`, a `LocaleRuntime`). The plugin registers its namespace's dictionaries with
 * `register(ns, { zh, en })`, translates through `bind(ns)`, and renders again on `subscribe`,
 * which fires on every language switch and dictionary registration (the snapshot's `revision`).
 * Which language is active (the user's explicit choice, else the browser's) is DSH's business.
 * A DSH without the service leaves the plugin in Chinese, with one warning.
 * @module dsh-agent-scheduler/dsh/client/locale
 */
import { features, hasFunction } from '../compat.js'
import { DICTIONARIES, NAMESPACE, setSource, type MessageKey, type Params, type Source } from '../../i18n/index.js'

/** The members of DSH's locale service the plugin uses. */
export interface LocaleFace {
  register(ns: string, dicts: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
  bind(ns: string): (key: string, params?: Params) => string
  getSnapshot(): { readonly active: string; readonly revision: number }
  subscribe(listener: () => void): () => void
}

/**
 * Whether a context offers DSH's locale service in the shape the plugin knows.
 * @param ctx - the browser plugin context.
 * @returns the service, or undefined.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function localeOf(ctx: any): LocaleFace | undefined {
  const ok = ['register', 'bind', 'getSnapshot', 'subscribe'].every(member => hasFunction(ctx, `locale.${member}`))
  return features.record('locale', ok, 'locale.register / bind / getSnapshot / subscribe') ? ctx.locale as LocaleFace : undefined
}

/**
 * A translation source over DSH's locale service.
 * @param locale - the service.
 * @returns the source; its dictionaries must be registered separately ({@link followDshLocale}).
 */
export function localeSource(locale: LocaleFace): Source {
  const t = locale.bind(NAMESPACE)
  return {
    t: (key: MessageKey, params?: Params) => t(key, params),
    subscribe: listener => locale.subscribe(listener),
    revision: () => locale.getSnapshot().revision,
  }
}

/**
 * Register the plugin's dictionaries with DSH and translate in DSH's active language for as
 * long as the plugin is mounted.
 * @param ctx - the browser plugin context.
 * @returns whether DSH's language is followed (false: Chinese).
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function followDshLocale(ctx: any): boolean {
  // Optional, so injected on its own: a DSH without the service still mounts the plugin.
  const present = typeof ctx.get === 'function' ? ctx.get('locale') !== undefined : ctx.locale !== undefined
  if (typeof ctx.inject !== 'function') {
    features.record('locale', false, 'no locale service')
    return false
  }
  // Absent at mount: Chinese (and one warning) until a locale service appears, if ever.
  if (!present) features.record('locale', false, 'no locale service')
  ctx.inject(['locale'], (scoped: any) => {
    const locale = localeOf(scoped)
    if (locale === undefined) return
    scoped.effect(() => locale.register(NAMESPACE, DICTIONARIES), 'agent-scheduler: dictionaries')
    scoped.effect(() => setSource(localeSource(locale)), 'agent-scheduler: language')
  })
  return present
}
