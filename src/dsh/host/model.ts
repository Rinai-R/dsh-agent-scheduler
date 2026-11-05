/**
 * A member's own model, installed on its live Agent with the runtime's model selection
 * (dsh-agent `installModelSelection`). The runtime's own selector refuses subagent Sessions, so
 * the plugin installs one per member Agent itself.
 * @module dsh-agent-scheduler/dsh/host/model
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent, ModelSelection, ModelSelectionRef } from '../types.js'
import { features } from '../compat.js'
import type { ModelChoice } from './runtime.js'

const toSelection = (choice: ModelChoice): ModelSelection => ({
  provider: choice.provider,
  model: choice.model,
  ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(choice.reasoningEffort) }),
})

/** One installed selection per live member Agent. */
const installed = new WeakMap<Agent, ModelSelectionRef>()

/**
 * @returns whether this DSH can switch one Agent's model.
 */
export const canSelectModel = (): boolean =>
  features.record('modelSelection', typeof installModelSelection === 'function', 'dsh-agent installModelSelection')

/**
 * Point a live member's later requests at a model; `null` returns it to the model it started
 * with. The step already assembling keeps its model, as with the runtime's selector.
 * @param agent - the member Agent.
 * @param choice - the model, or null.
 * @returns false when this DSH cannot select a model per Agent (nothing changed).
 */
export function applyModelSelection(agent: Agent, choice: ModelChoice | null): boolean {
  let ref = installed.get(agent)
  if (ref === undefined) {
    if (choice === null) return true
    if (!canSelectModel()) return false
    ref = { current: undefined, assembled: undefined }
    installed.set(agent, ref)
    const dispose = installModelSelection(agent.ctx, ref)
    agent.ctx.effect(() => dispose, 'agent-scheduler: member model')
  }
  ref.current = choice === null ? undefined : toSelection(choice)
  return true
}
