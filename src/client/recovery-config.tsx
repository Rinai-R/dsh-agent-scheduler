/**
 * The bundle's configuration page on the Plugins page: the restart-recovery option of the host
 * row `dsh-agent-scheduler`. The page renders `plugins.bundle.config` keyed by the package name
 * (a bundle that registers nothing shows no form there). Values are read and written through
 * the shared `configForms` service, which goes through the Host settings service: only the
 * host row's volatile fields are editable there, which is why the option lives on that row.
 */
import { useEffect, useState } from 'react'

/** The host row id in cordis.patch.yml, which is also its settings namespace. */
export const HOST_NS = 'dsh-agent-scheduler'
const PACKAGE = 'dsh-agent-scheduler'

type Mode = 'fail' | 'resume'
interface Recovery { onInterrupted?: Mode; maxResumes?: number }
interface Snapshot { status: string; value?: { recovery?: Recovery }; writable: boolean }
interface Form {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<boolean>
}

const CSS = `
.sch-rc{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px}
.sch-rc h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sch-rc p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.sch-rc-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25));cursor:pointer}
.sch-rc-opt[data-on=yes]{border-color:var(--dsw-alias-accent,#4d6bfe)}
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
  const snapshot = useSnapshot(props.form)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  if (snapshot.status !== 'ready') return <div className="sch-rc"><p>正在读取配置…</p></div>
  const recovery = snapshot.value?.recovery ?? {}
  const mode: Mode = recovery.onInterrupted === 'resume' ? 'resume' : 'fail'
  const max = typeof recovery.maxResumes === 'number' ? recovery.maxResumes : 2
  const write = (path: string, value: unknown) => {
    setSaving(true)
    setFailed(false)
    void props.form.mutate([{ op: 'set', path: ['recovery', path], value }]).then(ok => { setFailed(!ok) }, () => { setFailed(true) }).finally(() => { setSaving(false) })
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
      <h3>DSH 重启后，被打断的工作</h3>
      {option('fail', '判失败，交给 lead（默认）', '重启时还没做完的请求记为失败，lead 收到「r-N 给 X 的请求因 DSH 重启中断，未完成」，由 lead 决定是否重派。重启后不会自动调用模型。')}
      {option('resume', '在原会话里续跑', '给 worker 原会话补一条提示：先检查 worktree 和 git 状态，不要重复已对外做过的操作，再把这个请求做完。请求保持未完成。重启后会自动唤醒 worker，消耗 token。')}
      <div className="sch-rc-row">
        <span>每个请求最多续跑</span>
        <input type="number" min={0} max={10} value={max} disabled={disabled || mode !== 'resume'} onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 0 && n <= 10) write('maxResumes', n) }} />
        <span>次，超过就按「判失败」处理</span>
      </div>
      <p className="sch-rc-note">分身被打断时总是判失败（分身只负责派活）。{snapshot.writable ? '' : '当前 profile 不可写，无法修改。'}{failed ? '保存失败，请重试。' : ''}</p>
    </div>
  )
}

/**
 * Register the page while the Host serves the host row's settings.
 * @param ctx - the browser plugin context.
 */
export function registerRecoveryConfig(ctx: any): void {
  // Optional: a deployment without the settings client simply has no page, and a failure here
  // must not stop the rest of the browser half from mounting.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['configForms', 'slots'], (scoped: any) => {
    const form = scoped.configForms.get(HOST_NS) as Form
    scoped.effect(() => scoped.configForms.whileServed([HOST_NS], () => scoped.slots.inject('plugins.bundle.config', () => scoped.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE,
    }, ({ view }: { view?: string }) => view === 'summary' ? null : <RecoveryPage form={form} />))), 'agent-scheduler: recovery config page')
  })
}
