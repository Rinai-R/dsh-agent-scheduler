/**
 * The Session log as the plugin reads and writes it: event shapes, plugin records, message
 * sources, and the one write that edits the model-visible surface. Everything that depends on the
 * session format (dsh-session) or on message-source kinds (dsh-llm, dsh-subagent) is here.
 * @module dsh-agent-scheduler/dsh/host/session
 */
import { boundContextSummary, createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { Agent, ContentBlock, Session, SessionEvent, SessionSeq, UserMessage } from '../types.js'

export { SessionId }

// ------------------------------------------------------------------ plugin records

/**
 * Append one plugin record to a Session log.
 * @param session - the Session.
 * @param type - the record type, `plugin:<package>/<name>`.
 * @param data - plain JSON.
 * @returns its seq.
 */
export const appendRecord = (session: Session, type: string, data: object): SessionSeq =>
  appendPluginRecord(session, type as never, data as never)

/**
 * Read a plugin record from any event.
 * @param event - a Session event.
 * @returns its type and data, or undefined when it is not a plugin record.
 */
export function recordOf(event: SessionEvent): { type: string; data: unknown } | undefined {
  const record = pluginRecordOf(event)
  return record === undefined ? undefined : { type: String(record.type), data: record.data }
}

// ------------------------------------------------------------------ reading logs

/** A Session's log as stored: contiguous from seq 0, its first `inherited` events copied from a parent. */
export interface SessionLog {
  readonly events: readonly SessionEvent[]
  readonly inherited: number
}

/**
 * The log of a live Agent.
 * @param agent - the Agent.
 * @returns its events and inherited prefix length.
 */
export const liveLog = (agent: Agent): SessionLog =>
  ({ events: agent.session.snapshotEvents(), inherited: Number(agent.session.inheritedEventCount) })

/**
 * @param session - a Session.
 * @returns every event committed so far.
 */
export const eventsOf = (session: Session): readonly SessionEvent[] => session.snapshotEvents()

/**
 * @param session - a Session.
 * @returns the latest committed event.
 */
export const lastEvent = (session: Session): SessionEvent => session.snapshotEvents().at(-1)!

/** Inbox target of a splice. */
export type InboxTarget = 'next-turn' | 'next-step'

/** One change to a Session's durable inbox. */
export interface InboxSplice {
  readonly target: InboxTarget
  readonly start: number
  readonly removed: number
  readonly inserted: ReadonlyArray<{ readonly id: string; readonly content: unknown }>
}

/**
 * @param event - any event.
 * @returns the inbox change it records, or undefined.
 */
export function inboxSpliceOf(event: SessionEvent): InboxSplice | undefined {
  if (event.type !== 'agent/inbox/spliced') return undefined
  const { target, start, removedCount, inserted } = event.data
  return { target, start, removed: removedCount ?? 0, inserted: inserted.map(m => ({ id: String(m.id), content: m.content })) }
}

/**
 * @param event - any event.
 * @returns the message a turn took in, or undefined for other events.
 */
export function userMessageOf(event: SessionEvent): { id: string; content: unknown; sourceKind: unknown } | undefined {
  if (event.type !== 'user/message') return undefined
  return { id: String(event.data.id), content: event.data.content, sourceKind: (event.data.source as { kind?: unknown } | undefined)?.kind }
}

/**
 * @param event - any event.
 * @returns the model's tool call, or undefined.
 */
export function toolCallOf(event: SessionEvent): { name: string; arguments: string } | undefined {
  if (event.type !== 'tool/call') return undefined
  return { name: event.data.name, arguments: event.data.arguments }
}

export const isTurnStart = (event: SessionEvent): boolean => event.type === 'turn/start'
export const isTurnEnd = (event: SessionEvent): boolean => event.type === 'turn/end'

/** How a turn ended: `completed`, or why not, with a cancellation's cause. */
export interface TurnEnd {
  readonly kind: string
  readonly cause?: string | undefined
}

/**
 * @param event - a `turn/end` event.
 * @returns how the turn ended; an unknown shape reads as a kind of its own, never as completed.
 */
export function turnEndOf(event: SessionEvent): TurnEnd {
  const ended = (event.data as { reason?: { kind?: unknown; reason?: { kind?: unknown } } }).reason
  const kind = ended?.kind
  const cause = ended?.reason?.kind
  return { kind: kind === undefined ? 'completed' : String(kind), ...(typeof cause === 'string' ? { cause } : {}) }
}

/**
 * The text a turn closed with.
 * @param events - the events of one turn.
 * @returns its final assistant text, '' when none.
 */
export const closingText = (events: readonly SessionEvent[]): string => textOf(finalAssistantOutput(events) ?? [])

// ------------------------------------------------------------------ messages

/**
 * @param content - message blocks.
 * @returns their text blocks, joined by newlines.
 */
export const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** A message the user typed. */
export const isUserInput = (message: UserMessage): boolean => message.source.kind === 'user'

/** Context the runtime refreshes on every step; never a reason for the lead to speak. */
export const isContextOnly = (message: UserMessage): boolean => (message.source as { form?: unknown }).form === 'snapshot'

/**
 * @param message - a message the main Session claimed.
 * @returns the child whose settlement notice it is, or undefined.
 */
export function settledSender(message: UserMessage): string | undefined {
  return message.source.kind === 'subagent-settled' ? String(message.source.senderSessionId) : undefined
}

/**
 * A settlement notice rewritten to carry what the scheduler made of it.
 * @param message - the runtime's settlement notice.
 * @param summary - the row label the lead's chat shows.
 * @param text - what the lead reads.
 * @returns the rewritten message.
 */
export function rewriteSettled(message: UserMessage, summary: string, text: string): UserMessage {
  if (message.source.kind !== 'subagent-settled') return message
  return { ...message, source: { ...message.source, summary: boundContextSummary(summary) }, content: [{ type: 'text', text }] }
}

/**
 * A message for the lead from one member, queued for its next turn.
 * @param text - what the lead reads.
 * @param sender - the member's Session id.
 * @returns the message.
 */
export const relayMessage = (text: string, sender: string): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId(sender) } })

