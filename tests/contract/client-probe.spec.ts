/**
 * Browser contract (C1-C12, D4-D6, U1-U5 in docs/dsh-adapter.md): DSH's client bundles still
 * contain every service member, slot, attribute, resource address and theme token the browser
 * half uses. These are source probes over the published packages of the DSH version under test
 * (scripts/fetch-dsh.mjs): a hit does not prove the meaning is unchanged, but a miss means it broke.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG_EVENTS, CHAT_FLOW_KINDS, SEL, SLOT, SUBAGENT_CHAT_ADDRESS, SUBAGENT_CHAT_KIND } from '../../src/dsh/client/index.js'
import { fetched, ownFile, probesAvailable, ROOT } from './probe.js'

const attribute = (selector: string): string => /\[([a-z-]+)/u.exec(selector)![1]!

describe.runIf(probesAvailable())('DSH client bundles', () => {
  const sidebar = () => fetched('dsh-client-ui-sidebar-right')
  const shell = () => fetched('dsh-web-frontend')

  it('C5/C6: the right sidebar still has its layout, gestures and open options', () => {
    const code = sidebar()
    for (const member of ['mountedSurface', 'actionsFor', 'dropTab', 'placeTab', 'resizeSplit', 'openTab', 'openResource', 'toggleExpanded', 'isExpanded', 'revealIfOpened', 'preferNewPane']) {
      expect(code, member).toContain(member)
    }
  })

  it('C3/C4: tab types still take keepMounted, and the native chat is the subagentchat type', () => {
    expect(sidebar()).toContain('keepMounted')
    expect(fetched('dsh-client-ui-subagent')).toContain(`kind: "${SUBAGENT_CHAT_KIND}"`)
  })

  it('D4: the native subagent chat is still addressed as the plugin builds it', () => {
    const code = fetched('dsh-client-ui-subagent')
    expect(code).toContain(`"${SUBAGENT_CHAT_ADDRESS}"`)
    expect(code).toMatch(/parent: address\.parentSessionId,\s*mode: address\.mode/u)
    expect(code).toContain('mode !== "continuable"')
  })

  it('C7/C8: the session controller still answers subagent addresses and projection faces', () => {
    const code = fetched('dsh-api-session-controller')
    expect(code).toMatch(/subagentAddress\(sessionId\)\s*\{/u)
    expect(code).toContain('faceOf')
    expect(code).toMatch(/binding\(/u)
  })

  it('C13: the composer still lists models from the modelDirectories catalog store, reloaded on the same Host events', () => {
    const code = fetched('dsh-client-ui-model-selection')
    // The service the plugin reads, and its one shared catalog.
    expect(code).toMatch(/super\(ctx, "modelDirectories"\)/u)
    expect(code).toMatch(/this\.catalog = new ModelCatalogDirectory\(/u)
    // A snapshot store of { value, status, error }, value being the modelCatalog() answer.
    expect(code).toMatch(/store = \(0, [\w$]+\.createSnapshotStore\)\(\{\s*value: null,\s*status: "idle",\s*error: null/u)
    expect(code).toMatch(/load\(\) \{[\s\S]{0,600}this\.ctx\.remote\.session\.modelCatalog\(\)/u)
    // The composer's own seat renders that store, so the two stay one source.
    expect(code).toContain('directory: directory.store')
    for (const event of CATALOG_EVENTS) expect(code, event).toMatch(new RegExp(`\\$on\\("${event}", \\(\\) => \\{\\s*this\\.catalog\\.refresh\\(\\)`, 'u'))
  })

  it('C12: Session status rows still carry running and pendingInteraction', () => {
    const code = fetched('dsh-client-ui-conversation')
    expect(code).toContain('useSessionStatus')
    expect(code).toContain('pendingInteraction')
  })

  it('C2: every seat the plugin fills is still declared', () => {
    const where: Record<keyof typeof SLOT, string> = {
      chatNode: 'dsh-client-ui-chat',
      paneTab: 'dsh-client-ui-sidebar-right',
      inputLeft: 'dsh-client-ui-conversation',
      inputRight: 'dsh-client-ui-conversation',
      assistantActions: 'dsh-client-ui-chat',
      bundleConfig: 'dsh-client-ui-plugin-manager',
    }
    for (const [slot, pkg] of Object.entries(where)) expect(fetched(pkg), slot).toContain(SLOT[slot as keyof typeof SLOT])
    // The answer strip is a per-Session list the turn tail renders with the answer's messageId.
    const chat = fetched('dsh-client-ui-chat')
    expect(chat).toMatch(/"conversation\.chat\.assistant-actions": \{\s*kind: "list",\s*scope: "session"/u)
    expect(chat).toContain('renderSlot("conversation.chat.assistant-actions", { messageId })')
  })

  it('U1-U4: every DOM attribute the plugin reads or styles is still rendered', () => {
    expect(fetched('dsh-client-ui-sidebar-right')).toContain(attribute(SEL.sidebarSession))
    expect(shell()).toContain(attribute(SEL.dockPane))
    expect(shell()).toContain(attribute(SEL.stripTabs))
    expect(shell()).toMatch(/role: ?"tab"/u)
    expect(shell()).toContain('aria-selected')
    expect(fetched('dsh-client-ui-conversation')).toContain(attribute(SEL.composerCard))
    const chat = fetched('dsh-client-ui-chat')
    expect(chat).toContain('data-chat-flow-kind')
    for (const kind of CHAT_FLOW_KINDS) expect(chat, kind).toContain(kind)
  })

  it('U5: every theme token in the plugin\'s CSS is still defined by DSH', () => {
    const files = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|css)$/u.test(e.name) ? [join(dir, e.name)] : [])
    const used = new Set(files('src/client').concat(files('src/dsh/client')).flatMap(f => ownFile(f).match(/--dsw-[a-z0-9-]+/gu) ?? []))
    const host = ['dsh-web-frontend', 'dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-client-ui-sidebar-right'].map(fetched).join('\n')
    const missing = [...used].filter(token => !host.includes(token))
    expect(missing).toEqual([])
  })
})
