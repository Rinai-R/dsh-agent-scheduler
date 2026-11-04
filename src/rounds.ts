/**
 * Rounds of a child's log. A round is one turn, `turn/start` to `turn/end`; it answers exactly the
 * requests whose messages it claimed, with the summary it gave `report` or else its closing text.
 * Everything is read from the log, so attribution survives a host restart and never depends on
 * when the runtime's settlement notice reaches the main Session (a notice covers a whole
 * residency epoch and can arrive after the child's next round already claimed new work).
 * @module dsh-agent-scheduler/rounds
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'

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
}

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

function reportOf(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type !== 'tool/call' || event.data.name !== REPORT_TOOL) continue
    try {
      const summary = (JSON.parse(event.data.arguments) as { summary?: unknown }).summary
      if (typeof summary === 'string' && summary.trim() !== '') return summary
    } catch {
      // A malformed call failed in the tool runtime too; fall back to the closing text.
    }
  }
  return undefined
}

function roundOf(events: readonly SessionEvent[], end: SessionEvent): Round {
  const claimed = new Set<string>()
  for (const event of events) if (event.type === 'user/message') claimed.add(event.data.id)
  const report = reportOf(events)
  const closing = report ?? textOf(finalAssistantOutput(events) ?? [])
  const reason = (end.data as { reason?: { kind?: unknown } }).reason?.kind
  const answer = closing.trim() === '' ? '(no closing message)' : closing
  return {
    endSeq: end.seq, claimed, answer,
    ...(report === undefined ? {} : { report }),
    ...(reason === undefined || reason === 'completed' ? {} : { stopped: String(reason) }),
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
    if (event.type === 'turn/start') { open = []; continue }
    if (open === undefined) continue
    if (event.type === 'turn/end') {
      rounds.push(roundOf(open, event))
      open = undefined
      continue
    }
    open.push(event)
  }
  return rounds
}
