/**
 * Reading what is on screen as read: a member whose chat is open gets no review dot, and a report
 * arriving there counts as read, so it does not light up when the user navigates away.
 *
 * That read is kept in the browser, not in the session log. The browser half can reach the host
 * only through slash commands, and DSH logs every command as a row in the lead's chat, so an
 * automatic write per arrival would fill the lead's chat with "agents · …" rows. The user's own
 * actions (opening a member from its row or pill, 「全部已读」, `/agents seen`) still write the
 * session's `seen` record as before.
 * @module dsh-agent-scheduler/client/active-seen
 */
import { unread, type ReviewFields } from '../review.js'

/** One member a read may be due for. */
export interface SeenCandidate extends ReviewFields {
  readonly id: string
}

/**
 * The visible members whose latest report the user is looking at and that are still unread.
 * Only unread reports count: a waiting prompt is answered in the chat itself and its yellow mark
 * lasts until it is answered, not until a chat is opened.
 * @param members - every roster member.
 * @param visible - member Sessions the viewer currently shows.
 * @returns their Session ids, in roster order.
 */
export function autoSeenTargets(members: readonly SeenCandidate[], visible: ReadonlySet<string>): string[] {
  return members.filter(m => visible.has(m.id) && unread(m)).map(m => m.id)
}

/** Where the browser keeps what it read: `localStorage` or a stand-in with the same two calls. */
export interface SeenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Reads of reports the browser saw on screen, per main Session. */
export interface LocalSeen {
  /** Record that these members' current reports were on screen (each at its `reportedAt`). */
  mark(main: string, members: readonly SeenCandidate[]): void
  /** The members with what this browser read applied (a later `seenAt` where it saw the report). */
  apply<M extends SeenCandidate>(main: string, members: readonly M[]): readonly M[]
  subscribe(listener: () => void): () => void
  /** Changes whenever a read is recorded. */
  revision(): number
}

const KEY = (main: string): string => `dsh-agent-scheduler/seen/${main}`
/** Entries kept per main Session: a roster rarely has more members than this. */
const KEEP = 200

/**
 * A browser-side store of reads.
 * @param storage - where reads persist; absent or failing, they last only while the page is open.
 * @returns the store.
 */
export function localSeen(storage?: SeenStorage): LocalSeen {
  const cache = new Map<string, Record<string, number>>()
  const listeners = new Set<() => void>()
  let revision = 0
  const load = (main: string): Record<string, number> => {
    let read = cache.get(main)
    if (read !== undefined) return read
    read = {}
    try {
      const raw = storage?.getItem(KEY(main))
      const parsed: unknown = raw == null ? undefined : JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) if (typeof at === 'number') read[id] = at
      }
    } catch {
      // Unreadable storage: start empty.
    }
    cache.set(main, read)
    return read
  }
  return {
    mark(main, members) {
      const read = load(main)
      let changed = false
      for (const m of members) {
        if (!unread(m) || (read[m.id] ?? -1) >= m.reportedAt!) continue
        read[m.id] = m.reportedAt!
        changed = true
      }
      if (!changed) return
      const entries = Object.entries(read)
      if (entries.length > KEEP) {
        const kept = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, KEEP))
        cache.set(main, kept)
      }
      try { storage?.setItem(KEY(main), JSON.stringify(cache.get(main))) } catch { /* full or blocked: kept in memory */ }
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    apply(main, members) {
      const read = load(main)
      if (Object.keys(read).length === 0) return members
      return members.map(m => {
        const at = read[m.id]
        if (at === undefined || !unread(m) || at < m.reportedAt!) return m
        return { ...m, seenAt: m.reportedAt }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revision: () => revision,
  }
}

/** The page's store: persisted in `localStorage` when the browser offers it. */
export const browserSeen: LocalSeen = localSeen((() => {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
})())
