/** Forks route only: every working tool is refused at dispatch, and agent_create can make worktrees. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { setup, teardown } from './support/harness.js'
import { textResponse, toolCallResponse } from './support/mock-adapter.js'
import { body, forksOf, install, leadSaw, listThen, until, user } from './support/scheduler.js'
import { FORK_TOOLS, forkGuard } from '../src/fork-guard.js'
import { FORK_NOTICE } from '../src/scheduler.js'

afterEach(teardown)

const OK = { type: 'object', additionalProperties: true, properties: {} } as const
// Everything here is refused for a fork except the shell: bash/pwsh are allowlisted, and their
// write protection comes from the fork Session being pinned to the read-only sandbox.
const WORKING = ['edit', 'write', 'subagent', 'ask_user_question', 'schedule_create', 'job_list']
/** Stand-ins registered for both the allowed shell and the refused tools. */
const STAND_INS = ['bash', ...WORKING]
/** Stand-ins for the host's working tools: each records that its body ran. */
function workingTools(ran: string[]) {
  return STAND_INS.map(name => defineTool({
    name, description: `${name} stand-in`, parameters: { command: { type: 'string' } },
    output: { schema: OK, render: (_: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] },
    execute: async () => { ran.push(name); return { ok: name } },
  }))
}
const called = (o: GenerateOptions, tool: string) => o.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes(`"name":"${tool}"`))
const isWorker = (o: GenerateOptions) => body(o).includes('You are worker')

describe('fork guard', () => {
  it('refuses a fork every working tool but its read-only shell; it still routes; the lead and workers keep every tool', async () => {
    const ran: string[] = []
    let leadBash = false
    const { ctx, lead, adapter } = await setup(o => {
      if (o.sessionId === 'lead') {
        if (!leadBash) { leadBash = true; return toolCallResponse('l1', 'bash', { command: 'echo lead' }) }
        return textResponse('LEAD')
      }
      if (isWorker(o)) return called(o, 'bash') ? textResponse('WORKER DONE') : toolCallResponse('w1', 'bash', { command: 'npm run build' })
      // The fork triages with the shell (allowed), then tries every refused tool.
      // The lead's own bash call is in the inherited log; look for this call's command instead.
      if (!JSON.stringify(o.messages).includes('git log --oneline -5')) return toolCallResponse('f-bash', 'bash', { command: 'git log --oneline -5' })
      for (const tool of WORKING) if (!JSON.stringify(o.messages).includes(`"f-${tool}"`)) return toolCallResponse(`f-${tool}`, tool, { command: 'git push' })
      if (!called(o, 'agent_create')) return listThen(o, 'f-create', 'agent_create', { name: 'builder', role: 'builds', task: 'run the build' })
      return textResponse('FORK CONCLUSION: handed to builder')
    })
    for (const tool of workingTools(ran)) ctx.tools.register(tool)
    const scheduler = install(ctx, { defaultOn: false })
    // Scheduling off: the lead is an ordinary chat and its tools run.
    lead.followup(user('plain'))
    await vi.waitFor(async () => { await lead.whenIdle(); expect(ran).toEqual(['bash']) })
    scheduler.setMode(lead, true)
    lead.followup(user('continue the fix and push it'))
    await until(lead, '[reply to r-1 from builder')
    const forkId = forksOf(lead)[0]!
    // The fork's shell body ran; no refused tool body did; the worker's bash is in the same list.
    await vi.waitFor(() => { expect(ran.filter(name => name === 'bash')).toHaveLength(3) })
    expect(ran.filter(name => name !== 'bash')).toEqual([])
    expect(scheduler.ledgerOf(lead).find('builder')).toBeDefined()
    const forkReqs = adapter.requests.filter(r => r.sessionId === forkId)
    const lastFork = JSON.stringify(forkReqs.at(-1)!.messages)
    for (const tool of WORKING) expect(lastFork).toContain(`fork-1 is a fork: forks only route, so ${tool} is not available to you`)
    expect(lastFork).not.toContain('so bash is not available')
    expect(leadSaw(lead, 'FORK CONCLUSION: handed to builder')).toBe(1)
    expect(leadSaw(lead, 'WORKER DONE')).toBe(1)
  })

  it('still refuses an archived fork when the user wakes it, and after scheduling is switched off', async () => {
    const ran: string[] = []
    const { ctx, lead } = await setup(o => textResponse(o.sessionId === 'lead' ? 'LEAD' : 'FORK'))
    for (const tool of workingTools(ran)) ctx.tools.register(tool)
    const scheduler = install(ctx)
    lead.followup(user('hello'))
    await until(lead, 'Its conclusion')
    const forkId = forksOf(lead)[0]!
    await vi.waitFor(() => { expect(scheduler.ledgerOf(lead).members.get(forkId)?.state).toBe('archived') })
    scheduler.setMode(lead, false)
    const fork = { id: forkId, session: { header: { parentSession: lead.id } } } as never
    expect(scheduler.forkNameOf(fork)).toBe('fork-1')
    const guard = forkGuard(agent => scheduler.forkNameOf(agent))
    for (const tool of ['edit', 'agent_model', 'agent_access', 'schedule_create', 'job_kill']) expect(guard({ name: tool, agent: fork })).toContain(`so ${tool} is not available`)
    expect(guard({ name: 'bash', agent: fork })).toBeUndefined()
    expect(guard({ name: 'pwsh', agent: fork })).toBeUndefined()
    expect(guard({ name: 'agent_send', agent: fork })).toBeUndefined()
    // The lead and ordinary agents are never refused.
    expect(guard({ name: 'bash', agent: lead })).toBeUndefined()
    expect(guard({ name: 'bash', agent: { id: 'other', session: { header: { parentSession: lead.id } } } as never })).toBeUndefined()
    // A child of a main Session this process does not hold is left alone, and no empty ledger is cached for it.
    expect(scheduler.forkNameOf({ id: 'x', session: { header: { parentSession: 'gone' } } } as never)).toBeUndefined()
    // A subagent of the fork itself (parent: the fork, not a main Session) is not looked up either.
    expect(scheduler.forkNameOf({ id: 'y', session: { header: { parentSession: forkId } } } as never)).toBeUndefined()
  })

  it('allows only reading and routing tools', () => {
    for (const tool of ['agent_list', 'agent_send', 'agent_create', 'agent_recall', 'agent_interrupt', 'agent_archive', 'role_set', 'report', 'read', 'grep', 'glob', 'read_image', 'web_fetch', 'bash', 'pwsh', 'session_search', 'get_goal', 'skill', 'run_code']) expect(FORK_TOOLS.has(tool)).toBe(true)
    for (const tool of ['edit', 'write', 'apply_patch', 'str_replace_editor', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'list_agents', 'remote_send_message', 'create_goal', 'schedule_create', 'job_list', 'ask_user_question', 'agent_model', 'agent_access', 'present', 'todo_write', 'cua_driver_native__click', 'some_new_tool']) expect(FORK_TOOLS.has(tool)).toBe(false)
  })

  it('the fork notice forbids work outright and overrides the runtime\'s "carry out the work directly"', () => {
    expect(FORK_NOTICE).toContain('Never do the work yourself')
    expect(FORK_NOTICE).toContain('read-only shell')
    expect(FORK_NOTICE).toContain('file access denied under read-only mode')
    expect(FORK_NOTICE).toContain('it does not apply to you')
    expect(FORK_NOTICE).toContain('say in your conclusion what could not be handed over')
    expect(FORK_NOTICE).not.toContain('git worktree add')
  })
})

