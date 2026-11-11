/** A worker row while it takes part in a merge: the merge reads as its subtitle, not as a wide badge. */
import { afterEach, describe, expect, it } from 'vitest'
import { mergeLine } from '../src/client/index.js'
import { setLanguage, LANGS } from '../src/i18n/index.js'

afterEach(() => { setLanguage('zh') })

const merge = { id: 'mg-1', absorbed: 'a', survivor: 's' }
const nameOf = (id: string) => ({ a: 'scheduler-i18n-locales', s: 'scheduler-worker-merge' })[id] ?? id

describe('merge row', () => {
  it('names the other side and the merge on both sides', () => {
    setLanguage('zh')
    expect(mergeLine({ id: 'a' }, merge, nameOf)).toBe('合并到 scheduler-worker-merge · mg-1')
    expect(mergeLine({ id: 's' }, merge, nameOf)).toBe('合并 scheduler-i18n-locales 进来 · mg-1')
    setLanguage('en')
    expect(mergeLine({ id: 'a' }, merge, nameOf)).toBe('Merging into scheduler-worker-merge · mg-1')
    for (const lang of LANGS) {
      setLanguage(lang)
      for (const side of ['a', 's']) {
        const line = mergeLine({ id: side }, merge, nameOf)
        expect(line, lang).toContain('mg-1')
        expect(line, lang).toContain(nameOf(side === 'a' ? 's' : 'a'))
      }
    }
  })

})
