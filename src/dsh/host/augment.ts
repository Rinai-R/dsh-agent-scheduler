/**
 * The plugin's entries in DSH's declaration-merged registries: its plugin record types and its
 * session projection. Kept here so the module paths they extend are named in the adapter only.
 * @module dsh-agent-scheduler/dsh/host/augment
 */
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  AgentRecord, ForkModelRecord, ForkStateRecord, InputRecord, MailRecord, MergeRecord, ModeRecord, RequestRecord, TeamRecord, RoleRecord, SeenRecord, SettledRecord,
} from '../../records.js'
import type { MemberModelRecord } from '../../member-model.js'
import type { MemberAccessRecord } from '../../member-access.js'
import type { Roster, RosterView } from '../../projection.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-agent-scheduler/input': InputRecord
    'plugin:dsh-agent-scheduler/fork-state': ForkStateRecord
    'plugin:dsh-agent-scheduler/fork-model': ForkModelRecord
    'plugin:dsh-agent-scheduler/worker-model': ForkModelRecord
    'plugin:dsh-agent-scheduler/agent': AgentRecord
    'plugin:dsh-agent-scheduler/request': RequestRecord
    'plugin:dsh-agent-scheduler/role': RoleRecord
    'plugin:dsh-agent-scheduler/settled': SettledRecord
    'plugin:dsh-agent-scheduler/mode': ModeRecord
    'plugin:dsh-agent-scheduler/seen': SeenRecord
    'plugin:dsh-agent-scheduler/mail': MailRecord
    'plugin:dsh-agent-scheduler/member-access': MemberAccessRecord
    'plugin:dsh-agent-scheduler/merge': MergeRecord
    'plugin:dsh-agent-scheduler/team': TeamRecord
    'plugin:dsh-agent-scheduler/member-model': MemberModelRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    agentScheduler: RosterView
  }
  interface SessionProjectionStateMap {
    agentScheduler: Roster
  }
}
