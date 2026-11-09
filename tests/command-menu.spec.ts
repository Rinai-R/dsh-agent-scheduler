/** The plugin's rows in the composer's `/` menu: a short title and one line, in DSH's language. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { gate, setup, teardown } from './support/harness.js'
import { textResponse } from './support/mock-adapter.js'
import { LANGS, setLanguage, type Lang } from '../src/i18n/index.js'
import { MENU, menuDescription, menuHint } from '../src/menu.js'
import { followHostLocale, LOCALE_SETTINGS } from '../src/dsh/host/locale.js'
import { registerCommand } from '../src/dsh/host/services.js'
import * as RulePlugin from '../src/rule-plugin.js'

afterEach(teardown)

const NAMES = Object.keys(MENU) as (keyof typeof MENU)[]
/** Characters of a line: a CJK one reads as two Latin ones. */
const width = (s: string) => [...s].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0)

describe('/ menu copy', () => {
  for (const lang of LANGS) {
    it(`${lang}: every command has a short title and one short line, no chained clauses`, () => {
      const undo = setLanguage(lang)
      try {
        for (const name of NAMES) {
          const text = menuDescription(name)
          const [title, line, ...rest] = text.split(' · ')
          expect(rest, `${lang} ${name}`).toEqual([])
          expect(width(title!), `${lang} ${name} title`).toBeLessThanOrEqual(24)
          expect(width(line!), `${lang} ${name} line`).toBeLessThanOrEqual(72)
          expect(text, `${lang} ${name}`).not.toMatch(/[;；]/u)
          if (name !== 'fork') expect(menuHint(name).trim(), `${lang} ${name} hint`).not.toBe('')
        }
      } finally { undo() }
    })
  }

  it('titles differ by language and keep the command names in the hints', () => {
    const titles = (lang: Lang) => { const undo = setLanguage(lang); try { return NAMES.map(n => menuDescription(n)) } finally { undo() } }
    expect(titles('zh')[0]).toMatch(/^调度 · /u)
    expect(titles('en')[0]).toMatch(/^Scheduling · /u)
    expect(titles('de')[0]).toMatch(/^Planung · /u)
    const undo = setLanguage('ja')
    try { expect(menuHint('agents')).toContain('merge <a> into <b>') } finally { undo() }
  })
})

describe('registration follows the language', () => {
  it('registers again when the language changes: the runtime then lists the new text, and the command still runs', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    const changes: number[] = []
    ctx.on('commands/change' as never, (() => { changes.push(1) }) as never)
    const undo = setLanguage('zh')
    try {
      // The source the rule installs: here, one fixed language a test switches.
      registerCommand(ctx, { id: 'dsh-agent-scheduler/schedule', name: 'schedule', description: () => menuDescription('schedule'), hint: () => menuHint('schedule'), run: () => ({ kind: 'success', text: 'RAN' }) })
      const row = () => ctx.commands.list(lead).find(d => d.name === 'schedule')!
      expect(row().description).toMatch(/^调度 · /u)
      expect(row().definitionId).toBe('dsh-agent-scheduler/schedule')
      const before = changes.length
      setLanguage('de')
      expect(row().description).toMatch(/^Planung · /u)
      expect(row().input?.hint).toBe('[on | off]')
      expect(changes.length).toBeGreaterThan(before)
      // One row, not two, and it still executes.
      expect(ctx.commands.list(lead).filter(d => d.name === 'schedule')).toHaveLength(1)
      expect(ctx.commands.find(lead, 'schedule')).toBeDefined()
      // The same text again registers nothing.
      const settled = changes.length
      setLanguage('de')
      expect(changes.length).toBe(settled)
    } finally { undo() }
  })

  it('a command still running when the language changes finishes, and its reply is logged once', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    const undo = setLanguage('zh')
    try {
      const hold = gate()
      let ran = 0
      registerCommand(ctx, { id: 'dsh-agent-scheduler/agents', name: 'agents', description: () => menuDescription('agents'), hint: () => menuHint('agents'), run: async () => { ran += 1; await hold.promise; return { kind: 'success', text: 'FINISHED' } } })
      const running = ctx.commands.execute(lead, '/agents seen all', [], new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 10))
      // The row is replaced while the handler awaits: it is neither cancelled nor run twice.
      setLanguage('ru')
      expect(ctx.commands.list(lead).filter(d => d.name === 'agents')).toHaveLength(1)
      hold.open()
      const out = await running
      expect(out?.result).toMatchObject({ kind: 'success', text: 'FINISHED' })
      expect(ran).toBe(1)
      const done = lead.session.snapshotEvents().filter(e => e.type === 'command/done')
      expect(done).toHaveLength(1)
      // Re-registering wrote nothing to the session log: only this one run and its reply.
      expect(lead.session.snapshotEvents().filter(e => e.type === 'command/run')).toHaveLength(1)
    } finally { undo() }
  })

  it('the rule\'s commands follow DSH\'s language setting', async () => {
    const ctx = new Context()
    let value: Record<string, unknown> = { [LOCALE_SETTINGS.field]: 'en' }
    const updated = new Set<(ns: string) => void>()
    ;(ctx as unknown as { settings: unknown }).settings = { describe: () => [{ ns: LOCALE_SETTINGS.namespace, value }] }
    // A stand-in for dsh-settings: describe() and the update event the language reads.
    const scoped = { settings: (ctx as unknown as { settings: unknown }).settings, on: (_: string, fn: (ns: string) => void) => { updated.add(fn); return () => { updated.delete(fn) } }, effect: ctx.effect.bind(ctx) }
    ;(ctx as unknown as { inject: unknown }).inject = (_: unknown, fn: (c: unknown) => void) => { fn(scoped) }
    const lang = followHostLocale(ctx)
    expect(lang()).toBe('en')
    expect(menuDescription('role')).toMatch(/^Lead role · /u)
    value = { [LOCALE_SETTINGS.field]: 'fr' }
    for (const fn of updated) fn(LOCALE_SETTINGS.namespace)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lang()).toBe('fr')
    expect(menuDescription('role')).toMatch(/^Rôle du lead · /u)
    await ctx.fiber.dispose()
  })

  it('mounts on the real runtime with every row localized', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(RulePlugin as never, {} as never)
    const rows = ctx.commands.list(lead).filter(d => String(d.definitionId ?? '').startsWith('dsh-agent-scheduler/'))
    expect(rows.map(r => r.name).sort()).toEqual(['agent-access', 'agent-model', 'agents', 'fork', 'role', 'schedule', 'worker'])
    // No settings service here: Chinese, as every other reply.
    for (const r of rows) expect(r.description, r.name).toMatch(/ · /u)
    expect(rows.find(r => r.name === 'fork')!.input).toBeUndefined()
  })
})
