/**
 * Command menu contract (C14 in docs/dsh-adapter.md): what the composer's `/` menu shows for a
 * plugin command, in the DSH version under test. The host descriptor carries a name, a
 * description and an argument hint, nothing else; the client gives a title and an icon only to
 * DSH's own commands (by definition id) and shows every other row's host description as is. The
 * plugin therefore writes its title into the description and registers again on a language change.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { setup, teardown } from '../support/harness.js'
import { textResponse } from '../support/mock-adapter.js'
import { fetched, probesAvailable } from './probe.js'

afterEach(teardown)

describe('host command descriptors', () => {
  it('keep only definitionId, name, description and input: no title or icon field', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    ctx.commands.register({ definitionId: 'probe/x' as never, name: 'probe-x', description: 'd', input: { hint: 'h' }, label: 'L', icon: 'I', hidden: true, handler: () => ({ kind: 'success', text: '' }) } as never)
    const row = ctx.commands.list(lead).find(d => d.name === 'probe-x')!
    expect(Object.keys(row).sort()).toEqual(['definitionId', 'description', 'input', 'name'])
  })

  it('register returns a disposer, and both registering and removing announce commands/change', async () => {
    const { ctx, lead } = await setup(() => textResponse('X'))
    await ctx.plugin(CommandRuntime)
    let changes = 0
    ctx.on('commands/change' as never, (() => { changes += 1 }) as never)
    const def = { definitionId: 'probe/y' as never, name: 'probe-y', description: 'one', handler: () => ({ kind: 'success' as const, text: '' }) }
    const dispose = ctx.commands.register(def) as unknown as () => void
    expect(typeof dispose).toBe('function')
    // A second registration of the same name in the same layer is refused: the old one goes first.
    expect(() => ctx.commands.register({ ...def, description: 'two' })).toThrow()
    const before = changes
    dispose()
    ctx.commands.register({ ...def, description: 'two' })
    expect(changes).toBeGreaterThanOrEqual(before + 2)
    expect(ctx.commands.list(lead).find(d => d.name === 'probe-y')?.description).toBe('two')
  })
})

describe.runIf(probesAvailable())('the composer\'s / menu', () => {
  it('shows a host row\'s own description, a face only for DSH\'s built-ins, and re-reads on commands/change', () => {
    const code = fetched('dsh-client-ui-commands')
    expect(code).toContain('...builtinRowFace(c, this.t) ?? { description: c.description }')
    expect(code).toMatch(/const face = name === void 0 \? void 0 : HOST_FACES\.get\(name\);/u)
    expect(code).toContain('ctx.remote.$on("commands/change"')
    expect(code).toMatch(/invalidateAll\(\) \{/u)
    // A row is its label (absent for plugin rows, so the name), then its description.
    expect(fetched('dsh-client-ui-input-trigger')).toContain('children: item.label ?? item.name')
  })
})
