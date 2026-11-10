/**
 * The one quiet meta line under a worker row: a team count and an access mode, each only when it
 * differs from the default. Keeping this pure makes the row's "default is silent" rule testable
 * without a browser.
 * @module dsh-agent-scheduler/client/row-meta
 */
import { t } from './i18n.js'
import { modeLabel } from './access-picker.js'

/** The permission projection of the Session a roster is drawn in (`{ currentValue }`). */
export interface PermissionView {
  readonly currentValue?: unknown
}

/**
 * The lead's own access mode for one Session, from its own permission projection.
 * @param view - that Session's `permissions` projection view, when it has one.
 * @returns the preset name, or undefined when the Session is on a custom combination.
 */
export const accessDefaultOf = (view: PermissionView | undefined): string | undefined =>
  typeof view?.currentValue === 'string' ? view.currentValue : undefined

/** What a row's meta line needs to know. */
export interface RowMetaInput {
  readonly member: { readonly kind: 'fork' | 'worker'; readonly state: string; readonly accessPreset?: string | undefined }
  /** Members on its team; 0 or undefined means no team. */
  readonly teamMembers?: number | undefined
  /** The lead's own effective access mode: a worker on it shows nothing. */
  readonly accessDefault?: string | undefined
}

/** The meta line's parts, each already localized; both absent = render no meta line at all. */
export interface RowMeta {
  /** e.g. `团队 1`, shown with the expander. */
  readonly team?: string | undefined
  /** The access mode, only when it differs from the lead's own. */
  readonly access?: string | undefined
}

/**
 * A live worker's meta line.
 * @param input - the member, its team size and the lead's access mode.
 * @returns the parts to show; `{}` when the row should stay a single quiet card.
 */
export function rowMeta({ member, teamMembers, accessDefault }: RowMetaInput): RowMeta {
  const team = member.kind === 'worker' && (teamMembers ?? 0) > 0 ? t('row.teamBadge', { count: teamMembers! }) : undefined
  const access = member.kind === 'worker' && member.state !== 'archived' && member.accessPreset !== undefined && member.accessPreset !== accessDefault
    ? modeLabel(member.accessPreset)
    : undefined
  return { ...(team === undefined ? {} : { team }), ...(access === undefined ? {} : { access }) }
}

/**
 * Whether any meta line would be drawn.
 * @param meta - a {@link RowMeta}.
 * @returns true when the row needs the second line.
 */
export const hasMeta = (meta: RowMeta): boolean => meta.team !== undefined || meta.access !== undefined
