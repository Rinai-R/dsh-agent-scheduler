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
import { openQueueStore, OWNER_STALE_MS, QUEUE_DOMAIN, QueueOwnedElsewhere, watchQueueStore } from '../../src/dsh/host/queue-store.js'
import { MessageQueue, PendingQueueStore, type QueueHost } from '../../src/queue.js'

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

  it('Q4: one keeper per DSH_HOME: a second process is refused while the first lives, and takes over once it closed or went stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-owner-'))
    // Two mounts of the same root stand for two host processes on one DSH_HOME.
    const a = await mount(root)
    const b = await mount(root)
    const first = (await openQueueStore(a, { instance: 'A' }))!
    await expect(openQueueStore(b, { instance: 'B' })).rejects.toBeInstanceOf(QueueOwnedElsewhere)
    // The first closes cleanly: the second may keep the queue at once.
    await first.close()
    const second = (await openQueueStore(b, { instance: 'B' }))!
    expect(second).toBeDefined()
    await second.close()
    // A keeper that died without closing: its heartbeat goes stale and is taken over after the timeout.
    const c = await mount(root)
    const crashed = (await openQueueStore(c, { instance: 'C' }))!
    void crashed // never closed (the process died)
    const d = await mount(root)
    await expect(openQueueStore(d, { instance: 'D' })).rejects.toBeInstanceOf(QueueOwnedElsewhere)
    const later = Date.now() + OWNER_STALE_MS + 1_000
    const e = await mount(root)
    expect(await openQueueStore(e, { instance: 'E', now: () => later })).toBeDefined()
    for (const ctx of [a, b, c, d, e]) await ctx.fiber.dispose()
  })
})

describe('queue store across a live reload (Q5, r-175/r-176)', () => {
  it('a row remounted in the same process opens the queue again once the old row has closed it; requests never hang', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q5-'))
    const ctx = await mount(root)
    const logs: string[] = []
    const row = (store: PendingQueueStore) => (sub: Context) => {
      watchQueueStore(sub, opened => { store.set(opened) }, (m, e) => { logs.push(`${m} ${String(e)}`) }, reason => { store.fail(reason) })
    }
    const first = new PendingQueueStore()
    const fiber = await ctx.plugin(row(first) as never, {} as never) as unknown as { dispose(): unknown }
    await first.ready
    const q1 = new MessageQueue(first, host, undefined)
    await q1.enqueue({ target: 'W', producer: { kind: 'router', id: 'R' }, dedupeKey: 'before', text: 'x' })
    // The live reload: the old row is disposed and the new one mounts at once, before the old
    // domain has finished closing. Before the fix the new open failed with "already open" and the
    // store never became ready, so every agent_send waited forever.
    void fiber.dispose()
    const second = new PendingQueueStore()
    await ctx.plugin(row(second) as never, {} as never)
    await Promise.race([second.ready, new Promise((_, reject) => setTimeout(() => { reject(new Error('the remounted store never opened')) }, 5_000))])
    const q2 = new MessageQueue(second, host, undefined)
    expect(q2.messagesTo('W').map(m => m.dedupeKey)).toEqual(['before'])
    await q2.enqueue({ target: 'W', producer: { kind: 'router', id: 'R' }, dedupeKey: 'after', text: 'y' })
    expect(q2.messagesTo('W').map(m => m.dedupeKey)).toEqual(['before', 'after'])
    expect(logs.filter(l => /failed/u.test(l))).toEqual([])
  })
})
