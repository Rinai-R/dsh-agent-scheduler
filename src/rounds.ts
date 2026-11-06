/**
 * Rounds of a child's log. A round is one turn, `turn/start` to `turn/end`; it answers exactly the
 * requests whose messages it claimed, with the summary it gave `report` or else its closing text.
 * Everything is read from the log, so attribution survives a host restart and never depends on
 * when the runtime's settlement notice reaches the main Session (a notice covers a whole
 * residency epoch and can arrive after the child's next round already claimed new work).
 * @module dsh-agent-scheduler/rounds
 */
import type { SessionEvent } from './dsh/types.js'
import { closingText, isTurnEnd, isTurnStart, toolCallOf, turnEndOf, userMessageOf } from './dsh/host/index.js'

/** The model tool whose summary replaces a round's closing text. */
export const REPORT_TOOL = 'report'

/** One completed round. */
export interface Round {
  /** Seq of its `turn/end`. */
  readonly endSeq: number
  /** Inbox ids of the messages it claimed. */
  readonly claimed: ReadonlySet<string>
  /** What it answers with. */
  readonly answer: string
  /** The summary it gave `report`, when it called it. */
  readonly report?: string | undefined
  /** Why it ended when not normally (`aborted`, `error`, …); then it answers nothing. */
  readonly stopped?: string | undefined
  /** The cancellation cause of an `aborted` round (`user`, `parent`, `disposed`, …). */
  readonly cause?: string | undefined
}

/**
 * Whether a round was cut off by the host going away rather than by someone: a crash leaves an
 * `interrupted` closer (appended on resume and on cold reads); a shutdown cancels the child as
 * `disposed`, or as `parent` while its parent is torn down. The scheduler's own interrupt and
 * archive also cancel as `parent`; the scheduler tells those apart itself.
 * @param round - a completed round.
 * @returns true for a round a restart or shutdown may have cut off.
 */
export const cutByRestart = (round: Round): boolean =>
  round.stopped === 'interrupted' || (round.stopped === 'aborted' && (round.cause === 'disposed' || round.cause === 'parent'))

function reportOf(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const call = toolCallOf(events[i]!)
    if (call?.name !== REPORT_TOOL) continue
    try {
      const summary = (JSON.parse(call.arguments) as { summary?: unknown }).summary
      if (typeof summary === 'string' && summary.trim() !== '') return summary
    } catch {
      // A malformed call failed in the tool runtime too; fall back to the closing text.
    }
  }
  return undefined
}

function roundOf(events: readonly SessionEvent[], end: SessionEvent): Round {
  const claimed = new Set<string>()
  for (const event of events) {
    const message = userMessageOf(event)
    if (message !== undefined) claimed.add(message.id)
  }
  const report = reportOf(events)
  const closing = report ?? closingText(events)
  const { kind: reason, cause } = turnEndOf(end)
  const answer = closing.trim() === '' ? '(no closing message)' : closing
  return {
    endSeq: end.seq, claimed, answer,
    ...(report === undefined ? {} : { report }),
    ...(reason === 'completed' ? {} : { stopped: reason }),
    ...(cause === undefined ? {} : { cause }),
  }
}

/**
 * The rounds that completed at or after `from`; a round still running is not included.
 * @param events - the child's log in seq order.
 * @param from - first seq not yet attributed (past any inherited prefix and earlier rounds).
 * @returns completed rounds, oldest first.
 */
export function completedRounds(events: readonly SessionEvent[], from: number): Round[] {
  const rounds: Round[] = []
  let open: SessionEvent[] | undefined
  for (const event of events) {
    if (event.seq < from) continue
    if (isTurnStart(event)) { open = []; continue }
    if (open === undefined) continue
    if (isTurnEnd(event)) {
      rounds.push(roundOf(open, event))
      open = undefined
      continue
    }
    open.push(event)
  }
  return rounds
}
