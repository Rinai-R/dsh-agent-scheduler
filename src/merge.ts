/**
 * Merging a worker into another (the reverse of `agent_split`): the pure parts. The handoff the
 * absorbed worker writes, the one built from its log when it cannot, what git says about its
 * directory, which side stays by default, and what the survivor reads. The steps themselves are
 * in the scheduler; docs/worker-merge.md has the state machine.
 * @module dsh-agent-scheduler/merge
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import type { SessionEvent } from './dsh/types.js'
import type { GitFacts } from './records.js'
import type { RosterMember, RosterRequest } from './projection.js'
import { completedRounds } from './rounds.js'

export { defaultSurvivor } from './merge-pick.js'

/** The sections a handoff has, in order. */
export const HANDOFF_SECTIONS = ['Done', 'In progress', 'Decisions', 'Open questions', 'Files changed', 'Branch / PR', 'Uncommitted changes'] as const

/**
 * The request a worker being merged answers.
 * @param survivor - the name of the worker it goes into.
 * @returns the request text.
 */
export function handoffRequest(survivor: string): string {
  return [
    `You are being merged into worker "${survivor}": it takes over all of your work, and you are archived once you answer.`,
    'First settle your code: commit (and push) what is worth keeping. Anything you leave uncommitted must be listed under "Uncommitted changes", which hands it over to ' + `"${survivor}"; an empty section there with changes in your directory stops the merge.`,
    `Then answer with your handoff for "${survivor}", in exactly these sections (write "none" where there is nothing):`,
    ...HANDOFF_SECTIONS.map(s => `## ${s}`),
    'Done: what is finished. In progress: what is half done and the next step. Decisions: what you chose and why. Open questions: what is undecided or waits for the user. Files changed: paths and what changed. Branch / PR: your branch, its PR (link) and whether it is merged. Uncommitted changes: what is not committed and why.',
  ].join('\n')
}

/**
 * The text of one section of a handoff.
 * @param handoff - the handoff.
 * @param section - its heading without `## `.
 * @returns the section's text, trimmed, or undefined when it is missing.
 */
export function handoffSection(handoff: string, section: string): string | undefined {
  const lines = handoff.split('\n')
  const start = lines.findIndex(l => l.replace(/^#+\s*/u, '').trim().toLowerCase() === section.toLowerCase() && /^#+\s/u.test(l))
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && /^#+\s/u.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

/** Whether a section says there is nothing: empty, "none", "无", "-", "n/a". */
export const saysNone = (text: string | undefined): boolean =>
  text === undefined || /^(?:[-*]\s*)?(?:none|nothing|no|n\/a|无|没有|-)?\.?$/iu.test(text.trim())

/**
 * Whether the code is settled enough to merge: changes left in the absorbed worker's directory
 * must be handed over in its handoff (a handoff built from the log cannot say so; the facts do).
 * @returns why it is not, or undefined when it is.
 */
export function unsettled(facts: GitFacts | undefined, handoff: string, source: 'worker' | 'log'): string | undefined {
  if (facts === undefined || facts.dirty.length === 0 || source === 'log') return undefined
  if (!saysNone(handoffSection(handoff, 'Uncommitted changes'))) return undefined
  return `${facts.dirty.length} uncommitted change${facts.dirty.length === 1 ? '' : 's'} in ${facts.cwd} (${facts.dirty.slice(0, 5).join(', ')}) that the handoff does not hand over; commit them, or list them under "Uncommitted changes", then merge again`
}

/**
 * What git says about a worker's directory: its branch, uncommitted changes, unpushed commits.
 * @param cwd - the directory.
 * @returns the facts (`missing` when the directory is gone), or undefined when it is not a git
 *   checkout or git is unavailable.
 * @throws when `git status` fails in a checkout: an unknown state is not reported as clean.
 */
export async function gitFacts(cwd: string | undefined): Promise<GitFacts | undefined> {
  if (cwd === undefined) return undefined
  // A worktree removed or moved since: say so to the survivor instead of checking nothing quietly.
  if (!existsSync(cwd)) return { cwd, dirty: [], missing: true }
  const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 })).stdout
  try {
    const inside = (await git('rev-parse', '--is-inside-work-tree')).trim()
    if (inside !== 'true') return undefined
  } catch {
    return undefined
  }
  // A branch with no commit yet has no HEAD to resolve; its name still comes from the symbolic ref.
  const branch = await git('symbolic-ref', '--short', 'HEAD').then(s => s.trim(), () => git('rev-parse', '--short', 'HEAD').then(s => `detached at ${s.trim()}`, () => undefined))
  // Never read a failed status as clean: the merge then stops and says why.
  const dirty = await git('status', '--porcelain').then(s => s.split('\n').filter(l => l.trim() !== ''), (error: unknown) => {
    throw new Error(`could not read git status in ${cwd}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; merge again once git answers`)
  })
  const ahead = await git('rev-list', '--count', '@{u}..HEAD').then(s => Number.parseInt(s.trim(), 10), () => undefined)
  return { cwd, ...(branch === undefined ? {} : { branch }), dirty, ...(ahead === undefined || Number.isNaN(ahead) ? {} : { ahead }) }
}

