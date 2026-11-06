/**
 * Which side of a merge stays by default; pure, so the Agents page uses the same rule.
 * @module dsh-agent-scheduler/merge-pick
 */
import type { RosterMember } from './projection.js'

/**
 * Which of two workers stays by default: the one with work in hand (running or owing answers),
 * then the area's original owner (it carries the area's or more earlier names), then the older.
 * @param a - one worker.
 * @param b - the other.
 * @param busy - whether a worker has work in hand.
 * @returns `[absorbed, survivor]`.
 */
export function defaultSurvivor<T extends Pick<RosterMember, 'id' | 'name' | 'area' | 'formerNames' | 'createdAt'>>(a: T, b: T, busy: (m: T) => boolean): [T, T] {
  const score = (m: T): number[] => [
    busy(m) ? 1 : 0,
    m.area !== undefined && (m.name === m.area || m.formerNames?.includes(m.area) === true) ? 1 : 0,
    m.formerNames?.length ?? 0,
  ]
  const [sa, sb] = [score(a), score(b)]
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sa[i]! > sb[i]! ? [b, a] : [a, b]
  // Older stays: an ISO time compares as text; without one, roster order (a before b) decides.
  if (a.createdAt !== undefined && b.createdAt !== undefined && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? [b, a] : [a, b]
  return [b, a]
}
