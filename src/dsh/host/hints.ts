/**
 * The runtime's own wording that the plugin reads or answers to. None of it is API: each string
 * is checked against the installed DSH by tests/contract/host-text.spec.ts, so a reworded hint
 * fails there first instead of silently in a session.
 * @module dsh-agent-scheduler/dsh/host/hints
 */
import type { ContentBlock, UserMessage } from '../types.js'
import { warnOnce } from '../compat.js'

/**
 * The guidance the runtime appends to a continuable child's first task (dsh-subagent
 * `withContinuableReturnGuidance`: `Your parent agent id is ${JSON.stringify(parentId)}. …`).
 * The scheduler routes results itself, so a member must not also `send_message` them.
 */
export const RETURN_GUIDANCE = /^Your parent agent id is "/u
/** What the guidance starts with, however the id is quoted; a match without {@link RETURN_GUIDANCE} means the wording moved. */
const RETURN_GUIDANCE_LOOSE = /^Your parent agent id is\b/u

/**
 * A member's message without the runtime's return guidance.
 * @param message - a message inserted into a member's inbox.
 * @returns the message without that block, or undefined when it carried none.
 */
export function withoutReturnGuidance(message: UserMessage): UserMessage | undefined {
  const isGuidance = (block: ContentBlock) => block.type === 'text' && RETURN_GUIDANCE.test(block.text)
  const kept = message.content.filter(block => !isGuidance(block))
  if (kept.length === message.content.length) {
    if (message.content.some(block => block.type === 'text' && RETURN_GUIDANCE_LOOSE.test(block.text))) {
      warnOnce('hint:return-guidance', 'the runtime\'s return guidance for subagents changed its wording; members may also send their results with send_message')
    }
    return undefined
  }
  return { ...message, content: kept }
}

/** The prefix the runtime puts before a message relayed into a child (`Agent <id> sent a message: `). */
export const RELAY_PREFIX = /^Agent \S+ sent a message: /u

/**
 * The text of a relayed message as its sender wrote it.
 * @param text - the delivered text.
 * @returns it without the runtime's relay prefix.
 */
export const unwrapRelayed = (text: string): string => text.replace(RELAY_PREFIX, '')

/** The residency-limit refusal: the one start or delivery failure that waiting cures. */
export const CAPACITY_CODE = 'ACTIVATION_LIMIT_REACHED'
const CAPACITY_TEXT = /subagent limit reached/u

/**
 * Whether a refusal is the runtime's residency limit. Persistence, draining, and authority
 * failures are real and are not retried.
 * @param error - whatever the runtime threw.
 * @returns true for `ACTIVATION_LIMIT_REACHED`.
 */
export const isCapacity = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === CAPACITY_CODE
  || CAPACITY_TEXT.test(error instanceof Error ? error.message : String(error))

/**
 * What the runtime's delegation-depth context tells a depth-1 child (dsh-tool-subagent). Forks
 * are told this does not apply to them; FORK_NOTICE and the fork guard's refusal answer it.
 */
export const DELEGATION_DEPTH_HINT = 'carry out the work directly'
