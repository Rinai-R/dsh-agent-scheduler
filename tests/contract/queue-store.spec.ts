/**
 * Contract Q1–Q3: the queue's store on DSH's own storage domain and JSON backend, mounted as
 * dsh-base mounts them (`backend: json`, `root: <DSH_HOME>/storages`). Mirrors the spike
 * (design §1): a third-party domain with `layout: 'per-record'` writes one file per record and
 * reads it back after the facility is torn down and mounted again (a host restart).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { openQueueStore, QUEUE_DOMAIN } from '../../src/dsh/host/queue-store.js'
import { MessageQueue, type QueueHost } from '../../src/queue.js'

async function mount(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage as never, {} as never)
  await ctx.plugin(StorageJson as never, { root } as never)
  await ctx.plugin(StorageDomain as never, { backend: 'json' } as never)
  await new Promise(resolve => setTimeout(resolve, 0))
  return ctx
}

const host: QueueHost = {
  resolve: async () => undefined, prepare: () => 'x', send: async () => true, find: () => undefined, wake: () => undefined, rounds: async () => [],
}

describe('queue store on the storage domain (Q1-Q3)', () => {
  it('Q1: the spec is one defineDomain accepts as is', () => {
    expect(StorageDomain.defineDomain(QUEUE_DOMAIN as never)).toBe(QUEUE_DOMAIN)
  })

  it('Q2-Q3: per-record files under <root>/agent_scheduler_queue, read back after a restart; bad records refuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-store-'))
    let ctx = await mount(root)
    let opened = (await openQueueStore(ctx))!
    expect(opened).toBeDefined()
    const queue = new MessageQueue(opened.store, host)
    const { qid } = await queue.enqueue({ target: 'session-w', producer: { kind: 'router', id: 'session-r', session: 'session-r' }, dedupeKey: 'r-1', text: 'do it', request: 'r-1' })
    const file = join(root, 'agent_scheduler_queue', 'messages', `${qid}.json`)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, record: { qid, target: 'session-w', request: 'r-1' } })
    await opened.close()
    await ctx.fiber.dispose()

    ctx = await mount(root)
    opened = (await openQueueStore(ctx))!
    expect(opened.store.message(qid)).toMatchObject({ qid, text: 'do it', producer: { kind: 'router' } })
    expect(opened.store.target('session-w')?.nextSeq).toBe(2)
    // A record the schema refuses is refused on write too (never stored half-valid).
    await expect(opened.store.putMessage({ qid: 'q-bad' } as never)).rejects.toThrow()
    await opened.close()
    await ctx.fiber.dispose()
  })
})
