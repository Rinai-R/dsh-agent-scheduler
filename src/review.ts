/**
 * What a member owes the user's eyes, shared by the host fold and the browser half (no imports,
 * so the client bundle stays free of host code).
 * @module dsh-agent-scheduler/review
 */

/** The review fields a roster member carries. */
export interface ReviewFields {
  /** Time (ms) of the member's latest report: an answered or failed request, a fork's conclusion,
   * a failed start. */
  readonly reportedAt?: number | undefined
  /** The latest report is a failure. */
  readonly reportFailed?: true | undefined
  /** Time (ms) the user opened this member's chat (`/agents seen`) since its latest report;
   * a later report clears it. The fold's order decides, so clock skew cannot revive a mark. */
  readonly seenAt?: number | undefined
}

/**
 * The review mark of one member, most urgent first:
 * - `approval`: something waits for the user (a permission prompt, a question), read or not;
 * - `failed`: the latest report failed and the user has not opened the member since;
 * - `reported`: the latest report succeeded and the user has not opened the member since;
 * - undefined: read, or nothing reported yet.
 * A member whose chat is on screen carries no mark: whatever arrived is already in front of the
 * user. Pass `active` for the Session the viewer currently shows (the right pane's active tab).
 * @param member - the member's review fields.
 * @param pendingInteraction - whether the member's Session waits for the user right now.
 * @param active - whether the user is looking at this member's chat right now.
 * @returns the mark.
 */
export function reviewOf(member: ReviewFields, pendingInteraction = false, active = false): 'approval' | 'failed' | 'reported' | undefined {
  if (active) return undefined
  if (pendingInteraction) return 'approval'
  if (!unread(member)) return undefined
  return member.reportFailed === true ? 'failed' : 'reported'
}

/**
 * Whether the member's latest report came after the user last opened it.
 * @param member - the member's review fields.
 * @returns true when there is a report the user has not seen.
 */
export function unread(member: ReviewFields): boolean {
  return member.reportedAt !== undefined && member.seenAt === undefined
}
