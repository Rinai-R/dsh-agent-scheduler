/**
 * Reading what is on screen as read: a member whose chat is open gets no review dot, and a report
 * arriving there is recorded as seen (once, after a short quiet period) so it does not light up
 * when the user navigates away.
 * @module dsh-agent-scheduler/client/active-seen
 */
import { unread, type ReviewFields } from '../review.js'

/** One member a seen record may be due for. */
export interface SeenCandidate extends ReviewFields {
  readonly id: string
}

/**
 * The visible members whose latest report the user is looking at and that have no seen record yet.
 * Only unread reports count: a waiting prompt is answered in the chat itself and its yellow mark
 * lasts until it is answered, not until a chat is opened.
 * @param members - every roster member.
 * @param visible - member Sessions the viewer currently shows.
 * @param asked - members already handed to the seen scheduler (a write is on its way).
 * @returns their Session ids, in roster order.
 */
export function autoSeenTargets(members: readonly SeenCandidate[], visible: ReadonlySet<string>, asked: ReadonlySet<string> = new Set()): string[] {
  return members.filter(m => visible.has(m.id) && !asked.has(m.id) && unread(m)).map(m => m.id)
}

/** What one seen scheduler offers. */
export interface SeenScheduler {
  /** Ask for a seen record per member, once the calls go quiet for the delay. */
  note(ids: readonly string[]): void
  /** Record everything noted now. */
  flush(): void
  /** Drop what is noted (the component is going away). */
  dispose(): void
}

/**
 * A debounced seen writer: a streaming round reports several times, and the record is written once
 * after the reports stop. Members already noted do not stack up: each is written once per quiet
 * period, and the host records it only while it is still unread.
 * @param mark - writes one seen record (runs `/agents seen <id>`).
 * @param delayMs - quiet period after the last note.
 * @param onWrite - called with each id once a write is issued (tests and callers tracking work).
 * @returns the scheduler.
 */
export function seenScheduler(mark: (id: string) => void, delayMs = 1000, onWrite?: (ids: readonly string[]) => void): SeenScheduler {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const write = (): void => {
    timer = undefined
    if (pending.size === 0) return
    const ids = [...pending]
    pending = new Set()
    onWrite?.(ids)
    for (const id of ids) mark(id)
  }
  return {
    note(ids) {
      if (ids.length === 0) return
      for (const id of ids) pending.add(id)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(write, delayMs)
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer)
      write()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = new Set()
    },
  }
}
