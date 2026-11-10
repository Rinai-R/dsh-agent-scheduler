/**
 * The bundle's configuration page on the Plugins page: the restart-recovery option of the host
 * row `dsh-agent-scheduler`. The page renders `plugins.bundle.config` keyed by the package name
 * (a bundle that registers nothing shows no form there). Values are read and written through
 * the shared `configForms` service, which goes through the Host settings service: only the
 * host row's volatile fields are editable there, which is why the option lives on that row.
 */
import { useEffect, useState } from 'react'
import { configPage, type ConfigForm } from '../dsh/client/ui.js'
import { t, useLocale } from './i18n.js'

/** The host row id in cordis.patch.yml, which is also its settings namespace. */
export const HOST_NS = 'dsh-agent-scheduler'
const PACKAGE = 'dsh-agent-scheduler'

type Mode = 'fail' | 'resume'
interface Recovery { onInterrupted?: Mode; maxResumes?: number }
type Form = ConfigForm<{ recovery?: Recovery; deck?: { enabled?: boolean } }>
type Snapshot = ReturnType<Form['getSnapshot']>

const CSS = `
.sch-rc{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px}
.sch-rc h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sch-rc p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.sch-rc-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));cursor:pointer}
.sch-rc-opt[data-on=yes]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sch-rc-opt input{margin-top:3px}
.sch-rc-opt b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sch-rc-row{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sch-rc-row input{width:64px}
.sch-rc-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}
`

function useSnapshot(form: Form): Snapshot {
  const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
  useEffect(() => form.subscribe(() => { setSnapshot(form.getSnapshot()) }), [form])
  return snapshot
}

function RecoveryPage(props: { form: Form }) {
  useLocale()
  const snapshot = useSnapshot(props.form)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (snapshot.status !== 'ready') return <div className="sch-rc"><p>{t('rc.loading')}</p></div>
  const recovery = snapshot.value?.recovery ?? {}
  const mode: Mode = recovery.onInterrupted === 'resume' ? 'resume' : 'fail'
  const max = typeof recovery.maxResumes === 'number' ? recovery.maxResumes : 2
  const write = (path: string, value: unknown) => {
    setSaving(true)
    setFailed(false)
    void props.form.mutate([{ op: 'set', path: path.includes('.') ? path.split('.') : ['recovery', path], value }]).then(ok => { setFailed(!ok) }, () => { setFailed(true) }).finally(() => { setSaving(false) })
  }
  const disabled = saving || !snapshot.writable
  const option = (value: Mode, title: string, text: string) => (
    <label className="sch-rc-opt" data-on={mode === value ? 'yes' : 'no'} data-scheduler-recovery={value}>
      <input type="radio" name="sch-recovery" checked={mode === value} disabled={disabled} onChange={() => { write('onInterrupted', value) }} />
      <span><b>{title}</b><p>{text}</p></span>
    </label>
  )
  return (
    <div className="sch-rc" data-scheduler-recovery-config={mode}>
      <style>{CSS}</style>
      <h3>{t('rc.title')}</h3>
      {option('fail', t('rc.fail.title'), t('rc.fail.text'))}
      {option('resume', t('rc.resume.title'), t('rc.resume.text'))}
      <label className="sch-rc-opt" data-on={snapshot.value?.deck?.enabled === false ? 'no' : 'yes'} data-scheduler-deck-config={snapshot.value?.deck?.enabled === false ? 'off' : 'on'}>
        <input type="checkbox" checked={snapshot.value?.deck?.enabled !== false} disabled={disabled} onChange={event => { write('deck.enabled', event.currentTarget.checked) }} />
        <span><b>{t('cfg.deck.title')}</b><p>{t('cfg.deck.text')}</p></span>
      </label>
      <div className="sch-rc-row">
        <span>{t('rc.max.before')}</span>
        <input type="number" min={0} max={10} value={max} disabled={disabled || mode !== 'resume'} onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 0 && n <= 10) write('maxResumes', n) }} />
        <span>{t('rc.max.after')}</span>
      </div>
      <p className="sch-rc-note">{t('rc.note')}{snapshot.writable ? '' : t('rc.readonly')}{failed ? t('rc.saveFailed') : ''}</p>
    </div>
  )
}

/**
 * Register the page while the Host serves the host row's settings.
 * @param ctx - the browser plugin context.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- host services are untyped at this bundle boundary */
export function registerRecoveryConfig(ctx: any): void {
  // Optional: a deployment without the settings client simply has no page, and a failure here
  // must not stop the rest of the browser half from mounting.
  configPage<{ recovery?: Recovery }>(ctx, HOST_NS, PACKAGE, (form, view) => view === 'summary' ? null : <RecoveryPage form={form} />)
}
