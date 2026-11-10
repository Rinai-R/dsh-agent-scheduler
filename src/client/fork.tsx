/**
 * Forking a worker from the user's side: the Agents page's 「Fork…」 form on a worker row, and the
 * 「Fork this worker」 action under each answer of a worker's own chat (which opens that form).
 * Both run `/agents fork`, the same path as `agent_split` / `agent_create from`: the new worker
 * is a session of its own, with its own row and chat tab, never a branch of the main session.
 * @module dsh-agent-scheduler/client/fork
 */
import { memo, useSyncExternalStore } from 'react'
import { t, useLocale } from './i18n.js'

/** What the fork form holds. */
export interface ForkDraft {
  /** The worker being forked (its row id) and its current name. */
  readonly id: string
  readonly owner: string
  readonly name: string
  readonly role: string
  readonly task: string
  /** Create `cwd` as a new git worktree of `repo` on `branch`. */
  readonly worktree: boolean
  readonly cwd: string
  readonly branch: string
  /** An existing checkout to add the worktree from (the owner's directory). */
  readonly repo: string
  /** Whether the user edited `cwd` / `branch` (then the name no longer rewrites them). */
  readonly touched: boolean
  readonly ownerName: string
  readonly ownerRole: string
  readonly busy: boolean
  readonly error: string | null
}

/**
 * A worker name made path- and branch-safe.
 * @param name - the new worker's name.
 * @returns lower-kebab-case, or empty.
 */
export function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
}

/**
 * Where a fork's worktree goes by default: next to the owner's, as `<root>/worktrees/<repo>__<slug>`.
 * A worktree `…/worktrees/<repo>__<x>` gives `…/worktrees/<repo>__<slug>`; a checkout
 * `…/<repo>` gives `…/worktrees/<repo>__<slug>`.
 * @param ownerCwd - the owner's working directory.
 * @param slug - the new worker's slug.
 * @returns the directory, or undefined without a slug or directory.
 */
export function worktreePathOf(ownerCwd: string | undefined, slug: string): string | undefined {
  if (ownerCwd === undefined || ownerCwd.trim() === '' || slug === '') return undefined
  const cwd = ownerCwd.replace(/\/+$/u, '')
  const inWorktrees = /^(.*\/worktrees)\/([^/]+?)__[^/]+$/u.exec(cwd)
  if (inWorktrees !== null) return `${inWorktrees[1]}/${inWorktrees[2]}__${slug}`
  const plain = /^(.*)\/([^/]+)$/u.exec(cwd)
  if (plain === null) return undefined
  return `${plain[1] === '' ? '' : plain[1]}/worktrees/${plain[2]}__${slug}`
}

/**
 * A fresh form for forking `owner`.
 * @param owner - the worker row.
 * @returns the draft.
 */
export function startFork(owner: { readonly id: string; readonly name: string; readonly cwd?: string | undefined }): ForkDraft {
  const repo = owner.cwd ?? ''
  return { id: owner.id, owner: owner.name, name: '', role: '', task: '', worktree: repo !== '', cwd: '', branch: '', repo, touched: false, ownerName: '', ownerRole: '', busy: false, error: null }
}

/**
 * The draft after its new name changed: an untouched directory and branch follow the name.
 * @param draft - the form.
 * @param name - the new name.
 * @returns the draft.
 */
export function withForkName(draft: ForkDraft, name: string): ForkDraft {
  if (draft.touched) return { ...draft, name, error: null }
  const slug = slugOf(name)
  return { ...draft, name, cwd: worktreePathOf(draft.repo, slug) ?? '', branch: slug === '' ? '' : `feat/${slug}`, error: null }
}

/** A flag value must not read as the next flag, nor be empty. */
const flagValue = (text: string): string | undefined => {
  const value = text.trim().replace(/\s+/gu, ' ')
  if (value === '') return undefined
  return value.split(' ').some(w => w.startsWith('--')) ? '' : value
}

/**
 * The `/agents fork` line a form submits.
 * @param draft - the form.
 * @returns the line, or an error for the form.
 */
