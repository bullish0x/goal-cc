# Go-To-Market Notes

## Positioning

`/goal` is a tiny Claude Code add-on for long-running work. It gives an agent a
durable objective, progress controls, a Stop-hook continuation guard, and a
completion audit so work ends because it is actually done.

## Audience

- Developers who use Claude Code for multi-step repo work.
- Teams that want lightweight guardrails without adopting a task tracker.
- Open-source maintainers who want clearer agent work sessions.

## Launch Checklist

1. Tag `v0.1.0`.
2. Publish the public repo at `https://github.com/bullish0x/goal-cc`.
3. Confirm README install instructions work from a fresh clone.
4. Share a short demo:
   - Set a goal with a token budget.
   - Add a note.
   - Show Stop-hook continuation.
   - Complete after the audit.
5. Invite issues and PRs for shell support, docs, and integration testing.

## First Contribution Areas

- More shell smoke tests.
- Windows-specific Claude Code install notes.
- Examples for teams using one repo with multiple concurrent sessions.
- Additional regression cases around Stop-hook payloads.

