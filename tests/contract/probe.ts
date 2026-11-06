/**
 * Shared by the contract tests: where the probed DSH packages are, and their shipped code as text.
 * Host packages are the installed devDependencies; browser bundles and the subagent tool are the
 * tarballs scripts/fetch-dsh.mjs unpacks into `.cache/dsh/<version>/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..', '..')
const require = createRequire(join(ROOT, 'package.json'))

/** The DSH version under test: the installed runtime, unless DSH_PROBE_VERSION names another. */
export const DSH_VERSION: string = process.env.DSH_PROBE_VERSION ?? (require('@deepseek-ai/dsh-agent/package.json') as { version: string }).version

/** Where the fetched tarballs are, or undefined before `node scripts/fetch-dsh.mjs` ran. */
export const PROBE_DIR: string | undefined = (() => {
  const dir = join(ROOT, '.cache', 'dsh', DSH_VERSION)
  return existsSync(dir) ? dir : undefined
})()

/**
 * Whether the fetched-package probes run. `npm test` skips them when nothing was fetched (no
 * network needed); `npm run contract` fetches first and sets CONTRACT_STRICT, so they must run.
 */
export function probesAvailable(): boolean {
  if (PROBE_DIR !== undefined) return true
  if (process.env.CONTRACT_STRICT === '1') throw new Error(`no DSH ${DSH_VERSION} packages in .cache/dsh: run node scripts/fetch-dsh.mjs ${DSH_VERSION}`)
  return false
}

function filesUnder(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path, pattern)
    return pattern.test(name) ? [path] : []
  })
}

/**
 * The shipped JavaScript (and CSS) of one fetched package, concatenated.
 * @param name - package name without the scope.
 * @returns its code.
 */
export function fetched(name: string): string {
  if (PROBE_DIR === undefined) throw new Error('probes not fetched')
  const files = filesUnder(join(PROBE_DIR, name), /\.(m?js|css)$/u)
  if (files.length === 0) throw new Error(`${name}: no shipped code in ${PROBE_DIR}`)
  return files.map(f => readFileSync(f, 'utf8')).join('\n')
}

/**
 * The shipped JavaScript of one installed host package.
 * @param name - package name without the scope.
 * @returns its `lib/` code, concatenated.
 */
export function installed(name: string): string {
  const dir = dirname(require.resolve(`@deepseek-ai/${name}/package.json`))
  return filesUnder(join(dir, 'lib'), /\.js$/u).map(f => readFileSync(f, 'utf8')).join('\n')
}

/**
 * @param path - repository-relative path.
 * @returns the file's text.
 */
export const ownFile = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
