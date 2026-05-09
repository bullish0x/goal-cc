# Changelog

## 0.3.1 -- 2026-05-09

- Fixed a Windows-specific race in `withLock` that could drop concurrent state
  mutations. Two failure modes addressed: (1) `writeFileSync({flag:"wx"})` on
  Windows can return `EPERM`/`EBUSY` instead of `EEXIST` when another process
  is concurrently creating or unlinking the lock file -- the helper now treats
  those as contended and retries; (2) the brief window between O_CREAT and the
  write inside `wx` mode briefly exposes an empty lock file to readers, and
  the previous code declared the unparseable content "stale" and unlinked a
  valid lock, letting two writers through and dropping a note. The fix uses
  the lock file's mtime as the staleness tiebreaker when content is
  unreadable, so transient empty reads no longer override a fresh lock.
- Added a regression test (`tests/goal-command.test.mjs`) that hammers the
  helper with 12 concurrent `note` writers and asserts every note persists.

## 0.3.0 -- 2026-05-09

- Added a `/goal doctor` read-only diagnostic command that reports command and
  helper presence, Stop hook count, state file health, lock status, local
  settings presence, and session candidates without mutating goal state.
- Added `deadline_limited` and `budget_limited` statuses. The Stop hook now
  marks goals limited (instead of looping) when a deadline elapses or the
  observed token budget is exhausted; `/goal extend` reactivates a limited
  goal once the relevant limit is raised above current usage.
- Added transcript-backed token accounting. When Claude Code provides a
  Stop-hook `transcript_path`, the helper reads bounded JSONL usage snapshots,
  sums input/cache/output tokens, and stores the largest observed total so
  repeated Stop hooks do not double-count. Status now reports the accounting
  source and any error.
- Hardened the continuation prompt against prompt-injection in objective text.
  Objectives are XML-escaped and wrapped in `<untrusted_objective>` so they
  cannot break out into fake higher-priority tags. The instruction header
  marks the objective as user-provided data, not instructions.
- Tests: extended the suite to 70+ cases covering doctor diagnostics,
  untrusted-objective escaping, deadline-limited and budget-limited
  transitions, transcript accounting, and reactivation via `/goal extend`.

## 0.2.0 -- 2026-05-09

- Added a direct project lifecycle helper (`scripts/goal-lifecycle.mjs`) with
  `npm run goal:install`, `goal:update`, and `goal:uninstall` commands. The
  helper copies the `/goal` command, helper script, and managed `Stop` hook
  into a target project (or removes them) without touching unrelated keys,
  unrelated hooks, or `.claude/settings.local.json`.
- `uninstall` preserves customized command/helper files unless `--force` is
  passed, and removes only the managed Stop hook entry from
  `.claude/settings.json`.
- README: documented the lifecycle helper under a new "Direct project
  lifecycle helper" section.
- SMOKE_TEST: added a "Direct Lifecycle Helper Check" pass with PowerShell
  and Bash flows that verify `settings.local.json` is never modified.
- Tests: extended the suite to cover install, update, and uninstall behaviors
  (settings preservation, customized-file safety, `--force`, and
  `settings.local.json` invariance).

## 0.1.1 -- 2026-05-09

- Clarified project-scoped Claude Code plugin install docs so the in-session
  `/plugin marketplace add` command does not include `--scope project`; the
  project scope is applied on `/plugin install`, with a separate terminal CLI
  example for scoped marketplace declarations.

## 0.1.0 -- 2026-05-09

Initial release.

- `/goal` slash command for starting, pausing, resuming, completing, and
  aborting a durable objective.
- Stop-hook continuation guard with auto-continuation cap and refusal detection.
- Soft token budgets and soft deadlines (active-time-only clock).
- Progress notes (capped at 200 per goal).
- Heartbeat tracking with configurable idle warning.
- Outcome archive with 50-entry history.
- JSON output for scripting (`--json` on status and history).
- File-locked atomic writes for concurrent process safety.
- Legacy state migration, corrupt quarantine pruning, and stale-lock takeover.
- Claude Code plugin packaging (`/plugin install goal@goal-cc`).
- 60+ behavioral tests covering lifecycle, parsing, locking, deadlines, idle
  detection, refusal detection, JSON output, concurrent writes, and state
  migration.
