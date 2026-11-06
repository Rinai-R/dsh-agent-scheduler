/**
 * Which DSH this plugin is built for, and which one it runs in.
 * @module dsh-agent-scheduler/dsh/host/version
 */
import { createRequire } from 'node:module'

/**
 * The DSH versions this plugin is verified against. Kept equal to `engines.dsh` and to the
 * `@deepseek-ai/dsh-*` peer ranges in package.json (tests/contract/packaging.spec.ts).
 */
export const DSH_RANGE = '>=0.2.1-rc.5 <0.3.0'

/**
 * @returns the version of the DSH runtime this process loaded, or undefined when it cannot be read.
 */
export function hostVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@deepseek-ai/dsh-agent/package.json') as { version?: string }).version
  } catch {
    return undefined
  }
}
