/**
 * How the plugin's slash commands look in the composer's `/` menu, in DSH's language.
 * @module dsh-agent-scheduler/menu
 */
import { t } from './i18n/index.js'

/** The `/` menu face of each command, by command name: dictionary keys under `menu.`. */
export const MENU = { schedule: 'schedule', agents: 'agents', fork: 'fork', worker: 'worker', role: 'role', 'agent-model': 'agentModel' } as const

/**
 * The `/` menu description of a command in DSH's language now: its title, then one line.
 * @param name - the command.
 * @returns e.g. 「调度 · 之后每条消息交给一个分身（on / off）」.
 */
export const menuDescription = (name: keyof typeof MENU): string => `${t(`menu.${MENU[name]}.title`)} · ${t(`menu.${MENU[name]}.desc`)}`

/**
 * The argument hint of a command in DSH's language now.
 * @param name - a command that takes arguments.
 * @returns the hint.
 */
export const menuHint = (name: Exclude<keyof typeof MENU, 'fork'>): string => t(`menu.${MENU[name]}.hint`)
