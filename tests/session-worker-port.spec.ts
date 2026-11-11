/** The session-worker port's own rollback: a session created for a worker that then failed to set up is archived. */
import { describe, expect, it } from 'vitest'
import { sessionWorkerPort } from '../src/dsh/host/session-worker.js'

function fakeCtx(opts: { failResolve?: boolean; noArchive?: boolean } = {}) {
  const archived: string[] = []
  const controller = {
    create: async () => ({ sessionId: 'session-new' }),
    fork: async () => ({ sessionId: 'session-forked' }),
    rename: async () => undefined,
    selectModel: async () => undefined,
    resolveAgent: async () => { if (opts.failResolve === true) throw new Error('resume failed'); return { error: { code: 'session/not-found' } } },
  }
  const registry: Record<string, unknown> = { resolveByPath: async () => ({ id: 'ws', attachSession: async () => undefined }) }
  if (opts.noArchive !== true) registry.archiveSession = async (id: string) => { archived.push(id) }
  const ctx = { get: (name: string) => name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined }
  return { ctx, archived }
}

describe('session worker port', () => {
  const spec = { cwd: '/w', title: 'w · r', owner: { version: 1 as const, router: 'r', name: 'w', role: 'r' } }
  it('archives a created session when setting it up fails, and still throws', async () => {
    const { ctx, archived } = fakeCtx({ failResolve: true })
    const port = sessionWorkerPort(ctx as never)
    await expect(port.create(spec)).rejects.toThrow(/resume failed/u)
    expect(archived).toEqual(['session-new'])
    await expect(port.fork('session-src', spec)).rejects.toThrow(/resume failed/u)
    expect(archived).toEqual(['session-new', 'session-forked'])
  })
  it('without an archive API it still throws (and says nothing archived)', async () => {
    const { ctx, archived } = fakeCtx({ failResolve: true, noArchive: true })
    const port = sessionWorkerPort(ctx as never)
    await expect(port.create(spec)).rejects.toThrow()
    expect(archived).toEqual([])
    expect(await port.rollBack('x')).toBe(false)
  })
})
