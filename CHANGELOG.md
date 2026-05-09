# Changelog

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
