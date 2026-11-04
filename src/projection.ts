/**
 * Client-visible session projection: forks, workers, requests and the lead role, folded from
 * this plugin's records. The right-sidebar roster and the input dock read it through
 * `useProjection('agentScheduler')`; the host side never pushes these separately.
 * @module dsh-agent-scheduler/projection
 */
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ZodType } from 'zod'
import { inputOf, recordReaders as R } from './records.js'

/** Projection key registered with the session-projection registry. */
export const SCHEDULER_PROJECTION = 'agentScheduler'

/** One fork or worker as the client draws it. */
export interface RosterMember {
  readonly id: string
  readonly name: string
  readonly kind: 'fork' | 'worker'
  /** `queued`, `started`, `done`, `failed`, or `archived`. */
  readonly state: string
  /** Fork: the user's words. Worker: its role. */
  readonly text: string
  readonly role?: string | undefined
  readonly cwd?: string | undefined
  readonly model?: string | undefined
  readonly detail?: string | undefined
}

/** One piece of delegated work. */
export interface RosterRequest {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  /** `sent`, `answered`, or `failed`. */
  readonly state: string
  readonly answer?: string | undefined
  readonly deliveredTo?: string | undefined
}

/** Whole client view of one main Session. */
export interface RosterView {
  readonly role: string | null
  readonly members: readonly RosterMember[]
  readonly requests: readonly RosterRequest[]
}

/**
 * The registry only calls `parse` on persisted state and on the wire copy, and this plugin is
 * their only producer, so a parse-identity shim keeps zod out of the published dependency set.
 */
export const rosterSchema = { parse: (value: unknown): RosterView => value as RosterView } as unknown as ZodType<RosterView>

/** The view keeps the fold's own shape, so the wire copy is one reference. */
export const EMPTY_ROSTER: RosterView = { role: null, members: [], requests: [] }

/** @returns the state every empty or unrelated log starts from. */
export const initRoster = (_header: SessionHeader, _inherited: SessionLogOffset): RosterView => EMPTY_ROSTER

/**
 * Apply one event; unrelated events return the same state reference.
 * @param state - state covering all prior events.
 * @param event - the next committed event.
 * @returns the next state, or the same reference.
 */
export function applyRoster(state: RosterView, event: SessionEvent): RosterView {
  const input = inputOf(event)
  if (input !== undefined) {
    const member: RosterMember = { id: input.forkId, name: input.name ?? 'fork', kind: 'fork', state: 'started', text: input.text }
    return { ...state, members: [...state.members.filter(m => m.id !== input.forkId), member] }
  }
  const fork = R.forkState(event)
  if (fork !== undefined) {
    if (!state.members.some(m => m.id === fork.forkId)) return state
    return { ...state, members: state.members.map(m => m.id === fork.forkId ? update(m, { state: fork.state, ...(fork.detail === undefined ? {} : { detail: fork.detail }) }) : m) }
  }
  const agent = R.agent(event)
  if (agent !== undefined) {
    const existing = state.members.find(m => m.id === agent.id)
    const next: RosterMember = {
      id: agent.id,
      name: agent.name,
      kind: 'worker',
      state: agent.action === 'created' ? 'started' : agent.action,
      text: agent.role ?? existing?.text ?? '',
      ...(agent.role === undefined ? {} : { role: agent.role }),
      ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.detail === undefined ? {} : { detail: agent.detail }),
    }
    return { ...state, members: [...state.members.filter(m => m.id !== agent.id), next] }
  }
  const request = R.request(event)
  if (request !== undefined) {
    const existing = state.requests.find(r => r.id === request.id)
    const answer = request.answer ?? request.detail ?? existing?.answer
    const deliveredTo = request.deliveredTo ?? existing?.deliveredTo
    const next: RosterRequest = {
      id: request.id,
      from: request.from ?? existing?.from ?? '',
      to: request.to ?? existing?.to ?? '',
      text: request.text ?? existing?.text ?? '',
      state: request.action,
      ...(answer === undefined ? {} : { answer }),
      ...(deliveredTo === undefined ? {} : { deliveredTo }),
    }
    return { ...state, requests: [...state.requests.filter(r => r.id !== request.id), next] }
  }
  const role = R.role(event)
  if (role !== undefined) {
    if (role.agent === undefined) return { ...state, role: role.text }
    if (!state.members.some(m => m.id === role.agent)) return state
    return { ...state, members: state.members.map(m => m.id === role.agent ? update(m, { role: role.text, text: role.text }) : m) }
  }
  return state
}

function update(member: RosterMember, patch: Partial<RosterMember>): RosterMember {
  return { ...member, ...patch }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    agentScheduler: RosterView
  }
  interface SessionProjectionStateMap {
    agentScheduler: RosterView
  }
}
