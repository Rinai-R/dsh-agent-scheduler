/**
 * Host half of dsh-agent-scheduler. The Loader row makes the bundle's browser half available in
 * every session and registers the `fork-from` provider; all behaviour lives in `./rule`, mounted
 * by the `scheduler` preset.
 * @module dsh-agent-scheduler
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { installForkFrom } from './forks-from.js'
import { applyRoster, initRoster, rosterSchema, rosterView, rosterViewSchema, SCHEDULER_PROJECTION } from './projection.js'

export const name = 'agent-scheduler'
export const inject = ['subagents', 'sessionProjections']

/**
 * Register the fork provider and the roster projection once for the whole process, so a
 * client that draws the roster has the projection even before the preset's rule mounts.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  installForkFrom(ctx)
  ctx.effect(() => ctx.sessionProjections.register({
    key: SCHEDULER_PROJECTION,
    // 2: the fold carries settlement watermarks and archived forks; older cached state is dropped.
    stateVersion: 2,
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
export { parseForkCommand, type Config } from './rule-plugin.js'
