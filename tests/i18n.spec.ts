/**
 * The plugin's words in both languages: complete dictionaries, matching placeholders, every key
 * the code uses, English rendering of the client's labels and the host's replies, and the two
 * adapters that pick the language (src/dsh/client/locale.ts, src/dsh/host/locale.ts).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DICTIONARIES, en, LANGS, langOf, NAMESPACE, pluralForm, setLanguage, t, tn, translate, zh, type Lang, type MessageKey } from '../src/i18n/index.js'
import { features, resetWarnings, setWarnSink } from '../src/dsh/compat.js'
import { followDshLocale } from '../src/dsh/client/locale.js'
import { followHostLocale } from '../src/dsh/host/locale.js'
import { hiddenLabel, newWorkerCommand, openLabel, renameCommand, rowTitle, statusLine, subline, workerModelLabel } from '../src/client/index.js'
import { incompatible, runScheduleCommand, runWorkerModelCommand } from '../src/rule-plugin.js'

const ROOT = resolve(import.meta.dirname, '..')
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(m => m[1]).sort()
const sources = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/u.test(e.name) ? [join(dir, e.name)] : [])

let undo: () => void = () => undefined
afterEach(() => { undo(); undo = () => undefined; features.reset(); resetWarnings() })

describe('dictionaries', () => {
  it('ships every language DSH offers, each with exactly the keys of zh', () => {
    expect([...LANGS].sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const lang of LANGS) expect(Object.keys(DICTIONARIES[lang]).sort(), lang).toEqual(Object.keys(zh).sort())
  })

  it('every key has the same placeholders in every language, and no empty text', () => {
    for (const lang of LANGS) {
      for (const key of Object.keys(zh) as MessageKey[]) {
        expect(placeholders(DICTIONARIES[lang][key]), `${lang} ${key}`).toEqual(placeholders(zh[key]))
        expect(DICTIONARIES[lang][key].trim(), `${lang} ${key}`).not.toBe('')
      }
    }
  })

  it('every count has both its forms, with {count}, in every language', () => {
    for (const lang of LANGS) {
      const dict = DICTIONARIES[lang]
      for (const key of Object.keys(dict)) {
        const plural = /^(.*)\.(one|other)$/u.exec(key)
        if (plural === null) continue
        expect(Object.keys(dict), `${lang} ${key}`).toContain(`${plural[1]}.${plural[2] === 'one' ? 'other' : 'one'}`)
        expect(dict[key as MessageKey], `${lang} ${key}`).toContain('{count}')
      }
    }
  })

  it('translations are translated: nothing left identical to English except proper names and codes', () => {
    // Text that is the same in every language by design: symbols, placeholders only, names, usage lines.
    // Argument hints are command syntax: `[on | off]`, `model <provider>/<model> [effort]`.
    const same = (v: string) => /^[\s{}\w.,:/·⚡…|<>[\]-]*$/u.test(v.replace(/\{\w+\}/gu, '')) || /^[A-Z][\w ]*$/u.test(v)
    for (const lang of ['ja', 'es', 'fr', 'de', 'ru', 'pt'] as const) {
      const left = (Object.keys(en) as MessageKey[]).filter(k => DICTIONARIES[lang][k] === en[k] && !same(en[k]))
      expect(left, lang).toEqual([])
    }
  })

  it('maps DSH locale ids to the shipped languages, English otherwise', () => {
    expect(['zh', 'zh-TW', 'en-US', 'ja', 'ja-JP', 'pt-BR', 'pt_PT', 'ru', 'DE', 'fr-CA', 'es-419', 'ko', 'it'].map(langOf)).toEqual(['zh', 'zh', 'en', 'ja', 'ja', 'pt', 'pt', 'ru', 'de', 'fr', 'es', 'en', 'en'])
  })

  it('picks plural forms by each language\'s rules', () => {
    const forms = (lang: string) => [0, 1, 2, 5, 21].map(n => pluralForm(lang, n))
    expect(forms('en')).toEqual(['other', 'one', 'other', 'other', 'other'])
    expect(forms('de')).toEqual(['other', 'one', 'other', 'other', 'other'])
    expect(forms('fr')).toEqual(['one', 'one', 'other', 'other', 'other'])
    expect(forms('ru')).toEqual(['other', 'one', 'other', 'other', 'one'])
    expect(forms('ja')).toEqual(['other', 'other', 'other', 'other', 'other'])
    expect(forms('zh')).toEqual(['other', 'other', 'other', 'other', 'other'])
    // Japanese and Chinese pairs read the same, so their single form is always right.
    for (const lang of ['ja', 'zh'] as const) {
      for (const key of Object.keys(DICTIONARIES[lang]).filter(k => k.endsWith('.one'))) {
        expect(DICTIONARIES[lang][key.replace(/\.one$/u, '.other') as MessageKey], `${lang} ${key}`).toBe(DICTIONARIES[lang][key as MessageKey])
      }
    }
    // Russian: 21 takes the singular form, 2 and 5 a form that reads right for any count.
    undo = setLanguage('ru')
    expect(tn('roster.total', 21)).toBe('21 агент')
    expect(tn('roster.total', 3)).toBe('Агентов: 3')
    expect(tn('roster.total', 5)).toBe('Агентов: 5')
  })

  it('every key the code names exists', () => {
    const used = new Set<string>()
    for (const file of sources('src').filter(f => !f.startsWith(join('src', 'i18n')))) {
      const code = readFileSync(join(ROOT, file), 'utf8')
      for (const m of code.matchAll(/\bt\('([\w.]+)'/gu)) used.add(m[1]!)
      for (const m of code.matchAll(/\btn\('([\w.]+)'/gu)) { used.add(`${m[1]}.one`); used.add(`${m[1]}.other`) }
    }
    expect(used.size).toBeGreaterThan(50)
    expect([...used].filter(key => !(key in zh))).toEqual([])
  })

  it('what the model reads stays English: no translated text in prompts or tools', () => {
    for (const file of ['src/tools.ts', 'src/scheduler.ts', 'src/recovery.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/from '\.\/i18n\//u)
    }
  })

  it('fills placeholders and leaves unknown ones as written', () => {
    expect(translate('en', 'cmd.agents.renamed', { from: 'a', to: 'b' })).toBe('Renamed a to b.')
    expect(translate('zh', 'cmd.agents.renamed', { from: 'a' })).toBe('已把 a 改名为 {to}。')
  })
})

describe('client labels in English', () => {
  it('are English after a switch, and Chinese by default', () => {
    expect(openLabel(2, 'idle')).toBe('2 个请求待回答')
    undo = setLanguage('en')
    expect(openLabel(1, 'idle')).toBe('1 open request')
    expect(openLabel(2, 'running')).toBe('2 requests in progress')
    expect(hiddenLabel({ n: 3, unread: 1, waiting: 1, first: 0 })).toBe('3 more below · 1 needs you · 1 unread')
    expect(hiddenLabel({ n: 2, unread: 2, waiting: 2, first: 0 })).toBe('2 more below · 2 need you · 2 unread')
    expect(tn('roster.total', 1)).toBe('1 agent')
    expect(tn('roster.total', 4)).toBe('4 agents')
    expect(newWorkerCommand({ name: 'Bad', role: 'x' })).toEqual({ error: t('form.nameRule') })
    expect(newWorkerCommand({ name: 'ok', role: '' })).toEqual({ error: 'Say what this worker is responsible for' })
    expect(renameCommand('a', 'B')).toEqual({ error: 'Use lowercase letters, digits and hyphens, starting with a letter, at most 40 characters' })
    expect(rowTitle({ id: 's1', cwd: '/w' } as never)).toBe('s1\nDirectory: /w')
    expect(subline({ kind: 'worker', state: 'idle', text: '', role: 'r' } as never, [{ id: 'r-1', text: 'do  it' }])).toBe('r-1: do it')
    expect(workerModelLabel([], null)).toBe('Default')
  })

  it('the status line keeps the name bold wherever the language puts it', () => {
    undo = setLanguage('en')
    const say = (fork: 'queued' | 'running' | 'done' | 'failed', detail?: string) => {
      const l = statusLine({ fork, name: 'fork-7', ...(detail === undefined ? {} : { detail }) })
      return [l.lead, l.name, l.tail, l.open]
    }
    expect(say('queued')).toEqual(['Handed to ', 'fork-7', ' · waiting for a slot', 'View'])
    expect(say('done')).toEqual(['', 'fork-7', ' handed back', 'View'])
    expect(say('failed', 'at capacity')).toEqual(['', 'fork-7', ' failed to start: at capacity', 'View'])
    expect(statusLine({ fork: 'running' }).name).toBe('fork')
  })
})

describe('client labels in the added languages', () => {
  it('every language answers in itself', () => {
    const expected: Record<Exclude<Lang, 'zh' | 'en'>, string> = { ja: '振り分け', es: 'Reparto', fr: 'Répartir', de: 'Verteilen', ru: 'Распределение', pt: 'Distribuir' }
    for (const [lang, label] of Object.entries(expected)) {
      undo = setLanguage(lang as Lang)
      expect(t('switch.label'), lang).toBe(label)
      undo()
    }
    undo = setLanguage('fr')
    expect(tn('roster.total', 0)).toBe('0 agent')
    expect(tn('roster.total', 2)).toBe('2 agents')
    undo()
    undo = setLanguage('de')
    expect(openLabel(1, 'idle')).toBe('1 offene Anfrage')
    expect(openLabel(3, 'running')).toBe('3 Anfragen in Arbeit')
  })
})

describe('host replies follow the language', () => {
  it('answer in each language DSH can ask for', () => {
    const scheduler = { setMode: () => undefined, isOn: () => true }
    const invocation = { agent: { session: { header: {} } }, rawInput: 'maybe' } as never
    const usage: Record<Lang, string> = {
      zh: '用法：/schedule [on | off]', en: 'Usage: /schedule [on | off]', ja: '使い方：/schedule [on | off]', es: 'Uso: /schedule [on | off]',
      fr: 'Utilisation : /schedule [on | off]', de: 'Verwendung: /schedule [on | off]', ru: 'Использование: /schedule [on | off]', pt: 'Uso: /schedule [on | off]',
    }
    for (const lang of LANGS) {
      undo = setLanguage(lang)
      expect(runScheduleCommand(scheduler as never, invocation).text, lang).toBe(usage[lang])
      undo()
    }
    undo = () => undefined
  })

  const main = { session: { header: {} } } as never
  it('answer in Chinese by default and English when DSH asks for it', async () => {
    const scheduler = { setMode: () => undefined, isOn: () => true }
    const invocation = (rawInput: string) => ({ agent: main, rawInput }) as never
    // isMainSession reads the header: a main Session has no parent.
    expect(runScheduleCommand(scheduler as never, invocation('maybe')).text).toBe('用法：/schedule [on | off]')
    undo = setLanguage('en')
    expect(runScheduleCommand(scheduler as never, invocation('maybe')).text).toBe('Usage: /schedule [on | off]')
    expect((await runWorkerModelCommand(invocation('model nope'))).text).toMatch(/^Usage: \/worker model/u)
    expect(incompatible(['tools.guard'], '0.2.1')).toMatch(/^dsh-agent-scheduler cannot run on this DeepSeek Harness \(0\.2\.1\): it lacks tools\.guard\./u)
  })
})

/** A stand-in for dsh-client-locale's LocaleRuntime: the members the plugin uses. */
function fakeLocale(active: string) {
  const dicts = new Map<string, Record<string, Record<string, string>>>()
  const listeners = new Set<() => void>()
  let revision = 0
  const state = { active }
  const publish = () => { revision += 1; for (const l of [...listeners]) l() }
  return {
    state,
    dicts,
    listeners,
    switchTo(next: string) { state.active = next; publish() },
    service: {
      register(ns: string, value: Record<string, Record<string, string>>) { dicts.set(ns, value); publish(); return () => { dicts.delete(ns); publish() } },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => {
        const template = dicts.get(ns)?.[state.active]?.[key] ?? key
        return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (m, n: string) => n in params ? String(params[n]) : m)
      },
      getSnapshot: () => ({ active: state.active, revision }),
      subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    },
  }
}

