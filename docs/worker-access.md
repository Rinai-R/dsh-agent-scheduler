# Worker access modes

A worker's **access mode** is the permission preset it runs under: one sandbox mode plus one
approval policy (`read-only` + `ask`, `workspace-write` + `ask`, `danger-full-access` + `never`, and
whatever a deployment configures). This plugin lets the user and the lead switch it per worker.

## Why a delegated worker used to read `custom`

DSH delegates a child with `captureDelegatedPolicyOverrides` (`@deepseek-ai/dsh-subagent`): it
inherits only the parent's *explicit* sandbox override (never the deployment default) and always
pins the approval policy to `never`, so a reviewer's denials stay final. A worker therefore ran
under the deployment's sandbox mode with approval `never` — a combination no configured preset
bundles, so `PermissionPresetService.current()` derived `custom`, and the composer showed
`Custom`. The worker was never actually restricted to a preset that "wasn't switchable"; it simply
had no preset identity, and the client-side picker has no write path into an addressed child
Session anyway (below).

## What the plugin does

- **Born in the lead's mode.** When a worker is created and has no access record of its own, the
  rule records the lead's *current* preset as `inherited` and applies it to the child Session
  (`permission/preset` plus the two knob events, through `PermissionPresetService.set()`). A later
  switch of the lead's own mode does not move the worker: the inherited value is pinned once.
- **Switch from the worker's own chat footer.** The composer's access chip is the plugin's own
  control (`conversation.input.left`), because DSH's permission picker cannot write an addressed
  child Session (see the upstream draft). It runs `/agent-access <worker> <mode>` in the main
  Session.
- **Switch from the lead side.** `/agent-access <worker> <mode|default>` and, on the Agents page,
  the access row under each worker. `default` means the lead's current mode.
- **Switch from the lead's tools.** `agent_access` takes `{ name, mode, rosterVersion, for }`.
  The lead may narrow a worker, or bring it up to the user's own current mode; anything wider is
  refused with a message telling the lead to ask the user. Approval prompts still reach the user
  when the chosen mode needs them (`ask`); `never` modes still ask nothing.
- **Durable and restored.** One `member-access` plugin record in the main Session's log, folded
  into the roster; applied to the live worker and re-applied every time it is created again
  (host restart, resume after release, wake from archive).
- **Forks carry none.** A fork routes the lead's model and is restricted by the fork tool guard,
  so it has no access mode of its own; both the command and `agent_access` refuse forks, and the
  fork's footer chip is not rendered. The remaining host picker in a fork chat is still shown but
  does nothing — the upstream issue covers it.

## The host limitation

DSH's permission picker (`@deepseek-ai/dsh-client-ui-permission-presets`) submits
`/permission <preset>` through `sessions.binding(sessionId)?.session` and throws `this session is
not materialized yet` for a Session the client store has no binding for; an addressed subagent
chat is opened as a `sessions.retain(reference)` resource (`@deepseek-ai/dsh-client-ui-subagent`),
not a bound top-level Session, and the picker swallows the rejection, so a pick has no effect and
no message. That is why the plugin adds its own chip and a main-Session command. See
`docs/upstream-issue-child-permission.md`.

## Sources

- `dsh-subagent` `captureDelegatedPolicyOverrides` / `appendDelegatedPolicyOverrides`
- `dsh-permission-presets` `current()`, `set()`, `pinInitialPermission()`
- `dsh-client-ui-permission-presets` `submit()` → `live.command('/permission …')`
- `dsh-client-ui-subagent` `subagentChatResourceProvider` / `SidebarChatTab` (retained reference)
