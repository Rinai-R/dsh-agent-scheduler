/**
 * Packaging contract (P1-P4, U6 in docs/dsh-adapter.md): what the plugin declares to DSH.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DSH_RANGE } from '../../src/dsh/host/version.js'
import { ownFile, ROOT } from './probe.js'

const pkg = JSON.parse(ownFile('package.json')) as {
  engines: Record<string, string>
  peerDependencies: Record<string, string>
  dsh: { bundle: { patch: string }; client: { inject: string[] } }
}

describe('packaging', () => {
  it('P3: the bundle patch only inserts top-level rows; it overrides and declares no preset', () => {
    const patch = ownFile('cordis.patch.yml').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
    const rows = patch.split('\n').filter(line => /^\s*- (id|insert):/u.test(line))
    expect(rows[0]).toBe('- insert:')
    // No top-level row other than the insert, and nothing that names a preset.
    expect(patch.split('\n').filter(line => /^- /u.test(line))).toEqual(['- insert:'])
    expect(patch).not.toMatch(/preset/u)
    expect(patch).toMatch(/name: dsh-agent-scheduler\n/u)
    expect(patch).toMatch(/name: dsh-agent-scheduler\/rule\n/u)
  })

  // scripts/contract.mjs rewrites the ranges while it tries another DSH: nothing to check then.
  it.skipIf(process.env.CONTRACT_TAG !== undefined)('P2: engines.dsh, every DSH peer range and the adapter\'s DSH_RANGE agree', () => {
    expect(pkg.engines.dsh).toBe(DSH_RANGE)
    const peers = Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(peers.length).toBeGreaterThan(0)
    for (const [name, range] of peers) expect(range, name).toBe(DSH_RANGE)
  })

  it.skipIf(process.env.CONTRACT_TAG !== undefined)('P2: the framework peers accept what the pinned DSH ships with', async () => {
    const { satisfies } = await import('./semver.js')
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
      const version = (JSON.parse(ownFile(`node_modules/${name}/package.json`)) as { version: string }).version
      expect(satisfies(version, pkg.peerDependencies[name]!), `${name}@${version} vs ${pkg.peerDependencies[name]}`).toBe(true)
    }
  })

  it('P1: the type shim still points at a file the installed dsh-subagent ships', () => {
    const shim = ownFile('types/rc5-type-shims.d.ts')
    const ref = /path="([^"]+)"/u.exec(shim)?.[1]
    expect(ref).toBeDefined()
    expect(existsSync(join(ROOT, 'types', ref!))).toBe(true)
  })

  it.runIf(existsSync(join(ROOT, 'dist', 'client.js')))('U6: the browser bundle loads through DSH\'s module loader shape', () => {
    let loaded: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
    const stub: unknown = new Proxy(function () { /* any export */ }, { get: () => stub, apply: () => stub })
    runInNewContext(ownFile('dist/client.js'), { window: { __ModuleLoader__: { load: (m: typeof loaded) => { loaded = m } } } })
    expect(loaded?.id).toBe('dsh-agent-scheduler')
    const exports = loaded!.factory(() => stub)
    expect(typeof exports.apply).toBe('function')
    expect(exports.name).toBe('dsh-agent-scheduler')
  })
})
