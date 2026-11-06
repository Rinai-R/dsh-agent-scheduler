/**
 * The adapter boundary: outside src/dsh, nothing imports a DSH package or names DSH's DOM.
 * Everything that would break when DSH changes is then in src/dsh, where the contract tests point.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownFile, ROOT } from './probe.js'

const sources = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/u.test(e.name) ? [join(dir, e.name)] : [])

const business = sources('src').filter(f => !f.startsWith(join('src', 'dsh')))

describe('adapter boundary', () => {
  it('only src/dsh imports @deepseek-ai/dsh-* packages or extends their declarations', () => {
    const offenders = business.filter(f => /from '@deepseek-ai\/dsh-|import\('@deepseek-ai\/dsh-|declare module '@deepseek-ai\/dsh-/u.test(ownFile(f)))
    expect(offenders).toEqual([])
  })

  it('only src/dsh names DSH\'s DOM attributes, resource addresses and service members', () => {
    const host = /data-dockkit-|data-sidebar-right-|data-chat-flow-kind|data-composer-card|dsh-resource:\/\/|'subagentchat'|\.sidebarRightTabs\b|\.uiConversation\b|\.remote\.(commands|session)\b|subagentAddress\?\.|\.faceOf\b|mountedSurface\?\.\(|actionsFor\?\.\(|\.slots\.(inject|register)\b/u
    const offenders = business.flatMap(f => ownFile(f).split('\n').map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => !/^\s*(\*|\/\/)/u.test(line) && host.test(line)))
      .map(({ f, i, line }) => `${f}:${i}: ${line.trim().slice(0, 100)}`)
    expect(offenders).toEqual([])
  })

  it('only the session-query adapters read session history', () => {
    const all = sources('src').filter(f => !/(session-query|services)\.ts$/u.test(f))
    const offenders = all.filter(f => ownFile(f).split('\n').some(line => !/^\s*(\*|\/\/)/u.test(line) && /\.sessionQuery\b|\b(filterEvents|readEvent|searchEvents|observeSession)\(/u.test(line)))
    expect(offenders).toEqual([])
  })

  it('only the Agent Teams adapter touches Agent Teams', () => {
    const all = sources('src').filter(f => !/agent-team\.ts$/u.test(f))
    const offenders = all.filter(f => ownFile(f).split('\n').some(line => !/^\s*(\*|\/\/)/u.test(line) && /\.agentTeams\b|'agentTeams'|dsh-experimental-|\.roster\.tryMembership/u.test(line)))
    expect(offenders).toEqual([])
  })
})
