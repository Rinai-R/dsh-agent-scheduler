/**
 * The structured brief of a hand-off (design phase 2 §4): what a session tells a worker when it
 * gives it new work through `agent_create` or `agent_send`. A brief is checked field by field
 * before anything is recorded, kept with the queued message, and rendered for the worker as
 * fixed sections, so a worker reads every hand-off the same way.
 * @module dsh-agent-scheduler/brief
 */

/** Where a finding comes from. A `session` ref can be read with `agent_recall`. */
export type BriefRef =
  | { readonly kind: 'file'; readonly path: string; readonly line?: number | undefined; readonly lineTo?: number | undefined }
  | { readonly kind: 'commit'; readonly sha: string; readonly repo?: string | undefined }
  | { readonly kind: 'pr'; readonly url: string }
  | { readonly kind: 'session'; readonly id: string; readonly seqFrom: number; readonly seqTo: number }
  | { readonly kind: 'im'; readonly url: string }
  | { readonly kind: 'url'; readonly url: string }

export interface BriefFinding {
  readonly text: string
  readonly refs: readonly BriefRef[]
}

export interface Brief {
  /** What the work is for, in one or two sentences. */
  readonly goal: string
  /** What the user said about it, in their words (not checked against their messages). */
  readonly userWords: string
  readonly findings: readonly BriefFinding[]
  readonly constraints: readonly string[]
  readonly nonGoals: readonly string[]
  /** How the work is judged done; at least one item. */
  readonly acceptance: readonly string[]
  readonly openQuestions: readonly string[]
}

/**
 * The `brief` tool parameter (dsh-tools schema spec). No field is marked required here on
 * purpose: DSH would refuse a missing one with a generic schema error before the tool runs, while
 * {@link parseBrief} names every wrong field with what to give instead.
 */
export const BRIEF_PARAMETER = {
  type: 'object',
  additionalProperties: true,
  description: 'Required for new work (see the tool description). Every field is checked; a missing or invalid one refuses the call with the reason, and nothing is sent.',
  properties: {
    goal: { type: 'string', description: 'What the work is for, in one or two sentences.' },
    userWords: { type: 'string', description: 'What the user said about it, in their own words (quote or close paraphrase).' },
    findings: {
      type: 'array', description: 'What you found so far, each {text, refs}. May be empty.',
      items: {
        type: 'object', additionalProperties: true,
        properties: {
          text: { type: 'string' },
          refs: { type: 'array', description: 'Each ref: {kind:"file", path, line?, lineTo?} | {kind:"commit", sha, repo?} | {kind:"pr", url} | {kind:"session", id, seqFrom, seqTo} | {kind:"im", url} | {kind:"url", url}. May be empty.', items: { type: 'json' } },
        },
      },
    },
    constraints: { type: 'array', items: { type: 'string' }, description: 'Rules the work must keep (may be empty).' },
    nonGoals: { type: 'array', items: { type: 'string' }, description: 'What is out of scope (may be empty).' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'How the work is judged done: at least one checkable item.' },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'What is still undecided (may be empty).' },
  },
} as const

