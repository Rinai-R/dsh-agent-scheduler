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
      brandName: 'dsh-client-ui-sidebar',
      workspaces: 'dsh-client-ui-sidebar',
      sessionRowAction: 'dsh-client-ui-workspace',
    }
    for (const [slot, pkg] of Object.entries(where)) expect(fetched(pkg), slot).toContain(SLOT[slot as keyof typeof SLOT])
    // The answer strip is a per-Session list the turn tail renders with the answer's messageId.
    const chat = fetched('dsh-client-ui-chat')
    expect(chat).toMatch(/"conversation\.chat\.assistant-actions": \{\s*kind: "list",\s*scope: "session"/u)
    expect(chat).toContain('renderSlot("conversation.chat.assistant-actions", { messageId })')
    // The header brand name and the browsing region are root single slots; the deck swaps the
    // second one in place and uses the first for its switch.
    const sidebar = fetched('dsh-client-ui-sidebar')
    expect(sidebar).toMatch(/"sidebar\.brand\.name": \{\s*kind: "single",\s*scope: "root"/u)
    expect(sidebar).toMatch(/"sidebar\.workspaces": \{\s*kind: "single",\s*scope: "root"/u)
    expect(sidebar).toContain('renderSlot("sidebar.brand.name"')
    expect(sidebar).toContain('renderSlot("sidebar.workspaces"')
    // The stock occupant: a root single with a row-action LIST, where the shell registers its own
    // pin/archive actions (so a native pin already exists in 工作区 mode).
    const workspace = fetched('dsh-client-ui-workspace')
    expect(workspace).toMatch(/inject\("sidebar\.workspaces", \(\) => ctx\.slots\.register\(\{\s*name: "sidebar\.workspaces"/u)
    expect(workspace).toMatch(/"sidebar\.workspaces\.session\.row\.action": \{\s*kind: "list",\s*scope: "root"/u)
    expect(workspace).toMatch(/name: "sidebar\.workspaces\.session\.row\.action",\s*id: "pin"/u)
  })

  it('C14: a single slot renders its first live entry in priority order, so a -1 registration shadows it', () => {
    // The outlet lives in the renderer package; the registry (sort + first-live-wins) is bundled
    // into the web frontend, so both are probed.
    const renderer = fetched('dsh-client-ui-renderer')
    expect(renderer).toMatch(/spec\.kind === "single"/u)
    expect(renderer).toMatch(/const entry = host\.entriesOfSlot\(slotKey\)\[0\]/u)
    const core = fetched('dsh-web-frontend')
    // Registration sorts entries ascending by priority (default 0): a dynamic -1 wins the cell.
    expect(core).toMatch(/\.sort\([^;]{0,220}?options\.priority\?\?0\)-(\([a-z]\.options\.priority\?\?0\))/u)
    // Winning per cell skips abdicated entries and keeps the first remaining one, and for a single
    // slot every entry shares the same (undefined) cell key, so exactly one renders.
    expect(core).toMatch(/entriesOfSlot\([a-z]\)\{const [a-z]=this\.records\.get\([a-z]\)/u)
    expect(core).toContain('this.abdicated.has(')
    expect(core).toMatch(/r==="keyed"\?[a-z]\.options\.key:r==="list"\?[a-z]\.options\.id:void 0/u)
  })

  it('C15: the brand row: official wordmark occupant, local-build fallback only without one, shared primitives', () => {
    const brand = fetched('dsh-client-ui-brand-official')
    // The official package fills both brand seats; the name is the wordmark without its mark.
    expect(brand).toContain('require("@deepseek-ai/dsh-client-ui-primitives")')
    expect(brand).toMatch(/BrandWordmark, \{ includeMark: false \}/u)
    expect(brand).toMatch(/register\(\{ name: "sidebar\.brand\.name" \}, OfficialBrandName\)/u)
    const sidebar = fetched('dsh-client-ui-sidebar')
    // The local-build path is the slot FALLBACK: an occupant replaces it, which is why the deck only
    // occupies the seat beside an official occupant.
    expect(sidebar).toMatch(/renderSlot\("sidebar\.brand\.name", \{\}, \{ fallback: buildVersion === void 0/u)
    // The brand row is a new-session button around an aria-hidden identity. Next ignores clicks
    // inside [data-copy-version]; pinned calls openNewSession directly, so the toggle must stop
    // propagation itself (it does both).
    expect(sidebar).toMatch(/className: SidebarRoot_module_css_default\.brandIdentity,\s*"aria-hidden": "true"/u)
    expect(sidebar).toMatch(/if \(event\.target\.closest\("\[data-copy-version\]"\) !== null\) return;\s*openNewSession\(\)|onClick: openNewSession,\s*children: identity/u)
    // The workspace browser receives { wide, expandSidebar } like the stock tree.
    expect(sidebar).toMatch(/renderSlot\("sidebar\.workspaces", \{\s*wide,\s*expandSidebar/u)
    // The primitives are a shared loader module, with the wordmark and the icons the deck uses.
    const core = fetched('dsh-web-frontend')
    expect(core).toContain('"@deepseek-ai/dsh-client-ui-primitives":')
    for (const name of ['BrandWordmark:', 'IconSearchOutlineRegular:', 'IconChevronRightOutlineRegular:', 'IconPinFillRegular:']) expect(core, name).toContain(name)
  })

  it('C13: the config-forms surface still serves a namespace form to a bundle page', () => {
    const code = fetched('dsh-client-ui-settings')
    expect(code).toContain('configForms')
    expect(code).toMatch(/whileServed\(/u)
    const pluginManager = fetched('dsh-client-ui-plugin-manager')
    expect(pluginManager).toMatch(/"plugins\.bundle\.config": \{\s*kind: "keyed",\s*scope: "root"/u)
    expect(pluginManager).toContain('renderSlot("plugins.bundle.config", { view: "page" }')
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
