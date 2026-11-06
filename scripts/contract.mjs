// Run the contract tests (tests/contract) against a DSH version.
//   node scripts/contract.mjs          the installed (pinned) DSH
//   node scripts/contract.mjs next     npm's `next` (any tag or version works)
// For a tag, every @deepseek-ai/dsh-* devDependency moves to it and the framework packages
// (cordis, schemastery) to the ranges that DSH release ships with, in a fresh install;
// package.json, the lockfile and node_modules are restored afterwards (`npm ci`).
// It then typechecks against that DSH, fetches the probed browser bundles
// (scripts/fetch-dsh.mjs), and runs the whole suite with the probes required.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tag = process.argv[2]
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))

function test() {
  const version = read('node_modules/@deepseek-ai/dsh-agent/package.json').version
  console.log(`contract: DSH ${version}`)
  run('node', ['scripts/fetch-dsh.mjs', version])
  const env = { DSH_PROBE_VERSION: version, CONTRACT_STRICT: '1', ...(tag === undefined ? {} : { CONTRACT_TAG: tag }) }
  // Both run, so one report shows type breaks and behaviour breaks together.
  const failures = []
  for (const [what, args] of [['typecheck', ['tsc', '-p', 'tsconfig.json', '--noEmit']], ['tests', ['vitest', 'run']]]) {
    try { run('npx', args, env) } catch { failures.push(what) }
  }
  if (failures.length > 0) throw new Error(`contract against DSH ${version} failed: ${failures.join(', ')}`)
}

if (tag === undefined) {
  test()
} else {
  const backup = join(root, '.cache', 'contract-backup')
  mkdirSync(backup, { recursive: true })
  copyFileSync(join(root, 'package.json'), join(backup, 'package.json'))
  copyFileSync(join(root, 'package-lock.json'), join(backup, 'package-lock.json'))
  let failed = false
  try {
    const pkg = read('package.json')
    const shipped = JSON.parse(execFileSync('npm', ['view', `@deepseek-ai/dsh@${tag}`, 'dependencies', '--json'], { cwd: root, encoding: 'utf8' }))
    for (const field of ['devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) pkg[field][name] = tag
        else if (name in shipped) pkg[field][name] = shipped[name]
      }
    }
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    rmSync(join(root, 'package-lock.json'), { force: true })
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
    run('npm', ['install', '--no-audit', '--no-fund'])
    test()
  } catch (error) {
    failed = true
    console.error(error instanceof Error ? error.message : error)
  } finally {
    copyFileSync(join(backup, 'package.json'), join(root, 'package.json'))
    copyFileSync(join(backup, 'package-lock.json'), join(root, 'package-lock.json'))
    if (process.env.CI !== 'true') run('npm', ['ci', '--no-audit', '--no-fund'])
  }
  if (failed) process.exit(1)
}
