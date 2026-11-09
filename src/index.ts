/**
 * Host half of dsh-agent-scheduler. The Loader row makes the bundle's browser half available in
 * every session and registers the `fork-from` provider and the roster projection; all behaviour
 * lives in `./rule`, a second top-level row, switched per Session with `/schedule on|off`.
 * @module dsh-agent-scheduler
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_RECOVERY, setRecoveryPolicy, type RecoveryPolicy } from './recovery.js'
import { accessPort, HOST_SERVICES, installForkFrom, registerProjection } from './dsh/host/index.js'
import { applyRoster, initRoster, rosterSchema, rosterView, rosterViewSchema, SCHEDULER_PROJECTION } from './projection.js'

export const name = 'agent-scheduler'
export const inject = HOST_SERVICES

/**
 * Host row configuration. The plugin page edits this row's settings namespace
 * (`dsh-agent-scheduler`, see src/client/recovery-config.tsx). Volatile, so the plugin page edits it live without a remount.
 */
export interface Config {
  recovery: Volatile<RecoveryPolicy>
}

export const Config: z<Config> = z.object({
  recovery: z.object({
    onInterrupted: z.union(['fail', 'resume'] as const).default(DEFAULT_RECOVERY.onInterrupted)
      .description('After a DSH restart: fail work that was cut off and tell the lead (fail), or continue it in the worker\'s own session (resume).'),
    maxResumes: z.natural().max(10).default(DEFAULT_RECOVERY.maxResumes)
      .description('With resume: how many times one request is resumed before it fails.'),
  }).default({}).volatile(),
}) as unknown as z<Config>

/**
 * Register the fork provider and the roster projection once for the whole process, so a
 * client that draws the roster has the projection even before the rule row mounts.
 * @param ctx - host context.
 * @param config - host row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  installForkFrom(ctx)
  const access = accessPort(ctx)
  ctx.effect(() => setRecoveryPolicy(() => config.recovery.get() as RecoveryPolicy), 'agent-scheduler: recovery policy')
  registerProjection(ctx, {
    key: SCHEDULER_PROJECTION,
    // 3: the fold carries the scheduling switch. 4: the `/fork model` override. 5: each member's
    // own model. 6: who created a worker for which input, and each member's unread report.
    // 7: a renamed worker's former names, and the area workers split from one area share.
    // 8: the lead's inbox.
    // 9: Agent Teams led by the lead or a worker, and deferred requests. 10: merges. 11: where merged workers' history is.
    // Older cached state is dropped and refolded.
    stateVersion: 11,
    state: rosterSchema,
    view: rosterViewSchema,
    init: initRoster,
    apply: applyRoster,
    toView: state => ({ ...rosterView(state), accessModes: access.modes().map((m: { name: string; sandbox: string }) => ({ name: m.name, sandbox: m.sandbox })) }),
  })
}

export * from './forks-from.js'
export * from './records.js'
export * from './scheduler.js'
export * from './ledger.js'
export * from './projection.js'
export * from './rounds.js'
export * from './tools.js'
export * from './member-model.js'
export * from './recovery.js'
export { parseForkCommand, type Config as RuleConfig } from './rule-plugin.js'
