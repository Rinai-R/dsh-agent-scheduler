/**
 * The browser half of the DSH adapter. Client modules import DSH services, DOM selectors and UI
 * seats from here and nowhere else.
 * @module dsh-agent-scheduler/dsh/client
 */
export * from './dom.js'
export * from './services.js'
export * from './catalog.js'
export * from './sidebar.js'
export * from './ui.js'
export { features, warnOnce, type Feature } from '../compat.js'
