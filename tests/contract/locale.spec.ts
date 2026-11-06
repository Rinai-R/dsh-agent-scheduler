/**
 * Language contract (L1-L4 in docs/dsh-adapter.md): where the plugin reads DSH's language, in the
 * published packages of the DSH version under test. The browser half registers and translates
 * through dsh-client-locale's `LocaleRuntime`; the host half reads the preference that package
 * keeps in the Host settings (dsh-settings); package display text comes from `locale/*.json`
 * (dsh-app-boot). Source probes: a hit does not prove the meaning, a miss means it broke.
 */
import { describe, expect, it } from 'vitest'
import { LOCALE_SETTINGS } from '../../src/dsh/host/locale.js'
import { fetched, ownFile, probesAvailable } from './probe.js'

describe.runIf(probesAvailable())('DSH language', () => {
  it('L1: the locale service still registers dictionaries, binds a namespace, and reports changes', () => {
    const code = fetched('dsh-client-locale')
    expect(code).toMatch(/register\(ns, localeOrDicts, dict\) \{/u)
    expect(code).toMatch(/bind\(ns\) \{/u)
    expect(code).toMatch(/subscribe\(fn\) \{/u)
    expect(code).toMatch(/getSnapshot\(\) \{/u)
    // Registrations and switches both bump the revision the plugin re-renders on.
    expect(code).toMatch(/revision: this\.snapshot\.revision \+ 1/u)
    expect(code).toContain('ctx.provide("locale", locale)')
  })

  it('L2: templates still fill {name} placeholders, as src/i18n format does', () => {
    expect(fetched('dsh-client-locale')).toContain('template.replace(/\\{(\\w+)\\}/g')
  })

  it('L3: the explicit choice is still the `preference` field of the `locale` settings namespace, read live', () => {
    const code = fetched('dsh-client-locale')
    expect(code).toContain(`LOCALE_SETTINGS_NAMESPACE = "${LOCALE_SETTINGS.namespace}"`)
    expect(code).toContain(`LOCALE_PREFERENCE_FIELD = "${LOCALE_SETTINGS.field}"`)
    expect(code).toMatch(/\[LOCALE_PREFERENCE_FIELD\]: LocaleSettingsFields\[LOCALE_PREFERENCE_FIELD\]\.volatile\(\)/u)
    const settings = fetched('dsh-settings')
    expect(settings).toMatch(/describe\(options\) \{/u)
    expect(settings).toMatch(/ns: entry\.options\.id,[\s\S]{0,200}value: options\?\.redactSecrets \? redacted\.value : value/u)
    expect(settings).toContain('emit("settings/document-updated", entry.options.id, revision)')
  })

  it('L5: register accepts any language id, and where DSH offers ja, es, fr, de, ru and pt they fall back to English', () => {
    const code = fetched('dsh-client-locale')
    // DSH 0.2.1 lets the user pick zh and en only; 0.2.2 adds six languages. The plugin registers
    // all eight either way: an extra dictionary DSH does not offer is simply never active.
    const offered = /locale\.addLanguage\(\{\s*id,\s*label,\s*fallback: "en"\s*\}\)/u.test(code)
    if (offered) {
      for (const [id, label] of [['ja', '日本語'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português']]) {
        expect(code, id).toMatch(new RegExp(`\\["${id}",\\s*"${label}"\\]`, 'u'))
      }
    }
    if (process.env.CONTRACT_TAG !== undefined) expect(offered, 'the next DSH offers the six added languages').toBe(true)
    // register(ns, dicts) takes every entry of the object, checking only that each key is a language id.
    expect(code).toContain('const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);')
    const pattern = /LOCALE_ID_PATTERN = (\/.*\/u?);/u.exec(code)?.[1]
    expect(pattern).toBeDefined()
    const re = new Function(`return ${pattern}`)() as RegExp
    for (const id of ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) expect(re.test(id), id).toBe(true)
  })

  it('L4: package display text is still read from locale/<lang>.json `meta`, which the plugin fills', () => {
    const boot = fetched('dsh-app-boot')
    expect(boot).toMatch(/textOf\(meta\?\.title/u)
    expect(boot).toMatch(/textOf\(meta\?\.description/u)
    for (const lang of ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
      const meta = (JSON.parse(ownFile(`locale/${lang}.json`)) as { meta?: { title?: string; description?: string } }).meta
      expect(meta?.title, lang).toBeTruthy()
      expect(meta?.description, lang).toBeTruthy()
    }
  })
})
