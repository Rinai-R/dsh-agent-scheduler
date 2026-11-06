/**
 * Tests that read the host's command replies read them in English: DSH's language is a Host
 * setting these compositions do not have (the plugin would answer in Chinese).
 */
import { afterAll, beforeAll } from 'vitest'
import { setLanguage, type Lang } from '../../src/i18n/index.js'

/** Answer in one language for every test of the calling file. */
export function inLanguage(lang: Lang): void {
  let undo: () => void = () => undefined
  beforeAll(() => { undo = setLanguage(lang) })
  afterAll(() => { undo() })
}
