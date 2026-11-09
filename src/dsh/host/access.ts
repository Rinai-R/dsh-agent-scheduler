/**
 * A Session's access mode (sandbox + approval policy bundle), through the host's permission
 * presets: the names it offers, the one a Session is on, and the durable switch. Delegated
 * children are created with the approval policy pinned to `never`, which matches no preset, so a
 * child reads `custom` until it is given a preset of its own.
 * @module dsh-agent-scheduler/dsh/host/access
 */
import type { Context } from '@deepseek-ai/cordis'
import { hasFunction } from '../compat.js'

/** One selectable access mode. */
export interface AccessMode {
  readonly name: string
  /** Sandbox mode it bundles, e.g. `read-only`, `workspace-write`, `danger-full-access`. */
  readonly sandbox: string
  readonly approval: 'ask' | 'never'
}

/** The host's permission presets, narrowed to what the plugin uses. */
export interface AccessPort {
  /** Whether this DSH offers permission presets at all. */
  readonly available: boolean
  /** Selectable modes, in the host's table order. */
  modes(): AccessMode[]
  /** The mode a Session is on now, or `custom` when its knobs match no preset. */
  current(session: object): string
  /**
   * Switch one Session and record it durably (nothing is appended for a no-op). The call does not
   * announce the change to the model the way a live user switch does; the log is authoritative.
   */
  set(session: object, name: string): void
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the preset service is reached through the untyped context */

export const CUSTOM = 'custom'

/**
 * @param ctx - the rule's context.
 * @returns the port; `available: false` (and one warning) when the host has no permission presets.
 */
export function accessPort(ctx: Context): AccessPort {
  // The service is optional: a profile without permission presets simply has no access modes.
  // Reached through get() (a bare property read throws until the service is injected).
  const source = (): any => {
    try {
      const live = typeof (ctx as any).get === 'function' ? (ctx as any).get('permissionPresets') : undefined
      if (live !== undefined) return live
    } catch {
      // Not injectable in this composition.
    }
    return undefined
  }
  const port: AccessPort = {
    get available() { const live = source(); return live !== undefined && hasFunction(live, 'current') && hasFunction(live, 'set') },
    modes() {
      const live = source()
      const names: string[] = Array.isArray(live?.names) ? live.names : []
      return names.flatMap(name => {
        const spec = live?.resolve?.(name) as { sandbox?: unknown; approval?: unknown } | undefined
        return typeof spec?.sandbox === 'string' ? [{ name, sandbox: spec.sandbox, approval: spec.approval === 'never' ? 'never' as const : 'ask' as const }] : []
      })
    },
    current(session) { const live = source(); return port.available && live !== undefined ? String(live.current(session)) : CUSTOM },
    set(session, name) { const live = source(); if (port.available && live !== undefined) live.set(session, name) },
  }
  return port
}