describe('browser: DSH\'s locale service', () => {
  it('registers the namespace, translates in the active language, switches live, and lets go on dispose', async () => {
    const ctx = new Context()
    const locale = fakeLocale('en')
    ctx.provide('locale', locale.service)
    const fiber = ctx.plugin({ name: 'client', apply: (child: Context) => { followDshLocale(child) } } as never, undefined as never)
    await fiber
    expect(locale.dicts.get(NAMESPACE)).toBe(DICTIONARIES)
    expect(t('switch.label')).toBe('Schedule')
    let renders = 0
    const { subscribe } = await import('../src/i18n/index.js')
    const stop = subscribe(() => { renders += 1 })
    locale.switchTo('zh')
    expect(renders).toBe(1)
    expect(t('switch.label')).toBe('调度')
    // Every language DSH offers is registered; plural forms follow the active one.
    expect(Object.keys(locale.dicts.get(NAMESPACE)!).sort()).toEqual([...LANGS].sort())
    locale.switchTo('ru')
    expect(t('switch.label')).toBe('Распределение')
    expect(tn('roster.total', 21)).toBe('21 агент')
    expect(tn('roster.total', 22)).toBe('Агентов: 22')
    stop()
    await fiber.dispose()
    expect(locale.dicts.has(NAMESPACE)).toBe(false)
    expect(locale.listeners.size).toBe(0)
  })

  it('without the service, stays Chinese and warns once', () => {
    const seen: string[] = []
    const restore = setWarnSink(m => { seen.push(m) })
    expect(followDshLocale(new Context())).toBe(false)
    restore()
    expect(t('switch.label')).toBe('调度')
    expect(seen.filter(m => /locale/u.test(m))).toHaveLength(1)
  })
})