/**
 * A handoff for a worker that cannot write one (failed, archived, never started, or its handoff
 * round was cut): its role, the requests it had, and how its last rounds ended.
 * @param member - the absorbed worker.
 * @param requests - every request ever sent to it.
 * @param events - its log, when there is one.
 * @param inherited - events of its log inherited from the session it was forked from.
 * @returns the handoff.
 */
export function handoffFromLog(member: RosterMember, requests: readonly RosterRequest[], events: readonly SessionEvent[] | undefined, inherited = 0): string {
  const rounds = events === undefined ? [] : completedRounds(events, inherited).filter(r => r.stopped === undefined && r.answer.trim() !== '').slice(-4)
  const clip = (s: string, n: number) => { const t = s.trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
  const mine = requests.filter(r => r.kind !== 'handoff')
  return [
    `(${member.name} could not write its own handoff: built from its log by the scheduler.)`,
    '## Done',
    ...(mine.filter(r => r.state === 'answered').map(r => `- ${r.id}: ${clip(r.text, 160)}\n  answer: ${clip(r.answer ?? '', 600)}`)),
    ...(mine.some(r => r.state === 'answered') ? [] : ['none']),
    '## In progress',
    ...(mine.filter(r => r.state !== 'answered').map(r => `- ${r.id} (${r.state}): ${clip(r.text, 160)}`)),
    ...(mine.some(r => r.state !== 'answered') ? [] : ['none']),
    '## Its last rounds ended with',
    ...(rounds.length === 0 ? ['none'] : rounds.map(r => `- ${clip(r.answer, 800)}`)),
    `## Role\n${member.role ?? member.text}`,
  ].join('\n')
}

/**
 * The survivor's role after a merge when none is given: its own, widened by the absorbed one's.
 * @returns the role.
 */
export function mergedRole(survivor: Pick<RosterMember, 'role' | 'text'>, absorbed: Pick<RosterMember, 'role' | 'text'>): string {
  const mine = (survivor.role ?? survivor.text).trim()
  const theirs = (absorbed.role ?? absorbed.text).trim()
  if (theirs === '' || mine.includes(theirs)) return mine
  return mine === '' ? theirs : `${mine}; also: ${theirs}`
}

/**
 * The message the survivor reads: who it is now, the handoff, and what git showed.
 * @returns the message (not a request).
 */
export function handoffMessage(args: { id: string; absorbed: string; name: string; formerNames: readonly string[]; role: string; area?: string | undefined; handoff: string; facts?: GitFacts | undefined }): string {
  const facts = args.facts
  return [
    `[handoff ${args.id} from ${args.absorbed}, merged into you; not a request]`,
    `[you are now worker "${args.name}"${args.formerNames.length === 0 ? '' : ` (also reached as ${args.formerNames.map(n => `"${n}"`).join(', ')})`}${args.area === undefined ? '' : ` in area "${args.area}"`}; your role: ${args.role.replace(/\s+/gu, ' ')}]`,
    `"${args.absorbed}" was archived; its work is yours now. Its handoff:`,
    '',
    args.handoff.trim(),
    ...(facts?.missing === true ? [
      '',
      `[the scheduler found no directory at ${facts.cwd}: it was removed or moved, so nothing there could be checked; anything uncommitted in it is not in this handoff]`,
    ] : facts === undefined ? [] : [
      '',
      `[checked by the scheduler in ${facts.cwd}]`,
      `branch: ${facts.branch ?? 'unknown'}${facts.ahead === undefined ? ' (no upstream)' : facts.ahead > 0 ? ` (${facts.ahead} commit${facts.ahead === 1 ? '' : 's'} not pushed)` : ' (pushed)'}`,
      facts.dirty.length === 0 ? 'uncommitted: none' : `uncommitted (now yours to commit or drop, in ${facts.cwd}):\n${facts.dirty.slice(0, 30).map(l => `  ${l}`).join('\n')}`,
    ]),
  ].join('\n')
}