/**
 * @param sourceKind - a `user/message`'s source kind, from {@link userMessageOf}.
 * @returns whether it is a message relayed from another agent.
 */
export const isRelayed = (sourceKind: unknown): boolean => sourceKind === 'agent-message'

// ------------------------------------------------------------------ the hand-off write

/** Source of the empty node that hides a handed-off message from the lead's model input. */
export const HANDOFF_SOURCE = 'agent-scheduler-handoff'

/** The turn and step of a step still open at the end of the log, if any. */
export function openStep(events: readonly SessionEvent[]): { turn: number; step: number } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'step/end' || event.type === 'turn/end') return undefined
    if (event.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
  }
  return undefined
}

/**
 * Log a handed-off user message as received, then hide it from the lead's model input.
 *
 * The browser composer releases a sent draft (text and attachments) only once the Session log
 * holds a `user/message` carrying the prompt's request id; an inbox removal is recorded as a
 * cancellation, and a draft with attachments is then restored as unsent. Logging the message
 * gives the composer its receipt and the chat the user's own bubble, images included. The
 * replacement that follows shadows that one surface node, inside a step with an empty developer message
 * which yields no model message, so the lead never reads the words a fork is handling. Outside
 * a step the shadow is a one-line note instead (the format allows developer messages only
 * inside steps).
 * @param session - the main Session.
 * @param message - the user message being handed to a fork.
 * @param note - the line the lead reads in its place when no step is open.
 * @returns false when the log has no system prompt yet and nothing could be logged.
 */
export function admitHidden(session: Session, message: UserMessage, note: string): boolean {
  // A log's first surface node must be the system prompt, which only the lead's first step
  // writes; before it, a user message cannot be logged at all.
  const head = session.surface.nodes[0]
  if (head === undefined || session.eventAt(head)?.type !== 'system/message') return false
  const logged = session.append('user/message', message, { surfaceOp: 'append' })
  const replace = { surfaceOp: { op: 'replace', startSeq: logged.seq, endSeq: logged.seq }, sourceEventSeqs: [logged.seq] } as never
  const open = openStep(session.snapshotEvents())
  if (open !== undefined) {
    // Inside a step the node may sit between a tool call and its result, where no user message
    // may stand; an empty developer message of that step yields no model message at all.
    session.append('developer/message', {
      ...open,
      message: createDeveloperMessage({ source: { kind: HANDOFF_SOURCE } as never, content: [] }),
    } as never, replace)
    return true
  }
  // Outside a step a developer message is not allowed; a one-line note in its place is.
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: HANDOFF_SOURCE } as never }), replace)
  return true
}
