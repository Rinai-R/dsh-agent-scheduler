/**
 * The plugin's words in both languages: complete dictionaries, matching placeholders, every key
 * the code uses, English rendering of the client's labels and the host's replies, and the two
 * adapters that pick the language (src/dsh/client/locale.ts, src/dsh/host/locale.ts).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DICTIONARIES, en, NAMESPACE, setLanguage, t, tn, translate, zh, type MessageKey } from '../src/i18n/index.js'
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
  it('zh and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('every key has the same placeholders in both languages, and no empty text', () => {
    for (const key of Object.keys(zh) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
    }
  })

  it('every count has both its forms, with {count}', () => {
    for (const key of Object.keys(zh)) {
      const plural = /^(.*)\.(one|other)$/u.exec(key)
      if (plural === null) continue
      expect(Object.keys(zh), key).toContain(`${plural[1]}.${plural[2] === 'one' ? 'other' : 'one'}`)
      expect(zh[key as MessageKey], key).toContain('{count}')
    }
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
    for (const file of ['src/tools.ts', 'src/scheduler.ts', 'src/fork-guard.ts', 'src/recovery.ts']) {
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

describe('host replies follow the language', () => {
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
function fakeLocale(active: 'zh' | 'en') {
  const dicts = new Map<string, Record<string, Record<string, string>>>()
  const listeners = new Set<() => void>()
  let revision = 0
  const state = { active }
  const publish = () => { revision += 1; for (const l of [...listeners]) l() }
  return {
    state,
    dicts,
    listeners,
    switchTo(next: 'zh' | 'en') { state.active = next; publish() },
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
    store.box.preference = 'zh'
    const emit = ctx.emit.bind(ctx) as unknown as (name: string, ns: string, revision: number) => void
    emit('settings/document-updated', 'unrelated', 1)
    await Promise.resolve()
    expect(lang()).toBe('en')
    emit('settings/document-updated', 'locale', 2)
    await Promise.resolve()
    expect(lang()).toBe('zh')
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