/** A brief that failed its check: one reason per field, worded for the model to fix. */
export class BriefInvalid extends Error {
  override readonly name = 'BriefInvalid'
  constructor(readonly problems: readonly string[]) {
    super(`The brief is incomplete, so nothing was sent:\n${problems.map(p => `- ${p}`).join('\n')}\nFix these fields and call again.`)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** @returns the ref, or why it is not one. */
function checkRef(raw: unknown, where: string): BriefRef | string {
  if (!isRecord(raw)) return `${where} must be an object with a kind`
  switch (raw.kind) {
    case 'file':
      if (!text(raw.path)) return `${where}: a file ref needs path`
      if (raw.line !== undefined && !(count(raw.line) && raw.line > 0)) return `${where}: line is a positive integer`
      if (raw.lineTo !== undefined && !(count(raw.lineTo) && raw.lineTo > 0)) return `${where}: lineTo is a positive integer`
      return { kind: 'file', path: raw.path, ...(raw.line === undefined ? {} : { line: raw.line as number }), ...(raw.lineTo === undefined ? {} : { lineTo: raw.lineTo as number }) }
    case 'commit':
      if (!text(raw.sha)) return `${where}: a commit ref needs sha`
      if (raw.repo !== undefined && !text(raw.repo)) return `${where}: repo is a non-empty string`
      return { kind: 'commit', sha: raw.sha, ...(raw.repo === undefined ? {} : { repo: raw.repo as string }) }
    case 'session':
      if (!text(raw.id)) return `${where}: a session ref needs id`
      if (!count(raw.seqFrom) || !count(raw.seqTo)) return `${where}: a session ref needs seqFrom and seqTo (event seq numbers)`
      if (raw.seqTo < raw.seqFrom) return `${where}: seqTo is before seqFrom`
      return { kind: 'session', id: raw.id, seqFrom: raw.seqFrom, seqTo: raw.seqTo }
    case 'pr': case 'im': case 'url':
      if (!text(raw.url)) return `${where}: a ${raw.kind} ref needs url`
      return { kind: raw.kind, url: raw.url }
    default:
      return `${where}: kind is one of file, commit, pr, session, im, url (got ${JSON.stringify(raw.kind)})`
  }
}

/** @returns the list of non-empty strings, or a reason. */
function strings(raw: unknown, field: string, required: boolean): string[] | string {
  if (!Array.isArray(raw)) return `${field} is missing: give a list of strings${required ? ' with at least one item' : ' (an empty list [] is fine)'}`
  const bad = raw.findIndex(v => !text(v))
  if (bad >= 0) return `${field}[${bad}] must be a non-empty string`
  if (required && raw.length === 0) return `${field} is empty: give at least one item`
  return raw.map(v => (v as string).trim())
}

/**
 * Check a brief from a tool call.
 * @param raw - the `brief` argument.
 * @returns the brief.
 * @throws {BriefInvalid} with one reason per wrong field.
 */
export function parseBrief(raw: unknown): Brief {
  if (!isRecord(raw)) throw new BriefInvalid(['brief must be an object with goal, userWords, findings, constraints, nonGoals, acceptance and openQuestions'])
  const problems: string[] = []
  if (!text(raw.goal)) problems.push('goal is missing or empty: say what the work is for')
  if (!text(raw.userWords)) problems.push('userWords is missing or empty: give what the user said, in their words')
  const findings: BriefFinding[] = []
  if (!Array.isArray(raw.findings)) problems.push('findings is missing: give a list (an empty list [] is fine)')
  else {
    raw.findings.forEach((f, i) => {
      if (!isRecord(f) || !text(f.text)) { problems.push(`findings[${i}].text is missing or empty`); return }
      if (!Array.isArray(f.refs)) { problems.push(`findings[${i}].refs is missing: give where it comes from (an empty list [] if nowhere)`); return }
      const refs: BriefRef[] = []
      f.refs.forEach((r, j) => { const out = checkRef(r, `findings[${i}].refs[${j}]`); if (typeof out === 'string') problems.push(out); else refs.push(out) })
      findings.push({ text: f.text.trim(), refs })
    })
  }
  const lists: Record<string, string[]> = {}
  for (const [field, required] of [['constraints', false], ['nonGoals', false], ['acceptance', true], ['openQuestions', false]] as const) {
    const out = strings(raw[field], field, required)
    if (typeof out === 'string') problems.push(out); else lists[field] = out
  }
  if (problems.length > 0) throw new BriefInvalid(problems)
  return {
    goal: (raw.goal as string).trim(), userWords: (raw.userWords as string).trim(), findings,
    constraints: lists.constraints!, nonGoals: lists.nonGoals!, acceptance: lists.acceptance!, openQuestions: lists.openQuestions!,
  }
}

/** @returns a brief that also points at the sender's own exploration, unless it already does. */
export function withSenderRef(brief: Brief, sender: { id: string; seqFrom: number; seqTo: number }): Brief {
  const ref: BriefRef = { kind: 'session', id: sender.id, seqFrom: sender.seqFrom, seqTo: sender.seqTo }
  return { ...brief, findings: [...brief.findings, { text: 'The sender\'s exploration that led to this hand-off (read it with agent_recall).', refs: [ref] }] }
}

/** Every session a brief points at. */
export const sessionRefs = (brief: Brief): string[] => [...new Set(brief.findings.flatMap(f => f.refs.flatMap(r => r.kind === 'session' ? [r.id] : [])))]

function refText(r: BriefRef): string {
  switch (r.kind) {
    case 'file': return r.line === undefined ? r.path : `${r.path}:${r.line}${r.lineTo === undefined ? '' : `-${r.lineTo}`}`
    case 'commit': return r.repo === undefined ? `commit ${r.sha}` : `commit ${r.sha} in ${r.repo}`
    case 'session': return `session ${r.id} seq ${r.seqFrom}-${r.seqTo}`
    case 'pr': return `PR ${r.url}`
    case 'im': return `IM ${r.url}`
    case 'url': return r.url
  }
}

const list = (items: readonly string[]): string => items.length === 0 ? '- (none)' : items.map(i => `- ${i}`).join('\n')

/** The headings, in the order a worker always reads them. */
export const BRIEF_HEADINGS = ['Goal', 'User\'s words', 'Findings', 'Constraints', 'Non-goals', 'Acceptance criteria', 'Open questions'] as const

/**
 * Render a brief for the worker: fixed sections in a fixed order, with fixed English headings.
 * @param note - an optional free-text note from the sender, after the brief.
 */
export function renderBrief(brief: Brief, note?: string): string {
  const findings = brief.findings.length === 0 ? '- (none)' : brief.findings.map(f => `- ${f.text}${f.refs.length === 0 ? '' : ` [${f.refs.map(refText).join('; ')}]`}`).join('\n')
  const quoted = brief.userWords.split('\n').map(l => `> ${l}`).join('\n')
  const sections = [
    `## Goal\n${brief.goal}`,
    `## User's words\n${quoted}`,
    `## Findings\n${findings}`,
    `## Constraints\n${list(brief.constraints)}`,
    `## Non-goals\n${list(brief.nonGoals)}`,
    `## Acceptance criteria\n${list(brief.acceptance)}`,
    `## Open questions\n${list(brief.openQuestions)}`,
  ]
  const tail = note === undefined || note.trim() === '' ? '' : `\n\n## Note\n${note.trim()}`
  return `${sections.join('\n\n')}${tail}`
}
