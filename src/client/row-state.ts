/**
 * What to draw for one roster row: its recorded lifecycle refined by the shell's live Session
 * status. Shared by the Agents page and the focus deck, so both count running/waiting the same way.
 * @module dsh-agent-scheduler/client/row-state
 */
import type { Statuses } from '../dsh/client/index.js'

/** What a row's state cell and its counts use. */
export type RowState = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'queued' | 'archived'

/** The roster fields this rule reads. */
export interface StatefulMember {
  readonly id: string
  readonly state: string
}

/**
 * Refine one member's lifecycle record with the live status the client hook reports.
 * @param member - a roster row.
 * @param statuses - the root Session-status map (keyed by member Session id).
 * @returns what to draw.
 */
export function rowStateOf(member: StatefulMember, statuses: Statuses | ReadonlyMap<string, { running?: boolean | undefined; pendingInteraction?: unknown }> | undefined): RowState {
  if (member.state === 'archived' || member.state === 'failed' || member.state === 'queued' || member.state === 'done') {
    return member.state as RowState
  }
  const status = statuses?.get(member.id)
  if (status?.pendingInteraction !== undefined) return 'waiting'
  return status?.running === true ? 'running' : 'idle'
}
