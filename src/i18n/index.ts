/**
 * The plugin's words for people, in DSH's language. Both halves use it: the browser half
 * translates through DSH's locale service (src/dsh/client/locale.ts), the host half through the
 * language preference it reads from the Host settings (src/dsh/host/locale.ts). Until one is
 * installed, and wherever DSH offers neither, text is Chinese.
 * @module dsh-agent-scheduler/i18n
 */
import { de } from './de.js'
import { en } from './en.js'
import { es } from './es.js'
import { fr } from './fr.js'
import { ja } from './ja.js'
import { pt } from './pt.js'
import { ru } from './ru.js'
import { zh } from './zh.js'

export { de, en, es, fr, ja, pt, ru, zh }

/** The languages this plugin ships: every language DSH offers (dsh-client-locale). */
export const LANGS = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
export type Lang = typeof LANGS[number]
export type MessageKey = keyof typeof zh
export type Params = Readonly<Record<string, string | number>>
/** A key pair `<base>.one` / `<base>.other`, chosen by count. */
export type PluralKey = MessageKey extends infer K ? K extends `${infer B}.one` ? B : never : never

/** Namespace of the plugin's dictionaries in DSH's locale registry. */
export const NAMESPACE = 'agentScheduler'
export const DICTIONARIES: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = { zh, en, ja, es, fr, de, ru, pt }

/**
 * Fill `{name}` placeholders, the way DSH's locale runtime does: an unknown name stays as written.
 * @param template - the text.
 * @param params - placeholder values.
 * @returns the text.
 */
export function format(template: string, params?: Params): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => name in params ? String(params[name]) : match)
}

/**
 * @param lang - the language.
 * @param key - the message.
 * @param params - placeholder values.
 * @returns the text in that language.
 */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  // Like DSH's fallback chains: every added language falls back to English.
  return format(DICTIONARIES[lang][key] ?? en[key] ?? zh[key] ?? key, params)
}

/**
 * The language a DSH locale id reads in: the shipped language its primary subtag names, else
 * English (DSH's fallback chains all end in English).
 * @param id - a BCP 47-style id, e.g. `zh`, `zh-TW`, `pt-BR`, `en-US`.
 * @returns the language.
 */
export function langOf(id: string): Lang {
  const primary = id.split(/[-_]/u)[0]!.toLowerCase()
  return (LANGS as readonly string[]).includes(primary) ? primary as Lang : 'en'
}

const pluralRules = new Map<string, Intl.PluralRules>()

/**
 * Which of a key pair a count takes: `.one` when the language's plural rules call the count
 * `one` (1 in English and German; 0 and 1 in French and Portuguese; 1, 21, 31… in Russian;
 * never in Chinese or Japanese, whose pairs read the same), else `.other`.
 * @param lang - a locale id.
 * @param count - how many.
 * @returns the form.
 */
export function pluralForm(lang: string, count: number): 'one' | 'other' {
  let rules = pluralRules.get(lang)
  if (rules === undefined) {
    try { rules = new Intl.PluralRules(lang) } catch { rules = new Intl.PluralRules('en') }
    pluralRules.set(lang, rules)
  }
  return rules.select(count) === 'one' ? 'one' : 'other'
}

/** Where translations come from: DSH's locale service, or a fixed language. */
export interface Source {
  t(key: MessageKey, params?: Params): string
  /** Called on every change of language or dictionaries. */
  subscribe(listener: () => void): () => void
  /** Changes whenever {@link t} may answer differently. */
  revision(): number
  /** The active locale id, for plural forms; absent reads as English. */
  lang?(): string
}

/**
 * A source that answers in one language, picked on every call.
 * @param lang - the language, or a function read on every call.
 * @returns the source.
 */
export function fixedSource(lang: Lang | (() => Lang)): Source {
  const read = typeof lang === 'function' ? lang : () => lang
  return { t: (key, params) => translate(read(), key, params), subscribe: () => () => undefined, revision: () => 0, lang: read }
}

let source: Source = fixedSource('zh')
let generation = 0
const listeners = new Set<() => void>()
let unsubscribe: () => void = () => undefined

/**
 * Translate through the current source.
 * @param key - the message.
 * @param params - placeholder values.
 * @returns the text.
 */
export function t(key: MessageKey, params?: Params): string {
  return source.t(key, params)
}

/**
 * Translate a count: the `.one` form when the active language calls it `one` ({@link pluralForm}),
 * else `.other`; `{count}` is filled in.
 * @param key - the key pair's base.
 * @param count - how many.
 * @param params - other placeholder values.
 * @returns the text.
 */
export function tn(key: PluralKey, count: number, params?: Params): string {
  return t(`${key}.${pluralForm(source.lang?.() ?? 'en', count)}` as MessageKey, { ...params, count })
}

/**
 * Join names the way the language lists them.
 * @param items - the names.
 * @returns them in one string.
 */
export function list(items: readonly string[]): string {
  return items.join(t('list.separator'))
}

const notify = () => { for (const listener of [...listeners]) listener() }

/**
 * Install where translations come from.
 * @param next - the source.
 * @returns restores the previous source (when this one is still installed).
 */
export function setSource(next: Source): () => void {
  const previous = source
  unsubscribe()
  source = next
  generation += 1
  unsubscribe = next.subscribe(notify)
  notify()
  return () => { if (source === next) setSource(previous) }
}

/**
 * Answer in one fixed language (tests, and anything without a DSH language).
 * @param lang - the language.
 * @returns restores the previous source.
 */
export function setLanguage(lang: Lang): () => void {
  return setSource(fixedSource(lang))
}

/**
 * Hear every change of language: for `useSyncExternalStore`.
 * @param listener - called on change.
 * @returns unsubscribes.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** @returns a value that changes whenever the translations may have. */
export function snapshot(): string {
  return `${generation}:${source.revision()}`
}