describe('host: the language preference in the Host settings', () => {
  const settings = (preference: string | undefined) => {
    const box = { preference }
    return { box, service: { describe: () => [{ ns: 'other', value: {} }, { ns: 'locale', value: box.preference === undefined ? {} : { preference: box.preference } }] } }
  }

  it('reads the explicit choice and follows a change', async () => {
    const ctx = new Context()
    const store = settings('en-US')
    ctx.provide('settings', store.service)
    const lang = followHostLocale(ctx)
    await new Promise(r => setTimeout(r, 0))
    expect(lang()).toBe('en')
    expect(t('cmd.schedule.usage')).toBe('Usage: /schedule [on | off]')
    store.box.preference = 'ja-JP'
    const emit = ctx.emit.bind(ctx) as unknown as (name: string, ns: string, revision: number) => void
    emit('settings/document-updated', 'unrelated', 1)
    await Promise.resolve()
    expect(lang()).toBe('en')
    emit('settings/document-updated', 'locale', 2)
    await Promise.resolve()
    expect(lang()).toBe('ja')
    expect(t('cmd.schedule.usage')).toBe('使い方：/schedule [on | off]')
    store.box.preference = 'ko'
    emit('settings/document-updated', 'locale', 3)
    await Promise.resolve()
    expect(lang()).toBe('en')
  })

  it('answers in Chinese when no language was chosen, and when there is no settings service (one warning)', async () => {
    const ctx = new Context()
    ctx.provide('settings', settings(undefined).service)
    const lang = followHostLocale(ctx)
    await new Promise(r => setTimeout(r, 0))
    expect(lang()).toBe('zh')
    const seen: string[] = []
    const restore = setWarnSink(m => { seen.push(m) })
    const bare = followHostLocale(new Context())
    expect(bare()).toBe('zh')
    expect(bare()).toBe('zh')
    restore()
    expect(seen.filter(m => /settings/u.test(m))).toHaveLength(1)
  })
})
