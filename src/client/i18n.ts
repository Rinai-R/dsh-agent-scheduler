/**
 * The browser half's link to src/i18n: components call {@link useLocale} so they render again
 * when the user switches DSH's language, without a reload.
 */
import { useSyncExternalStore } from 'react'
import { snapshot, subscribe } from '../i18n/index.js'

export { list, t, tn } from '../i18n/index.js'

/** Render again whenever DSH's language (or the registered dictionaries) change. */
export function useLocale(): void {
  useSyncExternalStore(subscribe, snapshot, snapshot)
}
