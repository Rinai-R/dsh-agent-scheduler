/**
 * Every DSH type the rest of the plugin uses, from one place. Business modules import types from
 * here, never from `@deepseek-ai/dsh-*` (enforced by tests/contract/boundary.spec.ts), so a moved
 * or renamed declaration is fixed in this file alone.
 * @module dsh-agent-scheduler/dsh/types
 */
export type { Agent, AgentOptions, PreStepDecision, ModelSelection } from '@deepseek-ai/dsh-agent'
export type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
export type { Session, SessionEvent, SessionHeader, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
export type { SubagentRuntime, ContinuableCreateRequest, ContinuableCreateSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
export type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
export type { ToolDefinition } from '@deepseek-ai/dsh-tools'
