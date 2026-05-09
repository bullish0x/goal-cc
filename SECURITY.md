# Security Policy

## Supported Version

Version 0.1.x receives security and correctness fixes.

## Reporting a Vulnerability

Please open a private security advisory on GitHub or contact the maintainer if
the issue should not be disclosed publicly yet.

Useful reports include:

- Exact `/goal` input or Stop-hook payload.
- Operating system and shell.
- Node version used by Claude Code.
- Whether `CLAUDE_GOAL_SESSION_ID`, `CLAUDE_GOAL_DB`, or related environment
  variables were set.
- Expected behavior and observed behavior.

## Security Notes

The helper stores local runtime state in `goal-state/goals.json`. That file is
ignored by git and may include user objectives or progress notes. Do not commit
runtime state from real work sessions.

The slash command invokes the helper through a quoted heredoc so objective text
is passed on stdin rather than interpolated into a shell command.