export function forkCommand(draft: ForkDraft): { line: string } | { error: string } {
  const name = draft.name.trim()
  if (name === '' || /\s/u.test(name)) return { error: t('cmd.agents.forkUsage') }
  const parts = ['/agents fork', draft.owner, name]
  const add = (flag: string, text: string): string | undefined => {
    const value = flagValue(text)
    if (value === '') return t('cmd.agents.needsValue', { flag })
    if (value !== undefined) parts.push(flag, value)
    return undefined
  }
  const failed = add('--role', draft.role) ?? add('--task', draft.task)
  if (failed !== undefined) return { error: failed }
  if (draft.worktree) {
    if (draft.cwd.trim() === '' || draft.branch.trim() === '' || draft.repo.trim() === '') return { error: t('cmd.agents.forkRepoBranch') }
    // From the owner's checkout as it is (HEAD): the fork continues its conversation, so it starts from its code too.
    parts.push('--cwd', draft.cwd.trim(), '--repo', draft.repo.trim(), '--branch', draft.branch.trim(), '--base', 'HEAD')
  } else if (draft.cwd.trim() !== '') {
    parts.push('--cwd', draft.cwd.trim())
  }
  const ownerName = draft.ownerName.trim()
  if (ownerName !== '') {
    if (/\s/u.test(ownerName)) return { error: t('cmd.agents.forkUsage') }
    parts.push('--owner-name', ownerName)
    const roleFailed = add('--owner-role', draft.ownerRole)
    if (roleFailed !== undefined) return { error: roleFailed }
  }
  return { line: parts.join(' ') }
}

// ------------------------------------------------------------- a fork asked for from a chat

type Wanted = { readonly parent: string; readonly worker: string } | undefined
let wanted: Wanted
const listeners = new Set<() => void>()

/**
 * Ask the Agents page of `parent` to open the fork form for `worker`.
 * @param parent - the main Session.
 * @param worker - the worker's Session id.
 */
export function requestFork(parent: string, worker: string): void {
  wanted = { parent, worker }
  for (const listener of listeners) listener()
}

/** The pending request; the Agents page takes it once (see {@link takeFork}). */
export const forkRequests = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: (): Wanted => wanted,
}

/**
 * @param parent - the Agents page's main Session.
 * @returns the worker whose fork form to open, once.
 */
export function takeFork(parent: string): string | undefined {
  if (wanted?.parent !== parent) return undefined
  const worker = wanted.worker
  wanted = undefined
  return worker
}

/** Styles for the fork form and the chat action. */
export const FORK_STYLE = `
.sch-roster-fork{position:absolute;right:106px;top:26px;transform:translateY(-50%);display:none;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-roster-fork[data-slot="2"]{right:76px}
.sch-roster-fork[data-slot="1"]{right:46px}
.sch-roster-fork[data-slot="0"]{right:16px}
.sch-roster-item:hover .sch-roster-fork,.sch-roster-fork:focus-visible{display:inline-flex}
.sch-roster-fork:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sch-roster-item:has(.sch-roster-fork):hover .sch-roster-end{visibility:hidden}
.sch-roster-form-title{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-weight:600}
.sch-fork-check{display:flex!important;flex-direction:row!important;align-items:center;gap:6px}
.sch-fork-from-chat{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sch-fork-from-chat:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
`

const BRANCH_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13.5V9M8 9 4 5M8 9l4-4M4 5V2.5M12 5V2.5M2.5 4 4 2.5 5.5 4M10.5 4 12 2.5 13.5 4" /></svg>
)

/** A projection face. */
interface Face { subscribe: (listener: () => void) => () => void; getSnapshot: () => unknown }
const NO_FACE: Face = { subscribe: () => () => undefined, getSnapshot: () => undefined }

/**
 * 「Fork this worker」 under each answer in a worker's own chat: opens the Agents page with the
 * fork form for that worker. Shows nothing outside a live worker's chat.
 * @param deps - roster access and how to open the Agents page.
 * @returns the slot component.
 */
export function createForkFromChat(deps: {
  parentOf: (sessionId: string) => string | undefined
  rosterFace: (parent: string) => Face
  openAgents: () => void
}) {
  return memo(function ForkFromChat(props: { sessionId?: string }) {
    useLocale()
    const sessionId = props.sessionId
    const parent = sessionId === undefined ? undefined : deps.parentOf(sessionId)
    const face = parent === undefined ? NO_FACE : deps.rosterFace(parent)
    const roster = useSyncExternalStore(face.subscribe, face.getSnapshot) as { members?: ReadonlyArray<{ id: string; kind: string; state: string }> } | undefined
    const row = roster?.members?.find(m => m.id === sessionId)
    if (parent === undefined || sessionId === undefined || row === undefined || row.kind !== 'worker' || row.state === 'archived') return null
    return (
      <button
        type="button"
        className="sch-fork-from-chat"
        data-scheduler-fork-from-chat={sessionId}
        aria-label={t('fork.fromChat')}
        title={t('fork.fromChat')}
        onClick={() => { requestFork(parent, sessionId); deps.openAgents() }}
      >{BRANCH_ICON}</button>
    )
  })
}