describe('agent_create worktrees', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sched-repo-'))
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'a')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    return dir
  }

  it('creates the worker\'s new worktree on a new branch, so a fork needs no shell', async () => {
    const { ctx, lead } = await setup(() => textResponse('OK'))
    const scheduler = install(ctx)
    const checkout = repo()
    const cwd = join(mkdtempSync(join(tmpdir(), 'sched-wt-')), 'repo__feat')
    const create = ctx.tools.get('agent_create', lead)!
    const exec = { agent: lead, signal: new AbortController().signal } as never
    // The tool's own lock, version and for rules are covered in dispatch-lock.spec.ts; call the scheduler directly.
    const make = (name: string, dir: string, branch: string) => scheduler.createWorker(lead, { name, role: 'r', cwd: dir, worktree: { repo: checkout, branch, base: 'main' } })
    await make('feat', cwd, 'feat/x')
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
    expect(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/x')
    expect(scheduler.ledgerOf(lead).find('feat')).toMatchObject({ cwd })
    // An existing directory is never reused, and git's refusal is reported as is.
    await expect(make('feat2', cwd, 'feat/y')).rejects.toThrow(/already exists|already works/)
    await expect(make('feat3', `${cwd}-2`, 'feat/x')).rejects.toThrow(/git worktree add failed/)
    await expect(create.execute({ name: 'feat4', role: 'r', cwd: `${cwd}-3`, repo: checkout }, exec)).rejects.toThrow(/go together/)
    expect(scheduler.ledgerOf(lead).find('feat3')).toBeUndefined()
  })
})
