// Fetch the DSH packages the contract tests read but the plugin does not depend on (the browser
// bundles and the subagent tool), as published tarballs, without installing them or their
// dependencies. The host packages the tests load are the devDependencies in node_modules.
//   node scripts/fetch-dsh.mjs            the version of the installed @deepseek-ai/dsh-agent
//   node scripts/fetch-dsh.mjs next       the npm `next` tag (any tag or version works)
// Prints the directory, `.cache/dsh/<version>/`, holding one unpacked package per name.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/** What tests/contract reads, by package. */
export const PROBED = [
  'dsh-tool-subagent',
  'dsh-client-ui-sidebar-right',
  'dsh-client-ui-subagent',
  'dsh-client-ui-chat',
  'dsh-client-ui-conversation',
  'dsh-api-session-controller',
  'dsh-web-frontend',
  'dsh-client-ui-plugin-manager',
  'dsh-client-ui-model-selection',
  'dsh-client-locale',
  'dsh-settings',
  'dsh-app-boot',
]

const root = resolve(import.meta.dirname, '..')
const wanted = process.argv[2] ?? createRequire(join(root, 'package.json'))('@deepseek-ai/dsh-agent/package.json').version
const version = /^\d/u.test(wanted)
  ? wanted
  : execFileSync('npm', ['view', `@deepseek-ai/dsh-agent@${wanted}`, 'version'], { encoding: 'utf8' }).trim()
const dir = join(root, '.cache', 'dsh', version)
mkdirSync(dir, { recursive: true })
for (const name of PROBED) {
  const target = join(dir, name)
  if (existsSync(join(target, 'package.json'))) continue
  const work = join(dir, `.${name}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work)
  const file = execFileSync('npm', ['pack', `@deepseek-ai/${name}@${version}`, '--silent', '--pack-destination', work], { encoding: 'utf8' }).trim().split('\n').at(-1)
  execFileSync('tar', ['xzf', join(work, file), '-C', work])
  renameSync(join(work, 'package'), target)
  rmSync(work, { recursive: true, force: true })
  const got = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version
  if (got !== version) throw new Error(`${name}: wanted ${version}, got ${got}`)
}
if (readdirSync(dir).length < PROBED.length) throw new Error(`incomplete fetch in ${dir}`)
console.log(dir)
