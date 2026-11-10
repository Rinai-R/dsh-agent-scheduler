/**
 * Agent Teams on the Agents page: a worker's own team under its row, and the lead's team in a
 * section of its own. Read from the roster projection (the host copies each Team there, see
 * Scheduler.syncTeam); nothing here touches Agent Teams itself.
 * @module dsh-agent-scheduler/client/team
 */
import { useState } from 'react'
import type { TeamView } from '../projection.js'
import { t, tn } from './i18n.js'

const STATUS_ROW: Record<string, string> = { running: 'running', provisioning: 'running', inactive: 'idle', failed: 'failed' }
const TASK_MARK: Record<string, string> = { pending: '○', in_progress: '●', completed: '✓', deleted: '·' }

/**
 * One line summing up a team.
 * @param team - the team.
 * @returns e.g. 「2 个成员 · 任务 3/5」.
 */
export function teamSummary(team: TeamView): string {
  const tasks = team.tasks.filter(x => x.status !== 'deleted')
  const done = tasks.filter(x => x.status === 'completed').length
  return [tn('team.members', team.members.length), ...(tasks.length === 0 ? [] : [t('team.tasks', { done, total: tasks.length })])].join(' · ')
}

/**
 * A team's members and task board.
 * @param props - the team, its Lead's Session id, and how to open a member's chat.
 * @returns the block.
 */
export function TeamBlock(props: { team: TeamView; owner: string; open: (parent: string, child: string) => void }) {
  const [showTasks, setShowTasks] = useState(false)
  const tasks = props.team.tasks.filter(x => x.status !== 'deleted')
  return (
    <div className="sch-team" data-scheduler-team={props.owner}>
      {props.team.members.map(m => {
        const row = STATUS_ROW[m.status] ?? 'idle'
        const task = tasks.find(x => x.owner === m.name && x.status === 'in_progress')
        return (
          <button key={m.id} type="button" className="sch-team-member" data-row={row} title={m.description} onClick={() => { props.open(props.owner, m.id) }}>
            <span className="sch-dot" data-row={row} />
            <span className="sch-team-name">{m.name}</span>
            <span className="sch-team-sub">{task === undefined ? m.description : `${task.id} · ${task.subject}`}</span>
            <span className="sch-team-state">{t(`team.status.${m.status === 'provisioning' ? 'provisioning' : row}` as never)}</span>
          </button>
        )
      })}
      {tasks.length === 0 ? null : (
        <>
          <button type="button" className="sch-team-tasks-fold" aria-expanded={showTasks} onClick={() => { setShowTasks(v => !v) }}>
            ☑ {t('team.board', { count: tasks.length })} {showTasks ? '▾' : '▸'}
          </button>
          {!showTasks ? null : (
            <ol className="sch-team-tasks">
              {tasks.map(x => (
                <li key={x.id} data-status={x.status} title={x.blockedBy.length === 0 ? undefined : t('team.blocked', { ids: x.blockedBy.join(', ') })}>
                  <span className="sch-team-mark">{TASK_MARK[x.status] ?? '○'}</span>
                  <span className="sch-team-task-id">{x.id}</span>
                  <span className="sch-team-task-subject">{x.subject}</span>
                  <span className="sch-team-task-owner">{x.owner ?? (x.blockedBy.length > 0 ? t('team.waiting') : t('team.unclaimed'))}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  )
}

export const TEAM_STYLE = `
.sch-team{margin:0 8px 4px 30px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1,currentColor);display:flex;flex-direction:column;gap:1px}
.sch-team-member{display:grid;grid-template-columns:7px auto minmax(0,1fr) auto;align-items:center;column-gap:8px;border:0;background:none;padding:4px 8px;border-radius:8px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);text-align:left;cursor:pointer}
.sch-team-member:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-team-name{font-weight:500}
.sch-team-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.sch-team-state{color:var(--sch-tone,var(--dsw-alias-label-tertiary))}
.sch-team-tasks-fold{align-self:flex-start;border:0;background:none;padding:3px 8px;border-radius:6px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}
.sch-team-tasks-fold:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sch-team-tasks{list-style:none;margin:0;padding:0 8px 4px;display:flex;flex-direction:column;gap:2px;font:var(--dsw-font-xxs-12)}
.sch-team-tasks li{display:grid;grid-template-columns:12px auto minmax(0,1fr) auto;column-gap:6px;color:var(--dsw-alias-label-secondary)}
.sch-team-tasks li[data-status=completed]{color:var(--dsw-alias-label-tertiary)}
.sch-team-tasks li[data-status=in_progress] .sch-team-mark{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.sch-team-task-id{color:var(--dsw-alias-label-tertiary)}
.sch-team-task-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sch-team-task-owner{color:var(--dsw-alias-label-tertiary)}
.sch-roster-team-toggle{border:0;background:none;padding:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:16px;cursor:pointer;white-space:nowrap;border-radius:4px}
.sch-roster-team-toggle:hover{color:var(--dsw-alias-label-primary)}
.sch-roster-team-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
`
