# Upstream issue draft: one invalid stored session disables `session_search` for every session

> Draft only — **not filed**. Target: DeepSeek Harness, packages `@deepseek-ai/dsh-session-query-sqlite` / `@deepseek-ai/dsh-experimental-session-search`.

**Title:** `fix(session-query-sqlite): one stored session that fails replay validation makes every search fail with SESSION_QUERY_PERSISTENCE_FAILED`

## Summary

When the full-text index first opens (`openAt: first-search`), it observes the whole persisted corpus. If **any one** stored session fails replay validation, the whole observation throws `SESSION_QUERY_PERSISTENCE_FAILED`. Every `session_search` and `session_event_search` call then reports "session history storage is unavailable", even for sessions that are perfectly readable.

The failure is persistent: it repeats on every search until the offending session directory is removed by hand. Exact single-session reads (`filterEvents`, `readEvent`, `session_event_read`) keep working on the same store. So the data is fine, and only the index's all-or-nothing observation fails.

## Steps to reproduce

Run against an isolated store: `DSH_HOME=/tmp/recall-repro/home`, with JSONL persistence rooted at `$DSH_HOME/sessions`. The script and its output are in `docs/repro/`.

1. Mount `dsh-session-persistence-jsonl`, `dsh-session-query-sqlite` (`path: ':memory:'`, `openAt: 'first-search'`) and `dsh-agent-loop`.
2. Create session `good-1` with one valid user message, then dispose of it.
3. Call `searchSessions({ query: 'hello' })`. It succeeds with 1 result.
4. Create session `old-1` holding one user message whose shape the current replay rejects. The repro writes `{ id, content, source }` without `role`, as an older or buggy writer could leave. Dispose of it.
5. Call `searchSessions({ query: 'hello' })` again.

**Expected:** `good-1` is still found. `old-1` is skipped and reported, for example as a per-session diagnostic.

**Actual:**

```
SESSION_QUERY_PERSISTENCE_FAILED session-search persistence observation failed:
stored session "old-1" failed validation: Error: session event at seq 0 message must have role "user"
```

A `filterEvents` scan of `good-1` on the same store and context still returns its match.

## Where

`dsh-session-query-sqlite/lib/index.js`, `_observeStable` (lines 707–755 in 0.2.2-rc.1). Each cold session runs `readColdSessionLog` → `observeSession` inside one `try`. Any error is rethrown as `SESSION_QUERY_PERSISTENCE_FAILED` for the whole corpus.

## Impact in the field

On a long-lived desktop profile with about 280 session directories, collected across several format versions and interrupted writes, `session_search` and `session_event_search` always fail. A single stale or invalid session is enough. Users have no way to tell which session is to blame from the tool error.

## Suggested fix

- Index every session that validates. Skip and record those that do not, for example in a `diagnostics` list on search results, or with one warning per session id. Don't fail the whole observation.
- Name the offending session id in the tool-facing message, or expose it through a diagnostic API.
- Optionally, retry a skipped session when its persistence `revision` changes.

## Notes

- A session that keeps being written during observation did **not** reproduce the failure in this run; the index stabilized after its one retry. A directory holding a non-log file was skipped without error.
- Versions: `@deepseek-ai/dsh-session-query-sqlite` 0.2.1-rc.5 (where the repro ran), with the same code path read in the 0.2.2-rc.1 sources. Node 26.8.1 with `node:sqlite`.
