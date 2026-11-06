/**
 * A member's own model. Two runtime APIs exist:
 * - DSH ≥ 0.2.2: `agent.model.select(selection)`, a durable choice in the Agent's own log;
 * - DSH 0.2.1: `installModelSelection(agent.ctx, ref)`, a mutable selection the plugin installs
 *   per member Agent (the runtime's own selector refuses subagent Sessions there).
 * {@link applyModelSelection} probes for the first and falls back to the second.
 * @module dsh-agent-scheduler/dsh/host/model
 */
import * as AgentRuntime from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentOptions, ModelSelection } from '../types.js'
import { features } from '../compat.js'
import type { ModelChoice } from './runtime.js'

const toSelection = (choice: ModelChoice): ModelSelection => ({
  provider: choice.provider,
  model: choice.model,
  ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) }),
})

/** `agent.model` on DSH ≥ 0.2.2. */
interface AgentModel { current(): Readonly<ModelSelection> | undefined; select(selection: Readonly<ModelSelection>): void }
const agentModelOf = (agent: Agent): AgentModel | undefined => {
  const model = (agent as { model?: Partial<AgentModel> }).model
  return typeof model?.select === 'function' ? model as AgentModel : undefined
}

/** DSH ≥ 0.2.2 exports `AgentModel` alongside `agent.model`. */
const hasAgentModelApi = (): boolean => typeof (AgentRuntime as { AgentModel?: unknown }).AgentModel === 'function'

/** The DSH 0.2.1 selection: what to use next, and what the current step was assembled with. */
interface SelectionRef { current: ModelSelection | undefined; assembled: ModelSelection | undefined }
type InstallSelection = (agentCtx: Agent['ctx'], ref: SelectionRef) => () => void
const legacyInstall = (): InstallSelection | undefined => {
  const install = (AgentRuntime as { installModelSelection?: unknown }).installModelSelection
  // On 0.2.2 the same name takes only the context (it installs switch notices): not this API.
  return typeof install === 'function' && install.length >= 2 ? install as InstallSelection : undefined
}

/** One installed selection per live member Agent (DSH 0.2.1). */
const installed = new WeakMap<Agent, SelectionRef>()

/**
 * @returns whether this DSH can switch one Agent's model.
 */
export const canSelectModel = (): boolean =>
  features.record('modelSelection', hasAgentModelApi() || legacyInstall() !== undefined, 'neither agent.model.select nor installModelSelection(ctx, ref)')

const sameSelection = (a: Readonly<ModelSelection> | undefined, b: Readonly<ModelSelection>): boolean =>
  a !== undefined && a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)

/** The model an Agent was started with, from its options. */
const startModelOf = (agent: Agent): ModelSelection | undefined => {
  const { provider, model, reasoningEffort } = (agent as { options?: Partial<AgentOptions> }).options ?? {}
  if (provider === undefined || model === undefined) return undefined
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * Point a live member's later requests at a model; `null` returns it to the model it started
 * with. The step already assembling keeps its model, as with the runtime's selector.
 * @param agent - the member Agent.
 * @param choice - the model, or null.
 * @returns false when this DSH cannot select a model per Agent (nothing changed).
 */
export function applyModelSelection(agent: Agent, choice: ModelChoice | null): boolean {
  const model = agentModelOf(agent)
  if (model !== undefined) {
    // The choice is durable in the member's own log here, so `null` must be written back too,
    // also when a released member is recreated; an unchanged choice writes nothing.
    const selection = choice === null ? startModelOf(agent) : toSelection(choice)
    if (selection !== undefined && !sameSelection(model.current(), selection)) model.select(selection)
    return true
  }
  let ref = installed.get(agent)
  if (ref === undefined) {
    if (choice === null) return true
    const install = legacyInstall()
    if (!features.record('modelSelection', install !== undefined, 'installModelSelection(ctx, ref)')) return false
    ref = { current: undefined, assembled: undefined }
    installed.set(agent, ref)
    const dispose = install!(agent.ctx, ref)
    agent.ctx.effect(() => dispose, 'agent-scheduler: member model')
  }
  ref.current = choice === null ? undefined : toSelection(choice)
  return true
}
