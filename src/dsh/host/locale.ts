/**
 * DSH's language on the host, for slash-command replies. DSH keeps the user's explicit language
 * choice as a Host setting: namespace `locale` (the `@deepseek-ai/dsh-client-locale` row), field
 * `preference`, declared volatile, so `ctx.settings.describe()` (dsh-settings) reads it live and a
 * write announces itself with `settings/document-updated(ns, revision)`.
 *
 * DSH falls back to the browser's language when no choice was made; the host cannot see the
 * browser, so the plugin then answers in Chinese. So it does, with one warning, on a DSH
 * without the settings service.
 * @module dsh-agent-scheduler/dsh/host/locale
 */
import type { Context } from '@deepseek-ai/cordis'
import { features, warnOnce } from '../compat.js'
import { langOf, setSource, translate, type Lang } from '../../i18n/index.js'

/** The Host settings namespace and field DSH's locale plugin keeps the choice in. */
export const LOCALE_SETTINGS = { namespace: 'locale', field: 'preference' } as const

/** The members of the Host settings service the plugin uses. */
export interface SettingsFace {
  describe(): readonly { readonly ns: string; readonly value?: unknown }[]
}

/**
 * The language a settings snapshot asks for.
 * @param settings - the Host settings service.
 * @returns the language, or undefined when no explicit choice was made.
 */
export function preferredLang(settings: SettingsFace): Lang | undefined {
  const entry = settings.describe().find(d => d.ns === LOCALE_SETTINGS.namespace)
  const value = (entry?.value as Record<string, unknown> | undefined)?.[LOCALE_SETTINGS.field]
  return typeof value === 'string' && value !== '' ? langOf(value) : undefined
}

/**
 * Follow DSH's language on the host for as long as the row is mounted: the source of
 * src/i18n `t` there.
 * @param ctx - the rule's context.
 * @returns the language now in use, read on every call.
 */
export function followHostLocale(ctx: Context): () => Lang {
  let lang: Lang = 'zh'
  let revision = 0
  let service: SettingsFace | undefined
  const listeners = new Set<() => void>()
  // A change of language is announced, so what was registered in one (the composer's command
  // rows) can be registered again in the other.
  const set = (next: Lang) => {
    if (next === lang) return
    lang = next
    revision += 1
    for (const listener of [...listeners]) listener()
  }
  const read = () => {
    if (service === undefined) return
    try {
      set(preferredLang(service) ?? 'zh')
    } catch (error) {
      warnOnce('settings.locale.read', 'reading DSH\'s language from the Host settings failed; command replies are in Chinese', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => {
      // dsh-settings is not a dependency of the plugin: its service and event are typed here.
      const scoped = child as unknown as Context & { settings?: Partial<SettingsFace>; on(name: 'settings/document-updated', listener: (ns: string) => void): () => void }
      const settings = scoped.settings
      if (!features.record('settings.locale', typeof settings?.describe === 'function', 'settings.describe')) return
      service = settings as SettingsFace
      read()
      // describe() emits this event itself: read after it returns, never inside it.
      scoped.on('settings/document-updated', (ns) => { if (ns === LOCALE_SETTINGS.namespace) queueMicrotask(read) })
      scoped.effect(() => () => { service = undefined; set('zh') }, 'agent-scheduler: settings language')
    })
  }
  const current = () => {
    if (service === undefined) warnOnce('feature:settings.locale', 'this DSH has no settings service; command replies are in Chinese')
    return lang
  }
  ctx.effect(() => setSource({
    t: (key, params) => translate(current(), key, params),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    revision: () => revision,
    lang: current,
  }), 'agent-scheduler: host language')
  return current
}
