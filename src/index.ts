/**
 * Host half of dsh-agent-scheduler. The Loader row makes the bundle's browser half available in
 * every session and registers the `fork-from` provider; all behaviour lives in `./rule`, mounted
 * in the standard preset and switched per Session with `/schedule on|off`.
 * @module dsh-agent-scheduler
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_RECOVERY, setRecoveryPolicy, type RecoveryPolicy } from './recovery.js'
import { installForkFrom } from './forks-from.js'
import { applyRoster, initRoster, rosterSchema, rosterView, rosterViewSchema, SCHEDULER_PROJECTION } from './projection.js'

export const name = 'agent-scheduler'
export const inject = ['subagents', 'sessionProjections']

/**
 * Host row configuration. It lives here rather than on the preset's rule row: the rule row is
 * nested inside the overridden standard preset, and settings forms only address rows owned by
 * the profile's root Include. Volatile, so the plugin page edits it live without a remount.
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
 * client that draws the roster has the projection even before the preset's rule mounts.
 * @param ctx - host context.
 * @param config - host row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  installForkFrom(ctx)
  ctx.effect(() => setRecoveryPolicy(() => config.recovery.get() as RecoveryPolicy), 'agent-scheduler: recovery policy')
  ctx.effect(() => ctx.sessionProjections.register({
    key: SCHEDULER_PROJECTION,
    // 3: the fold carries the scheduling switch. 4: the `/fork model` override. 5: each member's
    // own model. 6: who created a worker for which input, and each member's unread report.
    // 7: a renamed worker's former names, and the area workers split from one area share.
    // Older cached state is dropped and refolded.
    stateVersion: 7,
    stateSchema: rosterSchema,
    init: initRoster,
    apply: applyRoster,
    wire: { viewSchema: rosterViewSchema, view: rosterView },
  }), 'agent-scheduler: roster projection')
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
