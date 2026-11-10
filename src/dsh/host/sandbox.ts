/**
 * Pin one Session's sandbox mode through the runtime's own durable write: it appends the
 * `sandbox/mode` event the sandbox policy folds, so a replay lands on the same mode.
 * @module dsh-agent-scheduler/dsh/host/sandbox
 */
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '../types.js'

/** Modes this plugin pins. */
export type PinnedSandbox = 'read-only'

/**
 * Make one Session run under a sandbox mode, from its next step on (the event is authoritative).
 * @param session - the child Session being created.
 * @param mode - the mode to pin.
 */
export function pinSandboxMode(session: Session, mode: PinnedSandbox): void {
  setSandboxMode(session as never, mode)
}
