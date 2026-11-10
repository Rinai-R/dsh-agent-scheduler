<!-- Draft only. Not filed. The user decides whether to open it on the DSH repository. -->

# feat(agent-team): let a host decide which sessions may lead a team

## Summary

`dsh-experimental-agent-team` decides who leads a team in one private method, `TeamRoster.tryMembership`. Any session that carries a `subagent/descriptor` resolves as *no member*: it can neither lead a team nor receive the team tools. A plugin that runs long-lived continuable children cannot let those children form their own teams without patching that private method. Please expose a supported way to make that decision.

## Motivation

[dsh-agent-scheduler](https://github.com/dsh-labs/dsh-agent-scheduler) runs long-lived **workers**. Each worker is a continuable direct child of the main session, has its own conversation and its own git worktree, and is given requests by the lead. Users want every worker to be able to act as a team lead: spawn teammates, share a task board, and message them, while the worker still reports a single summary back to its own lead.

Today this is blocked by:

- `dsh-experimental-agent-team/lib/index.js`, `TeamRoster.tryMembership` (0.2.2-rc.1, around lines 873-905). A child that is not in its root's roster and has a subagent descriptor returns `undefined`. Only sessions with no descriptor resolve as `lead`.
- `dsh-experimental-tool-agent-team/lib/index.js`, `apply`/`maybeInstall` (around lines 538-545). Tools are installed only where `ctx.agentTeams.tryMembership(agent)` is defined.

Depth is not the obstacle. `spawnTeammate` calls `ctx.subagents.startActivation` without `maxDepth`, and `resolveChildDepth` only enforces a cap when the request names one.

To ship this, we currently wrap `ctx.agentTeams.roster.tryMembership` at run time. For our live workers only, the wrapper returns `{ root: agent, id: agent.id, role: 'lead', name: 'lead' }`. It works end to end on 0.2.1-rc.5 and 0.2.2-rc.1:

- the worker gets the nine team tools;
- teammates become the worker's children;
- teammate answers return to the worker;
- the roster survives restart.

But it depends on a private field, so any refactor breaks it.

## Proposal

Any one of these would do:

1. **A config option** on `@deepseek-ai/dsh-experimental-agent-team`, e.g. `childLeads: 'none' | 'continuable'` (default `none`). With `continuable`, a continuable child that is not in its parent's roster resolves as the lead of its own team.
2. **An injectable resolver**: `ctx.agentTeams.registerLeadResolver((agent) => boolean)`, returning a disposer. `tryMembership` consults the registered resolvers before returning `undefined` for a child with a descriptor.
3. **A hook event**, e.g. a waterfall `agent-team/membership` with `{ agent, membership }`, so plugins can supply a lead membership for sessions the service would otherwise reject.

Whichever is chosen, the tool plugin should keep using `ctx.agentTeams.tryMembership`, so tools follow the decision automatically.

## Alternatives

- **Make workers top-level sessions** (`sessionController.create`). The worker then lacks a native parent: right-pane chats, fork-from continuation, cascading restart and interrupt are lost. In addition, `sessionController` is only mounted by `dsh-web-app`.
- **Reimplement teams inside the plugin.** This duplicates the roster, task board and messaging, and the result is invisible to the Team UI.
- **Keep the run-time wrapper.** It works, but it is fragile, and other plugins would have to do the same.
