# Goal State Format

The `/goal` command stores deterministic runtime state in `goal-state/goals.json`.

That file is intentionally ignored by git. It contains a JSON object with:

- `version`: state schema version.
- `goals`: active or completed goals keyed by Claude session candidate.
- `history`: archive of completed and cleared goals (newest first, capped at 50).

Mutating commands acquire `goals.json.lock` (an exclusive file created with `O_EXCL`) so concurrent helper invocations cannot lose updates. The lock is released on success or error; if a holder dies abruptly, a stale lock older than 5 seconds is taken over by the next caller after confirming the observed lock file has not changed. Tune via `CLAUDE_GOAL_LOCK_TIMEOUT_MS` and `CLAUDE_GOAL_LOCK_STALE_MS`. Notes per goal are capped at 200 (oldest dropped first).

Each active goal carries `lastActivityAtMs`, refreshed on every mutation (set, note, extend, pause/resume, abort, Stop-hook continuation, `/goal touch`). Status and Stop-hook continuation surface idle time and warn past `CLAUDE_GOAL_IDLE_WARN_SEC` (default 1800s). Read-only commands (`status`, `history`) do NOT bump the heartbeat.

Goal status values are `active`, `paused`, `deadline_limited`,
`budget_limited`, and `complete`.
`deadline_limited` is set by the Stop hook when an active goal's soft deadline
has elapsed; automatic continuation stays off until the user runs
`/goal extend --deadline D`, which adds time and reactivates the same goal.
`budget_limited` is set when the Stop hook can read Claude Code's
`transcript_path` JSONL usage data and observed usage reaches the configured
token budget; automatic continuation stays off until the user runs
`/goal extend --tokens N` with a budget above observed usage. Transcript usage
is stored as a monotonic snapshot (`tokensUsed`, `transcriptUsageTokens`,
`tokenAccountingSource`) so repeated Stop hooks do not double count.

The Stop-hook continuation counter is stored on the active goal. Pausing and resuming does not reset it; clear the goal or raise `CLAUDE_GOAL_MAX_STOP_CONTINUES` if a long-running goal intentionally needs more continuations.

Session identity uses `CLAUDE_GOAL_SESSION_ID`, `CLAUDE_SESSION_ID`, terminal session IDs, then a stable hash of the project directory (`cwd:<hash>`). The fallback is intentionally documented because Claude Code may not expose a stable session id to command subprocesses in every environment. Set `CLAUDE_GOAL_SESSION_ID` to an explicit unique value when running multiple Claude Code sessions in the same directory.

If `goals.json` is unreadable, the helper renames it to `goals.json.corrupt-<timestamp>` and starts with a fresh empty database. Corrupt quarantine files are capped at 10 so long-lived projects do not accumulate unbounded recovery artifacts.

Use the command surface instead of editing state by hand:

```text
/goal <objective>
/goal status
/goal pause
/goal resume
/goal complete
/goal clear
/goal history [N] [--json]
/goal note <text>
/goal extend [--tokens N] [--deadline D]
/goal touch
/goal doctor
/goal abort <reason>
/goal status --json
```

Archived goals carry their outcome (`complete`, `cleared`, or `aborted`), elapsed time, token budget snapshot, copied notes, and (for aborts) the supplied reason.
