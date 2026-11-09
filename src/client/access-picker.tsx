/**
 * A worker's access mode, in its own chat footer and beside the Agents page. DSH's own permission
 * picker cannot switch an addressed child Session (its picker writes through the client session
 * binding, which an embedded subagent chat does not have, so a pick is dropped silently), and a
 * delegated child is born with approval pinned to `never`, which matches no preset and reads
 * `custom`. This chip writes through the main Session's `/agent-access` command instead.
 * @module dsh-agent-scheduler/client/access-picker
 */
import { useState } from 'react'
import { t, useLocale } from './i18n.js'

/** One access mode as the host lists it. */
export interface AccessChoice {
  readonly name: string
  readonly sandbox: string
}

/** The chip's props. */
export interface AccessPickerProps {
  /** The member's name, as the command takes it. */
  readonly name: string
  /** The preset recorded for it, when there is one. */
  readonly preset?: string | undefined
  /** Modes the host offers; empty hides the chip. */
  readonly modes: readonly AccessChoice[]
  readonly busy?: boolean | undefined
  readonly error?: string | null | undefined
  /** Switch to one mode ('' = the lead's current mode). */
  readonly choose: (preset: string) => void
  /** `compact` renders the row form on the Agents page. */
  readonly compact?: boolean | undefined
}

const MODE_LABEL: Record<string, string> = {
  'read-only': 'access.mode.readOnly',
  'workspace-write': 'access.mode.workspaceWrite',
  'danger-full-access': 'access.mode.full',
  custom: 'access.mode.custom',
}

/**
 * The localized label of one preset.
 * @param preset - its name.
 * @returns a known label, else the name itself.
 */
export function modeLabel(preset: string | undefined): string {
  const key = preset === undefined ? undefined : MODE_LABEL[preset]
  return key === undefined ? (preset ?? t('access.mode.custom')) : t(key as never)
}

/**
 * The chip and its menu.
 * @param props - see {@link AccessPickerProps}.
 * @returns the control.
 */
export function AccessPicker(props: AccessPickerProps) {
  useLocale()
  const [open, setOpen] = useState(false)
  if (props.modes.length === 0) return null
  const label = modeLabel(props.preset)
  return (
    <span className="sch-access" data-scheduler-access={props.name} data-mode={props.preset ?? 'custom'}>
      <button
        type="button"
        className="sch-access-chip"
        aria-label={t('access.title', { name: props.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('access.title', { name: props.name })}
        disabled={props.busy === true}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="sch-access-glyph" aria-hidden="true">{ICON_KEY}</span>{label}
      </button>
      {open ? (
        <span className="sch-access-menu" role="menu">
          {props.modes.map(mode => (
            <button
              key={mode.name}
              type="button"
              role="menuitemradio"
              aria-checked={props.preset === mode.name}
              className="sch-access-item"
              data-access-mode={mode.name}
              disabled={props.busy === true}
              onClick={() => { setOpen(false); if (props.preset !== mode.name) props.choose(mode.name) }}
            >
              {props.preset === mode.name ? '✓ ' : ''}{modeLabel(mode.name)}
            </button>
          ))}
        </span>
      ) : null}
      {props.error === null || props.error === undefined ? null : <span className="sch-access-error" role="status">{props.error}</span>}
    </span>
  )
}

const ICON_KEY = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="5.5" cy="8" r="2.5" /><path d="M8 8h6M11 6l2 2-2 2" /></svg>

/** Styles of the chip; it sits in the composer's mode row and on a worker row. */
export const ACCESS_STYLE = `
.sch-access{position:relative;display:inline-flex;align-items:center;gap:4px;min-width:0}
.sch-access-chip{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:200px;border:0;border-radius:var(--dsw-radius-sm);background:none;padding:0 6px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sch-access-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sch-access-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.sch-access-chip:disabled{opacity:.55;cursor:default}
.sch-access-glyph{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.sch-access-menu{position:absolute;z-index:20;left:0;bottom:calc(100% + 6px);display:flex;flex-direction:column;min-width:160px;padding:4px;border:.5px solid var(--dsw-alias-border-l1,transparent);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1e1e21);box-shadow:0 8px 24px #000a}
.sch-access-item{border:0;background:none;padding:5px 8px;border-radius:6px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);text-align:left;cursor:pointer;white-space:nowrap}
.sch-access-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sch-access-error{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`
