# Upstream draft: a subagent chat cannot switch its own permission preset

Status: draft, not filed. Applies to DSH 0.2.1-rc.5 and 0.2.2-rc.1.

## Summary

In the Web GUI, the composer's permission picker is shown in a subagent ("addressed child")
chat, but choosing a preset does nothing: no error, no change, and the control keeps reading
`Custom`. Delegated children also always run under the approval policy `never`, which matches no
configured preset, so `Custom` is the only label they ever get.

## Steps to reproduce

1. Ask the lead to create a worker (`agent_create`) and open the worker's chat from the right
   sidebar (the `subagentchat` resource).
2. In that chat's footer, click the permission control and choose **Full access** (or any preset).
3. Nothing changes; the control still shows `Custom`/the previous label. The main session's own
   picker still works.

## Expected

The child Session switches to the chosen preset (its own log records `permission/preset` and the
changed knobs), or the control is hidden/disabled with an explanation. If `never`-pinned children
are intentional, the picker should not present itself as switchable state.

## Why it happens

- `@deepseek-ai/dsh-client-ui-permission-presets` `PermissionSelect` submits a pick by calling
  `live.command('/permission <preset>')` on `sessions.binding(sessionId)?.session`, and throws
  `this session is not materialized yet` when there is no binding. The rejection is swallowed by
  `submit()` (`select(id).catch(() => false)`), so the UI stays silent.
- `@deepseek-ai/dsh-client-ui-subagent` opens a child chat as a retained resource
  (`sessions.retain(reference)` with a `subagentchat` resource address), which is not a bound
  top-level Session; there is no binding for it, so the write path is unreachable.
- `@deepseek-ai/dsh-subagent` `captureDelegatedPolicyOverrides` pins `approvalPolicy: 'never'`
  for every delegated child and inherits only an explicit parent sandbox override, so the child's
  (sandbox, approval) pair usually matches no preset; `PermissionPresetService.current()` then
  derives the reserved `custom` label, which is display-only and never a select target.

## Possible fixes

- Give an addressed child Session a command binding (or a session-scoped command endpoint) so
  `/permission` can run against it from its composer, with the same durable write path.
- Alternatively, hide the permission seat for sessions whose composer cannot run commands, or
  show it read-only with a reason.
- Optionally, record an explicit preset identity for delegated children (for example the parent's
  effective preset with `never` approval as a real, selectable `delegated` entry), instead of
  leaving them on `custom`.

## Context

Found while building `dsh-agent-scheduler`'s worker access modes; the plugin works around it by
running `/agent-access` in the main Session from its own footer chip, and by giving a new worker
the lead's current preset so it no longer reads `Custom`.
