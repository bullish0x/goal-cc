# Contributing

Thanks for helping make `/goal` more reliable. This repo is small on purpose:
one Claude Code project command, one Stop hook, one helper script, and tests.

## Local Setup

Use Node 18 or newer for the test suite:

```bash
npm test
```

The runtime helper should remain compatible with Node 12.22+ because Claude
Code may execute project commands in older environments. In
`.claude/scripts/goal-helper.mjs`, avoid:

- Optional chaining (`?.`)
- Nullish coalescing (`??`)
- `crypto.randomUUID()`

The tests include a syntax and compatibility guard for this.

## Pull Requests

Good PRs usually include:

- A focused behavior change or documentation improvement.
- Tests for helper behavior, especially parsing, locking, state migration, or
  Stop-hook continuation.
- A short note about manual smoke testing when shell quoting or Claude Code
  command wiring changes.

Please keep runtime state out of commits. `goal-state/goals.json`, lock files,
temporary files, and corrupt quarantines are ignored intentionally.

## Design Principles

- One active goal per session unless the caller explicitly scopes sessions with
  `CLAUDE_GOAL_SESSION_ID`.
- State should be durable, inspectable JSON.
- Stop-hook continuation must never loop forever on refusals or hard blockers.
- Shell-facing command invocation must treat user objective text literally.
- The project command should be easy to copy into an existing Claude Code repo.

